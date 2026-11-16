# Trustlance

Freelance platform where each milestone payment is locked in a smart-contract
escrow, an explainable AI risk score can hold a payment for human review, and a
human arbiter makes the final decision. Graduation project, ESLSCA University.

**Milestone 2 (SRS + 25% implementation).** The full SRS is
[`docs/Trustlance_SRS_Milestone2.pdf`](docs/Trustlance_SRS_Milestone2.pdf), with a
Markdown copy in [`docs/SRS.md`](docs/SRS.md). Step-by-step run instructions and a
demo script are in [`docs/HOW_TO_RUN.md`](docs/HOW_TO_RUN.md). Of the 20 functional requirements, 13 are done, 2 are partial
with a named development stand-in, 2 are stubs and 3 are planned.

## What's implemented

| Layer | Location | What it does |
|---|---|---|
| Web app (UI screens) | `web/` | Login and registration; client dashboard (post jobs, accept proposals, add/fund/approve/dispute milestones); freelancer dashboard (find work, propose, submit work, appeal a flag); arbiter review queue (release, refund, pause); profile with wallet balance and notifications |
| REST API | `server/` | Express + JWT auth with role checks; routes for auth, jobs, proposals, milestones and arbiter decisions |
| Database | `server/db/schema.sql` | SQLite: users, jobs, proposals, milestones, risk_assessments, milestone_events, reviews, notifications. Personal data stays off-chain |
| Chain service | `server/services/chain.js` | Deploys one `MilestoneEscrow` per job when a proposal is accepted and calls it for every payment action; the database mirrors the contract's state |
| Risk service | `server/services/risk.js` | On work submission, calls the Python risk engine; a high score makes the risk oracle post the flag and reason on-chain. If the engine is down, the payment is held for a human (fail safe) |
| Escrow contract | `contracts/MilestoneEscrow.sol` | Funds locked per milestone; AI flag blocks client approval for up to 7 days; appeal, arbiter release/refund, pause, reentrancy guard |
| Risk engine | `risk-engine/` | Logistic regression on 8,731 real labelled Ethereum wallets (ROC-AUC 0.92), plain-language reasons, hash-chained decision log |
| Tests | `test/`, `risk-engine/test_engine.py` | 25 contract tests, 11 API tests, 12 Python tests |

Stubs (interfaces exist, behaviour still to build): notifications delivery
(`server/services/notifications.js`), ratings (`POST /api/jobs/:id/reviews` returns 501),
live wallet features from a block explorer (`server/services/walletFeatures.js`).

Development stand-ins, named in the code: each user gets a funded account on the
local chain and the server signs for them (MetaMask signing is planned), and each
freelancer is linked to a real held-out dataset wallet for scoring, because a new
local wallet has no history.

## Run the web app

```bash
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r risk-engine\requirements.txt   # Windows
.\.venv\Scripts\python.exe risk-engine\fetch_real_data.py                  # once
npm run dev
```

Open http://localhost:3000. Demo accounts, all with password `demo1234`:

| Email | Role | Notes |
|---|---|---|
| client@demo.com | Client | Owns a seeded open job |
| freelancer@demo.com | Freelancer | Wallet history: legitimate (low risk) |
| risky@demo.com | Freelancer | Wallet history: a wallet the dataset labels as fraud (held) |
| arbiter@demo.com | Arbiter | Reviews flagged and disputed milestones |

Demo script: send a proposal as `risky@demo.com`, accept it as the client, add and
fund a milestone, submit work as the freelancer (score 0.90, held on-chain), try to
approve as the client (refused), appeal as the freelancer, decide as the arbiter.
The chain and database start empty on every launch.

## Tests

```bash
npm test               # 25 contract + 11 API tests
npm run test:risk      # 12 Python tests
npm run demo           # original end-to-end script demo (three cases + security checks)
```

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

# 4. Contract and API tests (25 + 11)
npm test

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
server/                         REST API, database schema, chain and risk services.
web/                            UI screens for client, freelancer and arbiter.
test/api/api.test.js            11 API tests against the real contract.
docs/SRS.md                     Software requirements specification with traceability.
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
#   t r u s t l a n c e - p o c 
 
 