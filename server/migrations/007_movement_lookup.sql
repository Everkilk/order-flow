SET LOCAL search_path = orderflow, pg_catalog;

-- Latest movements for one warehouse, plus source/action lookups in large histories.
CREATE INDEX ledger_warehouse_id_idx ON inventory_ledger(warehouse_id, id DESC);
CREATE INDEX ledger_event_id_idx ON inventory_ledger(event_id, id DESC);
CREATE INDEX inventory_events_type_id_idx ON inventory_events(event_type, id DESC);
