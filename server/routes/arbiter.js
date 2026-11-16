// FR13 arbiter queue and decisions, FR14 emergency pause.
const express = require("express");
const { wrap } = require("./util");

module.exports = function arbiterRoutes({ db, chain, auth, notifications, milestoneHelpers }) {
  const { sync, logEvent, chainError, finishIfDone } = milestoneHelpers;
  const router = express.Router();
  router.use(auth.requireAuth, auth.requireRole("arbiter"));

  const me = (req) => db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);

  // Flagged or disputed milestones on this arbiter's jobs, with the latest risk reason.
  router.get("/arbiter/queue", (req, res) => {
    const rows = db
      .prepare(
        `SELECT m.*, j.title AS job_title, j.escrow_address,
                c.full_name AS client_name, f.full_name AS freelancer_name,
                (SELECT reason FROM risk_assessments r WHERE r.milestone_id = m.id ORDER BY r.id DESC LIMIT 1) AS risk_reason,
                (SELECT score  FROM risk_assessments r WHERE r.milestone_id = m.id ORDER BY r.id DESC LIMIT 1) AS risk_score,
                (SELECT detail FROM milestone_events e WHERE e.milestone_id = m.id AND e.event = 'appealed' ORDER BY e.id DESC LIMIT 1) AS appeal_note
         FROM milestones m JOIN jobs j ON j.id = m.job_id
         JOIN users c ON c.id = j.client_id JOIN users f ON f.id = j.freelancer_id
         WHERE j.arbiter_id = ? AND (m.status = 'disputed' OR (m.status = 'submitted' AND m.risk_flagged = 1))
         ORDER BY m.review_deadline IS NULL, m.review_deadline`
      )
      .all(req.user.id);
    res.json(rows);
  });

  function decide(kind) {
    return wrap(async (req, res) => {
      const m = db.prepare("SELECT * FROM milestones WHERE id = ?").get(req.params.id);
      const job = m && db.prepare("SELECT * FROM jobs WHERE id = ?").get(m.job_id);
      if (!job || job.arbiter_id !== req.user.id) return res.status(404).json({ error: "Milestone not found" });
      try {
        const fn = kind === "release" ? chain.arbiterRelease : chain.arbiterRefund;
        const { txHash } = await fn(job.escrow_address, me(req), m.chain_index);
        const note = (req.body && req.body.note) || "";
        logEvent(m.id, req.user.id, kind === "release" ? "arbiter_released" : "arbiter_refunded", note, txHash);
        notifications.notify(job.client_id, `Arbiter decision on "${m.title}": ${kind}`);
        notifications.notify(job.freelancer_id, `Arbiter decision on "${m.title}": ${kind}`);
        const updated = await sync(m, job);
        await finishIfDone(job);
        res.json(updated);
      } catch (err) {
        chainError(res, err);
      }
    });
  }

  router.post("/arbiter/milestones/:id/release", decide("release"));
  router.post("/arbiter/milestones/:id/refund", decide("refund"));

  function pauseRoute(paused) {
    return wrap(async (req, res) => {
      const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
      if (!job || job.arbiter_id !== req.user.id || !job.escrow_address) {
        return res.status(404).json({ error: "Job not found" });
      }
      try {
        await (paused ? chain.pause : chain.unpause)(job.escrow_address, me(req));
        res.json({ job_id: job.id, paused: await chain.isPaused(job.escrow_address) });
      } catch (err) {
        chainError(res, err);
      }
    });
  }

  router.post("/arbiter/jobs/:id/pause", pauseRoute(true));
  router.post("/arbiter/jobs/:id/unpause", pauseRoute(false));

  return router;
};
