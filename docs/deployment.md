# OrderFlow deployment guide

The repository has three deployable pieces: `frontend/` is a Vite React single-page app on Vercel; `server/` builds one Render API and one Render background worker; Render PostgreSQL stores application data. A private S3 bucket stores CSV uploads, exports, and evidence so the API and worker see the same files. Do not deploy the local `server/compose.yaml` stack alongside these services.

## Local development

1. Use Node.js 24 and PostgreSQL 18. In `server/`, copy `.env.example` to `.env`, set `DATABASE_URL`, then run `npm ci`, `npm run db:migrate`, and `npm run setup:admin` for a fresh database. Existing local databases do not need to be reset.
2. Start the API with `npm run dev` in `server/`. Start the worker in another terminal with `npm run build` and `npm run worker`.
3. In `frontend/`, run `npm ci` and `npm run dev`. Vite proxies `/api` to `http://127.0.0.1:3000`. Open the Vite URL, sign in with the initial manager, and change the temporary password.
4. Local `STORAGE_DRIVER=filesystem` uses `server/data/`. Keep this directory out of Git and back it up with the database if it contains real data.

## Render database, API, and worker

The repository-root [`render.yaml`](../render.yaml) is a Render Blueprint for a paid PostgreSQL 18 instance, a web API, and one background worker in Singapore. Review its compute plans and region before creating resources; these choices affect cost and cannot all be changed later. Use the same Blueprint branch for the API and worker. Both services run the idempotent, advisory-locked migration command before deployment; wait for a successful migration and `/health/ready` before serving traffic. Never run the older SQL functions from migration 003 manually against a current database.

Create a private S3 bucket in a nearby region. Give both services credentials with only the bucket operations they need: `GetObject`, `PutObject`, and `DeleteObject` for `imports/*`, `exports/*`, and `evidence/*`, plus `ListBucket` limited to those prefixes. The app's existence check uses S3 `HeadObject`: it needs `GetObject`, and `ListBucket` lets S3 return 404 for a missing key instead of an ambiguous 403. Keep the bucket private, turn on encryption and versioning, and arrange backups or replication appropriate for your data. Set the following values in the Render Dashboard when the Blueprint prompts for them on **both** services:

| Variable | Value |
| --- | --- |
| `APP_ORIGIN` | The exact production Vercel origin, for example `https://inventory.example.com`, without a trailing slash |
| `S3_BUCKET` | Private bucket name |
| `AWS_REGION` | Bucket's AWS region |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Scoped IAM credentials; rotate and store only in Render secrets |

`DATABASE_URL`, `STORAGE_DRIVER=s3`, `DATA_DIR=/app/data`, and `NODE_ENV=production` are set by the Blueprint. `DATA_DIR` is temporary scratch space on each instance; it is **not** the shared file store or a backup. If you use an IAM role instead of access keys, remove the two credential prompts and configure the role in Render. Do not put secrets in the repository or Vercel browser environment variables.

After the first deploy, create the initial manager through a Render shell on the API image with `node scripts/setup-admin.mjs manager@example.com "Initial manager"`. The script prompts for the password and refuses to run if a user already exists. Confirm `/health/live` and `/health/ready`, then test manager login, a small import, export download, and evidence upload/download. The worker must be running for jobs to finish.

## Vercel frontend

Import this Git repository as a Vercel project and set **Root Directory** to `frontend`. Use the Vite framework preset, `npm ci` install, `npm run build` build, and `dist` output. [`frontend/vercel.json`](../frontend/vercel.json) rewrites browser `/api/*` requests to the HTTPS Render API while keeping the browser on the Vercel origin; it also sends deep links such as `/products/123` to the React app. Update the API origin in this file and redeploy if the Render URL changes. Never expose the database URL, S3 credentials, or session data through a `VITE_*` variable.

Use one stable production Vercel domain as `APP_ORIGIN`. The backend checks request origins and issues secure, HTTP-only cookies. Vercel preview URLs have different origins, so production API login will reject them. For a working preview, use a separate preview API/database/bucket with its `APP_ORIGIN` set to the preview's exact domain, or test locally; do not loosen production origin checks. A preview frontend pointed at the production API is unsuitable for write testing.

The same-origin rewrite is important for login cookies, CSV upload/download, and notification streams. Verify these on a deployed staging pair or the production pair before giving access to real users. Keep the API responses uncacheable; the API sets `Cache-Control: private, no-store`, and Vercel's external rewrites are uncached by default.

## Release and recovery checklist

- Build and test both projects: `npm test` in `server/`; `npm run build`, `npm run lint`, and `npm run test:e2e` in `frontend/`. The browser suite uses mocked API responses, so also run the deployed smoke checks below.
- Confirm Render migrations finish before the new API release, and the worker is healthy on the same revision. Keep one worker initially so jobs cannot compete unexpectedly.
- Confirm manager, staff, and viewer permissions; product search and cursor paging; receipt, order, return, and transfer lifecycle; stock approvals; CSV validation/commit/export; evidence; and notification updates. Test a mobile viewport and a direct URL refresh.
- Back up PostgreSQL and the private S3 bucket, and **practice restoring both together** before using real inventory. Database rows reference S3 object keys; restoring only one side can leave missing attachments.
- Monitor `/health/ready`, Render API/worker logs, failed background jobs, PostgreSQL capacity, and S3 storage. Product and movement benchmarks under `server/` are local synthetic checks, not a promise that every production action stays under three seconds.
