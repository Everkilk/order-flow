# OrderFlow seven-issue repair: QA and release record

Plan: [seven-issue repair](../bug-fix-plan-2026-10-04.md). Scope: [coverage inventory](coverage-inventory.md). Baseline: `42757bb2736e2d2cff797aa4f6df0bcca5b548d3`. Unrelated drafts and shared tester data are excluded from the release.

## Published source and remaining gates

- Backend `fa64d18f785edd10e52cd68a7ea6b6c8747f9057`: pushed by the user; user confirmed Render **Live at fa64d18**. Read-only TLS inspection confirms migration `011_submission_evidence.sql`, applied at `2026-10-04T20:20:55.760Z`; readiness returned 200 ready.
- Frontend `531343efabb5a68a02e60021da82504aad9418ad`: Vercel success and served JS/CSS/logo match the tested build (`published-assets.json`).
- Selector follow-up `18d62f0cf46499d679fdd2da53d58231dd3089c8`: pushed; production assets match its tested build at `2026-10-04T20:44:36.944Z` (`published-selector-assets.json`). Adds EN/VI loading and empty-search feedback found missing during live verification.
- Later full-width sign-out request: implemented locally; lint/build and **87/87 browser tests** passed. Eight EN/VI viewport checks prove account/button equal width and centered icon. Desktop and 320 px screenshots reviewed. Publication/live width check outstanding.
- Hosted non-creator/Viewer role checks, rejection of synthetic request #17, post-decision locking and final error review remain open. The plan is incomplete until these and footer publication are verified.

## Requirement evidence

| Requirement | Local result | Hosted result |
|---|---|---|
| R1: aligned controls | Inventoried forms at 1440, 1024, 390, 320 px EN/VI; multi-line editors/long references; no widened reference tabs. | Order #34 and return #11 line controls inspected; existing receipt #14 at mobile 390 px without edits. |
| R2: returns/order identity | API rejects non-fulfilled/unauthorized orders, wrong original warehouse/item and excessive quantity. Selector distinguishes internal ID/reference; real local workflow reconciles stock. | ID 29 = fulfilled DEMO-V2-ORD-25; document DEMO-V2-ORD-29 = confirmed ID 33. Table/detail show ID. ID 33 excluded with VI empty feedback. ID 29 preselects Main. Return #11 links correctly to order #34 and posted. |
| R3: evidence | API creator/non-creator/Manager/Viewer, wrong request, decided state, decision race, replay, immutable history. Physical cleanup/retries/terminal failure tested locally. | File #5 uploaded/deleted by creator on request #17; history survives reload; job #27 DONE; user confirms actual S3 absence. Non-creator/post-decision UI checks open. |
| R4: repeated submissions | Mutation inventory covered by locks/replay tests: concurrency, changed actor/content, lost response, reload recovery, intentional repeat, save-success/refresh-failure. | Two rapid Submit clicks create exactly one request #17. Order #34/return #11 have exactly three expected ledger effects. |
| R5: product references | Actual-ID name/SKU links on requests, document items/editors, receiving/discrepancies, movements, stock/reports; missing/inactive/long names/navigation tested. | Order link opens Product ID 24, Canvas fabric / Vải canvas, SKU DEMO-V2-P020; request/receipt/stock/report references inspected. |
| R6: Vietnamese | Routes/controls/statuses/notification templates/errors/dates/accessibility tested; user names Order/Stock/Pending preserved. | Staff VI receipts, return, stock, reports, notifications, jobs, transfers and selector inspected. Original English receipt button/description fixed. Admin/Viewer live checks open. |
| R7: footer/sign-out | Long names, red icon below account, keyboard/failure/dirty guard tests. Full-width follow-up passes eight geometry checks. Real local Manager/Staff/Viewer sign-outs pass. | Actual Staff sign-out reaches VI sign-in. User confirms Close/Cancel preserves unsaved search 33, then closes without submit. Full-width publication/other roles open. |

## Local checks

- Frontend lint/build exit 0. Latest footer suite **87/87**, exit 0 (`frontend-footer-results.txt`); selector suite 87/87 (`frontend-selector-results.txt`); original release 85/85 (`frontend-release-results.txt`). Rendered screenshots in `layouts/`.
- Backend full test exit 0 (`server-final.log`): typecheck, 17 schema, 38 API, build, storage, demo, seed. Populated v010 upgrade with concurrent migration runners and simulated failure rollback pass.
- Real local browser/API/isolated PostgreSQL/local worker exit 0 (`local-browser-final.log`): Manager, Staff, Viewer, EN/VI, product navigation, evidence history/locking and reconciled order/return stock. Isolated database/storage removed; no hosted requests.
- Prior suite had one sign-in timing timeout; isolated and full reruns passed. Overlapping lint/test run hit temporary test-results directory removal; sequential lint passed without source errors. These infrastructure events are recorded rather than hidden.

