// FR1 register / login, FR2 profile, FR16 notifications list.
const express = require("express");
const { hashPassword, verifyPassword } = require("../services/passwords");
const { PROFILES } = require("../services/walletFeatures");
const { wrap, publicUser } = require("./util");

const ROLES = ["client", "freelancer", "arbiter"];

module.exports = function authRoutes({ db, chain, auth }) {
  const router = express.Router();

  router.post(
    "/auth/register",
    wrap(async (req, res) => {
      const { email, password, full_name, role } = req.body || {};
      if (!email || !password || !full_name || !ROLES.includes(role)) {
        return res.status(400).json({ error: "email, password, full_name and a valid role are required" });
      }
      if (String(password).length < 8) return res.status(400).json({ error: "Password must be at least 8 characters" });
      if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
        return res.status(409).json({ error: "Email already registered" });
      }
      // DEV ONLY: give the user the next local-chain account as their wallet (see services/chain.js).
      const next = (db.prepare("SELECT MAX(dev_wallet_index) AS m FROM users").get().m || 0) + 1;
      const wallet = await chain.devWallet(next);
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
    const { email, password } = req.body || {};
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
    if (dev_risk_profile !== undefined && !PROFILES.includes(dev_risk_profile)) {
      return res.status(400).json({ error: `dev_risk_profile must be one of ${PROFILES.join(", ")}` });
    }
    const current = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    db.prepare("UPDATE users SET full_name = ?, bio = ?, skills = ?, dev_risk_profile = ? WHERE id = ?").run(
      full_name ?? current.full_name,
      bio ?? current.bio,
      skills ?? current.skills,
      dev_risk_profile ?? current.dev_risk_profile,
      req.user.id
    );
    res.json(publicUser(db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id)));
  });

  router.get("/users/me/notifications", auth.requireAuth, (req, res) => {
    res.json(db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC").all(req.user.id));
  });

  return router;
};
