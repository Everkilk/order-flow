SET LOCAL search_path = orderflow, pg_catalog;

CREATE TABLE demo_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  storage_initialized boolean NOT NULL DEFAULT false,
  maintenance_at timestamptz
);
INSERT INTO demo_state(singleton) VALUES(true);

CREATE TABLE demo_storage_objects (
  storage_key text PRIMARY KEY,
  bytes bigint NOT NULL CHECK(bytes>=0),
  state text NOT NULL CHECK(state IN ('RESERVED','STORED','DELETING','DELETED','MISSING')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX demo_storage_active_idx ON demo_storage_objects(state,created_at);

CREATE TABLE demo_transfer_usage (
  month date PRIMARY KEY,
  bytes bigint NOT NULL CHECK(bytes>=0)
);

CREATE TABLE demo_job_admissions (
  actor_id bigint PRIMARY KEY REFERENCES users,
  last_started_at timestamptz NOT NULL
);
