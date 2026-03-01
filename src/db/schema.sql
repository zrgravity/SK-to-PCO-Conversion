-- SK to PCO Sync — D1 Schema
-- Run: npm run db:migrate:local   (local dev)
--      npm run db:migrate:remote  (production)

-- ── Import batches ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_batches (
  id           TEXT    PRIMARY KEY,          -- UUID
  filename     TEXT    NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'imported',
  -- 'imported' | 'diffed' | 'applied'
  imported_by  TEXT,                          -- CF Access email
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ── SK imported people (one row = one SK individual per batch) ───────────────
CREATE TABLE IF NOT EXISTS sk_people (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id  TEXT    NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  sk_individual_id TEXT    NOT NULL,
  sk_family_id     TEXT,
  first_name       TEXT,
  last_name        TEXT,
  middle_name      TEXT,
  preferred_name   TEXT,
  gender           TEXT,
  birthdate        TEXT,   -- ISO date YYYY-MM-DD or null
  anniversary      TEXT,   -- ISO date
  membership       TEXT,
  marital_status   TEXT,
  home_phone       TEXT,
  cell_phone       TEXT,
  work_phone       TEXT,
  email_home       TEXT,
  email_work       TEXT,
  address_street   TEXT,
  address_city     TEXT,
  address_state    TEXT,
  address_zip      TEXT,
  baptized         TEXT,
  baptized_date    TEXT,
  include_in_dir   INTEGER DEFAULT 1,
  raw_data         TEXT    NOT NULL,          -- full JSON of original CSV row
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sk_people_batch    ON sk_people(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_sk_people_sk_id    ON sk_people(sk_individual_id);

-- ── PCO people snapshot ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pco_people (
  pco_id       TEXT    PRIMARY KEY,
  remote_id    INTEGER,                       -- maps to SK individual_id
  first_name   TEXT,
  last_name    TEXT,
  middle_name  TEXT,
  nickname     TEXT,
  gender       TEXT,
  birthdate    TEXT,
  anniversary  TEXT,
  membership   TEXT,
  status       TEXT,
  raw_data     TEXT    NOT NULL,              -- full JSON from PCO API
  synced_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pco_people_remote_id ON pco_people(remote_id);

-- PCO contact details snapshot (emails, phones, addresses)
CREATE TABLE IF NOT EXISTS pco_emails (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pco_id     TEXT    NOT NULL REFERENCES pco_people(pco_id) ON DELETE CASCADE,
  address    TEXT    NOT NULL,
  location   TEXT    NOT NULL DEFAULT 'Home',  -- Home | Work | Other
  primary_e  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pco_phone_numbers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pco_id     TEXT    NOT NULL REFERENCES pco_people(pco_id) ON DELETE CASCADE,
  number     TEXT    NOT NULL,
  location   TEXT    NOT NULL DEFAULT 'Home',  -- Home | Mobile | Work | Other
  primary_p  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pco_addresses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pco_id     TEXT    NOT NULL REFERENCES pco_people(pco_id) ON DELETE CASCADE,
  street     TEXT,
  city       TEXT,
  state      TEXT,
  zip        TEXT,
  location   TEXT    NOT NULL DEFAULT 'Home'
);

CREATE TABLE IF NOT EXISTS pco_households (
  pco_household_id  TEXT PRIMARY KEY,
  name              TEXT,
  raw_data          TEXT NOT NULL,
  synced_at         DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pco_household_members (
  pco_household_id TEXT NOT NULL,
  pco_person_id    TEXT NOT NULL,
  PRIMARY KEY (pco_household_id, pco_person_id)
);

-- ── Person matches: SK individual ↔ PCO person ───────────────────────────────
CREATE TABLE IF NOT EXISTS person_matches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sk_individual_id TEXT    NOT NULL UNIQUE,
  pco_person_id    TEXT    NOT NULL,
  confidence       TEXT    NOT NULL,  -- 'remote_id' | 'name_dob' | 'name_email' | 'manual'
  user_confirmed   INTEGER NOT NULL DEFAULT 0,  -- 1 = user explicitly confirmed
  confirmed_by     TEXT,              -- CF Access email
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_person_matches_sk  ON person_matches(sk_individual_id);
CREATE INDEX IF NOT EXISTS idx_person_matches_pco ON person_matches(pco_person_id);

-- ── Pending / reviewed changes ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pending_changes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id  TEXT    NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  sk_individual_id TEXT,
  pco_person_id    TEXT,               -- null for 'create' until applied
  change_type      TEXT    NOT NULL,   -- 'create_person' | 'update_field' | 'add_email' |
                                       -- 'update_email' | 'add_phone' | 'update_phone' |
                                       -- 'add_address' | 'update_address' | 'household'
  field_name       TEXT,               -- for update_field
  old_value        TEXT,               -- JSON-encoded previous value
  new_value        TEXT,               -- JSON-encoded proposed value
  status           TEXT    NOT NULL DEFAULT 'pending',
  -- 'pending' | 'approved' | 'rejected' | 'applied' | 'failed'
  reviewed_by      TEXT,
  reviewed_at      DATETIME,
  applied_at       DATETIME,
  error_message    TEXT,
  created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_changes_batch  ON pending_changes(import_batch_id);
CREATE INDEX IF NOT EXISTS idx_changes_status ON pending_changes(status);
CREATE INDEX IF NOT EXISTS idx_changes_sk_id  ON pending_changes(sk_individual_id);
