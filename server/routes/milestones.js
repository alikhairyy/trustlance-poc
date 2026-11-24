// FR6 add milestones, FR7 fund, FR8 submit (+ FR9/FR10 risk check), FR11 approve / dispute,
// FR12 appeal, FR15 milestone history.
const express = require("express");
const { wrap, cleanEth, cleanText, toWei, isWebUrl } = require("./util");

module.exports = function milestoneRoutes({ db, chain, risk, auth, notifications }) {
  const router = express.Router();
  router.use(auth.requireAuth);

  const user = (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  const logEvent = (milestoneId, actorId, event, detail = "", txHash = null) =>
    db
      .prepare("INSERT INTO milestone_events (milestone_id, actor_id, event, detail, tx_hash) VALUES (?, ?, ?, ?, ?)")
      .run(milestoneId, actorId, event, detail, txHash);

  // Copies the contract's state into the database: the chain is the source of truth for money.
  async function sync(m, job) {
    const s = await chain.readMilestone(job.escrow_address, m.chain_index);
    db.prepare("UPDATE milestones SET status = ?, risk_flagged = ?, appealed = ?, review_deadline = ? WHERE id = ?").run(
      s.status,
      s.riskFlagged ? 1 : 0,
      s.appealed ? 1 : 0,
      s.reviewDeadline,
      m.id
    );
    return db.prepare("SELECT * FROM milestones WHERE id = ?").get(m.id);
  }

  // Loads milestone + job and checks the caller has the right role on this job.
  function load(req, res, role) {
    const m = db.prepare("SELECT * FROM milestones WHERE id = ?").get(req.params.id);
    const job = m && db.prepare("SELECT * FROM jobs WHERE id = ?").get(m.job_id);
    if (!job) {
      res.status(404).json({ error: "Milestone not found" });
      return null;
    }
    const owner = { client: job.client_id, freelancer: job.freelancer_id, arbiter: job.arbiter_id }[role];
    if (req.user.role !== role || owner !== req.user.id) {
      res.status(403).json({ error: `Only this job's ${role} can do this` });
      return null;
    }
    if (m.status === "cancelled") {
      res.status(409).json({ error: "This milestone was cancelled" });
      return null;
    }
    return { m, job };
  }

  // Maps contract errors to HTTP answers the UI can show.
  function chainError(res, err) {
    const map = {
      ReleaseHeldForReview: [409, "Payment is held for arbiter review (risk flag, up to 7 days)"],
      WrongStatus: [409, "The milestone is not in the right state for this action"],
      AlreadyAppealed: [409, "This flag was already appealed"],
      NotFlagged: [409, "Only a flagged milestone can be appealed"],
      ContractPaused: [423, "This job's contract is paused by the arbiter"],
      TextTooLong: [400, "Text is too long (max 512 bytes)"],
      NotPaused: [409, "This job's contract is not paused"],
      NotUnderReview: [409, "The arbiter can only decide flagged or disputed milestones"],
    };
    const [status, message] = map[err.contractError] || [502, `Blockchain error: ${err.message}`];
    return res.status(status).json({ error: message, contract_error: err.contractError || null });
  }

  router.post(
    "/jobs/:id/milestones",
    auth.requireRole("client"),
    wrap(async (req, res) => {
      const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
      if (!job || job.client_id !== req.user.id) return res.status(404).json({ error: "Job not found" });
      if (job.status !== "in_progress") return res.status(409).json({ error: "Accept a proposal before adding milestones" });
      const title = cleanText(req.body && req.body.title, 120);
      const amount = cleanEth(req.body && req.body.amount_eth);
      if (!title || !amount) {
        return res.status(400).json({ error: "A title (max 120 characters) and a positive amount_eth are required" });
      }
      // Milestones cannot add up to more than the job's budget (refunded and cancelled ones do not count).
      const used = db
        .prepare("SELECT amount_eth FROM milestones WHERE job_id = ? AND status NOT IN ('refunded', 'cancelled')")
        .all(job.id)
        .reduce((sum, row) => sum + toWei(row.amount_eth), 0n);
      if (used + toWei(amount) > toWei(job.budget_eth)) {
        return res.status(400).json({ error: `Milestones would exceed the job budget of ${job.budget_eth} ETH` });
      }
      try {
        const { chainIndex, txHash } = await chain.addMilestone(job.escrow_address, user(req.user.id), amount);
        const info = db
          .prepare("INSERT INTO milestones (job_id, chain_index, title, amount_eth) VALUES (?, ?, ?, ?)")
          .run(job.id, chainIndex, title, amount);
        logEvent(info.lastInsertRowid, req.user.id, "created", `${amount} ETH`, txHash);
        res.status(201).json(db.prepare("SELECT * FROM milestones WHERE id = ?").get(info.lastInsertRowid));
      } catch (err) {
        chainError(res, err);
      }
    })
  );

  router.get("/milestones/:id", (req, res) => {
    const m = db.prepare("SELECT * FROM milestones WHERE id = ?").get(req.params.id);
    const job = m && db.prepare("SELECT * FROM jobs WHERE id = ?").get(m.job_id);
    if (!job || ![job.client_id, job.freelancer_id, job.arbiter_id].includes(req.user.id)) {
      return res.status(404).json({ error: "Milestone not found" });
    }
    res.json({
      ...m,
      job: { id: job.id, title: job.title, escrow_address: job.escrow_address },
      risk: db.prepare("SELECT * FROM risk_assessments WHERE milestone_id = ? ORDER BY id").all(m.id),
      history: db
        .prepare(
          `SELECT e.event, e.detail, e.tx_hash, e.created_at, COALESCE(u.full_name, 'Risk engine') AS actor
           FROM milestone_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.milestone_id = ? ORDER BY e.id`
        )
        .all(m.id),
    });
  });

  router.post(
    "/milestones/:id/fund",
    wrap(async (req, res) => {
      const ctx = load(req, res, "client");
      if (!ctx) return;
      try {
        const { txHash } = await chain.fund(ctx.job.escrow_address, user(req.user.id), ctx.m.chain_index, ctx.m.amount_eth);
        logEvent(ctx.m.id, req.user.id, "funded", `${ctx.m.amount_eth} ETH locked in escrow`, txHash);
        notifications.notify(ctx.job.freelancer_id, `Milestone "${ctx.m.title}" is funded. You can start.`);
        res.json(await sync(ctx.m, ctx.job));
      } catch (err) {
        chainError(res, err);
      }
    })
  );

  router.post(
    "/milestones/:id/submit",
    wrap(async (req, res) => {
      const ctx = load(req, res, "freelancer");
      if (!ctx) return;
      const { note } = req.body || {};
      const deliverable_url = String((req.body && req.body.deliverable_url) || "").trim();
      if (!isWebUrl(deliverable_url) || deliverable_url.length > 2000) {
        return res.status(400).json({ error: "The deliverable must be a web link starting with http:// or https://" });
      }
      if (String(note || "").length > 2000) return res.status(400).json({ error: "The note is limited to 2000 characters" });
      const before = await chain.readMilestone(ctx.job.escrow_address, ctx.m.chain_index);
      if (before.status !== "funded") {
        return res.status(409).json({ error: "The milestone is not in the right state for this action", contract_error: "WrongStatus" });
      }

      // FR9: score the payout wallet BEFORE the work is marked submitted on-chain. If the work
      // were submitted first, the client could approve it while the score is still being computed,
      // before a high-risk flag lands. Now submit and flag are sent back to back.
      let assessment;
      try {
        assessment = await risk.assessPayout({ caseId: `milestone-${ctx.m.id}`, freelancer: user(req.user.id) });
      } catch (err) {
        // Fail safe: if the engine is down, hold for a human instead of releasing unchecked.
        assessment = {
          score: 1,
          band: "high",
          action: "hold_for_review",
          reason: "Risk check unavailable, so the payment is held for arbiter review.",
          modelVersion: "unavailable",
          auditHash: null,
        };
      }

      let txHash;
      try {
        ({ txHash } = await chain.submit(ctx.job.escrow_address, user(req.user.id), ctx.m.chain_index));
      } catch (err) {
        return chainError(res, err);
      }
      db.prepare("UPDATE milestones SET deliverable_url = ?, submission_note = ? WHERE id = ?").run(
        deliverable_url,
        note || "",
        ctx.m.id
      );
      logEvent(ctx.m.id, req.user.id, "submitted", deliverable_url, txHash);

      // FR10: hold the payment on-chain if the risk is high.
      db.prepare(
        `INSERT INTO risk_assessments (milestone_id, score, band, action, reason, model_version, audit_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(ctx.m.id, assessment.score, assessment.band, assessment.action, assessment.reason, assessment.modelVersion, assessment.auditHash);
      logEvent(ctx.m.id, null, "risk_scored", `${assessment.score} (${assessment.band}): ${assessment.action}`);

      if (assessment.action === "hold_for_review") {
        const flagged = await chain.flag(ctx.job.escrow_address, ctx.m.chain_index, assessment.reason);
        logEvent(ctx.m.id, null, "risk_flagged", assessment.reason, flagged.txHash);
        notifications.notify(ctx.job.arbiter_id, `Milestone "${ctx.m.title}" was flagged for review`);
        notifications.notify(ctx.job.freelancer_id, `Milestone "${ctx.m.title}" is held for review. You can appeal.`);
      }
      notifications.notify(ctx.job.client_id, `Work submitted for "${ctx.m.title}"`);
      res.json({ milestone: await sync(ctx.m, ctx.job), risk: assessment });
    })
  );

  // Open = not yet settled. Cancelled milestones are ignored.
  const openMilestones = (jobId) =>
    db.prepare("SELECT COUNT(*) AS n FROM milestones WHERE job_id = ? AND status NOT IN ('released', 'refunded', 'cancelled')").get(jobId).n;

  // A job completes by itself only when nothing is open AND the whole budget has been paid out.
  // Otherwise (for example after milestone 1 of 2) it stays in progress, so the client can add the
  // next milestone, or close the job early with POST /jobs/:id/complete.
  async function finishIfDone(job) {
    if (openMilestones(job.id) > 0) return;
    const paid = db
      .prepare("SELECT amount_eth FROM milestones WHERE job_id = ? AND status = 'released'")
      .all(job.id)
      .reduce((sum, row) => sum + toWei(row.amount_eth), 0n);
    if (paid >= toWei(job.budget_eth)) db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run(job.id);
  }

  // The client closes the job when the work is finished, even if not all of the budget was used.
  router.post("/jobs/:id/complete", auth.requireRole("client"), (req, res) => {
    const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
    if (!job || job.client_id !== req.user.id) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "in_progress") return res.status(409).json({ error: "Only a job in progress can be closed" });
    if (openMilestones(job.id) > 0) {
      return res.status(409).json({ error: "Settle or cancel every open milestone before closing the job" });
    }
    db.prepare("UPDATE jobs SET status = 'completed' WHERE id = ?").run(job.id);
    notifications.notify(job.freelancer_id, `The client closed the job "${job.title}"`);
    res.json(db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id));
  });

  // The client can cancel a milestone that was never funded, so it does not block the job from finishing.
  // Nothing was paid into the contract for it, so this only changes the platform's records.
  router.post(
    "/milestones/:id/cancel",
    wrap(async (req, res) => {
      const ctx = load(req, res, "client");
      if (!ctx) return;
      const s = await chain.readMilestone(ctx.job.escrow_address, ctx.m.chain_index);
      if (s.status !== "pending") return res.status(409).json({ error: "Only a milestone that was never funded can be cancelled" });
      db.prepare("UPDATE milestones SET status = 'cancelled' WHERE id = ?").run(ctx.m.id);
      logEvent(ctx.m.id, req.user.id, "cancelled", "Cancelled before funding");
      await finishIfDone(ctx.job);
      res.json(db.prepare("SELECT * FROM milestones WHERE id = ?").get(ctx.m.id));
    })
  );

  router.post(
    "/milestones/:id/approve",
    wrap(async (req, res) => {
      const ctx = load(req, res, "client");
      if (!ctx) return;
      try {
        const { txHash } = await chain.approve(ctx.job.escrow_address, user(req.user.id), ctx.m.chain_index);
        logEvent(ctx.m.id, req.user.id, "approved_released", `${ctx.m.amount_eth} ETH paid to freelancer`, txHash);
        notifications.notify(ctx.job.freelancer_id, `Payment released for "${ctx.m.title}"`);
        const m = await sync(ctx.m, ctx.job);
        await finishIfDone(ctx.job);
        res.json(m);
      } catch (err) {
        chainError(res, err);
      }
    })
  );

  router.post(
    "/milestones/:id/dispute",
    wrap(async (req, res) => {
      const ctx = load(req, res, "client");
      if (!ctx) return;
      try {
        const { txHash } = await chain.dispute(ctx.job.escrow_address, user(req.user.id), ctx.m.chain_index);
        logEvent(ctx.m.id, req.user.id, "disputed", (req.body && req.body.reason) || "", txHash);
        notifications.notify(ctx.job.arbiter_id, `Milestone "${ctx.m.title}" was disputed`);
        res.json(await sync(ctx.m, ctx.job));
      } catch (err) {
        chainError(res, err);
      }
    })
  );

  // The client sends submitted work back with a note; the freelancer fixes it and submits again
  // (which runs the risk check again). The money stays locked in escrow the whole time.
  router.post(
    "/milestones/:id/request-changes",
    wrap(async (req, res) => {
      const ctx = load(req, res, "client");
      if (!ctx) return;
      const note = cleanText(req.body && req.body.note, 1000);
      if (!note) return res.status(400).json({ error: "Say what should change (max 1000 characters)" });
      try {
        const { txHash } = await chain.requestChanges(ctx.job.escrow_address, user(req.user.id), ctx.m.chain_index);
        logEvent(ctx.m.id, req.user.id, "changes_requested", note, txHash);
        notifications.notify(ctx.job.freelancer_id, `The client asked for changes on "${ctx.m.title}": ${note}`);
        res.json(await sync(ctx.m, ctx.job));
      } catch (err) {
        chainError(res, err);
      }
    })
  );

  router.post(
    "/milestones/:id/appeal",
    wrap(async (req, res) => {
      const ctx = load(req, res, "freelancer");
      if (!ctx) return;
      const note = (req.body && req.body.note) || "";
      if (!note) return res.status(400).json({ error: "An appeal note is required" });
      try {
        const { txHash } = await chain.appeal(ctx.job.escrow_address, user(req.user.id), ctx.m.chain_index, note);
        logEvent(ctx.m.id, req.user.id, "appealed", note, txHash);
        notifications.notify(ctx.job.arbiter_id, `The freelancer appealed the flag on "${ctx.m.title}"`);
        res.json(await sync(ctx.m, ctx.job));
      } catch (err) {
        chainError(res, err);
      }
    })
  );

  return { router, sync, logEvent, chainError, finishIfDone };
};
