SET LOCAL search_path = orderflow, pg_catalog;

CREATE TABLE mutation_results (
  key uuid PRIMARY KEY,
  actor_id bigint NOT NULL REFERENCES users,
  operation text NOT NULL,
  access_context text NOT NULL,
  salt text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mutation_results_created_idx ON mutation_results(created_at);

ALTER TABLE api_commands ADD COLUMN access_context jsonb;
UPDATE api_commands c SET access_context=jsonb_build_object('role',u.role,'warehouses',
  coalesce((SELECT jsonb_agg(uw.warehouse_id::text ORDER BY uw.warehouse_id)
    FROM user_warehouses uw WHERE uw.user_id=u.id),'[]'::jsonb))
  FROM users u WHERE c.actor_id=u.id;

CREATE TABLE evidence_removals (
  file_id bigint PRIMARY KEY REFERENCES evidence_files,
  request_id bigint NOT NULL REFERENCES stock_change_requests,
  removed_by bigint NOT NULL REFERENCES users,
  removed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX evidence_removals_request_idx ON evidence_removals(request_id, file_id);
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON evidence_removals
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON evidence_removals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();
