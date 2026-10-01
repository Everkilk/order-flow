-- PostgreSQL 18. Applied inside a transaction by scripts/db.mjs.
CREATE SCHEMA orderflow;
REVOKE CREATE ON SCHEMA orderflow FROM PUBLIC;
SET LOCAL search_path = orderflow, pg_catalog;

CREATE DOMAIN quantity AS numeric(20,6)
  CHECK (VALUE >= 0 AND VALUE <> 'NaN'::numeric);
CREATE DOMAIN positive_quantity AS numeric(20,6)
  CHECK (VALUE > 0 AND VALUE <> 'NaN'::numeric);
CREATE DOMAIN money_amount AS numeric(20,4)
  CHECK (VALUE >= 0 AND VALUE <> 'NaN'::numeric);
CREATE DOMAIN currency_code AS text CHECK (VALUE IN ('VND', 'USD'));

CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email text NOT NULL CHECK (btrim(email) <> ''),
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('MANAGER','STAFF','VIEWER')),
  active boolean NOT NULL DEFAULT true,
  must_change_password boolean NOT NULL DEFAULT true,
  locale text NOT NULL DEFAULT 'en' CHECK (locale IN ('en','vi')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id bigint NOT NULL REFERENCES users,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE warehouses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  address text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_warehouses (
  user_id bigint NOT NULL REFERENCES users,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  PRIMARY KEY (user_id, warehouse_id)
);
CREATE INDEX user_warehouses_warehouse_idx ON user_warehouses(warehouse_id);
CREATE TABLE units (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  decimal_places integer NOT NULL DEFAULT 0 CHECK (decimal_places BETWEEN 0 AND 6)
);
CREATE TABLE categories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE category_attributes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  category_id bigint NOT NULL REFERENCES categories,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  label text NOT NULL,
  data_type text NOT NULL CHECK (data_type IN ('string','number','boolean')),
  required boolean NOT NULL DEFAULT false,
  unit_label text,
  min_value numeric,
  max_value numeric,
  allowed_values jsonb,
  UNIQUE (category_id, key),
  CHECK (min_value IS NULL OR min_value <> 'NaN'::numeric),
  CHECK (max_value IS NULL OR max_value <> 'NaN'::numeric),
  CHECK (min_value IS NULL OR max_value IS NULL OR min_value <= max_value),
  CHECK (data_type = 'number' OR (min_value IS NULL AND max_value IS NULL)),
  CHECK (allowed_values IS NULL OR
    (jsonb_typeof(allowed_values) = 'array' AND allowed_values <> '[]'::jsonb))
);
CREATE TABLE products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sku text NOT NULL UNIQUE CHECK (btrim(sku) <> ''),
  barcode text UNIQUE CHECK (barcode IS NULL OR btrim(barcode) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  category_id bigint NOT NULL REFERENCES categories,
  unit_id bigint NOT NULL REFERENCES units,
  attributes jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(attributes) = 'object'),
  selling_price money_amount,
  selling_currency currency_code,
  image_url text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((selling_price IS NULL) = (selling_currency IS NULL))
);
CREATE INDEX products_category_idx ON products(category_id, id);
CREATE INDEX products_unit_idx ON products(unit_id);
CREATE INDEX products_name_prefix_idx ON products(lower(name) text_pattern_ops);
CREATE INDEX products_sku_prefix_idx ON products(sku text_pattern_ops);
CREATE INDEX products_name_search_idx ON products USING gin
  (to_tsvector('simple', name));
CREATE TABLE suppliers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text,
  phone text,
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE product_suppliers (
  product_id bigint NOT NULL REFERENCES products,
  supplier_id bigint NOT NULL REFERENCES suppliers,
  supplier_sku text,
  primary_supplier boolean NOT NULL DEFAULT false,
  cost money_amount,
  currency currency_code,
  PRIMARY KEY (product_id, supplier_id),
  CHECK ((cost IS NULL) = (currency IS NULL))
);
CREATE INDEX product_suppliers_supplier_idx ON product_suppliers(supplier_id);
CREATE UNIQUE INDEX product_primary_supplier_uq ON product_suppliers(product_id)
  WHERE primary_supplier;
