// Blockchain service: deploys one MilestoneEscrow per job and calls it on behalf of users.
//
// DEVELOPMENT STAND-IN (FR5 "Partial", FR18 "Planned"):
// Each user is given one of the local Hardhat chain's funded accounts as a custodial
// dev wallet, and the server signs that user's transactions. In the final system the
// user signs in the browser with MetaMask and the server never holds user keys.
// Account 0 is the platform account: it deploys contracts and acts as the risk oracle.
const STATUS = ["pending", "funded", "submitted", "released", "disputed", "refunded"];

function makeChain(ethers) {
  let signersCache = null;
  async function signers() {
    if (!signersCache) signersCache = await ethers.getSigners();
    return signersCache;
  }

  async function platformSigner() {
    return (await signers())[0];
  }

  async function devWallet(index) {
    const all = await signers();
    if (index < 1 || index >= all.length) throw new Error("No free development wallet left");
    return all[index];
  }

  async function signerFor(user) {
    return devWallet(user.dev_wallet_index);
  }

  async function escrowAt(address, signer) {
    return ethers.getContractAt("MilestoneEscrow", address, signer);
  }

  async function deployEscrow(client, freelancer, arbiter) {
    const platform = await platformSigner();
    const Factory = await ethers.getContractFactory("MilestoneEscrow", platform);
    const escrow = await Factory.deploy(
      client.wallet_address,
      freelancer.wallet_address,
      arbiter.wallet_address,
      platform.address // risk oracle
    );
    await escrow.waitForDeployment();
    return { address: await escrow.getAddress(), txHash: escrow.deploymentTransaction().hash };
  }

  // Sends a transaction as `user` and turns contract errors into readable names.
  async function send(address, user, method, args = [], overrides = {}) {
    const signer = user === "oracle" ? await platformSigner() : await signerFor(user);
    const escrow = await escrowAt(address, signer);
    try {
      const tx = await escrow[method](...args, overrides);
      const receipt = await tx.wait();
      return { txHash: receipt.hash, receipt, escrow };
    } catch (err) {
      const data = err.data ?? err.info?.error?.data;
      let name = null;
      try {
        if (data) name = escrow.interface.parseError(data).name;
      } catch {
        /* not a custom error */
      }
      const e = new Error(name || err.shortMessage || err.message);
      e.contractError = name;
      throw e;
    }
  }

  async function addMilestone(address, client, amountEth) {
    const { txHash, receipt, escrow } = await send(address, client, "addMilestone", [ethers.parseEther(amountEth)]);
    const ev = receipt.logs.map((l) => {
      try {
        return escrow.interface.parseLog(l);
      } catch {
        return null;
      }
    }).find((e) => e && e.name === "MilestoneAdded");
    return { txHash, chainIndex: Number(ev.args.id) };
  }

  const fund = (address, client, index, amountEth) =>
    send(address, client, "fundMilestone", [index], { value: ethers.parseEther(amountEth) });
  const submit = (address, freelancer, index) => send(address, freelancer, "submitWork", [index]);
  const flag = (address, index, reason) => send(address, "oracle", "flagRisk", [index, reason]);
  const approve = (address, client, index) => send(address, client, "approveMilestone", [index]);
  const dispute = (address, client, index) => send(address, client, "disputeMilestone", [index]);
  const requestChanges = (address, client, index) => send(address, client, "requestChanges", [index]);
  const appeal = (address, freelancer, index, note) => send(address, freelancer, "appealFlag", [index, note]);
  const arbiterRelease = (address, arbiter, index) => send(address, arbiter, "arbiterRelease", [index]);
  const arbiterRefund = (address, arbiter, index) => send(address, arbiter, "arbiterRefund", [index]);
  const pause = (address, arbiter) => send(address, arbiter, "pause");
  const unpause = (address, arbiter) => send(address, arbiter, "unpause");

  // Reads the contract's view of a milestone so the database always mirrors the chain.
  async function readMilestone(address, index) {
    const escrow = await escrowAt(address, await platformSigner());
    const m = await escrow.getMilestone(index);
    const [, appealed, deadline] = await escrow.getReviewInfo(index);
    return {
      status: STATUS[Number(m.status)],
      riskFlagged: m.riskFlagged,
      appealed,
      reviewDeadline: deadline > 0n ? new Date(Number(deadline) * 1000).toISOString() : null,
    };
  }

  async function isPaused(address) {
    return (await escrowAt(address, await platformSigner())).paused();
  }

  async function balanceEth(address) {
    return ethers.formatEther(await ethers.provider.getBalance(address));
  }

  return {
    devWallet,
    deployEscrow,
    addMilestone,
    fund,
    submit,
    flag,
    approve,
    dispute,
    requestChanges,
    appeal,
    arbiterRelease,
    arbiterRefund,
    pause,
    unpause,
    readMilestone,
    isPaused,
    balanceEth,
  };
}

module.exports = { makeChain, STATUS };
