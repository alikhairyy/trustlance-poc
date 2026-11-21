// Tests for the security hardening added to MilestoneEscrow. Each test maps to a
// row of the threat table in docs/SECURITY.md.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("MilestoneEscrow security hardening", function () {
  let escrow, client, freelancer, arbiter, riskOracle, outsider;
  const AMOUNT = ethers.parseEther("1");
  const WINDOW = 7 * 24 * 60 * 60;

  async function deploy() {
    const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
    const c = await Factory.deploy(client.address, freelancer.address, arbiter.address, riskOracle.address);
    await c.waitForDeployment();
    return c;
  }

  async function fundedAndSubmitted() {
    await escrow.connect(client).addMilestone(AMOUNT);
    await escrow.connect(client).fundMilestone(0, { value: AMOUNT });
    await escrow.connect(freelancer).submitWork(0);
  }

  beforeEach(async function () {
    [client, freelancer, arbiter, riskOracle, outsider] = await ethers.getSigners();
    escrow = await deploy();
  });

  describe("role separation and input validation", function () {
    it("rejects a zero address for any role", async function () {
      const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
      await expect(
        Factory.deploy(client.address, ethers.ZeroAddress, arbiter.address, riskOracle.address)
      ).to.be.revertedWithCustomError(escrow, "ZeroAddress");
    });

    it("rejects the same address on both sides of a payment", async function () {
      const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
      await expect(
        Factory.deploy(client.address, client.address, arbiter.address, riskOracle.address)
      ).to.be.revertedWithCustomError(escrow, "InvalidParties");
    });

    it("rejects an arbiter who is also the client or the freelancer", async function () {
      const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
      await expect(
        Factory.deploy(client.address, freelancer.address, freelancer.address, riskOracle.address)
      ).to.be.revertedWithCustomError(escrow, "InvalidParties");
    });

    it("rejects zero-value milestones and an empty oracle address", async function () {
      await expect(escrow.connect(client).addMilestone(0)).to.be.revertedWithCustomError(escrow, "ZeroAmount");
      await expect(escrow.connect(client).setRiskOracle(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        escrow,
        "ZeroAddress"
      );
    });

    it("caps the length of on-chain flag reasons", async function () {
      await fundedAndSubmitted();
      const tooLong = "x".repeat(513);
      await expect(escrow.connect(riskOracle).flagRisk(0, tooLong)).to.be.revertedWithCustomError(
        escrow,
        "TextTooLong"
      );
    });
  });

  describe("oracle key compromise", function () {
    it("lets the client rotate the oracle, after which the old key is powerless", async function () {
      await fundedAndSubmitted();
      await expect(escrow.connect(client).setRiskOracle(outsider.address))
        .to.emit(escrow, "RiskOracleUpdated")
        .withArgs(outsider.address);

      await expect(escrow.connect(riskOracle).flagRisk(0, "old key")).to.be.revertedWithCustomError(
        escrow,
        "NotRiskOracle"
      );
      await expect(escrow.connect(outsider).flagRisk(0, "new key")).to.emit(escrow, "RiskFlagged");
    });

    it("only the client can rotate the oracle", async function () {
      await expect(escrow.connect(outsider).setRiskOracle(outsider.address)).to.be.revertedWithCustomError(
        escrow,
        "NotClient"
      );
    });
  });

  describe("the AI can delay a payment but never trap it", function () {
    it("holds release during the review window, then honors the client's approval", async function () {
      await fundedAndSubmitted();
      await escrow.connect(riskOracle).flagRisk(0, "high risk");

      await expect(escrow.connect(client).approveMilestone(0)).to.be.revertedWithCustomError(
        escrow,
        "ReleaseHeldForReview"
      );

      await time.increase(WINDOW + 1); // arbiter never responds

      await expect(escrow.connect(client).approveMilestone(0))
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(0, freelancer.address, AMOUNT, false);
    });

    it("re-flagging cannot restart the review clock", async function () {
      await fundedAndSubmitted();
      await escrow.connect(riskOracle).flagRisk(0, "first flag");
      const [firstFlaggedAt] = await escrow.getReviewInfo(0);

      await time.increase(WINDOW - 100);
      await escrow.connect(riskOracle).flagRisk(0, "second flag, trying to extend the hold");
      const [secondFlaggedAt] = await escrow.getReviewInfo(0);
      expect(secondFlaggedAt).to.equal(firstFlaggedAt);

      await time.increase(200);
      await expect(escrow.connect(client).approveMilestone(0)).to.emit(escrow, "MilestoneReleased");
    });
  });

  describe("appeal path and audit trail", function () {
    it("lets the flagged freelancer appeal once, on-chain", async function () {
      await fundedAndSubmitted();
      await escrow.connect(riskOracle).flagRisk(0, "high risk");

      await expect(escrow.connect(freelancer).appealFlag(0, "I have 3 prior clients; please review"))
        .to.emit(escrow, "FlagAppealed")
        .withArgs(0, "I have 3 prior clients; please review");

      const [, appealed] = await escrow.getReviewInfo(0);
      expect(appealed).to.equal(true);

      await expect(escrow.connect(freelancer).appealFlag(0, "again")).to.be.revertedWithCustomError(
        escrow,
        "AlreadyAppealed"
      );
    });

    it("only the freelancer can appeal, and only a flagged milestone", async function () {
      await fundedAndSubmitted();
      await expect(escrow.connect(freelancer).appealFlag(0, "nothing to appeal")).to.be.revertedWithCustomError(
        escrow,
        "NotFlagged"
      );
      await escrow.connect(riskOracle).flagRisk(0, "high risk");
      await expect(escrow.connect(client).appealFlag(0, "not mine")).to.be.revertedWithCustomError(
        escrow,
        "NotFreelancer"
      );
    });

    it("records every arbiter decision with whether the milestone was flagged and appealed", async function () {
      await fundedAndSubmitted();
      // Ordinary submitted work (not flagged, not disputed) is the client's call, not the arbiter's.
      await expect(escrow.connect(arbiter).arbiterRelease(0)).to.be.revertedWithCustomError(escrow, "NotUnderReview");
      await expect(escrow.connect(arbiter).arbiterRefund(0)).to.be.revertedWithCustomError(escrow, "NotUnderReview");

      await escrow.connect(riskOracle).flagRisk(0, "high risk");
      await escrow.connect(freelancer).appealFlag(0, "please review");

      await expect(escrow.connect(arbiter).arbiterRelease(0))
        .to.emit(escrow, "ArbiterDecided")
        .withArgs(0, true, true, true);
    });
  });

  describe("emergency pause", function () {
    it("only the arbiter can pause and unpause", async function () {
      await expect(escrow.connect(outsider).pause()).to.be.revertedWithCustomError(escrow, "NotArbiter");
      await expect(escrow.connect(arbiter).pause()).to.emit(escrow, "Paused").withArgs(arbiter.address);
      await expect(escrow.connect(outsider).unpause()).to.be.revertedWithCustomError(escrow, "NotArbiter");
      await expect(escrow.connect(arbiter).unpause()).to.emit(escrow, "Unpaused").withArgs(arbiter.address);
    });

    it("blocks new activity while paused but still lets the arbiter settle open funds", async function () {
      await fundedAndSubmitted();
      await escrow.connect(arbiter).pause();

      await expect(escrow.connect(client).addMilestone(AMOUNT)).to.be.revertedWithCustomError(
        escrow,
        "ContractPaused"
      );
      await expect(escrow.connect(client).approveMilestone(0)).to.be.revertedWithCustomError(
        escrow,
        "ContractPaused"
      );
      await expect(escrow.connect(riskOracle).flagRisk(0, "x")).to.be.revertedWithCustomError(
        escrow,
        "ContractPaused"
      );

      // funds are not stuck behind the pause
      await expect(escrow.connect(arbiter).arbiterRelease(0)).to.emit(escrow, "MilestoneReleased");
    });
  });

  describe("reentrancy", function () {
    it("blocks a malicious client contract from re-entering during a refund", async function () {
      const Malicious = await ethers.getContractFactory("MaliciousClient", client);
      const attacker = await Malicious.deploy();
      await attacker.waitForDeployment();

      const Factory = await ethers.getContractFactory("MilestoneEscrow", client);
      const target = await Factory.deploy(
        await attacker.getAddress(),
        freelancer.address,
        arbiter.address,
        riskOracle.address
      );
      await target.waitForDeployment();

      await attacker.setEscrow(await target.getAddress());
      await attacker.setup(AMOUNT, { value: AMOUNT });
      await target.connect(freelancer).submitWork(0);
      await target.connect(riskOracle).flagRisk(0, "high risk"); // the arbiter only refunds flagged or disputed work

      await target.connect(arbiter).arbiterRefund(0);

      expect(await attacker.reentryAttempted()).to.equal(true);
      const selector = target.interface.getError("Reentrancy").selector;
      expect(await attacker.lastReentryError()).to.equal(selector);
      expect(await ethers.provider.getBalance(await target.getAddress())).to.equal(0n);
    });
  });
});
