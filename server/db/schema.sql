-- Trustlance database schema (SQLite). Personal data lives here, off-chain.
-- Only milestone state, risk flags and reasons go on-chain (see contracts/MilestoneEscrow.sol).

CREATE TABLE IF NOT EXISTS users (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  email            TEXT    NOT NULL UNIQUE,
  password_hash    TEXT    NOT NULL,                 -- scrypt, "salt:hash"
  role             TEXT    NOT NULL CHECK (role IN ('client', 'freelancer', 'arbiter')),
  full_name        TEXT    NOT NULL,
  bio              TEXT    DEFAULT '',
  skills           TEXT    DEFAULT '',               -- comma-separated
  wallet_address   TEXT    UNIQUE,                   -- payout / signing address
  dev_wallet_index INTEGER UNIQUE,                   -- DEV ONLY: index of the local-chain account used as this user's wallet
  dev_risk_profile TEXT    DEFAULT 'legit',          -- DEV ONLY: which real dataset wallet stands in for this user's on-chain history
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id        INTEGER NOT NULL REFERENCES users(id),
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL,
  budget_eth       TEXT    NOT NULL,
  skills           TEXT    DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed', 'cancelled')),
  freelancer_id    INTEGER REFERENCES users(id),
  arbiter_id       INTEGER REFERENCES users(id),
  escrow_address   TEXT,                             -- one MilestoneEscrow contract per job
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS proposals (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  freelancer_id    INTEGER NOT NULL REFERENCES users(id),
  cover_letter     TEXT    NOT NULL,
  price_eth        TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, freelancer_id)
);

CREATE TABLE IF NOT EXISTS milestones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  chain_index      INTEGER NOT NULL,                 -- milestone id inside the job's escrow contract
  title            TEXT    NOT NULL,
  amount_eth       TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'funded', 'submitted', 'released', 'disputed', 'refunded')),
  deliverable_url  TEXT,
  submission_note  TEXT,
  risk_flagged     INTEGER NOT NULL DEFAULT 0,
  appealed         INTEGER NOT NULL DEFAULT 0,
  review_deadline  TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, chain_index)
);

CREATE TABLE IF NOT EXISTS risk_assessments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id     INTEGER NOT NULL REFERENCES milestones(id),
  score            REAL    NOT NULL,
  band             TEXT    NOT NULL CHECK (band IN ('low', 'medium', 'high')),
  action           TEXT    NOT NULL CHECK (action IN ('auto_approve', 'monitor', 'hold_for_review')),
  reason           TEXT    NOT NULL,
  model_version    TEXT    NOT NULL,
  audit_hash       TEXT,                             -- link to the hash-chained decision log
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Every state change on a milestone (who, what, which transaction). Feeds the history view (FR15).
CREATE TABLE IF NOT EXISTS milestone_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id     INTEGER NOT NULL REFERENCES milestones(id),
  actor_id         INTEGER REFERENCES users(id),     -- NULL when the system (risk oracle) acted
  event            TEXT    NOT NULL,
  detail           TEXT    DEFAULT '',
  tx_hash          TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- FR17 (stub): ratings after a job completes.
CREATE TABLE IF NOT EXISTS reviews (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  reviewer_id      INTEGER NOT NULL REFERENCES users(id),
  reviewee_id      INTEGER NOT NULL REFERENCES users(id),
  rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment          TEXT    DEFAULT '',
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, reviewer_id)
);

-- FR16 (stub): in-app notifications.
CREATE TABLE IF NOT EXISTS notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  message          TEXT    NOT NULL,
  is_read          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
