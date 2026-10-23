CREATE TABLE app.bills (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  bill_key text NOT NULL UNIQUE,
  content_hash text NOT NULL,
  context_id text,
  status text NOT NULL,
  source_type text NOT NULL,
  effective_date text,
  imported_at timestamptz NOT NULL,
  payload_mode text NOT NULL,
  metadata_json jsonb NOT NULL,
  payload_json jsonb,
  snapshot_json jsonb,
  snapshot_hash text,
  snapshot_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX bills_user_idx ON app.bills (user_id);

CREATE TABLE app.profile_facts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  kind text NOT NULL,
  fact_key text NOT NULL,
  fact_value text NOT NULL,
  evidence text,
  source text NOT NULL,
  source_ref text,
  confidence integer NOT NULL,
  fact_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX profile_facts_user_idx ON app.profile_facts (user_id);

CREATE TABLE app.profiles (
  user_id text PRIMARY KEY,
  summary_json jsonb,
  summary_source_hash text,
  summary_at timestamptz,
  summary_version integer,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
