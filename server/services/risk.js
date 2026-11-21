// Risk service: asks the Python risk engine (risk-engine/predict_cli.py) to score a
// payout wallet. The engine returns score, band, action and a plain-language reason,
// and appends the decision to the hash-chained audit log (FR9, FR15, NFR4).
const { execFile, spawn } = require("child_process");
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
  // One long-running Python process ("predict_cli.py --serve") that loads the model once.
  // Requests are answered in order, one JSON line each. If the worker is not available,
  // each request falls back to starting predict_cli.py on its own (slower, same answer).
  let worker = null;

  function startWorker() {
    const child = spawn(python, ["predict_cli.py", "--serve"], { cwd: RISK_ENGINE_DIR, stdio: ["pipe", "pipe", "pipe"] });
    const w = { child, pending: [], buffer: "", ready: null };
    w.ready = new Promise((resolve, reject) => {
      w.onReady = resolve;
      w.onFail = reject;
    });
    w.ready.catch(() => {}); // a failed start is handled by the caller's fallback
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      w.buffer += chunk;
      let nl;
      while ((nl = w.buffer.indexOf("\n")) >= 0) {
        const line = w.buffer.slice(0, nl).trim();
        w.buffer = w.buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // not one of our answers
        }
        if (msg.ready) {
          w.onReady();
          continue;
        }
        const job = w.pending.shift();
        if (!job) continue;
        clearTimeout(job.timer);
        msg.error ? job.reject(new Error(`Risk engine failed: ${msg.error}`)) : job.resolve(msg);
      }
    });
    child.stderr.on("data", () => {}); // warnings from pandas or scikit-learn are not answers
    const fail = (err) => {
      if (worker === w) worker = null;
      w.onFail(err);
      for (const job of w.pending.splice(0)) {
        clearTimeout(job.timer);
        job.reject(err);
      }
    };
    child.on("error", fail);
    child.on("exit", (code) => fail(new Error(`Risk engine stopped (exit code ${code})`)));
    child.unref(); // never keep Node running just for the worker
    child.stdin.on("error", () => {});
    return w;
  }

  function getWorker() {
    if (!worker) worker = startWorker();
    return worker;
  }

  async function askWorker(payload) {
    const w = getWorker();
    await w.ready;
    return new Promise((resolve, reject) => {
      const job = { resolve, reject };
      job.timer = setTimeout(() => {
        reject(new Error("Risk engine timed out"));
        w.child.kill(); // a stuck worker is replaced on the next request
      }, timeoutMs);
      w.pending.push(job);
      w.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  // Starts the worker in the background so the first submission is already fast.
  function warmUp() {
    getWorker().ready.catch(() => {});
  }

  async function runEngine(payload) {
    try {
      return await askWorker(payload);
    } catch {
      return runOnce(payload);
    }
  }

  function runOnce(payload) {
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

  return { assessPayout, warmUp };
}

module.exports = { makeRiskService, findPython };
