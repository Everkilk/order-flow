# OrderFlow seven-issue repair: QA and release record

Baseline source: `42757bb2736e2d2cff797aa4f6df0bcca5b548d3` on `main`. Agreed work and acceptance criteria: [plan](../bug-fix-plan-2026-10-04.md). Route/form/translation scope: [coverage inventory](coverage-inventory.md). Unrelated working changes present at the start are excluded from the scoped release.

The additive backend implementation `fa64d18f785edd10e52cd68a7ea6b6c8747f9057` has been pushed by the user. The hosted database now has migration 011, and Render's readiness endpoint returns 200 with `{"status":"ready"}`. The user checked Render's existing dashboard tab and confirmed **Live at fa64d18**; browser control could not read that tab. Staff sign-in and the dashboard work with the previous compatible frontend, with no captured browser errors. The dependent frontend has passed local checks and awaits publication.

## Requirement results

| Requirement | Local result and evidence | Hosted result |
|---|---|---|
| R1: aligned controls | Document and remaining-form browser geometry/screenshots at 1440, 1024, 390 and 320 px in EN/VI; multi-line editors at desktop/mobile. Reference tabs no longer widen the page. | Pending release. |
| R2: returns and order identity | API validates fulfilled/authorized order, original warehouse, order items and quantity. Browser selector distinguishes internal ID 29 from document ORD-25, and shows both on linked return/order pages. Real browser creates and posts a return; stock reconciles. | Read-only hosted check confirms ID 29 = `DEMO-V2-ORD-25` (FULFILLED); `DEMO-V2-ORD-29` = ID 33 (CONFIRMED). New UI and selector checks pending frontend publication. |
| R3: evidence deletion | API tests creator/non-creator/manager/viewer, wrong request, decided state, concurrent decision, replay, history and physical cleanup. Retry and terminal cleanup failure are exercised locally. Real browser uploads, deletes and observes history/lock. | Pending S3 versioning/physical cleanup check. |
| R4: repeated submissions | API covers concurrent replay across catalog, users, documents, notifications, jobs, inventory and evidence. Browser tests double submit, lost response, reload recovery, confirmed/unconfirmed status, plus successful evidence deletion, order action and stock decision followed by refresh failure. Real browser observes one stock request from two rapid submits. | Pending release. Older frontend clients omit replay keys until updated. |
| R5: product references | Actual-ID links/name/SKU added to stock requests, document items/editors, receiving/discrepancies, movements and low-stock reports. Real browser opens a product link; browser/UI layout checks cover long names. | Pending release. |
| R6: Vietnamese | Shared dictionary/error mapper covers routes, controls, statuses, notification templates, dates and accessibility labels; user strings/CSV headers remain data. Browser tests include route and state checks, user-content regression and screenshots; real browser verifies a Vietnamese approval. | Pending broader hosted spot-check. Native file picker chrome follows OS/browser language. |
| R7: account footer/sign out | Browser screenshots show long EN/VI names and the red 44 px icon beneath the name at four widths. Keyboard, dirty-form guard and failed sign-out retry tests pass. Real manager/staff/viewer sessions sign out. | Pending release. |

## Exact local checks

- `frontend: npm run lint` — pass, exit 0 (`frontend-lint-final.log`).
- `frontend: npm run build` — pass, exit 0 (`frontend-build-final.log`).
- `frontend: npm run test:e2e -- --trace retain-on-failure` — pass, exit 0, 85/85 browser tests on the latest source (`frontend-release-results.txt`; the earlier 82-test run is in `frontend-final.log`).
- `server: npm test` — pass, exit 0 (`server-final.log`): typecheck, 17/17 schema, 38/38 API, build, 1/1 storage, 1/1 demo, 2/2 seed. Schema checks upgrade a populated v010 database with two concurrent migration runners and prove a simulated failure rolls back.
- Real local browser, API, isolated PostgreSQL and local storage — pass, exit 0 (`local-browser-final.log`); Manager, Staff and Viewer; no hosted requests. Isolated database and temporary storage were removed. Stock ended at its starting quantity after order fulfilment and return posting.
- Rendered evidence: `layouts/` (document and remaining forms in EN/VI at four widths), `local-browser/evidence-history-desktop.png`, `local-browser/approval-vietnamese.png`.

All required local command gates passed on the latest source: lint, build and the full 85/85 frontend browser suite, plus the backend suite recorded above. Final screenshot review found that mobile account captures occurred during the sidebar transition; the test now waits for the fully open menu, checks name/button containment and captures the viewport. The first full rerun had one sign-in-form timeout on the Movements navigation test (84 passed); its isolated rerun passed, followed by the complete 85/85 run with failure tracing enabled. No product-code change was needed for that timeout. The updated real-browser harness clicked the product link and passed after its test-only change. Frontend publication and bounded live verification remain outstanding. Test logs are diagnostic data, not user instructions.

## Current provider preflight (4–5 October 2026, Vietnam time)

