// End-to-end proof-of-concept demo: deploys MilestoneEscrow on an in-memory
// Hardhat network, then for each sample case calls the Python explainable risk
// engine (risk-engine/predict_cli.py) and drives the real contract accordingly.
//
// The engine scores the wallet that will receive the payout with a model trained on
// REAL labeled Ethereum fraud data (a logistic regression, so every score comes with
// plain-language reasons). Each case uses a real held-out wallet from that dataset
// (features only, never the address); the wallet was never seen during training.
//
//   - "auto_approve"    -> client approves, funds release immediately.
//   - "hold_for_review" -> the risk oracle posts the reason on-chain via flagRisk,
//                          the client's approval reverts, the freelancer may
//                          appeal on-chain, and the arbiter makes the final call.
//
// After the three cases the demo runs short security checks (unauthorized flag,
// emergency pause, "the AI can delay but never trap a payment") and prints the
// on-chain audit trail plus the off-chain tamper-evident log verification.
//
// Run with: npm run demo   (after `npm run build:contracts`)
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const RISK_ENGINE_DIR = path.join(__dirname, "..", "risk-engine");

// Prefer the project's virtual environment so the demo works the same on
// Windows, macOS and Linux without activating anything. Override with PYTHON=...
function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidates = [
    path.join(__dirname, "..", ".venv", "Scripts", "python.exe"), // Windows venv
    path.join(__dirname, "..", ".venv", "bin", "python"), // macOS / Linux venv
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}
const PYTHON = findPython();

function runPython(script, input) {
  return execFileSync(PYTHON, [script], {
    cwd: RISK_ENGINE_DIR,
    input,
    encoding: "utf8",
  }).trim();
}

function scoreCase(payload) {
  return JSON.parse(runPython("predict_cli.py", JSON.stringify(payload)));
}

const CASES = [
  {
    id: "A",
    label: "Case A — established wallet, routine milestone",
    amountEth: "1.0",
    wallet_sample: "legit", // a real, clearly legitimate wallet from the dataset
  },
  {
    id: "B",
    label: "Case B — payout wallet that looks like known fraud",
    amountEth: "2.0",
    wallet_sample: "fraud", // a real wallet the dataset labels as fraud
  },
  {
    id: "C",
    label: "Case C — brand-new wallet, flagged, then appealed",
    amountEth: "0.5",
    wallet_sample: "false_positive", // a real legitimate wallet the model scores high
  },
];

function decodeRevert(escrow, err) {
  const errorData = err.data ?? err.info?.error?.data;
  try {
    if (errorData) return escrow.interface.parseError(errorData).name + "()";
  } catch {
    /* fall through */
  }
  return err.shortMessage || err.message;
}

async function expectRevert(escrow, label, fn) {
  try {
    await fn();
    console.log(`  UNEXPECTED: ${label} succeeded`);
  } catch (err) {
    console.log(`  ${label} -> reverted: ${decodeRevert(escrow, err)}`);
  }
}

async function balanceChange(addr, fn) {
  const before = await ethers.provider.getBalance(addr);
  await fn();
  const after = await ethers.provider.getBalance(addr);
  return ethers.formatEther(after - before);
}