CREATE TABLE low_stock_thresholds (
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  product_id bigint NOT NULL REFERENCES products,
  threshold quantity NOT NULL,
  critical_threshold quantity,
  PRIMARY KEY (warehouse_id, product_id),
  CHECK (critical_threshold IS NULL OR critical_threshold <= threshold)
);
CREATE TABLE inventory_balances (
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  product_id bigint NOT NULL REFERENCES products,
  on_hand quantity NOT NULL DEFAULT 0,
  reserved quantity NOT NULL DEFAULT 0,
  available numeric(20,6) GENERATED ALWAYS AS (on_hand - reserved) STORED,
  version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (warehouse_id, product_id),
  CHECK (reserved <= on_hand)
);
CREATE INDEX inventory_balances_product_idx ON inventory_balances(product_id, warehouse_id);

CREATE TABLE orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_number text NOT NULL UNIQUE,
  created_by bigint NOT NULL REFERENCES users,
  assigned_to bigint REFERENCES users,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','CONFIRMED','FULFILLED','CANCELLED')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  fulfilled_at timestamptz,
  cancelled_at timestamptz
);
CREATE INDEX orders_status_idx ON orders(status, created_at DESC, id DESC);
CREATE INDEX orders_creator_idx ON orders(created_by, id DESC);
CREATE INDEX orders_assignee_idx ON orders(assigned_to, id DESC);
CREATE TABLE order_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES orders,
  product_id bigint NOT NULL REFERENCES products,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  quantity positive_quantity NOT NULL,
  unit_price money_amount,
  currency currency_code,
  UNIQUE (order_id, warehouse_id, product_id),
  UNIQUE (id, order_id),
  CHECK ((unit_price IS NULL) = (currency IS NULL))
);
CREATE INDEX order_items_product_idx ON order_items(product_id, warehouse_id);
CREATE TABLE receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_number text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('OPENING','INBOUND')),
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  supplier_id bigint REFERENCES suppliers,
  created_by bigint NOT NULL REFERENCES users,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz
);
CREATE INDEX receipts_warehouse_idx ON receipts(warehouse_id, id DESC);
CREATE TABLE receipt_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id bigint NOT NULL REFERENCES receipts,
  product_id bigint NOT NULL REFERENCES products,
  quantity positive_quantity NOT NULL,
  unit_cost money_amount,
  currency currency_code,
  UNIQUE (receipt_id, product_id),
  CHECK ((unit_cost IS NULL) = (currency IS NULL))
);
CREATE TABLE order_returns (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_number text NOT NULL UNIQUE,
  order_id bigint NOT NULL REFERENCES orders,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  received_by bigint NOT NULL REFERENCES users,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','POSTED')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, order_id)
);
CREATE TABLE order_return_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  return_id bigint NOT NULL,
  order_id bigint NOT NULL,
  order_item_id bigint NOT NULL,
  quantity positive_quantity NOT NULL,
  FOREIGN KEY (return_id, order_id) REFERENCES order_returns(id, order_id),
  FOREIGN KEY (order_item_id, order_id) REFERENCES order_items(id, order_id),
  UNIQUE (return_id, order_item_id)
);
CREATE INDEX order_return_items_original_idx ON order_return_items(order_item_id);

