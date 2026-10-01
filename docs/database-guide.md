# Using the OrderFlow database

The physical schema is in `server/migrations`. It uses PostgreSQL 18 and the approved logical design. The `orderflow` **database** contains an `orderflow` **schema**, which groups our tables, views, and functions. A name such as `orderflow.products` means the `products` table inside that schema.

The current backend is described in [server/README.md](../server/README.md). This guide also preserves the earlier SQL-command lesson. On a current database, inventory workflows run through the API; the old lesson file applies only through migration 004.

For a visual map, open the [editable database ERD](erd/orderflow.drawio) or browse its [overview and detailed PNG pages](erd/README.md).

## Run it locally

Open a terminal in the server folder:

```powershell
cd E:\Projects\ProjectX\OrderFlow\server
npm run db:create
npm run db:migrate
npm run db:status
```

The scripts read `DATABASE_URL` from `server/.env`. The existing `.env.example` shows the format. Keep your actual password in `.env`, which is ignored by Git. On another computer, copy `.env.example` to `.env`, fill in the local connection, and install the server dependencies with `npm ci`. Node 20.20 or newer is sufficient for these scripts.

`db:create` creates the local database named in the connection string if it is missing. It does not recreate an existing database. `db:migrate` applies each new SQL file once, in order. Each file runs in a transaction, so a failure rolls back that file. Applied filenames and checksums are recorded in `public.orderflow_schema_migrations`. Re-running the command skips unchanged migrations.

The files have different jobs:

| File | What it creates |
| --- | --- |
| `001_schema.sql` | Tables, keys, column constraints, indexes, and stock/discrepancy views. |
| `002_guards.sql` | Attribute validation, immutable history, and checks across related records; its automatic balance writer is replaced by migration 005. |
| `003_commands.sql` | Historical stock command functions, removed by migration 006. |
| `004_revisions.sql` | Draft document and product revision columns. |
| `005_backend_stock.sql` | Backend balance writing and command idempotency records. |
| `006_retire_sql_commands.sql` | Removes obsolete SQL stock commands. |

After a migration has been applied, keep it unchanged. A future schema change belongs in a new numbered file. Never run the creation files repeatedly by hand against an existing schema.

## See the order flow work

```powershell
npm run db:demo
```

The demonstration creates a fictional phone, receives 10 units, creates an order for 3, confirms it, retries confirmation, and fulfills it. It also attempts your two invalid attribute examples and prints the database's rejection messages. All example rows are rolled back at the end, including the example account. Identity sequences may advance; gaps in IDs are normal.

You should see:

| Situation | On hand | Reserved | Available |
| --- | ---: | ---: | ---: |
| Received 10 | 10 | 0 | 10 |
| Draft order for 3 | 10 | 0 | 10 |
| Confirmed order | 10 | 3 | 7 |
| Retried the same confirmation | 10 | 3 | 7 |
| Fulfilled order | 7 | 0 | 7 |

`available` is a generated column: PostgreSQL computes `on_hand - reserved`. You never enter it yourself. In-transit goods and unverified excess are outside accepted on-hand stock and are shown by the transfer views.

## Use pgAdmin or another SQL editor

Connect to your local PostgreSQL server and choose the **orderflow database**. In pgAdmin, open its Query Tool. Refresh the browser tree, then expand **Schemas → orderflow → Tables** to inspect the physical tables. Views and Functions are in their own folders under the same schema.

[`inventory-lesson.sql`](../server/examples/inventory-lesson.sql) is a historical lesson for an isolated database migrated only through 004. On a current database, use `npm run db:demo` to see the same flow through the backend writer. If you stop on an error while practicing inside a transaction, run `ROLLBACK;` before trying again.

To see all table names:

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'orderflow' AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

The application database starts without real users or products. The demonstration deliberately does not leave demo data behind. A real manager account needs an Argon2id password hash created by the authentication setup; the lesson's disabled password placeholder must not be used as a real credential.

