// FR3 post jobs, FR4 browse jobs and send proposals, FR5 accept a proposal (deploys escrow).
const express = require("express");
const { wrap, cleanEth, cleanText, toWei, pickArbiter } = require("./util");

const MAX_BUDGET_WEI = toWei("1000000");

module.exports = function jobRoutes({ db, chain, auth, notifications }) {
  const router = express.Router();
  router.use(auth.requireAuth);

  const getJob = (id) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);

  router.get(
    "/jobs",
    wrap(async (req, res) => {
      const { id, role } = req.user;
      let rows;
      if (req.query.mine) {
        const col = role === "client" ? "client_id" : role === "freelancer" ? "freelancer_id" : "arbiter_id";
        rows = db.prepare(`SELECT * FROM jobs WHERE ${col} = ? ORDER BY id DESC`).all(id);
        // The arbiter's page shows Pause or Unpause, so it needs each contract's current state.
        if (role === "arbiter") {
          for (const j of rows) j.paused = j.escrow_address ? await chain.isPaused(j.escrow_address) : false;
        }
        for (const j of rows) j.unread_messages = unreadCount(j.id, id);
      } else {
        rows = db
          .prepare(
            `SELECT j.*, u.full_name AS client_name FROM jobs j JOIN users u ON u.id = j.client_id
             WHERE j.status = 'open' ORDER BY j.id DESC`
          )
          .all();
        // Search for freelancers on "Find work": words in the title, description or skills, and a minimum budget.
        const q = String(req.query.q || "").trim().toLowerCase();
        if (q) rows = rows.filter((j) => `${j.title} ${j.description} ${j.skills}`.toLowerCase().includes(q));
        const minBudget = cleanEth(req.query.min_budget);
        if (minBudget) rows = rows.filter((j) => toWei(j.budget_eth) >= toWei(minBudget));
      }
      res.json(rows);
    })
  );

  router.post("/jobs", auth.requireRole("client"), (req, res) => {
    const { budget_eth, skills } = req.body || {};
    const title = cleanText(req.body && req.body.title, 120);
    const description = cleanText(req.body && req.body.description, 5000);
    const budget = cleanEth(budget_eth);
    if (!title || !description || !budget) {
      return res.status(400).json({
        error: "A title (max 120 characters), a description (max 5000) and a positive budget_eth are required",
      });
    }
    if (toWei(budget) > MAX_BUDGET_WEI) return res.status(400).json({ error: "Budget cannot be more than 1,000,000 ETH" });
    const info = db
      .prepare("INSERT INTO jobs (client_id, title, description, budget_eth, skills) VALUES (?, ?, ?, ?, ?)")
      .run(req.user.id, title, description, budget, String(skills || "").trim().slice(0, 300));
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
    const { price_eth } = req.body || {};
    const cover_letter = cleanText(req.body && req.body.cover_letter, 3000);
    const price = cleanEth(price_eth);
    if (!cover_letter || !price) {
      return res.status(400).json({ error: "A cover letter (max 3000 characters) and a positive price_eth are required" });
    }
    if (db.prepare("SELECT 1 FROM proposals WHERE job_id = ? AND freelancer_id = ?").get(job.id, req.user.id)) {
      return res.status(409).json({ error: "You already sent a proposal for this job" });
    }
    const info = db
      .prepare("INSERT INTO proposals (job_id, freelancer_id, cover_letter, price_eth) VALUES (?, ?, ?, ?)")
      .run(job.id, req.user.id, cover_letter, price);
    notifications.notify(job.client_id, `New proposal on "${job.title}"`, `#/job/${job.id}`);
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
      const arbiter = pickArbiter(db);
      if (!arbiter) return res.status(503).json({ error: "No arbiter is available yet" });
      const client = db.prepare("SELECT * FROM users WHERE id = ?").get(job.client_id);
      const freelancer = db.prepare("SELECT * FROM users WHERE id = ?").get(proposal.freelancer_id);

      const { address, txHash } = await chain.deployEscrow(client, freelancer, arbiter);

      const others = db
        .prepare("SELECT freelancer_id FROM proposals WHERE job_id = ? AND id != ? AND status = 'pending'")
        .all(job.id, proposal.id);
      db.transaction(() => {
        db.prepare("UPDATE proposals SET status = 'accepted' WHERE id = ?").run(proposal.id);
        db.prepare("UPDATE proposals SET status = 'rejected' WHERE job_id = ? AND id != ?").run(job.id, proposal.id);
        db.prepare(
          "UPDATE jobs SET status = 'in_progress', freelancer_id = ?, arbiter_id = ?, escrow_address = ? WHERE id = ?"
        ).run(freelancer.id, arbiter.id, address, job.id);
      })();
      notifications.notify(freelancer.id, `Your proposal for "${job.title}" was accepted`, `#/job/${job.id}`);
      for (const o of others) notifications.notify(o.freelancer_id, `Another freelancer was chosen for "${job.title}"`, `#/job/${job.id}`);
      res.json({ ...getJob(job.id), deploy_tx: txHash });
    })
  );

  // ---- FR17: reviews ----
  // Once a job is completed, the client and the freelancer each rate the other once (1 to 5 stars).

  router.get("/jobs/:id/reviews", (req, res) => {
    const job = getJob(req.params.id);
    if (!job || ![job.client_id, job.freelancer_id, job.arbiter_id].includes(req.user.id)) {
      return res.status(404).json({ error: "Job not found" });
    }
    res.json(
      db
        .prepare(
          `SELECT r.*, u.full_name AS reviewer_name FROM reviews r JOIN users u ON u.id = r.reviewer_id
           WHERE r.job_id = ? ORDER BY r.id`
        )
        .all(job.id)
    );
  });

  router.post("/jobs/:id/reviews", (req, res) => {
    const job = getJob(req.params.id);
    const me = req.user.id;
    if (!job || (job.client_id !== me && job.freelancer_id !== me)) return res.status(404).json({ error: "Job not found" });
    if (job.status !== "completed") return res.status(409).json({ error: "You can review once the job is completed" });
    const rating = Number(req.body && req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "rating must be a whole number from 1 to 5" });
    const comment = String((req.body && req.body.comment) || "").trim();
    if (comment.length > 1000) return res.status(400).json({ error: "The comment is limited to 1000 characters" });
    if (db.prepare("SELECT 1 FROM reviews WHERE job_id = ? AND reviewer_id = ?").get(job.id, me)) {
      return res.status(409).json({ error: "You already reviewed this job" });
    }
    const reviewee = me === job.client_id ? job.freelancer_id : job.client_id;
    const info = db
      .prepare("INSERT INTO reviews (job_id, reviewer_id, reviewee_id, rating, comment) VALUES (?, ?, ?, ?, ?)")
      .run(job.id, me, reviewee, rating, comment);
    notifications.notify(reviewee, `You received a ${rating}-star review for "${job.title}"`, `#/job/${job.id}`);
    res.status(201).json(db.prepare("SELECT * FROM reviews WHERE id = ?").get(info.lastInsertRowid));
  });

  // ---- FR20: messages ----
  // The client and the freelancer of a job can write; the arbiter can read (useful in a dispute).

  function messageAccess(job, userId) {
    if (!job || !job.freelancer_id) return null;
    if (userId === job.client_id || userId === job.freelancer_id) return "write";
    if (userId === job.arbiter_id) return "read";
    return null;
  }

  function unreadCount(jobId, userId) {
    const seen = db.prepare("SELECT last_seen_id FROM message_reads WHERE job_id = ? AND user_id = ?").get(jobId, userId);
    return db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE job_id = ? AND sender_id != ? AND id > ?")
      .get(jobId, userId, seen ? seen.last_seen_id : 0).n;
  }

  router.get("/jobs/:id/messages", (req, res) => {
    const job = getJob(req.params.id);
    if (!messageAccess(job, req.user.id)) return res.status(404).json({ error: "Job not found" });
    const rows = db
      .prepare(
        `SELECT m.id, m.sender_id, m.body, m.created_at, u.full_name AS sender_name, u.role AS sender_role,
                a.id AS attachment_id, a.filename AS attachment_name, a.size AS attachment_size
         FROM messages m JOIN users u ON u.id = m.sender_id LEFT JOIN attachments a ON a.message_id = m.id
         WHERE m.job_id = ? ORDER BY m.id`
      )
      .all(job.id);
    // Reading the thread marks it as seen.
    const last = rows.length ? rows[rows.length - 1].id : 0;
    db.prepare(
      `INSERT INTO message_reads (job_id, user_id, last_seen_id) VALUES (?, ?, ?)
       ON CONFLICT (job_id, user_id) DO UPDATE SET last_seen_id = excluded.last_seen_id`
    ).run(job.id, req.user.id, last);
    res.json(rows);
  });

  router.post("/jobs/:id/messages", (req, res) => {
    const job = getJob(req.params.id);
    const access = messageAccess(job, req.user.id);
    if (!access) return res.status(404).json({ error: "Job not found" });
    if (access !== "write") return res.status(403).json({ error: "The arbiter can read this conversation but not write in it" });
    // A message is text, a file the sender uploaded to this job first (attachment_id), or both.
    const text = String((req.body && req.body.body) || "").trim();
    if (text.length > 2000) return res.status(400).json({ error: "A message is limited to 2000 characters" });
    let attachment = null;
    if (req.body && req.body.attachment_id) {
      attachment = db
        .prepare("SELECT * FROM attachments WHERE id = ? AND job_id = ? AND uploader_id = ? AND milestone_id IS NULL AND message_id IS NULL")
        .get(req.body.attachment_id, job.id, req.user.id);
      if (!attachment) return res.status(404).json({ error: "File not found, or already sent" });
    }
    if (!text && !attachment) return res.status(400).json({ error: "Write a message or attach a file" });
    const info = db.prepare("INSERT INTO messages (job_id, sender_id, body) VALUES (?, ?, ?)").run(job.id, req.user.id, text);
    if (attachment) db.prepare("UPDATE attachments SET message_id = ? WHERE id = ?").run(info.lastInsertRowid, attachment.id);
    const other = req.user.id === job.client_id ? job.freelancer_id : job.client_id;
    notifications.notify(other, `New message on "${job.title}"`, `#/job/${job.id}`);
    res.status(201).json(db.prepare("SELECT * FROM messages WHERE id = ?").get(info.lastInsertRowid));
  });

  return router;
};
