// API tests: the web backend driving a real MilestoneEscrow on Hardhat's in-process chain.
// The Python risk engine is replaced by a stand-in with fixed answers, so these tests
// check the backend logic (roles, state, on-chain hold) without training the model.
// The real engine is covered by risk-engine/test_engine.py and the end-to-end demo.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { openDatabase } = require("../../server/db");
const { createApp } = require("../../server/app");
const { makeChain } = require("../../server/services/chain");
const { seedDemo } = require("../../server/seed");

const fakeRisk = {
  async assessPayout({ freelancer }) {
    if (freelancer.dev_risk_profile === "fraud") {
      return { score: 0.9, band: "high", action: "hold_for_review", reason: "Test: high risk wallet.", modelVersion: "test", auditHash: null };
    }
    return { score: 0.1, band: "low", action: "auto_approve", reason: "Test: low risk wallet.", modelVersion: "test", auditHash: null };
  },
};

describe("Trustlance API", function () {
  this.timeout(60000);
  let server, base;

  async function call(method, path, body, token) {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }
  const login = async (email) => (await call("POST", "/api/auth/login", { email, password: "demo1234" })).body.token;

  // Creates a job, proposal from `freelancerEmail`, accepts it and adds one funded milestone.
  async function fundedMilestone(t, freelancerEmail, amount = "0.5") {
    const job = (await call("POST", "/api/jobs", { title: "Job", description: "d", budget_eth: "1" }, t.client)).body;
    const fl = await login(freelancerEmail);
    const p = (await call("POST", `/api/jobs/${job.id}/proposals`, { cover_letter: "hi", price_eth: "1" }, fl)).body;
    await call("POST", `/api/proposals/${p.id}/accept`, null, t.client);
    const m = (await call("POST", `/api/jobs/${job.id}/milestones`, { title: "M1", amount_eth: amount }, t.client)).body;
    await call("POST", `/api/milestones/${m.id}/fund`, null, t.client);
    return { job, m, fl };
  }

  let t;
  before(async function () {
    const db = await openDatabase(":memory:");
    const chain = makeChain(ethers);
    await seedDemo(db, chain);
    const app = createApp({ db, chain, risk: fakeRisk, jwtSecret: "test-secret" });
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}`;
    t = { client: await login("client@demo.com"), arbiter: await login("arbiter@demo.com") };
  });
  after(() => server.close());

  describe("accounts (FR1, FR2, NFR3)", function () {
    it("registers a user with a wallet and logs in", async function () {
      const r = await call("POST", "/api/auth/register", {
        email: "new@x.com", password: "longpassword", full_name: "New User", role: "freelancer",
      });
      expect(r.status).to.equal(201);
      expect(r.body.user.wallet_address).to.match(/^0x[0-9a-fA-F]{40}$/);
      expect(r.body.user).to.not.have.property("password_hash");
      const me = await call("GET", "/api/users/me", null, r.body.token);
      expect(me.body.email).to.equal("new@x.com");
      // Emails ignore case, and a user cannot pick the dataset wallet the risk engine scores.
      expect((await call("POST", "/api/auth/login", { email: "NEW@x.com", password: "longpassword" })).status).to.equal(200);
      expect((await call("PUT", "/api/users/me", { dev_risk_profile: "legit" }, r.body.token)).status).to.equal(403);
    });

    it("rejects a wrong password and a short password", async function () {
      expect((await call("POST", "/api/auth/login", { email: "client@demo.com", password: "nope" })).status).to.equal(401);
      const r = await call("POST", "/api/auth/register", { email: "s@x.com", password: "short", full_name: "S", role: "client" });
      expect(r.status).to.equal(400);
      const bad = { password: "longpassword", full_name: "S", role: "client" };
      expect((await call("POST", "/api/auth/register", { ...bad, email: "not-an-email" })).status).to.equal(400);
      expect((await call("POST", "/api/auth/register", { ...bad, email: "CLIENT@demo.com" })).status).to.equal(409);
    });

    it("requires a token", async function () {
      expect((await call("GET", "/api/jobs")).status).to.equal(401);
    });
  });

  describe("jobs and proposals (FR3, FR4, FR5, NFR1)", function () {
    it("only clients post jobs; freelancers see open jobs and send proposals", async function () {
      const fl = await login("freelancer@demo.com");
      expect((await call("POST", "/api/jobs", { title: "x", description: "y", budget_eth: "1" }, fl)).status).to.equal(403);
      expect((await call("POST", "/api/jobs", { title: "   ", description: "y", budget_eth: "1" }, t.client)).status).to.equal(400);
      const open = await call("GET", "/api/jobs", null, fl);
      expect(open.body.length).to.be.greaterThan(0);
      const p = await call("POST", `/api/jobs/${open.body[0].id}/proposals`, { cover_letter: "I can do it", price_eth: "1.2" }, fl);
      expect(p.status).to.equal(201);
      const dup = await call("POST", `/api/jobs/${open.body[0].id}/proposals`, { cover_letter: "again", price_eth: "1" }, fl);
      expect(dup.status).to.equal(409);
    });

    it("accepting a proposal assigns the job and deploys an escrow contract", async function () {
      const { job } = await fundedMilestone(t, "freelancer@demo.com");
      const j = (await call("GET", `/api/jobs/${job.id}`, null, t.client)).body;
      expect(j.status).to.equal("in_progress");
      expect(j.escrow_address).to.match(/^0x/);
      expect(await ethers.provider.getCode(j.escrow_address)).to.not.equal("0x");
      // The job's budget is 1 ETH and 0.5 ETH is already planned, so another 0.6 ETH does not fit.
      const over = await call("POST", `/api/jobs/${job.id}/milestones`, { title: "Too much", amount_eth: "0.6" }, t.client);
      expect(over.status).to.equal(400);
      // A milestone that was never funded can be cancelled.
      const extra = (await call("POST", `/api/jobs/${job.id}/milestones`, { title: "Maybe", amount_eth: "0.4" }, t.client)).body;
      expect((await call("POST", `/api/milestones/${extra.id}/cancel`, null, t.client)).body.status).to.equal("cancelled");
    });
  });

  describe("milestone payments (FR6 to FR13)", function () {
    it("low risk: submit, then client approval releases the funds on-chain", async function () {
      const { m, fl } = await fundedMilestone(t, "freelancer@demo.com", "0.5");
      const badLink = await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "javascript:alert(1)" }, fl);
      expect(badLink.status).to.equal(400);
      const sub = await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "https://example.com/work" }, fl);
      expect(sub.body.risk.action).to.equal("auto_approve");
      expect(sub.body.milestone.risk_flagged).to.equal(0);
      // Unflagged, undisputed work is the client's decision, so the arbiter cannot settle it.
      const arb = await call("POST", `/api/arbiter/milestones/${m.id}/refund`, null, t.arbiter);
      expect(arb.status).to.equal(409);
      expect(arb.body.contract_error).to.equal("NotUnderReview");
      const ok = await call("POST", `/api/milestones/${m.id}/approve`, null, t.client);
      expect(ok.status).to.equal(200);
      expect(ok.body.status).to.equal("released");
      const detail = (await call("GET", `/api/milestones/${m.id}`, null, t.client)).body;
      expect(detail.history.map((h) => h.event)).to.include.members(["funded", "submitted", "risk_scored", "approved_released"]);
      // Only 0.5 of the 1 ETH budget is paid, so the job stays open for the next milestone
      // until the client closes it.
      const jobId = detail.job.id;
      expect((await call("GET", `/api/jobs/${jobId}`, null, t.client)).body.status).to.equal("in_progress");
      expect((await call("POST", `/api/jobs/${jobId}/complete`, null, t.client)).body.status).to.equal("completed");
    });

    it("high risk: flag goes on-chain, approval is blocked, freelancer appeals, arbiter releases", async function () {
      const { m, fl } = await fundedMilestone(t, "risky@demo.com", "0.3");
      const sub = await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "https://example.com/w" }, fl);
      expect(sub.body.risk.action).to.equal("hold_for_review");
      expect(sub.body.milestone.risk_flagged).to.equal(1);
      expect(sub.body.milestone.review_deadline).to.be.a("string");

      const blocked = await call("POST", `/api/milestones/${m.id}/approve`, null, t.client);
      expect(blocked.status).to.equal(409);
      expect(blocked.body.contract_error).to.equal("ReleaseHeldForReview");

      expect((await call("POST", `/api/milestones/${m.id}/appeal`, { note: "New wallet, please check" }, fl)).body.appealed).to.equal(1);
      const queue = (await call("GET", "/api/arbiter/queue", null, t.arbiter)).body;
      const item = queue.find((q) => q.id === m.id);
      expect(item.appeal_note).to.equal("New wallet, please check");
      expect(item.risk_reason).to.equal("Test: high risk wallet.");

      const rel = await call("POST", `/api/arbiter/milestones/${m.id}/release`, { note: "False positive" }, t.arbiter);
      expect(rel.body.status).to.equal("released");
    });

    it("dispute: client disputes and the arbiter refunds", async function () {
      const { m, fl } = await fundedMilestone(t, "freelancer@demo.com", "0.2");
      await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "https://example.com/w" }, fl);
      expect((await call("POST", `/api/milestones/${m.id}/dispute`, { reason: "Not delivered" }, t.client)).body.status).to.equal("disputed");
      expect((await call("POST", `/api/arbiter/milestones/${m.id}/refund`, null, t.arbiter)).body.status).to.equal("refunded");
    });

    it("only the job's own parties can act on a milestone", async function () {
      const { m } = await fundedMilestone(t, "freelancer@demo.com", "0.1");
      const other = await login("risky@demo.com");
      expect((await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "x" }, other)).status).to.equal(403);
      expect((await call("POST", `/api/milestones/${m.id}/approve`, null, t.arbiter)).status).to.equal(403);
      expect((await call("POST", `/api/arbiter/milestones/${m.id}/release`, null, t.client)).status).to.equal(403);
    });

    it("arbiter pause blocks new activity (FR14)", async function () {
      const { job, m } = await fundedMilestone(t, "freelancer@demo.com", "0.1");
      expect((await call("POST", `/api/arbiter/jobs/${job.id}/pause`, null, t.arbiter)).body.paused).to.equal(true);
      const blocked = await call("POST", `/api/jobs/${job.id}/milestones`, { title: "M2", amount_eth: "0.1" }, t.client);
      expect(blocked.status).to.equal(423);
      expect((await call("POST", `/api/arbiter/jobs/${job.id}/unpause`, null, t.arbiter)).body.paused).to.equal(false);
      expect((await call("POST", `/api/arbiter/jobs/${job.id}/unpause`, null, t.arbiter)).status).to.equal(409);
      expect(m.status).to.equal("pending");
    });
  });

  describe("portfolios and packages", function () {
    it("anyone can see a freelancer's public profile, portfolio and packages", async function () {
      const list = await call("GET", "/api/public/freelancers");
      expect(list.status).to.equal(200);
      const omar = list.body.find((f) => f.full_name === "Omar Freelancer");
      expect(omar.portfolio_count).to.be.greaterThan(0);
      expect(omar).to.not.have.property("email"); // no private data on public pages
      const profile = (await call("GET", `/api/public/freelancers/${omar.id}`)).body;
      expect(profile.portfolio.length).to.equal(omar.portfolio_count);
      expect(profile.packages.length).to.be.greaterThan(0);
      expect((await call("GET", "/api/public/freelancers/1")).status).to.equal(404); // user 1 is a client
    });

    it("a freelancer adds portfolio work and packages; others cannot", async function () {
      const fl = await login("freelancer@demo.com");
      const item = await call("POST", "/api/me/portfolio", { title: "Black Friday ads", result: "ROAS 5x", link: "https://example.com/case" }, fl);
      expect(item.status).to.equal(201);
      expect((await call("POST", "/api/me/portfolio", { title: "x", link: "javascript:alert(1)" }, fl)).status).to.equal(400);
      expect((await call("POST", "/api/me/portfolio", { title: "x" }, t.client)).status).to.equal(403);
      expect((await call("POST", "/api/me/packages", { title: "Bad", cases: 0, price_eth: "1" }, fl)).status).to.equal(400);
      const pkg = await call("POST", "/api/me/packages", { title: "2 campaigns", cases: 2, price_eth: "0.5" }, fl);
      expect(pkg.status).to.equal(201);
      expect((await call("PUT", `/api/me/packages/${pkg.body.id}`, { active: false }, fl)).body.active).to.equal(0);
      expect((await call("POST", `/api/packages/${pkg.body.id}/buy`, null, t.client)).status).to.equal(404); // hidden
      const other = await login("risky@demo.com");
      expect((await call("DELETE", `/api/me/portfolio/${item.body.id}`, null, other)).status).to.equal(404);
      expect((await call("DELETE", `/api/me/portfolio/${item.body.id}`, null, fl)).status).to.equal(200);
    });

    it("buying a package creates a job with one escrowed milestone per case", async function () {
      const fl = await login("freelancer@demo.com");
      const pkg = (await call("POST", "/api/me/packages", { title: "3 media-buying cases", cases: 3, price_eth: "1" }, fl)).body;
      expect((await call("POST", `/api/packages/${pkg.id}/buy`, null, fl)).status).to.equal(403); // only clients buy
      const bought = await call("POST", `/api/packages/${pkg.id}/buy`, null, t.client);
      expect(bought.status).to.equal(201);
      const job = (await call("GET", `/api/jobs/${bought.body.id}`, null, t.client)).body;
      expect(job.status).to.equal("in_progress");
      expect(job.package_id).to.equal(pkg.id);
      expect(await ethers.provider.getCode(job.escrow_address)).to.not.equal("0x");
      expect(job.milestones.map((m) => m.title)).to.deep.equal(["Case 1 of 3", "Case 2 of 3", "Case 3 of 3"]);
      // 1 ETH over 3 cases: the remainder goes on the last case, so the total is exact.
      const totalWei = job.milestones.reduce((s, m) => s + ethers.parseEther(m.amount_eth), 0n);
      expect(totalWei).to.equal(ethers.parseEther("1"));
      // The cases go through the normal escrow flow.
      expect((await call("POST", `/api/milestones/${job.milestones[0].id}/fund`, null, t.client)).body.status).to.equal("funded");
    });
  });

  describe("reviews, revisions, messages and search (FR17, FR20)", function () {
    it("reviews: only after completion, once per side, shown on the public profile", async function () {
      const { job, m, fl } = await fundedMilestone(t, "freelancer@demo.com", "1");
      expect((await call("POST", `/api/jobs/${job.id}/reviews`, { rating: 5 }, t.client)).status).to.equal(409); // not completed
      await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "https://example.com/w" }, fl);
      await call("POST", `/api/milestones/${m.id}/approve`, null, t.client); // whole budget paid -> completed
      expect((await call("POST", `/api/jobs/${job.id}/reviews`, { rating: 6 }, t.client)).status).to.equal(400);
      const r = await call("POST", `/api/jobs/${job.id}/reviews`, { rating: 4, comment: "Good work" }, t.client);
      expect(r.status).to.equal(201);
      expect((await call("POST", `/api/jobs/${job.id}/reviews`, { rating: 5 }, t.client)).status).to.equal(409); // once
      expect((await call("POST", `/api/jobs/${job.id}/reviews`, { rating: 5 }, fl)).status).to.equal(201); // other side
      const profile = (await call("GET", `/api/public/freelancers/${r.body.reviewee_id}`)).body;
      expect(profile.reviews).to.be.greaterThan(0);
      expect(profile.review_list[0].reviewer).to.equal("Mona"); // first name only on public pages
    });

    it("request changes sends work back; the freelancer resubmits", async function () {
      const { m, fl } = await fundedMilestone(t, "freelancer@demo.com", "0.2");
      await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "https://example.com/v1" }, fl);
      expect((await call("POST", `/api/milestones/${m.id}/request-changes`, { note: "" }, t.client)).status).to.equal(400);
      expect((await call("POST", `/api/milestones/${m.id}/request-changes`, { note: "x" }, fl)).status).to.equal(403);
      const back = await call("POST", `/api/milestones/${m.id}/request-changes`, { note: "Use the brand colours" }, t.client);
      expect(back.body.status).to.equal("funded");
      const again = await call("POST", `/api/milestones/${m.id}/submit`, { deliverable_url: "https://example.com/v2" }, fl);
      expect(again.body.milestone.status).to.equal("submitted");
      const events = (await call("GET", `/api/milestones/${m.id}`, null, t.client)).body.history.map((h) => h.event);
      expect(events.filter((e) => e === "submitted").length).to.equal(2);
      expect(events).to.include("changes_requested");
      // A flagged payment belongs to the arbiter, so it cannot be sent back.
      const risky = await fundedMilestone(t, "risky@demo.com", "0.1");
      await call("POST", `/api/milestones/${risky.m.id}/submit`, { deliverable_url: "https://example.com/r" }, risky.fl);
      expect((await call("POST", `/api/milestones/${risky.m.id}/request-changes`, { note: "x" }, t.client)).status).to.equal(409);
    });

    it("messages: client and freelancer chat, the arbiter only reads, outsiders see nothing", async function () {
      const { job, fl } = await fundedMilestone(t, "freelancer@demo.com", "0.1");
      expect((await call("POST", `/api/jobs/${job.id}/messages`, { body: "Hi, any questions?" }, t.client)).status).to.equal(201);
      const mine = (await call("GET", "/api/jobs?mine=1", null, fl)).body.find((j) => j.id === job.id);
      expect(mine.unread_messages).to.equal(1);
      const read = await call("GET", `/api/jobs/${job.id}/messages`, null, fl);
      expect(read.body.map((m) => m.body)).to.deep.equal(["Hi, any questions?"]);
      expect((await call("GET", "/api/jobs?mine=1", null, fl)).body.find((j) => j.id === job.id).unread_messages).to.equal(0);
      expect((await call("POST", `/api/jobs/${job.id}/messages`, { body: "All clear" }, fl)).status).to.equal(201);
      expect((await call("GET", `/api/jobs/${job.id}/messages`, null, t.arbiter)).body.length).to.equal(2);
      expect((await call("POST", `/api/jobs/${job.id}/messages`, { body: "x" }, t.arbiter)).status).to.equal(403);
      expect((await call("GET", `/api/jobs/${job.id}/messages`, null, await login("risky@demo.com"))).status).to.equal(404);
      expect((await call("POST", `/api/jobs/${job.id}/messages`, { body: "   " }, t.client)).status).to.equal(400);
    });

    it("search: freelancers by words, price and rating; jobs by words", async function () {
      const names = async (qs) => (await call("GET", `/api/public/freelancers?${qs}`)).body.map((f) => f.full_name);
      expect(await names("q=media%20buying")).to.include("Omar Freelancer");
      expect(await names("q=media%20buying")).to.not.include("Karim NewWallet");
      expect(await names("max_price=0.5")).to.include("Karim NewWallet");
      expect(await names("q=nothing-matches-this")).to.deep.equal([]);
      const fl = await login("freelancer@demo.com");
      const jobs = (await call("GET", "/api/jobs?q=landing%20page", null, fl)).body;
      expect(jobs.length).to.be.greaterThan(0);
      expect(jobs.every((j) => `${j.title} ${j.description}`.toLowerCase().includes("landing page"))).to.equal(true);
    });
  });
});
