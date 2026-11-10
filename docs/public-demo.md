# Public CV demo

The public demo displays Manager, Staff and Viewer credentials through `/api/demo-info`. This endpoint is disabled by default. Its three intentionally public passwords are configured on the backend, never fetched from password hashes or cloud credentials. Startup verifies that these passwords, roles and active-account states match the database before serving the demo.

## Enable safely

1. Back up PostgreSQL and run migrations, including `012_demo_limits.sql`.
2. Deploy the backend before publishing the updated frontend.
3. On the existing Render service, set `DEMO_MODE=true` and set `DEMO_MANAGER_PASSWORD`, `DEMO_STAFF_PASSWORD`, and `DEMO_VIEWER_PASSWORD` to the existing passwords intended for public display. This does not reset any account.
4. Startup inventories application objects in the existing private S3 bucket under `imports/`, `exports/`, and `evidence/`. Their existing byte sizes count toward the storage budget, including unreferenced objects. This requires ListBucket for these prefixes in addition to the existing object permissions. No bucket policy or IAM permission is changed automatically.
5. Verify readiness, public demo information, all three logins and refused account mutations. Then deploy the frontend and check the login table on desktop/mobile in both languages.

The account table autofills without submitting. User administration and password changes are read-only for every visitor while demo mode is enabled. Shared inventory workflows remain available; no automatic inventory reset runs.

## Defaults

| Environment setting | Default |
| --- | --- |
| `DEMO_CSV_ROWS` | 200 |
| `DEMO_CSV_BYTES` | 262144 (256 KiB) |
| `DEMO_EVIDENCE_BYTES` | 2097152 (2 MiB) |
| `DEMO_EXPORT_BYTES` | 2097152 (2 MiB) |
| `DEMO_JOB_COOLDOWN_SECONDS` | 10 |
| `DEMO_STORAGE_BYTES` | 52428800 (50 MiB) |
| `DEMO_TRANSFER_BYTES` | 1073741824 (1 GiB per calendar month, Asia/Saigon) |
| `DEMO_DATABASE_BYTES` | 209715200 (200 MiB) |
| `DEMO_REQUESTS_PER_MINUTE` | 300 across the API |
| `DEMO_ACCOUNT_REQUESTS_PER_MINUTE` | 120 per shared account |
| `DEMO_LOGINS_PER_MINUTE` | 20 across the demo |

There is **no daily import/export count limit**. Each account may have one queued/running import or export job; admission and cooldown checks happen under a database lock. Successful idempotent retries reuse the saved result and do not upload another copy. Files are parsed and checked before S3 publication.

Storage and transfer reservations are durable and serialized in PostgreSQL. Transfers conservatively count S3 uploads, worker reads, previews and downloads, including failed network attempts. Demo-mode S3 calls use one SDK attempt; the existing worker provides bounded retries. Failed transfers do not refund reserved traffic because AWS might already have transferred data. Storage remains charged until deletion succeeds. These limits govern application traffic, not unrelated use of the AWS account.

At a file or database limit, new resource-consuming actions receive an explanatory error; normal browsing, login/logout and worker cleanup remain available. Fast repeated reads are still subject to request throttling. Login prunes expired/revoked sessions and keeps at most six active sessions per account.

Notification streams are disabled in demo mode. The frontend polls every 30 seconds while visible and active, stops after five idle minutes, and resumes when the visitor returns.

## Retention and recovery

Exports cannot download after their seven-day expiry. The existing worker enqueues deletion of expired exports, terminal import files older than seven days, abandoned reservations and old unreferenced files. Active evidence attachments are preserved. Failed cleanup retains its reservation and uses bounded retries; DEAD cleanup tasks may be retried after an hour. Cleanup resumes when the free API wakes. It does not require a new scheduled service.

Do not truncate the usage tables to recover capacity. Inspect pending cleanup and missing objects first. Increase a documented environment limit only after checking the provider allowance. Keep backend demo protection enabled while public credentials are displayed; remove the public table before disabling demo mode.

## Provider limits and verification

The current Render database expires December 10, 2026. Application safeguards do not extend this expiry or guarantee that public traffic cannot exhaust provider allowances. AWS Billing could not be verified because its sign-in handoff stalled. Do not claim a current credit balance or zero-charge guarantee without reading the account's current plan. A Free AWS account plan stops at plan/credit expiry; Paid plans may bill beyond credits. Budget alerts are delayed notifications, not a universal spending cap.

Run `npm test` in `server/` and `npm run test:e2e -- public-demo.spec.ts --workers=1` in `frontend/`. The quota tests use isolated local PostgreSQL and a simulated S3 server, including concurrency, exact size boundaries, failed deletion, fresh-pool persistence and more than thirty successful jobs in a day. Do not load-test hosted free resources.
