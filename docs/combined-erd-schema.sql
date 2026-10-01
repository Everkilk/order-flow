-- Standalone PostgreSQL schema matching the three combined logical ERDs.
-- Run against a fresh database; this is not an application migration.

BEGIN;

CREATE SCHEMA orderflow;
SET LOCAL search_path = orderflow, pg_catalog;

CREATE TABLE categories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text,
    active boolean
);

CREATE TABLE category_attributes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id bigint NOT NULL REFERENCES categories (id),
    key text,
    data_type text,
    required boolean
);

CREATE TABLE units (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text UNIQUE,
    decimal_places integer
);

CREATE TABLE products (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku text UNIQUE,
    barcode text UNIQUE,
    name text,
    category_id bigint NOT NULL REFERENCES categories (id),
    unit_id bigint NOT NULL REFERENCES units (id),
    attributes jsonb,
    active boolean
);

CREATE TABLE suppliers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text,
    active boolean
);

CREATE TABLE product_suppliers (
    product_id bigint NOT NULL REFERENCES products (id),
    supplier_id bigint NOT NULL REFERENCES suppliers (id),
    supplier_sku text,
    primary_supplier boolean,
    PRIMARY KEY (product_id, supplier_id)
);

CREATE TABLE warehouses (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text UNIQUE,
    name text,
    active boolean
);

CREATE TABLE inventory_balances (
    warehouse_id bigint NOT NULL REFERENCES warehouses (id),
    product_id bigint NOT NULL REFERENCES products (id),
    on_hand numeric(20,6),
    reserved numeric(20,6),
    version bigint,
    PRIMARY KEY (warehouse_id, product_id)
);

CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email text UNIQUE,
    role text,
    active boolean
);

CREATE TABLE orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_number text UNIQUE,
    created_by bigint NOT NULL REFERENCES users (id),
    status text,
    confirmed_at timestamptz
);

CREATE TABLE order_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES orders (id),
    product_id bigint NOT NULL REFERENCES products (id),
    warehouse_id bigint NOT NULL REFERENCES warehouses (id),
    quantity numeric(20,6)
);

CREATE TABLE inventory_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type text,
    actor_id bigint NOT NULL REFERENCES users (id),
    idempotency_key uuid UNIQUE,
    occurred_at timestamptz,
    reason text
);

CREATE TABLE inventory_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL REFERENCES inventory_events (id),
    product_id bigint NOT NULL REFERENCES products (id),
    warehouse_id bigint NOT NULL REFERENCES warehouses (id),
    order_item_id bigint REFERENCES order_items (id),
    on_hand_delta numeric(20,6),
    reserved_delta numeric(20,6)
);

CREATE TABLE transfers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source_warehouse_id bigint NOT NULL REFERENCES warehouses (id),
    destination_warehouse_id bigint NOT NULL REFERENCES warehouses (id),
    created_by bigint NOT NULL REFERENCES users (id),
    status text,
    sent_at timestamptz
);

CREATE TABLE transfer_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id bigint NOT NULL REFERENCES transfers (id),
    product_id bigint NOT NULL REFERENCES products (id),
    requested_qty numeric(20,6),
    sent_qty numeric(20,6)
);

CREATE TABLE transfer_receipts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_id bigint NOT NULL REFERENCES transfers (id),
    received_by bigint NOT NULL REFERENCES users (id),
    idempotency_key uuid UNIQUE,
    received_at timestamptz,
    document_ref text
);

CREATE TABLE transfer_receipt_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    receipt_id bigint NOT NULL REFERENCES transfer_receipts (id),
    transfer_item_id bigint NOT NULL REFERENCES transfer_items (id),
    counted_qty numeric(20,6),
    accepted_qty numeric(20,6),
    quarantined_qty numeric(20,6)
);

CREATE TABLE transfer_discrepancies (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transfer_item_id bigint NOT NULL REFERENCES transfer_items (id),
    kind text,
    reported_qty numeric(20,6),
    status text
);

CREATE TABLE discrepancy_resolutions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    discrepancy_id bigint NOT NULL REFERENCES transfer_discrepancies (id),
    manager_id bigint NOT NULL REFERENCES users (id),
    resolution_type text,
    quantity numeric(20,6),
    reason text
);

COMMIT;
