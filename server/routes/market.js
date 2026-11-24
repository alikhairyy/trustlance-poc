// Freelancer portfolios and packages.
//
// Public (no login): the freelancer directory, each freelancer's profile page with their
// portfolio and packages, and the featured packages on the landing page.
// Freelancers manage their own portfolio items and packages.
// Clients buy a package: that creates a job with one escrowed milestone per case,
// with no proposal step (the package's price and scope are already agreed).
const express = require("express");
const { wrap, cleanEth, cleanText, isWebUrl, toWei, fromWei, pickArbiter } = require("./util");

const MAX_PORTFOLIO = 30;
const MAX_PACKAGES = 10;

module.exports = function marketRoutes({ db, chain, auth, notifications, milestoneHelpers }) {
  const { logEvent } = milestoneHelpers;
  const router = express.Router();

  // ---- public ----

  const publicProfile = (u) => ({
    id: u.id,
    full_name: u.full_name,
    bio: u.bio || "",
    skills: u.skills || "",
    member_since: u.created_at,
  });

  const completedJobs = (freelancerId) =>
    db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE freelancer_id = ? AND status = 'completed'").get(freelancerId).n;

  const activePackages = (freelancerId) =>
    db.prepare("SELECT * FROM packages WHERE freelancer_id = ? AND active = 1 ORDER BY id").all(freelancerId);

  router.get("/public/freelancers", (req, res) => {
    const rows = db.prepare("SELECT * FROM users WHERE role = 'freelancer' ORDER BY id").all();
    res.json(
      rows.map((u) => ({
        ...publicProfile(u),
        portfolio_count: db.prepare("SELECT COUNT(*) AS n FROM portfolio_items WHERE freelancer_id = ?").get(u.id).n,
        packages: activePackages(u.id).length,
        completed_jobs: completedJobs(u.id),
        from_eth: (() => {
          const prices = activePackages(u.id).map((p) => toWei(p.price_eth));
          return prices.length ? fromWei(prices.reduce((a, b) => (b < a ? b : a))) : null;
        })(),
      }))
    );
  });

  router.get("/public/freelancers/:id", (req, res) => {
    const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'freelancer'").get(req.params.id);
    if (!u) return res.status(404).json({ error: "Freelancer not found" });
    res.json({
      ...publicProfile(u),
      completed_jobs: completedJobs(u.id),
      portfolio: db.prepare("SELECT * FROM portfolio_items WHERE freelancer_id = ? ORDER BY id DESC").all(u.id),
      packages: activePackages(u.id),
    });
  });

  router.get("/public/packages", (req, res) => {
    res.json(
      db
        .prepare(
          `SELECT p.*, u.full_name AS freelancer_name FROM packages p JOIN users u ON u.id = p.freelancer_id
           WHERE p.active = 1 ORDER BY p.id LIMIT 12`
        )
        .all()
    );
  });

  // ---- a freelancer's own portfolio ----

  router.get("/me/portfolio", auth.requireAuth, auth.requireRole("freelancer"), (req, res) => {
    res.json(db.prepare("SELECT * FROM portfolio_items WHERE freelancer_id = ? ORDER BY id DESC").all(req.user.id));
  });

  router.post("/me/portfolio", auth.requireAuth, auth.requireRole("freelancer"), (req, res) => {
    const b = req.body || {};
    const title = cleanText(b.title, 120);
    const description = String(b.description ?? "").trim();
    const link = String(b.link ?? "").trim();
    const result = String(b.result ?? "").trim();
    if (!title) return res.status(400).json({ error: "A title is required (max 120 characters)" });
    if (description.length > 2000 || result.length > 120) {
      return res.status(400).json({ error: "Description is limited to 2000 characters and the result to 120" });
    }
    if (link && (!isWebUrl(link) || link.length > 2000)) {
      return res.status(400).json({ error: "The link must start with http:// or https://" });
    }
    const count = db.prepare("SELECT COUNT(*) AS n FROM portfolio_items WHERE freelancer_id = ?").get(req.user.id).n;
    if (count >= MAX_PORTFOLIO) return res.status(409).json({ error: `A portfolio holds at most ${MAX_PORTFOLIO} items` });
    const info = db
      .prepare("INSERT INTO portfolio_items (freelancer_id, title, description, link, result) VALUES (?, ?, ?, ?, ?)")
      .run(req.user.id, title, description, link, result);
    res.status(201).json(db.prepare("SELECT * FROM portfolio_items WHERE id = ?").get(info.lastInsertRowid));
  });

  router.delete("/me/portfolio/:id", auth.requireAuth, auth.requireRole("freelancer"), (req, res) => {
    const item = db.prepare("SELECT * FROM portfolio_items WHERE id = ?").get(req.params.id);
    if (!item || item.freelancer_id !== req.user.id) return res.status(404).json({ error: "Portfolio item not found" });
    db.prepare("DELETE FROM portfolio_items WHERE id = ?").run(item.id);
    res.json({ deleted: item.id });
  });

  // ---- a freelancer's own packages ----

  router.get("/me/packages", auth.requireAuth, auth.requireRole("freelancer"), (req, res) => {
    res.json(db.prepare("SELECT * FROM packages WHERE freelancer_id = ? ORDER BY id").all(req.user.id));
  });

  router.post("/me/packages", auth.requireAuth, auth.requireRole("freelancer"), (req, res) => {
    const b = req.body || {};
    const title = cleanText(b.title, 120);
    const description = String(b.description ?? "").trim();
    const price = cleanEth(b.price_eth);
    const cases = Number(b.cases);
    const days = b.delivery_days === undefined || b.delivery_days === "" ? 30 : Number(b.delivery_days);
    if (!title || !price) return res.status(400).json({ error: "A title (max 120 characters) and a positive price_eth are required" });
    if (!Number.isInteger(cases) || cases < 1 || cases > 12) return res.status(400).json({ error: "cases must be a whole number from 1 to 12" });
    if (!Number.isInteger(days) || days < 1 || days > 365) return res.status(400).json({ error: "delivery_days must be from 1 to 365" });
    if (description.length > 2000) return res.status(400).json({ error: "Description is limited to 2000 characters" });
    if (toWei(price) > toWei("1000000")) return res.status(400).json({ error: "Price cannot be more than 1,000,000 ETH" });
    const count = db.prepare("SELECT COUNT(*) AS n FROM packages WHERE freelancer_id = ? AND active = 1").get(req.user.id).n;
    if (count >= MAX_PACKAGES) return res.status(409).json({ error: `At most ${MAX_PACKAGES} active packages` });
    const info = db
      .prepare("INSERT INTO packages (freelancer_id, title, description, cases, price_eth, delivery_days) VALUES (?, ?, ?, ?, ?, ?)")
      .run(req.user.id, title, description, cases, price, days);
    res.status(201).json(db.prepare("SELECT * FROM packages WHERE id = ?").get(info.lastInsertRowid));
  });

  // Turn a package off or on. Jobs already bought from it are not affected.
  router.put("/me/packages/:id", auth.requireAuth, auth.requireRole("freelancer"), (req, res) => {
    const pkg = db.prepare("SELECT * FROM packages WHERE id = ?").get(req.params.id);
    if (!pkg || pkg.freelancer_id !== req.user.id) return res.status(404).json({ error: "Package not found" });
    const active = req.body && req.body.active;
    if (typeof active !== "boolean") return res.status(400).json({ error: "Send active: true or false" });
    db.prepare("UPDATE packages SET active = ? WHERE id = ?").run(active ? 1 : 0, pkg.id);
    res.json(db.prepare("SELECT * FROM packages WHERE id = ?").get(pkg.id));
  });

  // ---- a client buys a package ----

  router.post(
    "/packages/:id/buy",
    auth.requireAuth,
    auth.requireRole("client"),
    wrap(async (req, res) => {
      const pkg = db.prepare("SELECT * FROM packages WHERE id = ? AND active = 1").get(req.params.id);
      if (!pkg) return res.status(404).json({ error: "Package not found or no longer offered" });
      const arbiter = pickArbiter(db);
      if (!arbiter) return res.status(503).json({ error: "No arbiter is available yet" });
      const client = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
      const freelancer = db.prepare("SELECT * FROM users WHERE id = ?").get(pkg.freelancer_id);

      // One escrow contract for the job, then one milestone per case. The price is split
      // evenly in wei; any remainder goes on the last case so the total is exact.
      const { address } = await chain.deployEscrow(client, freelancer, arbiter);
      const total = toWei(pkg.price_eth);
      const each = total / BigInt(pkg.cases);
      const amounts = Array.from({ length: pkg.cases }, (_, i) => (i === pkg.cases - 1 ? total - each * BigInt(pkg.cases - 1) : each));

      const job = db
        .prepare(
          `INSERT INTO jobs (client_id, title, description, budget_eth, skills, status, freelancer_id, arbiter_id, escrow_address, package_id)
           VALUES (?, ?, ?, ?, ?, 'in_progress', ?, ?, ?, ?)`
        )
        .run(client.id, pkg.title, pkg.description || pkg.title, pkg.price_eth, freelancer.skills || "", freelancer.id, arbiter.id, address, pkg.id);
      const jobId = job.lastInsertRowid;

      for (let i = 0; i < amounts.length; i++) {
        const amount = fromWei(amounts[i]);
        const { chainIndex, txHash } = await chain.addMilestone(address, client, amount);
        const m = db
          .prepare("INSERT INTO milestones (job_id, chain_index, title, amount_eth) VALUES (?, ?, ?, ?)")
          .run(jobId, chainIndex, `Case ${i + 1} of ${pkg.cases}`, amount);
        logEvent(m.lastInsertRowid, client.id, "created", `${amount} ETH (package "${pkg.title}")`, txHash);
      }
      notifications.notify(freelancer.id, `${client.full_name} bought your package "${pkg.title}"`);
      res.status(201).json(db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId));
    })
  );

  return router;
};