CREATE TABLE transfers (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_number text NOT NULL UNIQUE,
  source_warehouse_id bigint NOT NULL REFERENCES warehouses,
  destination_warehouse_id bigint NOT NULL REFERENCES warehouses,
  created_by bigint NOT NULL REFERENCES users,
  assigned_to bigint REFERENCES users,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN
    ('DRAFT','SENT','PARTIALLY_RECEIVED','DISPUTED','RECEIVED','RESOLVED','CANCELLED')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK (source_warehouse_id <> destination_warehouse_id)
);
CREATE INDEX transfers_source_idx ON transfers(source_warehouse_id, status, id DESC);
CREATE INDEX transfers_destination_idx ON transfers(destination_warehouse_id, status, id DESC);
CREATE TABLE transfer_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id bigint NOT NULL REFERENCES transfers,
  product_id bigint NOT NULL REFERENCES products,
  requested_qty positive_quantity NOT NULL,
  sent_qty quantity NOT NULL DEFAULT 0,
  UNIQUE (transfer_id, product_id),
  UNIQUE (id, transfer_id),
  CHECK (sent_qty <= requested_qty)
);
CREATE TABLE transfer_receipts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id bigint NOT NULL REFERENCES transfers,
  received_by bigint NOT NULL REFERENCES users,
  idempotency_key uuid NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  document_ref text,
  note text,
  UNIQUE (id, transfer_id)
);
CREATE TABLE transfer_receipt_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  receipt_id bigint NOT NULL,
  transfer_id bigint NOT NULL,
  transfer_item_id bigint NOT NULL,
  counted_qty quantity NOT NULL,
  accepted_qty quantity NOT NULL,
  quarantined_qty quantity NOT NULL,
  FOREIGN KEY (receipt_id, transfer_id) REFERENCES transfer_receipts(id, transfer_id),
  FOREIGN KEY (transfer_item_id, transfer_id) REFERENCES transfer_items(id, transfer_id),
  UNIQUE (receipt_id, transfer_item_id),
  UNIQUE (id, transfer_item_id),
  CHECK (counted_qty = accepted_qty + quarantined_qty)
);
CREATE INDEX transfer_receipt_items_item_idx ON transfer_receipt_items(transfer_item_id);
CREATE TABLE transfer_discrepancies (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_item_id bigint NOT NULL REFERENCES transfer_items,
  receipt_item_id bigint,
  kind text NOT NULL CHECK (kind IN ('SHORTAGE','EXCESS')),
  reported_qty positive_quantity NOT NULL,
  reported_by bigint NOT NULL REFERENCES users,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (receipt_item_id, transfer_item_id) REFERENCES transfer_receipt_items(id, transfer_item_id)
);
CREATE INDEX transfer_discrepancies_item_idx ON transfer_discrepancies(transfer_item_id);
CREATE TABLE discrepancy_resolutions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  discrepancy_id bigint NOT NULL REFERENCES transfer_discrepancies,
  manager_id bigint NOT NULL REFERENCES users,
  resolution_type text NOT NULL CHECK (resolution_type IN
    ('LOSS','DISPATCH_CORRECTION','LATER_RECEIPT','ACCEPT_EXCESS','RETURN_EXCESS')),
  quantity positive_quantity NOT NULL,
  later_receipt_item_id bigint REFERENCES transfer_receipt_items,
  idempotency_key uuid NOT NULL UNIQUE,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolution_type = 'LATER_RECEIPT') = (later_receipt_item_id IS NOT NULL))
);
CREATE INDEX discrepancy_resolutions_dispute_idx ON discrepancy_resolutions(discrepancy_id);

