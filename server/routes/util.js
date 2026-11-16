// Small helpers shared by the route modules.

// Lets async route handlers pass errors to Express.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Never send password hashes or dev-only keys to the browser.
function publicUser(u) {
  if (!u) return null;
  const { password_hash, dev_wallet_index, ...rest } = u;
  return rest;
}

// Turns an amount string into a positive decimal ETH string, or null.
function cleanEth(value) {
  const s = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s) || Number(s) <= 0) return null;
  return s;
}

module.exports = { wrap, publicUser, cleanEth };
