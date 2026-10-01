# OrderFlow backend

OrderFlow is a small Express and PostgreSQL service for catalog, warehouse stock,
orders, returns, transfers, and reviewed stock corrections. It has one API process
and one background worker. Stock events, ledger rows, balances, document status,
and notifications are written in one database transaction.
For runnable product-creation requests and a route-to-database walkthrough, see
[API.md](API.md).

## Run locally

Use Node.js 24 and PostgreSQL 18. Copy `.env.example` to `.env` and set a local
`DATABASE_URL`. Then run these commands from `server/`:

```sh
npm ci
npm run db:create
npm run db:migrate
npm run setup:admin
npm run dev
```

`setup:admin` prompts for the initial manager password. Start the worker in another
terminal with `npm run build` followed by `npm run worker`. The API defaults to
`http://127.0.0.1:3000`. `GET /health/live` checks the process and
`GET /health/ready` checks that migration 010 is installed. Run `npm test` for the
database, HTTP, concurrency, worker, and demo checks. `npm run db:demo` shows a
stock lifecycle and rolls its example rows back.

## Main API

All application routes use `/api`. Sign in through `POST /auth/login`; the API
returns a secure HTTP-only session cookie in production. Change the temporary
password through `POST /auth/change-password` before using other routes.
Repeated failed sign-ins are temporarily limited per email and client IP, so
one account's mistakes do not block a different account behind the same proxy.

| Area | Routes |
| --- | --- |
| Catalog | `/products`, `/categories`, `/units`, `/suppliers`, `/warehouses` |
| Inventory | `/stock`, `/movements`, `/reports/low-stock`, `/reports/movements` |
| Documents | `/receipts`, `/orders`, `/returns`, `/transfers` |
| Review | `/transfers/:id/shortages`, `/discrepancies/:id/resolve`, `/stock-requests` |
| Support | `/notifications`, `/imports/products`, `/exports` |
| Evidence | `/evidence/discrepancies/:id`, `/evidence/stock-requests/:id` |
| Dashboard | `/dashboard` with role-scoped stock and work counts |
| Valuation | `/reports/valuation` for managers |
| Administration | `/users`, `/users/:id`, and manager password reset |

Create a draft document, save its items with `expectedRevision`, then call its
action endpoint (for example, `POST /orders/:id/confirm`). Stock-changing actions
require a UUID `Idempotency-Key` header. Repeating the same request with the same
key returns the original result; reusing a key for a different request is rejected.
Quantities are decimal strings such as `"2.000000"`. List endpoints use a
`nextCursor` for pagination. Staff and viewers see only assigned warehouses;
managers can see all warehouses.
Staff can read their own receipts, returns, and stock-change requests, subject
to warehouse access where applicable. Transfer records are visible at either
assigned endpoint warehouse so receiving staff can act on incoming transfers.
Product create/update requests can include `description` and an external
`imageUrl`; the API stores the image URL without fetching remote content.
Managers can list users with `GET /api/users`, inspect assignments with
`GET /api/users/:id`, and reset a password with
`POST /api/users/:id/reset-password` and `{"temporaryPassword":"..."}`.
Reset revokes existing sessions and requires the user to change that password
on the next sign-in.

`GET /api/movements` supports `warehouseId`, `productId`, exact `sku`,
`eventType`, `actorId`, exact document `reference`, and `from`/`to` ISO
timestamps. The end timestamp is exclusive. Combine filters with `limit` and
`cursor` to page through history; each row includes the source document ID.
The reference filter accepts order, receipt, return, and transfer numbers.
`GET /api/stock` accepts `availability=AVAILABLE` or `OUT_OF_STOCK` alongside
the warehouse and product filters. Fully reserved stock is out of stock because
its available quantity is zero.
`GET /api/notifications/stream` is a session-authenticated Server-Sent Events
stream. It emits a `notification` event with the newest ID when stored alerts
change; the browser then fetches the notification feed. A reconnect can pass
`since=<last ID>` or the `Last-Event-ID` header. The stream rechecks the
session while open.
The dashboard returns counts as decimal strings and gives viewers stock counts,
staff their operational queues, and managers approval queues plus valuation.
Valuation uses current on-hand stock multiplied by each product's primary
supplier cost, grouped by currency. Stock without a primary supplier cost is
counted separately as `unvaluedStockRows`; currencies are never combined.

The API owns business workflows. PostgreSQL still enforces keys, checks, product
attribute validity, append-only history, and the requirement that posted documents
have matching inventory events. Migrations 005 and 006 replace the older SQL stock
commands. Do not call the functions from migration 003 against a current database.