## How to read the schema

`PRIMARY KEY` identifies one row. `GENERATED ALWAYS AS IDENTITY` asks PostgreSQL to assign its numeric ID. `REFERENCES` is a foreign key: `products.category_id REFERENCES categories` requires that category to exist. `UNIQUE` prevents duplicate values or pairs, such as two identical SKUs or two balances for the same product and warehouse. `CHECK` rejects invalid values, such as negative stock.

`numeric(20,6)` stores quantities as exact decimals with six fractional digits. Each product's unit sets a tighter allowed precision: a piece has zero decimal places, so half a phone is rejected. Money also uses exact decimals and a VND/USD currency code. PostgreSQL `bigint` IDs and `numeric` values are returned as strings by the Node `pg` driver by default; keep that precision instead of blindly converting money or large IDs into JavaScript numbers.

`timestamptz` records an instant. The app can display it in the user's timezone. `jsonb` stores a structured JSON value. A trigger is database code that runs when a row is written; our product trigger validates JSONB against category definitions. Some consistency checks run at transaction commit, after all the related rows have been written.

## Category definitions and product values

The definition might say:

```text
category: Phone
key: screen_size_inches
data_type: number
required: true
unit_label: inches
min_value: 0.1
```

A matching product stores its value in `products.attributes`:

```json
{"screen_size_inches": 6.1}
```

The database rejects unknown keys such as `dpi` until a manager defines them for that category. It also rejects a missing required screen size, JSON `null`, the string `"6.1"` where a number is required, and a number outside the defined range. Optional fields may be omitted. Providing a supported optional field still requires the correct type.

To inspect definitions and values:

```sql
SELECT c.name AS category, a.key, a.data_type, a.required,
       a.unit_label, a.min_value, a.max_value
FROM orderflow.category_attributes a
JOIN orderflow.categories c ON c.id = a.category_id
ORDER BY c.name, a.key;

SELECT sku, name, attributes,
       attributes ->> 'screen_size_inches' AS screen_size_text
FROM orderflow.products
ORDER BY id
LIMIT 20;
```

Changing an attribute definition validates existing products too. To add a new required attribute to a populated category, add it as optional, fill in the existing products' values, then mark it required. Removing or renaming a used key also requires migrating its product values. These changes can be expensive on a large category, so they belong in a deliberate data migration.

## Read stock and its history

Use the prepared view for ordinary stock reads:

```sql
SELECT warehouse_code, sku, product_name, on_hand, reserved, available
FROM orderflow.current_inventory
ORDER BY warehouse_id, product_id
LIMIT 50;
```

See the reason for a balance change:

```sql
SELECT l.id, e.event_type, p.sku, w.code AS warehouse,
       l.on_hand_delta, l.reserved_delta,
       l.on_hand_before, l.on_hand_after,
       l.reserved_before, l.reserved_after,
       u.display_name AS actor, e.reason, e.occurred_at
FROM orderflow.inventory_ledger l
JOIN orderflow.inventory_events e ON e.id = l.event_id
JOIN orderflow.products p ON p.id = l.product_id
JOIN orderflow.warehouses w ON w.id = l.warehouse_id
JOIN orderflow.users u ON u.id = e.actor_id
ORDER BY l.id DESC
LIMIT 50;
```

An **event** is one action, such as confirming an order. Its **ledger rows** describe the effect on individual product/warehouse balances. A three-item order can create one confirmation event with three ledger rows. On a current database, the backend writes before/after values and balances in the same transaction. Posted history remains append-only.

## Historical SQL inventory commands (through migration 004)

Before migration 005, catalog records and draft documents were inserted with ordinary SQL and stock was posted with the functions below. Migration 006 removes these functions. Current clients call the HTTP API; this section explains the old lesson and should not be followed against a current database.

