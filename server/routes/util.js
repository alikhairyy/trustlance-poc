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

// Exact ETH amount in wei, as a BigInt, so sums of decimals do not lose precision.
function toWei(eth) {
  const [whole, frac = ""] = String(eth).split(".");
  return BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
}

// Trims a text field and checks its length. Returns the trimmed text, or null.
function cleanText(value, maxLength) {
  const s = String(value ?? "").trim();
  if (!s || s.length > maxLength) return null;
  return s;
}

// Only plain web links can be submitted as deliverables (no javascript: or data: links).
function isWebUrl(value) {
  try {
    const u = new URL(String(value ?? "").trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Wei (BigInt) back to a decimal ETH string without trailing zeros, e.g. 300000000000000000n -> "0.3".
function fromWei(wei) {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// The platform assigns an arbiter to each new job: the one with the fewest jobs in progress.
function pickArbiter(db) {
  return db
    .prepare(
      `SELECT u.* FROM users u LEFT JOIN jobs j ON j.arbiter_id = u.id AND j.status = 'in_progress'
       WHERE u.role = 'arbiter' GROUP BY u.id ORDER BY COUNT(j.id), u.id LIMIT 1`
    )
    .get();
}

module.exports = { wrap, publicUser, cleanEth, toWei, fromWei, cleanText, isWebUrl, pickArbiter };
