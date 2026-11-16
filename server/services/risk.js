// Risk service: asks the Python risk engine (risk-engine/predict_cli.py) to score a
// payout wallet. The engine returns score, band, action and a plain-language reason,
// and appends the decision to the hash-chained audit log (FR9, FR15, NFR4).
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { walletFeaturesFor } = require("./walletFeatures");

const RISK_ENGINE_DIR = path.join(__dirname, "..", "..", "risk-engine");

function findPython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const root = path.join(__dirname, "..", "..");
  const candidates = [
    path.join(root, ".venv", "Scripts", "python.exe"), // Windows venv
    path.join(root, ".venv", "bin", "python"), // macOS / Linux venv
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return process.platform === "win32" ? "python" : "python3";
}

function makeRiskService({ python = findPython(), timeoutMs = 60000 } = {}) {
  function runEngine(payload) {
    return new Promise((resolve, reject) => {
      const child = execFile(
        python,
        ["predict_cli.py"],
        { cwd: RISK_ENGINE_DIR, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error(`Risk engine failed: ${stderr || err.message}`));
          try {
            resolve(JSON.parse(stdout.trim()));
          } catch {
            reject(new Error("Risk engine returned invalid JSON"));
          }
        }
      );
      child.stdin.end(JSON.stringify(payload));
    });
  }

  async function assessPayout({ caseId, freelancer }) {
    const result = await runEngine({ case_id: caseId, ...walletFeaturesFor(freelancer) });
    return {
      score: result.score,
      band: result.band,
      action: result.action,
      reason: result.reason,
      modelVersion: "wallet-ethereum-kaggle-v1",
      auditHash: result.audit_hash,
    };
  }

  return { assessPayout };
}

module.exports = { makeRiskService, findPython };