CREATE TABLE stock_change_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_type text NOT NULL CHECK (request_type IN ('DAMAGE','LOSS','COUNT','REVERSAL')),
  warehouse_id bigint REFERENCES warehouses,
  product_id bigint REFERENCES products,
  requested_by bigint NOT NULL REFERENCES users,
  requested_delta numeric(20,6) CHECK (requested_delta <> 'NaN'::numeric),
  counted_qty quantity,
  observed_on_hand quantity,
  observed_version bigint CHECK (observed_version >= 0),
  original_event_id bigint,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (request_type IN ('DAMAGE','LOSS') AND warehouse_id IS NOT NULL AND product_id IS NOT NULL
      AND requested_delta IS NOT NULL AND requested_delta < 0 AND original_event_id IS NULL)
    OR (request_type = 'COUNT' AND warehouse_id IS NOT NULL AND product_id IS NOT NULL
      AND counted_qty IS NOT NULL AND observed_on_hand IS NOT NULL AND observed_version IS NOT NULL
      AND original_event_id IS NULL)
    OR (request_type = 'REVERSAL' AND original_event_id IS NOT NULL
      AND warehouse_id IS NULL AND product_id IS NULL)
  )
);
CREATE TABLE stock_change_decisions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL UNIQUE REFERENCES stock_change_requests,
  manager_id bigint NOT NULL REFERENCES users,
  decision text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  approved_delta numeric(20,6) CHECK (approved_delta <> 'NaN'::numeric),
  reviewed_balance_version bigint,
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'REJECTED' OR approved_delta IS NULL)
);
CREATE TABLE inventory_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type text NOT NULL CHECK (event_type IN
    ('OPENING','RECEIPT','ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL','ORDER_RETURN',
     'TRANSFER_SEND','TRANSFER_RECEIVE','TRANSFER_RESOLUTION','ADJUSTMENT','REVERSAL')),
  actor_id bigint NOT NULL REFERENCES users,
  idempotency_key uuid NOT NULL UNIQUE,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  order_id bigint REFERENCES orders,
  receipt_id bigint REFERENCES receipts,
  order_return_id bigint REFERENCES order_returns,
  transfer_id bigint REFERENCES transfers,
  transfer_receipt_id bigint REFERENCES transfer_receipts,
  resolution_id bigint REFERENCES discrepancy_resolutions,
  decision_id bigint REFERENCES stock_change_decisions,
  reversal_of_event_id bigint UNIQUE REFERENCES inventory_events,
  CHECK (num_nonnulls(order_id,receipt_id,order_return_id,transfer_id,
    transfer_receipt_id,resolution_id,decision_id) = 1),
  CHECK (
    (event_type IN ('OPENING','RECEIPT') AND receipt_id IS NOT NULL)
    OR (event_type IN ('ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL') AND order_id IS NOT NULL)
    OR (event_type = 'ORDER_RETURN' AND order_return_id IS NOT NULL)
    OR (event_type = 'TRANSFER_SEND' AND transfer_id IS NOT NULL)
    OR (event_type = 'TRANSFER_RECEIVE' AND transfer_receipt_id IS NOT NULL)
    OR (event_type = 'TRANSFER_RESOLUTION' AND resolution_id IS NOT NULL)
    OR (event_type IN ('ADJUSTMENT','REVERSAL') AND decision_id IS NOT NULL)
  ),
  CHECK ((event_type = 'REVERSAL') = (reversal_of_event_id IS NOT NULL))
);
ALTER TABLE stock_change_requests ADD FOREIGN KEY (original_event_id) REFERENCES inventory_events;
CREATE UNIQUE INDEX event_order_action_uq ON inventory_events(order_id, event_type) WHERE order_id IS NOT NULL;
CREATE UNIQUE INDEX event_receipt_uq ON inventory_events(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE UNIQUE INDEX event_return_uq ON inventory_events(order_return_id) WHERE order_return_id IS NOT NULL;
CREATE UNIQUE INDEX event_transfer_send_uq ON inventory_events(transfer_id) WHERE transfer_id IS NOT NULL;
CREATE UNIQUE INDEX event_transfer_receipt_uq ON inventory_events(transfer_receipt_id) WHERE transfer_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX event_resolution_uq ON inventory_events(resolution_id) WHERE resolution_id IS NOT NULL;
CREATE UNIQUE INDEX event_decision_uq ON inventory_events(decision_id) WHERE decision_id IS NOT NULL;
CREATE INDEX inventory_events_actor_idx ON inventory_events(actor_id, occurred_at DESC, id DESC);
CREATE TABLE inventory_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES inventory_events,
  product_id bigint NOT NULL REFERENCES products,
  warehouse_id bigint NOT NULL REFERENCES warehouses,
  order_item_id bigint REFERENCES order_items,
  receipt_item_id bigint REFERENCES receipt_items,
  return_item_id bigint REFERENCES order_return_items,
  transfer_item_id bigint REFERENCES transfer_items,
  transfer_receipt_item_id bigint REFERENCES transfer_receipt_items,
  on_hand_delta numeric(20,6) NOT NULL CHECK (on_hand_delta <> 'NaN'::numeric),
  reserved_delta numeric(20,6) NOT NULL CHECK (reserved_delta <> 'NaN'::numeric),
  on_hand_before quantity NOT NULL,
  reserved_before quantity NOT NULL,
  on_hand_after quantity NOT NULL,
  reserved_after quantity NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (on_hand_delta <> 0 OR reserved_delta <> 0),
  CHECK (on_hand_after = on_hand_before + on_hand_delta),
  CHECK (reserved_after = reserved_before + reserved_delta),
  CHECK (reserved_after <= on_hand_after)
);
CREATE INDEX ledger_product_warehouse_idx ON inventory_ledger(product_id, warehouse_id, id DESC);
CREATE INDEX ledger_warehouse_time_idx ON inventory_ledger(warehouse_id, created_at DESC, id DESC);
CREATE INDEX ledger_order_item_idx ON inventory_ledger(order_item_id) WHERE order_item_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_order_line_uq ON inventory_ledger(event_id,order_item_id) WHERE order_item_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_receipt_line_uq ON inventory_ledger(event_id,receipt_item_id) WHERE receipt_item_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_return_line_uq ON inventory_ledger(event_id,return_item_id) WHERE return_item_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_transfer_line_uq ON inventory_ledger(event_id,transfer_item_id) WHERE transfer_item_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_transfer_receipt_line_uq ON inventory_ledger(event_id,transfer_receipt_item_id) WHERE transfer_receipt_item_id IS NOT NULL;
CREATE UNIQUE INDEX ledger_adjustment_balance_uq ON inventory_ledger(event_id,warehouse_id,product_id)
  WHERE num_nonnulls(order_item_id,receipt_item_id,return_item_id,transfer_item_id,transfer_receipt_item_id) = 0;

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id bigint REFERENCES users,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_idx ON audit_events(entity_type, entity_id, id DESC);
CREATE TABLE evidence_files (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  uploaded_by bigint NOT NULL REFERENCES users,
  storage_key text NOT NULL UNIQUE,
  filename text NOT NULL,
  content_type text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE discrepancy_evidence (
  discrepancy_id bigint NOT NULL REFERENCES transfer_discrepancies,
  file_id bigint NOT NULL REFERENCES evidence_files,
  PRIMARY KEY (discrepancy_id, file_id)
);
CREATE TABLE stock_request_evidence (
  request_id bigint NOT NULL REFERENCES stock_change_requests,
  file_id bigint NOT NULL REFERENCES evidence_files,
  PRIMARY KEY (request_id, file_id)
);
CREATE TABLE notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users,
  event_id bigint REFERENCES inventory_events,
  event_class text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  target_path text,
  dedupe_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notifications_feed_idx ON notifications(user_id, created_at DESC, id DESC);
CREATE TABLE user_notification_preferences (
  user_id bigint NOT NULL REFERENCES users,
  event_class text NOT NULL,
  browser_push boolean NOT NULL DEFAULT false,
  telegram boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, event_class)
);
CREATE TABLE push_subscriptions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES users,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth_secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions(user_id);
CREATE TABLE telegram_links (
  user_id bigint PRIMARY KEY REFERENCES users,
  chat_id bigint NOT NULL UNIQUE,
  active boolean NOT NULL DEFAULT true,
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id bigint REFERENCES notifications,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox_events(available_at, id) WHERE status = 'PENDING';
CREATE TABLE delivery_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  outbox_id bigint NOT NULL REFERENCES outbox_events,
  channel text NOT NULL CHECK (channel IN ('WEB_PUSH','TELEGRAM')),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  result text NOT NULL CHECK (result IN ('SUCCESS','RETRY','PERMANENT_FAILURE')),
  error_code text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_id, channel, attempt_number)
);
CREATE TABLE background_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  requested_by bigint REFERENCES users,
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_pending_idx ON background_jobs(available_at, id) WHERE status = 'PENDING';
CREATE TABLE import_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL UNIQUE REFERENCES background_jobs,
  uploaded_by bigint NOT NULL REFERENCES users,
  kind text NOT NULL CHECK (kind IN ('PRODUCTS','OPENING_STOCK','ORDERS')),
  storage_key text NOT NULL,
  status text NOT NULL DEFAULT 'UPLOADED' CHECK (status IN ('UPLOADED','VALIDATING','INVALID','READY','COMMITTED','FAILED')),
  commit_key uuid NOT NULL UNIQUE,
  validated_rows integer CHECK (validated_rows >= 0),
  committed_at timestamptz
);
CREATE TABLE import_errors (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_id bigint NOT NULL REFERENCES import_jobs,
  row_number integer NOT NULL CHECK (row_number > 0),
  field text,
  message text NOT NULL
);
CREATE INDEX import_errors_import_idx ON import_errors(import_id, row_number);
CREATE TABLE export_jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL UNIQUE REFERENCES background_jobs,
  requested_by bigint NOT NULL REFERENCES users,
  kind text NOT NULL CHECK (kind IN ('PRODUCTS','STOCK','MOVEMENTS','REPORT')),
  format text NOT NULL CHECK (format IN ('CSV','XLSX')),
  filters jsonb NOT NULL DEFAULT '{}',
  storage_key text,
  expires_at timestamptz
);

