// FR3 post jobs, FR4 browse jobs and send proposals, FR5 accept a proposal (deploys escrow).
const express = require("express");
const { wrap, cleanEth } = require("./util");

module.exports = function jobRoutes({ db, chain, auth, notifications }) {
  const router = express.Router();
  router.use(auth.requireAuth);

  const getJob = (id) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);

  router.get("/jobs", (req, res) => {
    const { id, role } = req.user;
    let rows;
    if (req.query.mine) {
      const col = role === "client" ? "client_id" : role === "freelancer" ? "freelancer_id" : "arbiter_id";
      rows = db.prepare(`SELECT * FROM jobs WHERE ${col} = ? ORDER BY id DESC`).all(id);
    } else {
      rows = db
        .prepare(
          `SELECT j.*, u.full_name AS client_name FROM jobs j JOIN users u ON u.id = j.client_id
           WHERE j.status = 'open' ORDER BY j.id DESC`
        )
        .all();
    }
    res.json(rows);
  });

  router.post("/jobs", auth.requireRole("client"), (req, res) => {
    const { title, description, budget_eth, skills } = req.body || {};
    const budget = cleanEth(budget_eth);
    if (!title || !description || !budget) {
      return res.status(400).json({ error: "title, description and a positive budget_eth are required" });
    }
    const info = db
      .prepare("INSERT INTO jobs (client_id, title, description, budget_eth, skills) VALUES (?, ?, ?, ?, ?)")
      .run(req.user.id, title, description, budget, skills || "");
    res.status(201).json(getJob(info.lastInsertRowid));
  });

  router.get("/jobs/:id", (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });
    const milestones = db.prepare("SELECT * FROM milestones WHERE job_id = ? ORDER BY chain_index").all(job.id);
    const involved = [job.client_id, job.freelancer_id, job.arbiter_id].includes(req.user.id);
    res.json({ ...job, milestones: involved ? milestones : [] });
  });

  // ---- proposals ----
  router.post("/jobs/:id/proposals", auth.requireRole("freelancer"), (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.status !== "open") return res.status(404).json({ error: "Open job not found" });
    const { cover_letter, price_eth } = req.body || {};
    const price = cleanEth(price_eth);
    if (!cover_letter || !price) return res.status(400).json({ error: "cover_letter and a positive price_eth are required" });
    if (db.prepare("SELECT 1 FROM proposals WHERE job_id = ? AND freelancer_id = ?").get(job.id, req.user.id)) {
      return res.status(409).json({ error: "You already sent a proposal for this job" });
    }
    const info = db
      .prepare("INSERT INTO proposals (job_id, freelancer_id, cover_letter, price_eth) VALUES (?, ?, ?, ?)")
      .run(job.id, req.user.id, cover_letter, price);
    notifications.notify(job.client_id, `New proposal on "${job.title}"`);
    res.status(201).json(db.prepare("SELECT * FROM proposals WHERE id = ?").get(info.lastInsertRowid));
  });

  router.get("/jobs/:id/proposals", auth.requireRole("client"), (req, res) => {
    const job = getJob(req.params.id);
    if (!job || job.client_id !== req.user.id) return res.status(404).json({ error: "Job not found" });
    res.json(
      db
        .prepare(
          `SELECT p.*, u.full_name AS freelancer_name, u.skills AS freelancer_skills
           FROM proposals p JOIN users u ON u.id = p.freelancer_id WHERE p.job_id = ? ORDER BY p.id`
        )
        .all(job.id)
    );
  });

  router.post(
    "/proposals/:id/accept",
    auth.requireRole("client"),
    wrap(async (req, res) => {
      const proposal = db.prepare("SELECT * FROM proposals WHERE id = ?").get(req.params.id);
      const job = proposal && getJob(proposal.job_id);
      if (!job || job.client_id !== req.user.id) return res.status(404).json({ error: "Proposal not found" });
      if (job.status !== "open" || proposal.status !== "pending") {
        return res.status(409).json({ error: "This job already has a freelancer" });
      }
      // The platform assigns an arbiter. For now: the arbiter with the fewest active jobs.
      const arbiter = db
        .prepare(
          `SELECT u.* FROM users u LEFT JOIN jobs j ON j.arbiter_id = u.id AND j.status = 'in_progress'
           WHERE u.role = 'arbiter' GROUP BY u.id ORDER BY COUNT(j.id), u.id LIMIT 1`
        )
        .get();
      if (!arbiter) return res.status(503).json({ error: "No arbiter is available yet" });
      const client = db.prepare("SELECT * FROM users WHERE id = ?").get(job.client_id);
      const freelancer = db.prepare("SELECT * FROM users WHERE id = ?").get(proposal.freelancer_id);

      const { address, txHash } = await chain.deployEscrow(client, freelancer, arbiter);

      db.transaction(() => {
        db.prepare("UPDATE proposals SET status = 'accepted' WHERE id = ?").run(proposal.id);
        db.prepare("UPDATE proposals SET status = 'rejected' WHERE job_id = ? AND id != ?").run(job.id, proposal.id);
        db.prepare(
          "UPDATE jobs SET status = 'in_progress', freelancer_id = ?, arbiter_id = ?, escrow_address = ? WHERE id = ?"
        ).run(freelancer.id, arbiter.id, address, job.id);
      })();
      notifications.notify(freelancer.id, `Your proposal for "${job.title}" was accepted`);
      res.json({ ...getJob(job.id), deploy_tx: txHash });
    })
  );

  // FR17 ratings: STUB. The reviews table exists; the rules (only after completion,
  // one review per side, aggregate score on profile) are not implemented yet.
  router.post("/jobs/:id/reviews", (req, res) => {
    res.status(501).json({ error: "Ratings are not implemented yet (FR17)" });
  });

  return router;
};
