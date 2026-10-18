# Security model

Trustlance handles payments, so the proof of concept treats security as part of the design.
Each row below names a threat, the protection, where it lives in the code, and how it is verified.
Status is stated honestly: **Built** means it exists in this repository and is tested.
**Planned** means it is part of the design but not built yet.

This is a graduation-project proof of concept. It has **not** been externally audited.

## Threat table

| # | Threat | Protection | Where | Verified by | Status |
|---|---|---|---|---|---|
| 1 | Wrong person releases or takes escrowed money | Role-gated functions: only the client funds/approves, only the freelancer submits, only the arbiter resolves disputes | `MilestoneEscrow.sol` modifiers | `MilestoneEscrow.test.js` (access control tests) | Built |
| 2 | One person acts on both sides of a payment, or reviews their own job | Constructor rejects zero addresses and requires client, freelancer and arbiter to be three different addresses | constructor | `Security.test.js` (role separation) | Built |
| 3 | Re-entrancy while funds are being paid out | State is updated before the transfer (checks-effects-interactions) plus a `nonReentrant` guard | `_release`, `arbiterRefund` | `Security.test.js` with `MaliciousClient.sol` attacking mid-refund | Built |
| 4 | Stolen or faulty risk-oracle key posts false flags | Only the authorized oracle can flag; the client can rotate the oracle with `setRiskOracle` | `flagRisk`, `setRiskOracle` | `Security.test.js` (oracle key compromise) | Built |
| 5 | A flag (or a silent arbiter) freezes a payment forever | A flag only holds release for `REVIEW_WINDOW` (7 days). After that the client's approval is honored. The AI can delay a payment, never trap it | `approveMilestone` | `Security.test.js` (time travel test) | Built |
| 6 | Oracle keeps re-flagging to extend the hold | The review clock starts at the first flag only; re-flagging updates the reason but cannot restart it | `flagRisk` | `Security.test.js` (re-flag test) | Built |
| 7 | Honest freelancer is wrongly flagged | On-chain appeal: the freelancer can contest a flag once, with a note recorded as an event | `appealFlag` | `Security.test.js` (appeal tests) | Built |
| 8 | Decisions cannot be audited afterwards | Every flag, appeal and arbiter decision is emitted as an on-chain event. Off-chain, each AI decision is appended to a hash-chained log; editing or deleting an entry breaks verification | events in `MilestoneEscrow.sol`; `risk-engine/audit_log.py` | `Security.test.js`; `test_engine.py` (tamper tests) | Built |
| 9 | A discovered bug while money is locked | Emergency pause (arbiter) stops new activity; the arbiter can still settle open milestones so funds are not stuck behind a pause | `pause`, `unpause` | `Security.test.js` (pause tests) | Built |
| 10 | Gas or storage abuse through huge text fields | Flag reasons and appeal notes are capped at 512 bytes | `MAX_TEXT_LENGTH` | `Security.test.js` | Built |
| 11 | Personal data exposed on a public chain | Only milestone state, the flag, and its reason go on-chain. Personal data stays in a private database. The audit log stores a digest of the inputs, not the raw data | design; `audit_log.py` | `test_engine.py` (raw inputs not stored) | Partly built (no database yet) |
| 12 | Single oracle account is one point of trust | Require several independent signers to agree before a flag counts | — | — | Planned |
| 13 | Undiscovered contract bugs | Independent security audit before any real use | — | — | Planned |
| 14 | Fake accounts built up with a good history before a scam | Payout-vs-history and wallet-behavior signals help, but a patient attacker can still game them | risk engine | — | Known limitation |

## What the AI is and is not allowed to do

- The AI **scores and explains**. It never moves money.
- A high score **holds** a payment for a human arbiter. The arbiter decides; the contract enforces who may decide, not what they decide.
- Every score comes with a plain-language reason so the client, freelancer and arbiter can see why.

## Run the checks

```bash
npm run test:contracts                        # 25 contract tests, including the security suite
cd risk-engine && python -m unittest -v       # 12 tests: audit log tamper detection, real-data model
npm run demo                                  # shows the security checks live
```