CREATE VIEW current_inventory AS
SELECT b.warehouse_id, w.code AS warehouse_code, b.product_id, p.sku,
       p.name AS product_name, b.on_hand, b.reserved, b.available, b.version,
       t.threshold, (b.available <= t.threshold) AS low_stock
FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id
JOIN products p ON p.id = b.product_id
LEFT JOIN low_stock_thresholds t USING (warehouse_id, product_id);

CREATE VIEW discrepancy_status AS
SELECT d.*, coalesce(r.resolved_qty,0) AS resolved_qty,
       d.reported_qty - coalesce(r.resolved_qty,0) AS outstanding_qty,
       CASE WHEN coalesce(r.resolved_qty,0) = d.reported_qty THEN 'RESOLVED' ELSE 'OPEN' END AS status
FROM transfer_discrepancies d
LEFT JOIN (SELECT discrepancy_id, sum(quantity) AS resolved_qty
           FROM discrepancy_resolutions GROUP BY discrepancy_id) r ON r.discrepancy_id = d.id;

CREATE VIEW transfer_item_balances AS
SELECT i.id AS transfer_item_id, i.transfer_id, i.product_id, i.sent_qty,
       coalesce(rc.accepted,0) AS received_qty,
       i.sent_qty - coalesce(rc.accepted,0) - coalesce(rs.transit_settled,0) AS in_transit_qty,
       coalesce(rc.quarantined,0) - coalesce(rs.quarantine_settled,0) AS quarantined_qty
