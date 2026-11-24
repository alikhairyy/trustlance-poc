// Builds the Express app. Dependencies (database, chain, risk engine) are passed in,
// so tests can use an in-memory database and a stand-in risk engine.
const path = require("path");
const express = require("express");
const { makeAuth } = require("./middleware/auth");
const { makeNotifications } = require("./services/notifications");

function createApp({ db, chain, risk, jwtSecret }) {
  const app = express();
  app.use(express.json({ limit: "100kb" }));

  const auth = makeAuth(jwtSecret);
  const notifications = makeNotifications(db);
  const deps = { db, chain, risk, auth, notifications };

  const milestones = require("./routes/milestones")(deps);

  app.get("/api/health", (req, res) => res.json({ ok: true }));
  app.use("/api", require("./routes/auth")(deps));
  // Before the jobs router, whose login check covers every path it sees: the public pages need no login.
  app.use("/api", require("./routes/market")({ ...deps, milestoneHelpers: milestones }));
  app.use("/api", require("./routes/jobs")(deps));
  app.use("/api", milestones.router);
  app.use("/api", require("./routes/arbiter")({ ...deps, milestoneHelpers: milestones }));

  app.use("/api", (req, res) => res.status(404).json({ error: "No such API route" }));

  app.use(express.static(path.join(__dirname, "..", "web")));

  // Last-resort error handler: log, and do not leak internals.
  app.use((err, req, res, next) => {
    // A request body that is not valid JSON (or too large) is the caller's mistake, not ours.
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request body is not valid JSON" });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "The request body is too large" });
    console.error(err);
    res.status(500).json({ error: "Internal error" });
  });

  return app;
}

module.exports = { createApp };