## CSV jobs

Import is a two-step process: upload `multipart/form-data` with one `.csv`
file in the `file` field, poll
`GET /api/imports/:id` until it is `READY`, then call
`POST /api/imports/:id/commit` using the returned `commitKey` as the
`Idempotency-Key`. The worker validates rows and reports up to 1,000 errors. A
review screen can call `GET /api/imports/:id/preview` after validation to show
the CSV columns, first 20 rows, whether more rows exist, and row-level errors.
Committing inserts the entire file in one transaction. Each file supports up to 10,000
rows and 20 MB; split larger imports into several files.
The worker records a fingerprint of each newly validated CSV and rejects a commit
if the file changes after review.

Managers can upload products and opening stock; staff can upload draft outbound
orders for assigned warehouses. Upload routes and required CSV columns are:

```text
POST /api/imports/products
sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json

POST /api/imports/opening-stock
receipt_number,warehouse_id,sku,quantity,unit_cost,currency

POST /api/imports/orders
order_number,warehouse_id,sku,quantity,unit_price,currency
```

Leave optional amount and currency cells blank together. `attributes_json` is a
JSON object, with normal CSV quoting around it. Product SKUs must be new; an
import does not overwrite products. Repeated receipt or order numbers group
lines into one document, with at most 200 lines per document. Opening stock
creates posted receipts and cannot start a product/warehouse balance twice.
Order imports create drafts only; confirming each order later reserves its stock.
The worker rechecks references and warehouse access when committing.
Staff and managers can attach one PNG, JPEG, or PDF file (up to 5 MB) at a time
to a transfer discrepancy or stock-change request using multipart `file`.
`GET` on the same evidence route lists attachments; `GET /api/evidence/:id/file`
downloads one after the same warehouse/ownership check. Evidence uses `DATA_DIR`
locally and a private S3 bucket when `STORAGE_DRIVER=s3`.

Request a CSV export with `POST /api/exports` and a body such as
`{"kind":"STOCK","warehouseId":"1"}`. Kinds are `PRODUCTS`, `STOCK`,
`MOVEMENTS`, and `REPORT` (the low-stock report). Poll `GET /api/exports/:id`,
then download `GET /api/exports/:id/file` after it reaches `DONE`. Exports and
uploads use `DATA_DIR` locally; production API and worker instances use the same
private S3 bucket. Job
leases and retries let the worker resume after a restart.

## Local Docker pilot

`compose.yaml` runs PostgreSQL 18, a one-time migration task, the API, and the
worker. Copy `.env.production.example` to `.env.production`, set a long unique
database password in both `POSTGRES_PASSWORD` and `DATABASE_URL`, set the real
`APP_ORIGIN`, and keep the file out of source control. URL-encode reserved
characters in the password portion of `DATABASE_URL`. Run from `server/`:

```sh
docker compose up -d --build
docker compose ps
```

On a fresh database, create the initial manager through the API image:

```sh
docker compose run --rm api node scripts/setup-admin.mjs manager@example.com "Initial manager"
```

The command prompts for a password and refuses to run after any user exists.

The API port is bound to loopback. Put an HTTPS reverse proxy in front of it and
serve the browser from the configured origin. Keep the PostgreSQL and job-data
volumes persistent, back up PostgreSQL and the job-data volume, and test a restore
before using real inventory. Run migrations before starting a new API version.
For the Vercel frontend and Render API/worker/PostgreSQL deployment, see
[deployment guide](../docs/deployment.md) and the repository-root `render.yaml`.

Current scope is a single API instance and one worker, with in-app notifications
and CSV jobs. Browser push, Telegram delivery, and XLSX files are optional later
integrations. CSV exports read pages of live data, so values may change while a
long export is being created.

For a local performance check, run `npm run benchmark:search`,
`npm run benchmark:movements`, or `npm run benchmark:orders`.
Set `BENCH_PRODUCTS` (up to 1,000,000) or
`BENCH_MOVEMENTS` (up to 10,000,000) to change the synthetic dataset size.
Set `BENCH_STOCK=1` with the search benchmark to add one balance, supplier
cost, and occasional low-stock threshold per product and measure dashboard,
stock, valuation, and low-stock reads.
Each benchmark creates and removes a separate local database. The movement
benchmark seeds synthetic ledger rows to measure read queries; it does not
measure inventory-command write throughput.
The order benchmark posts 200 independent confirmations in parallel by default,
checks that every reservation committed, and accepts `BENCH_ORDERS` up to 500.