## Hosted fixtures and reconciliation

Counter: **3/10 business records, 1/2 tiny uploads, 0/2 new CSV jobs, 0 new services/upgrades**. Existing data reused for read-only checks; historical duplicates #15/#16 preserved.

1. Request **#17**: unique reason `QA-20261005-R1: rapid-click/evidence check; reject after verification; no stock adjustment intended.` Rapid clicks yield exactly one DB row. Staff creator ID 5, product 24, Main warehouse 3, proposed damage 0.125. Pending, never approved; rejection outstanding.
2. Order **#34**, `QA-20261005-ORDER-1`: one 0.125 product-24/Main line, fulfilled once. Ledger #268 reserves +0.125; #269 deducts on-hand/reservation 0.125.
3. Return **#11**, `QA-20261005-RETURN-1`: order ID 34, original Main, one 0.125 line, POSTED. Ledger #270 restores +0.125 on-hand. Main ends **on-hand 1, reserved 0, available 1**, matching baseline. North/South remain 30.625 each, unchanged version. See `hosted/inventory-reconciled.json`.

Synthetic evidence #5: `qa-wrong-evidence-20261005.png`, 68 bytes, SHA-256 `962e55e50bbc12ec65fd556fd9deec940e1d33c6687534b53fb8788b664eb8b0`. Removed by creator 5 at `2026-10-04T20:48:30.827Z`; key `evidence/cc73a527-bbfb-4032-a261-1fc058022fd5.bin`; cleanup #27 DONE, one attempt, no error. Active link/Delete absent after reload, immutable history retained. User confirmed Delete dialog and inspected S3 Objects, reporting no matching object. Disabled versioning plus actual absence, audit and job establish physical removal. No other evidence deleted.

Existing export **#8 PRODUCTS** downloaded through UI to orderflow-8.csv: 17,065 bytes, 63 parsed rows, 10 columns, expected P020 present. SHA-256 `fbc09b4c1778c1997da1f7d28506bb1fcb512d8c9a7b63b18816f4361d64465d`; `hosted/export8-download.json`. No new job.

Hosted native confirmations are not reliably exposed by browser control. User assisted with exact evidence deletion, order fulfilment, return posting and Close/Cancel. Results independently checked in UI/database; not claimed fully automated.

## Provider allowance and backup

User 4–5 October screenshots: AWS Free $100 credit, $0 due/month-to-date, expiry 1 April 2027; Render 11/750 free hours, 6 MB/5 GB bandwidth, 2/25 services, 1/500 pipeline minutes, $0 current/projected; Vercel Hobby active, no payment method, 13.12 MB/100 GB transfer, about 3.2K CDN requests. S3 orderflow-demo ap-southeast-2 versioning Disabled. Render Free PG18 Available, 7.07% of 1 GB, **expires 31 October 2026**. Account observations, not estimates; recheck if delayed/usage changes.

Pre-migration protected backup outside Git: `E:\Projects\ProjectX\.orderflow-backups\orderflow-before-011-20261005-001440.dump`, 253,165 bytes, SHA-256 `B6AA1D57D83430EC71474D8CDAB6041300935E50D17D99AD316E97236BD4608B`. Access only Windows owner, Codex sandbox account, SYSTEM. Restore list/full stream read pass. Temporary ignored `.env.render-demo` must be removed after verification. No credentials/private provider screenshots in Git.

## Replay, storage operations and rollback

Immediate UI locking prevents repeats. Logical mutations keep actor/operation/key/safe fingerprint through uncertain response and browser-session reload recovery for 24 hours. Persisted recovery contains no submitted values/passwords/file bytes. Server results retained 30 days and cleaned in bounded indexed batches. Changed content with uncertain key blocked; intentional new submit uses fresh key; replays recheck permissions. Older clients without keys remain compatible but lack keyed replay protection.

Deletion denies download at DB commit. Embedded cleanup attempts three times and retains DEAD on terminal failure. Authorized recovery identifies the single file/key/job, resolves storage failure and retries that job; preserve history, never reopen removed downloads or run unbounded retries.

Rollback frontend to prior compatible source if needed. Backend rollback must support pending cleanup or preserve jobs for fixed worker; leave additive schema/history intact. Do not reset shared data, replay successful inventory or recreate removed evidence. Physical removal is not reversible from metadata alone. Protected backup is the recovery artifact; Render Free has no managed backup.

Publish scoped reviewed files through user-operated GitHub Desktop, verify served assets. Complete bounded checks/reconciliation, restore viewport/locale, sign out, close verification tabs and remove temporary hosted URL before marking complete.
