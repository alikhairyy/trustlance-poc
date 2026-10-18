const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("MilestoneEscrow", function () {
  let escrow, client, freelancer, arbiter, riskOracle, outsider;
  const AMOUNT = ethers.parseEther("1");

  beforeEach(async function () {
    [client, freelancer, arbiter, riskOracle, outsider] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
    escrow = await Factory.deploy(
      client.address,
      freelancer.address,
      arbiter.address,
      riskOracle.address
    );
    await escrow.waitForDeployment();

    await escrow.connect(client).addMilestone(AMOUNT);
  });

  describe("happy path (no risk flag)", function () {
    it("funds, submits, and auto-releases on client approval", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await escrow.connect(freelancer).submitWork(0);

      const before = await ethers.provider.getBalance(freelancer.address);
      const tx = await escrow.connect(client).approveMilestone(0);
      await expect(tx)
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(0, freelancer.address, AMOUNT, false);
      const after = await ethers.provider.getBalance(freelancer.address);

      expect(after - before).to.equal(AMOUNT);
      const m = await escrow.getMilestone(0);
      expect(m.status).to.equal(3n); // Released
    });
  });

  describe("AI risk-engine integration", function () {
    it("holds release for arbiter review once the risk oracle flags the milestone", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await escrow.connect(freelancer).submitWork(0);

      await expect(
        escrow.connect(riskOracle).flagRisk(0, "Payout 4.1x above this freelancer's 90-day average; account is 6 days old")
      )
        .to.emit(escrow, "RiskFlagged")
        .withArgs(0, "Payout 4.1x above this freelancer's 90-day average; account is 6 days old");

      // Client can no longer auto-approve a flagged milestone.
      await expect(escrow.connect(client).approveMilestone(0)).to.be.revertedWithCustomError(
        escrow,
        "ReleaseHeldForReview"
      );

      const m = await escrow.getMilestone(0);
      expect(m.riskFlagged).to.equal(true);
      expect(m.status).to.equal(2n); // still Submitted, not Released

      // Arbiter reviews and decides to release anyway (false positive).
      await expect(escrow.connect(arbiter).arbiterRelease(0))
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(0, freelancer.address, AMOUNT, true);
    });

    it("lets the arbiter refund the client when a flagged milestone turns out risky", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await escrow.connect(freelancer).submitWork(0);
      await escrow.connect(riskOracle).flagRisk(0, "Freelancer's dispute rate jumped to 38% this week");

      const before = await ethers.provider.getBalance(client.address);
      const tx = await escrow.connect(arbiter).arbiterRefund(0);
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(client.address);

      // client paid gas for this tx too since client == signer here is not the case;
      // arbiter paid gas, client only receives the refund.
      expect(after - before).to.equal(AMOUNT);
      void gasCost;

      const m = await escrow.getMilestone(0);
      expect(m.status).to.equal(5n); // Refunded
    });

    it("only the designated risk oracle can post a flag", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await escrow.connect(freelancer).submitWork(0);

      await expect(
        escrow.connect(outsider).flagRisk(0, "not actually the oracle")
      ).to.be.revertedWithCustomError(escrow, "NotRiskOracle");
    });
  });

  describe("manual dispute path", function () {
    it("lets the client dispute instead of approving, then the arbiter decides", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await escrow.connect(freelancer).submitWork(0);

      await expect(escrow.connect(client).disputeMilestone(0)).to.emit(escrow, "MilestoneDisputed").withArgs(0);

      const m = await escrow.getMilestone(0);
      expect(m.status).to.equal(4n); // Disputed

      await expect(escrow.connect(arbiter).arbiterRelease(0))
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(0, freelancer.address, AMOUNT, true);
    });
  });

  describe("access control & state guards", function () {
    it("rejects funding from anyone but the client", async function () {
      await expect(
        escrow.connect(freelancer).fundMilestone(0, { value: AMOUNT })
      ).to.be.revertedWithCustomError(escrow, "NotClient");
    });

    it("rejects an incorrect funding amount", async function () {
      await expect(
        escrow.connect(client).fundMilestone(0, { value: ethers.parseEther("0.5") })
      ).to.be.revertedWithCustomError(escrow, "WrongFundingAmount");
    });

    it("rejects submitting work before funding", async function () {
      await expect(escrow.connect(freelancer).submitWork(0)).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
    });

    it("rejects approval before submission", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await expect(escrow.connect(client).approveMilestone(0)).to.be.revertedWithCustomError(
        escrow,
        "WrongStatus"
      );
    });

    it("rejects arbiter actions from a non-arbiter", async function () {
      await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
      await escrow.connect(freelancer).submitWork(0);
      await expect(escrow.connect(outsider).arbiterRelease(0)).to.be.revertedWithCustomError(
        escrow,
        "NotArbiter"
      );
    });
  });
});
