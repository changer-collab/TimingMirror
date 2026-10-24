CREATE TABLE app.rule_sets (
  user_id text PRIMARY KEY,
  payload_json jsonb NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
