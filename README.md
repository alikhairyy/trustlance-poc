# Trustlance — Proof of Concept (Milestone 1)

This is the Milestone 1 Proof of Concept: working code demonstrating the
feasibility of Trustlance's core idea — **milestone escrow payments gated by
an explainable AI risk score, with automated release for the normal case and
human (arbiter) review only when the AI flags a risk** — rather than a full
build of the platform. Per the rubric, this represents roughly the first
10% of the eventual system: the one mechanism everything else in the
proposal depends on, implemented end to end on both sides (smart contract +
AI) and wired together.

It intentionally does **not** include: a web frontend, user accounts,
multi-currency support, freelancer–client matching (designed separately,
not yet built), or a production-grade ML model. Those are later milestones.

## What's implemented

| Component | Location | What it proves |
|---|---|---|
| Milestone escrow smart contract | `contracts/MilestoneEscrow.sol` | Funds are locked per milestone and released only through a defined state machine; an AI risk flag provably blocks the client's normal approval until a human arbiter resolves it (or a 7-day review window ends). |
| Security hardening | same contract | Role separation, reentrancy guard, emergency pause, appeal path, review window, oracle rotation, on-chain audit events. See [`docs/SECURITY.md`](docs/SECURITY.md). |
| Contract test suite (25 tests) | `test/MilestoneEscrow.test.js`, `test/Security.test.js`, `contracts/MaliciousClient.sol` | The hybrid logic and every security protection behave as described, including a reentrancy attack that is blocked. |
| Wallet risk model trained on **real data** | `risk-engine/wallet_model.py`, `fetch_real_data.py` | A logistic regression on 8,731 real labeled Ethereum accounts reaches ROC-AUC 0.92 on held-out data. See [`docs/DATASET.md`](docs/DATASET.md) and [`docs/BENCHMARK.md`](docs/BENCHMARK.md). |
| Benchmark against black-box models | `risk-engine/benchmark.py` | The price of explainability is measured (about 0.05 ROC-AUC against random forest / gradient boosting). |
| Risk engine | `risk-engine/engine.py` | The wallet score becomes a band (low / medium / high), an action (auto-approve / monitor / hold) and a plain-language reason built from the biggest contributing facts. |
| Tamper-evident decision log | `risk-engine/audit_log.py` | Every AI decision is hash-chained; editing or deleting one is detected. |
| Python tests (12) | `risk-engine/test_engine.py` | Audit-log tamper detection, data cleaning, real-data model quality, banding and hold rules. |
| End-to-end demo | `scripts/demo.js`, `risk-engine/predict_cli.py` | The AI output drives the deployed contract: auto-release, flag, revert, appeal, arbiter decision, plus live security checks. |

## Why this design (maps to the proposal's Feasibility Analysis)

- **Technical feasibility — blockchain side:** a minimal but complete escrow
  state machine (`Pending → Funded → Submitted → Released/Disputed/Refunded`)
  compiles and passes tests on standard Solidity/Hardhat tooling. No novel
  cryptography or infrastructure is required — the contract uses only
  patterns (custom errors, role-gated modifiers, an authorized-oracle
  address) that are standard and auditable.
- **Technical feasibility — AI side:** logistic regression was chosen
  deliberately over a more "impressive" black-box model. The project's
  stated edge is *explainable* AI, so the proof of concept has to show that
  a score can be decomposed into the specific facts that drove it, in plain
  language. `engine.py` does this by ranking each fact's contribution to the
  score. The model is trained on a real labeled dataset and benchmarked against
  random forest and gradient boosting, so the cost of explainability
  (about 0.05 ROC-AUC) is measured, not assumed.
- **Integration feasibility:** the hardest systems-level risk in the whole
  project is that the off-chain AI and the on-chain contract are two
  different trust domains. This proof of concept shows the actual
  mechanism for bridging them: an authorized `riskOracle` address calls
  `flagRisk(milestoneId, reason)`, which is the same shape a real deployment
  would use (an oracle service signs and submits the AI's output on-chain).
  `scripts/demo.js` exercises this with a real contract on a local chain,
  not a mock.
- **Known limitation, stated honestly:** the dataset describes Ethereum
  *wallets*, not freelancers. The proof of concept therefore scores the wallet
  that will receive the payout. Signals about a freelancer's own history
  (completion rate, dispute rate, ratings) are not in the model yet, because we
  found no public dataset that records them; they are planned from survey and
  pilot data. No synthetic data is used anywhere in this repository.

## How to run it

Requires Node.js (18+) and Python 3 (with pip).

```bash
# 1. Install JS dependencies
npm install

# 2. Python environment (Windows PowerShell shown; use .venv/bin/python on macOS/Linux)
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r risk-engine\requirements.txt

# 3. Download the real dataset once (not committed to the repo)
.\.venv\Scripts\python.exe risk-engine\fetch_real_data.py

# 4. Contract tests (25)
npm run test:contracts

# 5. Python tests (12)
cd risk-engine
..\.venv\Scripts\python.exe -m unittest -v
cd ..

# 6. Benchmark on real data (writes docs/BENCHMARK.md)
.\.venv\Scripts\python.exe risk-engine\benchmark.py

# 7. Full end-to-end demo (three cases + security checks + audit trail)
npm run demo
```

`demo.js` finds the `.venv` Python automatically; set `PYTHON=...` to override.

### Note on this sandbox's network restrictions

`npx hardhat compile` normally downloads its Solidity compiler binary from
`binaries.soliditylang.org`. That host isn't reachable from this sandboxed
environment, so `scripts/compile.js` compiles the contract directly with the
npm-distributed `solc` package instead and writes the resulting artifact in
Hardhat's own format. `npm run build:contracts` (which `test:contracts` and
`demo` both call first) uses this path automatically — no action needed, but
worth knowing if `npx hardhat compile` is run directly and fails with
`HH502`.

## Repository layout

```
contracts/MilestoneEscrow.sol   Escrow contract with security hardening.
contracts/MaliciousClient.sol   TEST DOUBLE that attacks the contract (reentrancy test).
test/MilestoneEscrow.test.js    10 core tests.
test/Security.test.js           15 security tests.
scripts/compile.js              solc-based compiler (network workaround).
scripts/demo.js                 End-to-end demo with security checks.
risk-engine/wallet_model.py     Wallet risk model, real labeled data.
risk-engine/fetch_real_data.py  Downloads the dataset.
risk-engine/benchmark.py        Logistic regression vs black-box models.
risk-engine/engine.py           Score -> band, action and plain-language reason.
risk-engine/audit_log.py        Hash-chained decision log.
risk-engine/predict_cli.py      stdin/stdout JSON bridge used by demo.js.
risk-engine/test_engine.py      10 Python tests.
docs/SECURITY.md                Threat table: threat, protection, test, status.
docs/DATASET.md                 Datasets, cleaning, results, limits.
docs/BENCHMARK.md               Generated benchmark table.
docs/COMPETITOR_GAPS.md         What competitors have that we do not.
```

## Mapping to Milestone 1 deliverables

This proof of concept supports the **Proposed Solution** and **Feasibility
Analysis** sections of the Project Proposal Document, and its results
(contract test output, demo transcript) are intended to be screenshotted or
quoted directly into those sections and into the Project Proposal
Presentation.