FROM transfer_items i
LEFT JOIN (SELECT transfer_item_id, sum(accepted_qty) AS accepted, sum(quarantined_qty) AS quarantined
           FROM transfer_receipt_items GROUP BY transfer_item_id) rc ON rc.transfer_item_id = i.id
LEFT JOIN (SELECT d.transfer_item_id,
  sum(r.quantity) FILTER (WHERE r.resolution_type IN ('LOSS','DISPATCH_CORRECTION')) AS transit_settled,
  sum(r.quantity) FILTER (WHERE r.resolution_type IN ('ACCEPT_EXCESS','RETURN_EXCESS')) AS quarantine_settled
  FROM discrepancy_resolutions r JOIN transfer_discrepancies d ON d.id = r.discrepancy_id
  GROUP BY d.transfer_item_id) rs ON rs.transfer_item_id = i.id;

COMMENT ON SCHEMA orderflow IS 'OrderFlow business data. Use migrations for structure and inventory commands for stock changes.';
COMMENT ON COLUMN products.attributes IS 'Values keyed by category_attributes.key; validated by database trigger.';
COMMENT ON TABLE inventory_balances IS 'Accepted warehouse stock only. Updated by inventory_ledger trigger.';
COMMENT ON TABLE inventory_ledger IS 'Append-only warehouse stock history; before/after values are assigned by trigger.';
