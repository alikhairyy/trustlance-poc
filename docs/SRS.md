# Trustlance: Software Requirements Specification (Milestone 2)

Team: Ali Khairy, Hamza Milad, Youssef Eslam, Adam Elshal, Abdelrahman Amgad
Supervisor: Dr. Raghda Essam

## 1. Introduction and problem

Freelance platforms hold client money themselves and decide disputes without
explaining why. Freelancers risk doing work and not being paid; clients risk
paying for work that is not delivered or a payout going to a fraudulent wallet.

Trustlance locks each milestone payment in a smart contract, scores the wallet
that will receive the payout with an explainable machine-learning model, and
leaves every held or disputed payment to a human arbiter. The AI can only hold a
payment, for at most 7 days; it cannot move money, and the freelancer can appeal.

## 2. Scope and objectives

In scope: web application for client, freelancer and arbiter; REST API and
database; milestone escrow smart contract; explainable risk engine; survey and
small pilot on a test network.

Out of scope: real money on a public main network before an independent audit;
job matching/recommendation; fiat on/off-ramps; legal arbitration across
jurisdictions.

Objectives:
1. Milestone escrow with role-based control (client, freelancer, arbiter, risk oracle).
2. A risk score from 0 to 1 for the payout wallet, with plain-language reasons.
3. Trained and benchmarked on real labelled data.
4. The AI can only hold a payment, for a fixed window, never move money.
5. On-chain appeal path and tamper-evident decision log.
6. Evaluation through a survey and a small pilot.

## 3. Actors

| Actor | Description |
|---|---|
| Client | Posts jobs, accepts proposals, defines and funds milestones, approves or disputes work |
| Freelancer | Browses jobs, sends proposals, submits work, appeals risk flags |
| Arbiter | Platform-side human reviewer; resolves flagged and disputed milestones; can pause a contract |
| Risk engine / oracle (system) | Scores the payout wallet on submission; posts a flag and reason on-chain when risk is high |
| Smart contract (system) | Holds funds and enforces who may release or refund them |

## 4. Functional requirements

Status: **Done** = implemented and tested in this repository; **Partial** = works
with a development stand-in that is named; **Stub** = interface, route or table exists but
the behaviour is not built (ratings return `501 Not Implemented`); **Planned** = not started.

| ID | Requirement | Actor | Status |
|---|---|---|---|
| FR1 | Register and log in with a role (client, freelancer, arbiter) | All | Done |
| FR2 | View and update profile (name, bio, skills) and payout wallet address | All | Done |
| FR3 | Client posts a job with title, description, budget and skills | Client | Done |
| FR4 | Freelancer browses open jobs and sends a proposal (cover letter, price) | Freelancer | Done |
| FR5 | Client accepts a proposal; the job is assigned and an escrow contract is deployed for it | Client | Partial (dev wallets on a local chain) |
| FR6 | Client adds milestones (title, amount) to an assigned job | Client | Done |
| FR7 | Client funds a milestone; the amount is locked in the escrow contract | Client | Done |
| FR8 | Freelancer submits work for a funded milestone (deliverable link and note) | Freelancer | Done |
| FR9 | On submission the risk engine scores the payout wallet and stores score, band, action and reason | System | Partial (wallet features from dataset profiles, not live chain data) |
| FR10 | If the score is high (>= 0.65) the oracle posts the flag and reason on-chain; client approval is blocked for up to 7 days | System | Done |
| FR11 | Client approves submitted work (funds release) or disputes it | Client | Done |
| FR12 | Freelancer appeals a flag once, with a note stored on-chain | Freelancer | Done |
| FR13 | Arbiter sees a queue of flagged and disputed milestones with reasons and appeal notes, and releases or refunds | Arbiter | Done |
| FR14 | Arbiter can pause and unpause a job's contract in an emergency | Arbiter | Done |
| FR15 | Every risk decision is written to a hash-chained audit log; users can view a milestone's history | All | Done |
| FR16 | Users receive notifications on milestone events | All | Stub |
| FR17 | Client and freelancer rate each other after a job completes | Client, Freelancer | Stub (table exists) |
| FR18 | Connect a browser wallet (MetaMask) and sign transactions client-side | Client, Freelancer | Planned |
| FR19 | Freelancer-history signals (completion, dispute rate) added to the risk model | System | Planned (needs survey/pilot data) |
| FR20 | Messaging between client and freelancer on a job | Client, Freelancer | Planned |