User-provided billing screenshots show AWS Free plan, $100 credit remaining, $0 due and $0 month-to-date; Render monthly included usage at 11/750 free instance hours, 6 MB/5 GB bandwidth, 2/25 services and 1/500 pipeline minutes, with $0 charges and $0 projected for October; Vercel Hobby active with no payment method shown. The subsequent Vercel Usage screenshot shows 13.12 MB of 100 GB Fast Data Transfer in the last 30 days and about 3.2K CDN requests. The S3 `orderflow-demo` Properties screenshot shows Bucket Versioning **Disabled** in `ap-southeast-2`; ordinary deletion therefore does not leave a retained object version in this bucket. Render `orderflow-db` is on the Free database plan, Available, PostgreSQL 18, at 7.07% of 1 GB storage, and its Info page states it expires **31 October 2026**. These are account views, not estimates.

The hosted database was reached read-only over TLS and showed migrations 001–010, with 011 not yet applied. A custom-format PostgreSQL backup was saved outside Git in `E:\Projects\ProjectX\.orderflow-backups\orderflow-before-011-20261005-001440.dump` (253,165 bytes; SHA-256 `B6AA1D57D83430EC71474D8CDAB6041300935E50D17D99AD316E97236BD4608B`). The directory has inherited access removed and allows only the Windows owner account, the Codex sandbox account and SYSTEM. `pg_restore --list` and a full `pg_restore --file=NUL` stream read both succeeded. The temporary ignored Render URL file remains local for deployment verification and must be removed after the release.

## Replay, recovery and storage operations

- The frontend immediately locks a form/action while it submits. For a lost response it keeps the logical key in session storage and blocks changed values until the user retries the same submission or checks its result after reload. The session record contains actor ID, operation, key and a safe body fingerprint; it does not contain submitted values, passwords or file bytes. Recovery is supported for 24 hours while that browser session persists; server results are kept for 30 days and removed in small indexed batches on later mutations. Beyond the supported window, review the record before intentionally creating a new one.
- The backend accepts absent keys for older clients during staged deployment. Those older clients do not gain replay protection until the new frontend is published.
- A deleted evidence link becomes unavailable after the database commit. The embedded worker removes its local/S3 object. Cleanup has three attempts and a retained `DEAD` state; authorized history shows that state. For a failed job, identify its evidence file and object key from trusted operational records, resolve the storage cause, then retry that single job through an authorized database/worker procedure. Do not reopen download access or alter the immutable deletion record.
- S3 bucket versioning was verified disabled in the user-provided bucket Properties view. The bounded hosted evidence check still needs to confirm that deletion removes the actual object and preserves its audit record.

## Release procedure and rollback

1. Review/stage only task files; exclude unrelated user drafts, temporary logs, screenshots containing private data and credentials. Keep the report/coverage/plan and useful non-sensitive test evidence.
2. Before publishing, recheck current Vercel Hobby, Render Free usage/database expiration, AWS Free-plan credits/expiry, S3 versioning and permissions. Historical Oct 2 observations are not a current allowance. Do not exceed a $0 budget. Verify the current hosted source/schema and make a protected database recovery artifact; confirm that it can be read with the restore tool.
3. Ask the user to push the backend/schema commit via GitHub Desktop. Verify Render deploy source, migration 011, `/health/ready`, free service and database capacity. The frontend must remain on its prior compatible revision during this step.
4. Ask the user to push the dependent frontend commit. Verify Vercel production source and served assets against the tested revision; ensure no paid `render.yaml` Blueprint is deployed.
5. Recheck remaining free capacity, then run a live check with at most 10 new business records, 2 tiny evidence uploads and 2 small CSV jobs; prefer existing records/read-only checks. Reconcile stock/ledger, evidence object state and worker results, then sign out.

Rollback: revert frontend to its prior production revision if its UI fails. Revert backend only to a revision compatible with pending cleanup jobs, or preserve those jobs for the fixed worker; leave additive schema/history intact. Do not reset the hosted database or recreate deleted files. Render Free Postgres has no managed backup, so obtain a protected, verifiable recovery artifact by an authorized method before migration. A physically removed evidence file cannot be restored from the deletion record alone.

## Hosted usage counter

Business records: **0/10**. Tiny evidence uploads: **0/2**. Small CSV jobs: **0/2**. New hosting services/upgrades: **0**. Account-specific allowance was checked against the user-provided 4–5 October screenshots recorded above; recheck it if publication is delayed or usage changes. No hosted writes have occurred in this repair phase.

GitHub's `main` branch was checked directly on 5 October and now points to `fa64d18f785edd10e52cd68a7ea6b6c8747f9057`. A read-only TLS database check confirmed migration `011_submission_evidence.sql`, applied at `2026-10-04T20:20:55.760Z`. Render `/health/ready` returned HTTP 200 with `{"status":"ready"}`. The user confirmed Render **Live at fa64d18**. GitHub reports a successful Vercel deployment for this backend commit; its frontend files still contain the prior compatible UI. The backend deployment gate is satisfied; the frontend release and bounded live checks remain outstanding.
