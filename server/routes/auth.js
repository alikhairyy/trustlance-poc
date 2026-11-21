// FR1 register / login, FR2 profile, FR16 notifications list.
const express = require("express");
const { hashPassword, verifyPassword } = require("../services/passwords");
const { wrap, publicUser, cleanText } = require("./util");

const ROLES = ["client", "freelancer", "arbiter"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Emails are compared without case, so Client@demo.com and client@demo.com are one account.
const normEmail = (value) => String(value ?? "").trim().toLowerCase();

module.exports = function authRoutes({ db, chain, auth }) {
  const router = express.Router();

  router.post(
    "/auth/register",
    wrap(async (req, res) => {
      const { password, role } = req.body || {};
      const email = normEmail(req.body && req.body.email);
      const full_name = cleanText(req.body && req.body.full_name, 100);
      if (!email || !password || !full_name || !ROLES.includes(role)) {
        return res.status(400).json({ error: "email, password, full_name and a valid role are required" });
      }
      if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address" });
      if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
      if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
        return res.status(409).json({ error: "Email already registered" });
      }
      // DEV ONLY: give the user the next local-chain account as their wallet (see services/chain.js).
      const next = (db.prepare("SELECT MAX(dev_wallet_index) AS m FROM users").get().m || 0) + 1;
      let wallet;
      try {
        wallet = await chain.devWallet(next);
      } catch {
        return res.status(503).json({ error: "No more accounts can be created on the local test chain. Restart the app to reset it." });
      }
      const info = db
        .prepare(
          `INSERT INTO users (email, password_hash, role, full_name, wallet_address, dev_wallet_index)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(email, hashPassword(password), role, full_name, wallet.address, next);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(info.lastInsertRowid);
      res.status(201).json({ token: auth.sign(user), user: publicUser(user) });
    })
  );

  router.post("/auth/login", (req, res) => {
    const { password } = req.body || {};
    const email = normEmail(req.body && req.body.email);
    const user = email && db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user || !password || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Wrong email or password" });
    }
    res.json({ token: auth.sign(user), user: publicUser(user) });
  });

  router.get(
    "/users/me",
    auth.requireAuth,
    wrap(async (req, res) => {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
      res.json({ ...publicUser(user), balance_eth: await chain.balanceEth(user.wallet_address) });
    })
  );

  router.put("/users/me", auth.requireAuth, (req, res) => {
    const { full_name, bio, skills, dev_risk_profile } = req.body || {};
    // The dataset wallet that stands in for a user's history (DEV ONLY, see walletFeatures.js) is
    // fixed when the account is seeded. Users cannot pick it, or a risky user could choose "legit".
    if (dev_risk_profile !== undefined) {
      return res.status(403).json({ error: "The risk profile cannot be changed by the user" });
    }
    const name = full_name === undefined ? undefined : cleanText(full_name, 100);
    if (full_name !== undefined && !name) return res.status(400).json({ error: "Full name cannot be empty (max 100 characters)" });
    if (String(bio ?? "").length > 2000 || String(skills ?? "").length > 300) {
      return res.status(400).json({ error: "Bio is limited to 2000 characters and skills to 300" });
    }
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    db.prepare("UPDATE users SET full_name = ?, bio = ?, skills = ? WHERE id = ?").run(
      name ?? current.full_name,
      bio ?? current.bio,
      skills ?? current.skills,
      req.user.id
    );
    res.json(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)));
  });

  router.get("/users/me/notifications", auth.requireAuth, (req, res) => {
    res.json(db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC").all(req.user.id));
  });

  return router;
};
