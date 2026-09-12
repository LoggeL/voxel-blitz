CREATE TABLE IF NOT EXISTS vb_schema_migrations (
  version integer PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vb_accounts (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{32}$'),
  username text NOT NULL CHECK (username ~ '^[A-Za-z0-9_-]{3,20}$'),
  username_key text GENERATED ALWAYS AS (lower(username)) STORED UNIQUE,
  password jsonb NOT NULL,
  recovery_hash text NOT NULL CHECK (recovery_hash ~ '^[a-f0-9]{64}$'),
  auth_version bigint NOT NULL CHECK (auth_version > 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= created_at_ms),
  registration_context jsonb
);

CREATE TABLE IF NOT EXISTS vb_sessions (
  hash text PRIMARY KEY CHECK (hash ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL REFERENCES vb_accounts(id) ON DELETE CASCADE,
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX IF NOT EXISTS vb_sessions_account ON vb_sessions(account_id);

CREATE TABLE IF NOT EXISTS vb_careers (
  id text PRIMARY KEY CHECK (id ~ '^([a-f0-9]{64}|account:[a-f0-9]{32})$'),
  account_id text UNIQUE REFERENCES vb_accounts(id),
  xp bigint NOT NULL DEFAULT 0 CHECK (xp BETWEEN 0 AND 9007199254740991),
  credits bigint NOT NULL DEFAULT 0 CHECK (credits BETWEEN 0 AND 9007199254740991),
  kills bigint NOT NULL DEFAULT 0 CHECK (kills BETWEEN 0 AND 9007199254740991),
  matches bigint NOT NULL DEFAULT 0 CHECK (matches BETWEEN 0 AND 9007199254740991),
  owned jsonb NOT NULL,
  equipped jsonb NOT NULL,
  CHECK ((account_id IS NULL AND id ~ '^[a-f0-9]{64}$') OR id = 'account:' || account_id)
);

CREATE TABLE IF NOT EXISTS vb_career_claims (
  guest_id text PRIMARY KEY CHECK (guest_id ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL UNIQUE REFERENCES vb_accounts(id),
  profile jsonb NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vb_json_imports (
  source_path text PRIMARY KEY,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vb_reward_receipts (
  id uuid PRIMARY KEY,
  profile_id text NOT NULL,
  delta jsonb NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now()
);