| Function | Effect |
| --- | --- |
| `post_receipt(receipt_id, actor_id, key)` | Adds all receipt quantities; opening stock requires a manager. |
| `confirm_order(order_id, actor_id, key)` | Reserves every order line or fails without reserving any line. |
| `cancel_order(order_id, actor_id, key)` | Releases a confirmed order's reservation. |
| `fulfill_order(order_id, actor_id, key)` | Deducts all confirmed order quantities and their reservations. |
| `post_order_return(return_id, actor_id, key)` | Receives returned quantities without exceeding what was fulfilled. |
| `send_transfer(transfer_id, actor_id, key)` | Sends every requested transfer quantity into transit. |

For example, with actual existing IDs substituted:

```sql
SELECT orderflow.confirm_order(
  42, -- order ID
  7,  -- actor ID, supplied by the authenticated backend
  '68dc246b-3a9c-48b3-91cf-d60d6a181718'::uuid
);
```

A successful command returns its `inventory_events.id`. If the response is lost, retry the same action with the same key; it returns that event without changing stock again. A different action gets a new key. A key reused for another actor, document, or action is rejected. Do not generate a new key on each network retry.

The confirmation command locks the affected stock rows in warehouse/product order. If another order took the last available quantity, confirmation fails. A stock document's status is updated together with its ledger entries. Changing `orders.status` to `CONFIRMED` on its own fails at commit because the reservation event is missing.

These functions ran with the SQL caller's permissions. They did not authenticate a browser or prove that a supplied actor ID belonged to the caller. The current API checks sessions and warehouse access before running a backend transaction.

## Transfers, approvals, and supporting modules

`transfer_item_balances` shows sent, received, in-transit, and quarantined quantities. `discrepancy_status` derives the remaining disputed quantity from append-only reports and resolutions. A receipt line cannot accept more than is still in transit; extra counted stock belongs in `quarantined_qty`. A manager resolution cannot exceed the unresolved quantity. A transfer cannot be closed while transit, quarantine, or a reported discrepancy remains unresolved.

For transfer receipt posting, the backend transaction creates the receipt and its lines, creates a `TRANSFER_RECEIVE` event, and inserts a ledger row for each positive accepted quantity. Excess reports and notifications are added in that same transaction. Each receipt has a unique idempotency key. Shortages are reported through a separate API action.

`stock_change_requests` holds the original request. `stock_change_decisions` holds its immutable approval or rejection. A stock-count approval includes the balance version that the manager reviewed and the recalculated difference; stale versions are rejected. An approved decision and its adjustment event must commit together. An approved loss-in-transit resolution changes transit accounting without another warehouse deduction, because sending already removed that stock from the source.

Generic full reversal is supported for receipt, opening, and adjustment events. Order cancellations, returns, and transfer corrections use their corresponding workflows so a generic reversal cannot leave an order's reservation/status inconsistent. Verified excess may need a separate documented source correction if evidence shows additional goods left the sending warehouse; accepting excess alone does not assume its origin.

The backend uses sessions, in-app notifications, a live notification stream, background jobs, product imports, CSV exports, and report queries. Migrations 007 and 008 add indexes for movement lookups and notification paging. Evidence files, browser push, Telegram delivery, and the outbox/delivery-attempt tables remain extension points. Report aggregation tables can be introduced if the current indexed queries outgrow the pilot workload.

## Verify changes

```powershell
npm run db:test
```

The tests create a uniquely named temporary local database, apply the migrations, exercise the rules, then delete only that test database. They require permission to create databases and never reset the application database. Tests cover attribute errors, immutable history, complete events, reservation races, duplicate requests, cancellation, excessive returns, transfer shortages and excess, count approvals, reversals, and balance/ledger reconciliation.

PostgreSQL references: [constraints](https://www.postgresql.org/docs/18/ddl-constraints.html), [transactions](https://www.postgresql.org/docs/18/tutorial-transactions.html), and [JSON types](https://www.postgresql.org/docs/18/datatype-json.html).