async function main() {
  const [client, freelancer, arbiter, riskOracle, outsider] = await ethers.getSigners();

  const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
  const escrow = await Factory.deploy(client.address, freelancer.address, arbiter.address, riskOracle.address);
  await escrow.waitForDeployment();

  console.log("MilestoneEscrow deployed at", await escrow.getAddress());
  console.log("client:", client.address, " freelancer:", freelancer.address);
  console.log("arbiter:", arbiter.address, " riskOracle:", riskOracle.address);

  for (const testCase of CASES) {
    console.log(`\n================ ${testCase.label} ================`);

    const amount = ethers.parseEther(testCase.amountEth);
    const addReceipt = await (await escrow.connect(client).addMilestone(amount)).wait();
    const id = addReceipt.logs
      .map((l) => {
        try {
          return escrow.interface.parseLog(l);
        } catch {
          return null;
        }
      })
      .find((e) => e && e.name === "MilestoneAdded").args.id;
    console.log(`Milestone #${id} created for ${testCase.amountEth} ETH`);

    await escrow.connect(client).fundMilestone(id, { value: amount });
    await escrow.connect(freelancer).submitWork(id);
    console.log("Funded and submitted. Scoring with the Python risk engine...");

    const a = scoreCase({ case_id: testCase.id, wallet_sample: testCase.wallet_sample });
    const f = a.wallet_features;
    console.log(
      `Payout wallet (real, held-out): active ${f.wallet_age_days.toFixed(0)} days, ` +
        `${f.total_transactions} transactions, ${f.unique_senders} distinct senders, ` +
        `${f.total_ether_received.toFixed(1)} ETH received. Dataset label: ` +
        `${a.wallet_dataset_label === 1 ? "FRAUD" : "legitimate"}.`
    );
    console.log(`Risk engine -> score=${a.score} band=${a.band} action=${a.action}`);
    console.log(`Reason: ${a.reason}`);

    if (a.action === "auto_approve") {
      const gained = await balanceChange(freelancer.address, async () => {
        await (await escrow.connect(client).approveMilestone(id)).wait();
      });
      console.log(`Client approved. No flag was raised, so funds released immediately: +${gained} ETH to freelancer.`);
      continue;
    }

    await (await escrow.connect(riskOracle).flagRisk(id, a.reason)).wait();
    const [, , deadline] = await escrow.getReviewInfo(id);
    console.log(
      `Risk oracle posted the flag on-chain. Review window open until ${new Date(Number(deadline) * 1000).toISOString()}.`
    );
    await expectRevert(escrow, "Client's approveMilestone", () => escrow.connect(client).approveMilestone(id));

    if (testCase.id === "C") {
      const note = "This is a new wallet I created for this job, so it has no history. Please review.";
      await (await escrow.connect(freelancer).appealFlag(id, note)).wait();
      console.log(`Freelancer appealed the flag on-chain: "${note}"`);
    }

    console.log("Escalating to the arbiter for human review...");
    // Demo policy standing in for a human reviewer: refund when the score is very
    // high, otherwise release (likely false positive). The contract enforces who may
    // decide, not what they decide.
    if (a.score < 0.85) {
      const gained = await balanceChange(freelancer.address, async () => {
        await (await escrow.connect(arbiter).arbiterRelease(id)).wait();
      });
      console.log(`Arbiter reviewed and released anyway (likely false positive): +${gained} ETH to freelancer.`);
    } else {
      const gained = await balanceChange(client.address, async () => {
        await (await escrow.connect(arbiter).arbiterRefund(id)).wait();
      });
      console.log(`Arbiter reviewed and refunded the client (very high risk): +${gained} ETH back to client.`);
    }
  }

  console.log("\n================ Security checks ================");

  console.log("1. An outsider (not the risk oracle) tries to post a flag:");
  await (await escrow.connect(client).addMilestone(ethers.parseEther("0.1"))).wait();
  const secId = (await escrow.milestoneCount()) - 1n;
  await (await escrow.connect(client).fundMilestone(secId, { value: ethers.parseEther("0.1") })).wait();
  await (await escrow.connect(freelancer).submitWork(secId)).wait();
  await expectRevert(escrow, "outsider flagRisk", () => escrow.connect(outsider).flagRisk(secId, "fake flag"));

  console.log("2. The arbiter pauses the contract (emergency stop):");
  await (await escrow.connect(arbiter).pause()).wait();
  await expectRevert(escrow, "client addMilestone while paused", () =>
    escrow.connect(client).addMilestone(ethers.parseEther("1"))
  );
  await (await escrow.connect(arbiter).unpause()).wait();
  console.log("  arbiter unpaused; normal activity resumes.");

  console.log("3. The AI can delay a payment but never trap it (arbiter never responds):");
  await (await escrow.connect(riskOracle).flagRisk(secId, "demo flag: arbiter will not answer")).wait();
  await expectRevert(escrow, "client approve inside the review window", () =>
    escrow.connect(client).approveMilestone(secId)
  );
  await ethers.provider.send("evm_increaseTime", [7 * 24 * 60 * 60 + 1]);
  await ethers.provider.send("evm_mine", []);
  const gained = await balanceChange(freelancer.address, async () => {
    await (await escrow.connect(client).approveMilestone(secId)).wait();
  });
  console.log(`  7 days later the client's approval is honored: +${gained} ETH to freelancer.`);

  console.log("\n================ On-chain audit trail ================");
  const trail = [
    ...(await escrow.queryFilter(escrow.filters.RiskFlagged())),
    ...(await escrow.queryFilter(escrow.filters.FlagAppealed())),
    ...(await escrow.queryFilter(escrow.filters.ArbiterDecided())),
  ].sort((x, y) => x.blockNumber - y.blockNumber || x.index - y.index);
  for (const ev of trail) {
    const args = ev.args;
    if (ev.fragment.name === "RiskFlagged") {
      console.log(`  block ${ev.blockNumber}  RiskFlagged     milestone #${args.id}`);
    } else if (ev.fragment.name === "FlagAppealed") {
      console.log(`  block ${ev.blockNumber}  FlagAppealed    milestone #${args.id}`);
    } else {
      console.log(
        `  block ${ev.blockNumber}  ArbiterDecided  milestone #${args.id}  ` +
          `${args.releasedToFreelancer ? "released" : "refunded"}  flagged=${args.wasFlagged}  appealed=${args.wasAppealed}`
      );
    }
  }

  console.log("\n================ Off-chain decision log ================");
  console.log(runPython("audit_log.py", ""));

  console.log("\n================ demo complete ================");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
