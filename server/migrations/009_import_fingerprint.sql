SET LOCAL search_path = orderflow, pg_catalog;

-- New validations save the exact CSV version that was reviewed before commit.
ALTER TABLE import_jobs ADD COLUMN validated_sha256 text
  CHECK (validated_sha256 ~ '^[0-9a-f]{64}$');
