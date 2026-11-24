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
  package_id       INTEGER REFERENCES packages(id),  -- set when the job came from buying a freelancer's package
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Public portfolio: work a freelancer shows on their profile page.
CREATE TABLE IF NOT EXISTS portfolio_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  freelancer_id    INTEGER NOT NULL REFERENCES users(id),
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  link             TEXT    DEFAULT '',               -- http(s) link to the work, optional
  result           TEXT    DEFAULT '',               -- the outcome in one line, e.g. "ROAS 4.2x in 30 days"
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Packages: a fixed offer a client can buy directly, e.g. "3 media-buying campaigns for 0.9 ETH".
-- Buying one creates a job with one escrowed milestone per case.
CREATE TABLE IF NOT EXISTS packages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  freelancer_id    INTEGER NOT NULL REFERENCES users(id),
  title            TEXT    NOT NULL,
  description      TEXT    NOT NULL DEFAULT '',
  cases            INTEGER NOT NULL CHECK (cases BETWEEN 1 AND 12),
  price_eth        TEXT    NOT NULL,                 -- total for all cases
  delivery_days    INTEGER NOT NULL DEFAULT 30,
  active           INTEGER NOT NULL DEFAULT 1,
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
                   CHECK (status IN ('pending', 'funded', 'submitted', 'released', 'disputed', 'refunded', 'cancelled')),
                   -- 'cancelled' exists only here: a never-funded milestone the client removed (no money moved).
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

-- FR20: messages between the client and the freelancer on a job. The job's arbiter can read them.
CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  sender_id        INTEGER NOT NULL REFERENCES users(id),
  body             TEXT    NOT NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The last message each user has seen on each job, for unread counts.
CREATE TABLE IF NOT EXISTS message_reads (
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  user_id          INTEGER NOT NULL REFERENCES users(id),
  last_seen_id     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, user_id)
);

-- Files attached to a job: deliverables or briefs on a milestone, or a file sent in the chat.
-- The file itself is stored on the server's disk (uploads/) under a random name.
CREATE TABLE IF NOT EXISTS attachments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id           INTEGER NOT NULL REFERENCES jobs(id),
  milestone_id     INTEGER REFERENCES milestones(id),  -- set for milestone files
  message_id       INTEGER REFERENCES messages(id),    -- set once sent in the chat
  uploader_id      INTEGER NOT NULL REFERENCES users(id),
  filename         TEXT    NOT NULL,                    -- the name shown to people
  mime             TEXT    NOT NULL,
  size             INTEGER NOT NULL,                    -- bytes
  stored_name      TEXT    NOT NULL UNIQUE,             -- random name on disk
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- FR16: in-app notifications, shown in the bell menu.
CREATE TABLE IF NOT EXISTS notifications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id),
  message          TEXT    NOT NULL,
  link             TEXT    NOT NULL DEFAULT '',          -- page the notification is about, e.g. #/job/3
  is_read          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
