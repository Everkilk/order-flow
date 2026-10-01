-- Backend services now write balances and ledger rows in one transaction.
-- Existing structural and document consistency guards remain in place.
SET LOCAL search_path = orderflow, pg_catalog;

DROP TRIGGER ledger_apply ON inventory_ledger;
DROP TRIGGER balance_from_ledger ON inventory_balances;
DROP FUNCTION apply_ledger();
DROP FUNCTION guard_balance_write();

CREATE TABLE api_commands (
  idempotency_key uuid PRIMARY KEY,
  actor_id bigint NOT NULL REFERENCES users,
  action text NOT NULL,
  target_id text NOT NULL,
  request_hash text NOT NULL,
  status integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_commands_created_idx ON api_commands(created_at);
