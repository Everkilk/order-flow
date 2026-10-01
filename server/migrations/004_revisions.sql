-- Draft and catalog edit revisions prevent silent overwrites by concurrent editors.
SET LOCAL search_path = orderflow, pg_catalog;
ALTER TABLE products ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE orders ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE receipts ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE order_returns ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE transfers ADD COLUMN revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0);
