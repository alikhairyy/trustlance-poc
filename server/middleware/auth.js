// JWT authentication and role checks (FR1, NFR1).
const jwt = require("jsonwebtoken");

function makeAuth(secret) {
  function sign(user) {
    return jwt.sign({ sub: user.id, role: user.role }, secret, { expiresIn: "8h" });
  }

  function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
      const payload = jwt.verify(token, secret);
      req.user = { id: payload.sub, role: payload.role };
      next();
    } catch {
      res.status(401).json({ error: "Invalid or expired token" });
    }
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: `Only ${roles.join(" or ")} can do this` });
      }
      next();
    };
  }

  return { sign, requireAuth, requireRole };
}

module.exports = { makeAuth };