## 5. Non-functional requirements

| ID | Category | Requirement | How it is met / measured |
|---|---|---|---|
| NFR1 | Security | Only the right role can call each contract function and API route | Contract modifiers + JWT role checks; 25 contract tests, API role tests |
| NFR2 | Security | No reentrancy; state changes before transfers | Reentrancy guard; attack test with MaliciousClient |
| NFR3 | Security | Passwords never stored in plain text | scrypt with per-user salt |
| NFR4 | Explainability | Every risk score comes with a readable reason naming the top 3 factors | engine.py; reason stored with each score |
| NFR5 | Fairness / liveness | The AI can delay a payment at most 7 days and never move funds | REVIEW_WINDOW in contract; test proves approval honored after 7 days |
| NFR6 | Privacy | Personal data stays off-chain; only milestone state, flag and reason go on-chain; the audit log stores digests | Design + audit_log.py |
| NFR7 | Integrity | Edits or deletions in the decision log are detected | Hash chain; unit tests |
| NFR8 | Performance | Risk check completes in under 10 s per submission; API calls under 500 ms (excluding chain and model) | Measured in the pilot |
| NFR9 | Model quality | ROC-AUC >= 0.90 on held-out wallets; recall reported | Current 0.92; recall 0.61 is the weak point |
| NFR10 | Usability | Each role completes its main task from one dashboard screen | UI screens in web/ |
| NFR11 | Maintainability | Modules separated (routes, services, contract, engine); automated tests run with one command | Repository layout; npm test |
| NFR12 | Portability | Runs on Windows, macOS and Linux with Node 18+ and Python 3 | README steps |

## 6. Constraints

- Smart contracts cannot run machine learning, so the model runs off-chain and only
  its flag and reason go on-chain through one authorised oracle address.
- Development uses a local Hardhat chain and test ETH; no real money.
- Free-text on-chain (reasons, appeal notes) is capped at 512 bytes for gas cost.
- Open-source tools only (Solidity, Hardhat, Node.js, Express, SQLite, Python,
  scikit-learn): zero running cost for the prototype.
- One academic semester, five team members.

## 7. Assumptions

- The training dataset (Kaggle Ethereum Fraud Detection, 8,731 wallets after
  cleaning) describes wallets, not freelancers; wallet risk is a proxy until
  freelancer-history data exists.
- Thresholds 0.35 / 0.65 are starting points to be tuned on pilot data.
- Each user has one payout wallet; payments are in ETH on the test network.
- The arbiter is an honest platform reviewer; the contract limits what the
  arbiter can do (release or refund only) but not which decision they take.
- Users have internet access and a modern browser.

## 8. Traceability: requirement to code

| Requirement | Code |
|---|---|
| FR1, FR2, NFR3 | server/routes/auth.js, server/middleware/auth.js, server/services/passwords.js |
| FR3, FR4, FR5 | server/routes/jobs.js (jobs and proposals), server/services/chain.js (deployEscrow) |
| FR6, FR7, FR8, FR11, FR12 | server/routes/milestones.js, server/services/chain.js |
| FR9, FR10, NFR4 | server/services/risk.js, risk-engine/engine.py, risk-engine/predict_cli.py |
| FR13, FR14 | server/routes/arbiter.js |
| FR15, NFR7 | risk-engine/audit_log.py, server/routes/milestones.js (GET /milestones/:id history) |
| FR16 | server/services/notifications.js (stub) |
| FR17 | server/routes/jobs.js (POST /jobs/:id/reviews returns 501), reviews table |
| NFR1, NFR2, NFR5 | contracts/MilestoneEscrow.sol, test/*.test.js, test/api/*.test.js |
| Database | server/db/schema.sql, server/db/index.js (SQLite via sql.js) |
| UI screens | web/ |

## 9. Implementation progress

Counting the 20 functional requirements: 13 Done, 2 Partial (FR5, FR9, each with
a named development stand-in), 2 Stub (FR16, FR17), 3 Planned (FR18 to FR20).
Automated tests: 25 contract, 11 API, 12 Python. Planned work: browser wallet signing,
test-network deployment, live wallet features, freelancer-history signals,
notifications, ratings, messaging, survey and pilot.
