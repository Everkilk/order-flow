# OrderFlow: seven-issue repair and verification plan

Date: 4 October 2026, Asia/Saigon.

## 1. Purpose, decisions and current status

Repair the seven issues reported by the user across the project, verify the complete local behavior, then publish and perform limited live checks within the existing $0 hosting constraint. The screenshots are examples of affected screens, not the boundary of the review.

The user requested discussion and clarification before this plan. The following choices are now agreed:

1. Returns use a searchable selector showing document number, internal Order ID and status. Only fulfilled orders permitted for the signed-in user are selectable. Show Order ID in the Orders table and order details as well.
2. Only the stock-request creator can delete evidence, and only while the request is Pending. Lock evidence uploads and deletion after approval or rejection. Remove deleted stored files and retain deletion history.
3. Protect all actions that save or create data against accidental repeated submission, including rapid clicks and retries. A new intentional submission with identical values must remain possible.
4. Audit similar form layouts throughout the project.
5. Display product name and SKU with a link to product details wherever this helps identify a referenced product.
6. Audit Vietnamese throughout the website, including different roles and states.
7. Place sign out below the avatar/name row, left aligned, with a red background and a white sign-out icon. Give the name the available row width.

**Status at plan creation:** investigation completed; unfinished local implementation drafts exist. Those drafts are not verified fixes. This plan does not claim that any repair, migration, deployment or test has passed. Implementation results must be recorded separately with actual evidence.

### What the order investigation established

`orders.id` is an automatically generated internal identifier. `orders.order_number` is a separate, unique document reference. Their numbers need not match. The saved return API looks up the internal ID and already requires `FULFILLED` at creation and posting.

Thus a link labelled `#29` can correctly open a document named `DEMO-V2-ORD-25` if its internal ID is 29. The screenshots are consistent with this explanation; the exact hosted mapping remains unverified. Verify that mapping read-only during live checks. Do not rename documents or change IDs to make their numbers match.

## 2. Work boundaries and precautions

- Preserve existing business records, shared demo accounts, tester edits, inventory balances, posted history, historical QA artifacts and unrelated working-tree changes. Preserve reported duplicate requests #15 and #16; this work prevents new accidental duplicates.
- Review the existing drafts before finishing or replacing them. Record the starting revision and changed files so new work can be distinguished from earlier work.
- Do not edit previously applied migrations, reset an application database or reseed the hosted demo. Use additive migrations and isolated local test databases.
- Maintain role, ownership and warehouse permissions at the server. A hidden button alone is insufficient authorization enforcement.
- Keep decimal values and large IDs exact. Presentation and link work must not alter financial calculations, quantity precision, CSV contracts or document identity.
- Avoid blanket translation of data strings: names, reasons, document references, SKUs, file names, currency codes and other user content remain unchanged.
- Keep database transactions short. Do not perform S3 network operations while holding inventory/request locks.
- Use local files and simulated storage failures for destructive, failure and concurrency tests. No hosted load tests, outage injection or repeated account resets.
- Do not expose environment files, passwords, cookies or access tokens in logs, screenshots, fixtures committed to Git or replay storage.
- The repository's `render.yaml` declares paid resources. Follow the existing free-demo deployment configuration; do not deploy that blueprint, add a paid worker, upgrade plans or create additional hosted services.
- Current allowances are unknown until checked. Previous provider screenshots are historical evidence and cannot authorize new live usage.

## 3. Requirement R1: aligned fields throughout the project

### Work

- Inventory all shared form layouts: draft receipt/order/return/transfer item editors, transfer receiving and discrepancy resolution, stock requests, product/supplier forms, stock thresholds, reference-data forms, imports/exports and user administration.
- Separate multi-control product search/selection/helper areas from the row of quantity, warehouse, price, currency and remove controls. Give that picker area the full usable line width.
- Use consistent field grids, label spacing and control heights. Align corresponding fields; helper text, errors and long labels must not push one neighboring control out of alignment.
- Keep each line's remove action visually associated with that line. Ensure links introduced by R5 use the intended grid span.
- Stack fields on narrow screens with readable labels, adequate touch targets and no clipped inputs. Retain intentional scrolling inside wide data tables.

### Cautions

Shared CSS changes can affect unrelated forms. Check nested fieldsets, disabled states, several item lines, validation errors, search results, empty pickers and long product names. Changing layout must preserve field associations, keyboard order and entered values.

### Acceptance and tests

- Check English and Vietnamese at desktop, tablet, 390 px and 320 px widths.
- Use rendered screenshots plus geometry assertions for corresponding control edges/heights; inspect label/helper/error wrapping visually.
- Test receipt/order/return/transfer line editors with one and several lines, receiving/discrepancy controls and every other inventoried form.
- Confirm no page-level horizontal overflow caused by forms, no overlap and no lost validation or keyboard access.

## 4. Requirement R2: understandable and correct order selection for returns

### Work

- Add a labelled Order ID column to Orders and an Order ID value to order details. Keep the document reference prominently visible.
- Replace manual ID entry in the new-return form with an authorized, paginated fulfilled-order selector.
- Search by document reference or exact internal ID, with clear search instructions. If numeric document references are supported, define and test an unambiguous search rule so a numeric reference is not silently mistaken for an ID.
- Each option and selected-order summary displays document reference, Order ID and translated status. Loading, no results, access errors and pagination are explicit.
- On a fulfilled order's Create a return action, preselect that order using its actual ID. Reject invalid or inaccessible URL preselection clearly.
- Show both references on the return's order link and route it using the internal ID.
- Limit return warehouses to the selected order's warehouses within the user's permissions. Clear a previous warehouse when the selected order changes.
- Preserve server checks for fulfilled status, ownership, warehouse access, valid order items and cumulative returned quantities. Enforce order/warehouse compatibility at creation as well as line saving/posting.

### Cautions

UI filtering must not replace server validation. The server must reject tampered requests and stale selections. IDs remain strings. A fulfilled order may already have fully returned lines; do not offer unavailable lines or permit returns exceeding fulfilled quantity. The existing maximum page size is not a total searchable-record limit.

### Acceptance and tests

- Build a fixture where internal ID 29 has reference ORD-25 and a different, confirmed order has reference ORD-29. Selection, creation and the return link must identify the correct record consistently.
- Search by full/partial reference and exact ID; verify case handling, numeric-reference behavior, empty results, pagination and selection outside the current page.
- Verify preselection, changing selection, several original warehouses and invalid/inaccessible query parameters.
- Try DRAFT, CONFIRMED, CANCELLED, unknown and unauthorized orders through the API: no return is created.
- Verify permitted staff, restricted staff and manager behavior without widening access. Preserve existing role visibility rules for viewers.
- Verify unrelated warehouses, incorrect order items, excessive quantity and repeated posting do not alter stock.
- Update browser tests that still fill the removed manual ID field. Run actual frontend-to-backend tests in addition to selector mocks.

## 5. Requirement R3: creator-only deletion of Pending stock-request evidence

### Work

- Add a delete control next to each evidence file for the request creator while Pending. Confirm with the file name before removal.
- Return explicit upload/delete permissions and enforce them server-side. Managers who did not create the request cannot delete its evidence.
- After a decision, hide or disable evidence changes with a clear translated explanation; retain readable evidence according to existing access rules.
- Verify attachment/request association before deletion. Serialize evidence modification and approval/rejection against the same request state so races cannot bypass the lock.
- Record immutable removal metadata and audit history: request, evidence identifier, file name, actor and time. A history entry must be reviewable by authorized users through an appropriate existing or documented audit view.
- Remove deleted evidence from active lists and authenticated download access immediately after the database removal commits.
- Queue physical storage cleanup using the existing worker, with bounded retries and a retained operational failure state. Include any storage configuration changes needed for the existing service to delete its own evidence objects with appropriately scoped permissions.
- Treat deletion of an already absent object as successful. Ensure a retry cannot delete another object or recreate an attachment.
- Reset the file picker after successful upload, preserve useful retry behavior after failure and prevent accidental repeated uploads.

### Cautions

Database and object storage are separate systems. Do not claim physical deletion is complete merely because the link disappeared. If cleanup fails, keep downloads blocked, retain the job/error and provide a documented recovery path. Repeated cleanup remains bounded; no new paid worker. Evidence attached to transfer discrepancies is outside this creator-only stock-request deletion requirement and must keep its existing behavior.

### Acceptance and tests

- Creator/Pending: cancel confirmation preserves evidence; confirm removes the intended file and records history.
- Other staff, non-creator manager, viewer and signed-out requests cannot delete it, including direct API calls.
- Approved/rejected requests reject both new uploads and deletions, including stale open pages.
- Test deletion versus approval/rejection concurrently; only a valid serialized outcome may commit.
- Repeated deletion and lost-response retry produce one removal record and one cleanup job.
- Verify wrong request/file combinations, unavailable object, storage failure, retry success and terminal failure handling.
- Verify physical removal locally and during the tiny permitted hosted storage check, including S3 versioning behavior if enabled. A delete marker alone must not be described as purging retained versions.
- Confirm deletion never changes the request's stock adjustment, decision or inventory ledger.

## 6. Requirement R4: duplicate protection for every save/create action

### Work

- Build an action inventory covering catalog and references, users/access/password administration, receipts/orders/returns/transfers and line saves, receiving/resolutions, stock requests/decisions/thresholds, evidence, imports/commit, exports and notification read actions. Review authentication actions for immediate UI locking and session-safe retry behavior.
- Lock submission immediately before the first asynchronous step. Cover mouse clicks, Enter, touch and confirmation controls; show translated progress and disable competing actions where needed.
- Preserve entered values on a known failure and restore controls when safe.
- Give each logical mutation a replay key tied to actor, operation and submitted content. Concurrent or retried copies return the original result without repeating records, events, jobs, notifications or audit effects.
- Reuse the same key when the outcome is uncertain, such as a lost response after commit. Define safe recovery across an unmounted form, navigation or reload; do not silently turn uncertainty into a fresh submission. Keep credentials and session secrets out of persisted recovery state.
- Reject reuse of a key for different content, target, operation or actor. Recheck relevant permissions on replay.
- After a confirmed result, allow a new intentional identical submission with a new key.
- Distinguish a successful save followed by a failed refresh from a failed save. Show that the write succeeded and permit refresh/recovery rather than inviting duplicate creation.
- Match multipart retries using actual content and relevant metadata. Clean up temporary/candidate uploads created by replayed requests.
- Preserve existing inventory-command replay behavior and job-specific commit keys. Review status/result semantics when an asynchronous job progresses after submission.
- Define replay-record retention and its retry guarantee. Avoid unbounded database growth and avoid expiring a key while a supported recovery path still relies on it.

### Cautions

Button disabling alone does not protect against retries or simultaneous HTTP requests. Conversely, rejecting all identical payloads would block legitimate repeated business actions. Optional headers for older clients require an explicit compatibility window; do not claim an older client without a key has full retry protection. Authentication/password results must not cache or replay raw credentials or stale sessions.

### Acceptance and tests

- For every inventoried action, prove immediate UI locking and the appropriate server replay or naturally repeat-safe behavior.
- Rapid double click and Enter bursts result in one logical action. Run concurrent same-key requests locally and count committed database side effects.
- Simulate a committed write with its response lost, then retry: original result, no extra business record/job/event/notification/audit entry.
- Same key with changed content/actor/target fails without writes. Known validation failure allows corrected input; uncertain outcomes follow the documented recovery path.
- New logical key with intentionally identical values succeeds where normal business uniqueness rules allow it.
- Test unmount/reload recovery, multipart bytes/metadata changes, cleanup, stale permissions and write-success/refresh-failure separately.
- Preserve historical duplicates #15/#16 and all existing inventory invariants.

## 7. Requirement R5: recognizable product references and links

### Work

- Use a shared reference presentation containing product name and SKU, linked by actual product ID.
- Cover stock-request details, order/receipt/return/transfer items, transfer receiving/discrepancies, movements, stock and relevant reports. Review remaining pages and selected editable-line summaries for useful links.
- Replace bare warehouse IDs in request summaries with available warehouse name/code.
- Use existing joined data or bounded page queries for names and IDs; avoid one network/database lookup per table row.
- Preserve ordinary link behavior, keyboard access, open-in-new-tab and the application's unsaved-change guard. Returning to the originating page should retain its existing supported filters/page state.
- Handle inactive, missing and inaccessible products honestly. Do not create broken links from order-item IDs or an ID guessed from a SKU.

### Acceptance and tests

- Click each inventoried reference and verify the destination's ID, name and SKU.
- Use a fixture with different product and order-item IDs to catch incorrect routing.
- Verify long names, inactive products, missing references and current permissions, including direct navigation.
- Verify keyboard activation, new-tab behavior, Back/filter preservation and Cancel/Confirm branches for unsaved changes.
- Check query/request counts on a page of several rows to detect per-row fetching.

## 8. Requirement R6: complete Vietnamese application text

### Work

- Inventory app-controlled text by route and state: navigation, headings, descriptions, buttons, fields, placeholders, status/type options, helper text, dialogs, toasts, success/error messages, empty/loading states, notifications, roles, accessibility labels and dates.
- Use explicit translation keys/templates for dynamic text; preserve interpolation values as data. Localize known server errors consistently, including actionable field errors.
- Translate existing and new application-generated notifications without rewriting user content. Prefer structured event/template data for new messages; define a verified fallback for known legacy messages.
- Format displayed dates/times for the selected locale while preserving the instant and timezone behavior. Keep IDs, currency codes, CSV headers and exported data contracts unchanged.
- Review generic table/heading translation that may accidentally translate a user's product name or document reference equal to a dictionary key.
- Ensure changing locale respects unsaved changes. Translate role names and the new R2/R3/R4/R7 controls.

### Cautions

File-picker chrome and other native browser/OS controls may use the browser/OS language. Record these separately from application translation gaps. Do not hide missing keys behind a fallback and call coverage complete. Unknown errors need a safe useful message, without exposing database internals.

### Acceptance and tests

- Visit every accessible route as manager, staff, warehouse-restricted staff and viewer in Vietnamese, covering relevant draft/final/empty/error/dialog/loading states.
- Include sign-in/password flows, pagination, return picker, approvals/evidence, imports/exports, reports and reference/user administration.
- Verify notifications already stored in English and newly generated events, preserving names/reasons inside them.
- Test names such as `Order`, `Stock` and `Pending` as user content; they must remain unchanged.
- Check English for regressions, dictionary/template coverage, visible date examples and screen-reader labels.
- Exercise both branches of the unsaved-change prompt when changing locale.

## 9. Requirement R7: account footer and sign out

### Work

- Layout: avatar and account name/translated role on one row; sign-out icon button on the next row, left aligned.
- Give the name the available width and allow long names to wrap without overlapping the avatar or button.
- Use a red background, white sign-out icon, visible hover/focus/busy states and at least a 44 by 44 px target.
- Keep the visible button icon-only. Provide translated tooltip and accessible name.
- Preserve the unsaved-change confirmation, prevent repeated sign-out requests and handle failure without falsely reporting a signed-out session.

### Acceptance and tests

- Short/long English and Vietnamese names at desktop/tablet/390/320 widths: name readable, no overlap or clipping; correct role and button placement.
- Verify contrast, Tab focus, Enter/Space activation, tooltip and accessible name.
- Cancel sign-out with an unsaved form: session/form remain. Confirm: session ends and sign-in appears.
- Test rapid activation and network failure; verify the authenticated state matches the actual result.

## 10. Execution sequence and gates

### Phase A: establish the baseline

1. Read applicable repository instructions and this plan; inspect Git status, existing drafts, package scripts, current deployments and migration history without printing secrets.
2. Record the baseline in `docs/qa-2026-10-04/report.md`, with one row per R1-R7 subrequirement and statuses: not started, in progress, passed, failed or unverified.
3. Inventory all forms, mutation actions, product-reference locations, routes/roles and translation states. Attach a coverage checklist rather than relying on the example screenshots.
4. Establish isolated local fixtures and local file storage. Ensure no test configuration points at the hosted database or S3.
5. Reproduce each reported defect in an appropriate saved-code/local environment. Where an existing draft already changes behavior, use a disposable baseline checkout or fixture; preserve the main working tree.

**Gate:** requirements and fixtures are traceable; normal/shared data is untouched; unverified behavior is explicitly labelled.

### Phase B: backend foundation and business validation

1. Finish/review replay handling and additive migration(s), including result safety, permissions, compatibility, storage growth and concurrency.
2. Finish order search/details/return validation, preserving exact IDs and authorization.
3. Finish evidence deletion/history/state locking and bounded cleanup using the existing embedded worker.
4. Add required joined product/warehouse fields and structured notification/error support without changing data contracts unexpectedly.
5. Run focused API/storage/schema regressions after each change, including races and failure recovery.

**Gate:** no duplicate logical effects, permission bypass, stale-state evidence change, wrong-order association or inventory corruption in focused tests.

### Phase C: frontend behavior and presentation

1. Finish shared immediate submission locking, retry recovery and success-versus-refresh reporting; apply to the entire mutation inventory.
2. Finish the return selector and explicit IDs/reference links.
3. Finish evidence controls/history messages, product references and layouts.
4. Finish footer and Vietnamese coverage, including templates, errors, notifications and accessibility.
5. Update old tests for intentionally changed controls; add assertions that prove the new requirements rather than only updating snapshots.

**Gate:** each requirement has focused rendered and behavior evidence, with no permission weakening or user-data translation.

### Phase D: complete local verification

Run these existing commands from their respective directories:

```text
frontend: npm run lint
frontend: npm run build
frontend: npm run test:e2e
server:   npm test
```

`server`'s full test script includes typecheck, schema/database tests, API tests, build, storage tests, demo tests and seed tests. Inspect that the tests actually cover the requirement before treating a green result as proof.

Also run real local browser-to-API flows with the isolated database and local worker/storage. Existing browser mocks alone do not prove backend integration. Exercise all relevant roles, EN/VI, required viewport sizes, order/return workflow, approval/evidence permissions, retries and product navigation. Inspect screenshots and record command exit results; do not infer a pass from a build or test starting.

Reconcile stock balances/reservations and ledger effects before/after inventory tests. Validate additive migration on a fresh test database and an upgraded fixture database, including concurrent startup, schema constraints and original-data preservation.

**Gate:** all required local checks pass on the exact proposed revision. Investigate concrete failures; do not waive required coverage to obtain a smaller passing subset.

### Phase E: reviewable commit and staged publication

1. Review the full diff, migrations, QA evidence and unrelated changes. Stage only scoped files; include no credentials, sensitive browser state or unrelated user work.
2. Provide a concise tested-change summary and concrete commit(s). Ask the user to push using GitHub Desktop; do not push on their behalf.
3. Before hosted mutations, inspect current Vercel/Render/AWS plan, usage, remaining allowance, credits/expiry, database expiry, spending settings and S3 versioning/deletion permissions. If remaining capacity cannot support this bounded check at $0, stop hosted writes and report the exact blocker.
4. Deploy additive schema and compatible backend before frontend features requiring them. Coordinate auto-deployment using existing deployment controls or separate backend/frontend commits so one GitHub push cannot accidentally release the new frontend first.
5. Verify migration/startup logs, backend ready health and deployed source revision before publishing the dependent frontend. Older clients remain operational during the transition; document their replay-protection limitation until the frontend update is active.
6. Verify frontend production revision and served asset against the tested build. A provider Ready badge alone is not proof of matching code or correct workflows.

**Gate:** both releases match tested changes, migration is healthy and current free capacity is verified.

### Phase F: bounded hosted verification

Maintain a written usage counter. Ceiling for this repair verification: ten new business records, two tiny evidence uploads and two small import/export jobs in total. Use substantially fewer where existing records/read-only checks suffice. These ceilings are not a guarantee of $0; fresh allowance checks must support them. No additional hosted accounts unless an existing account cannot cover a required role and the user agrees.

- Read-only verify internal Order ID 29 and its document reference; capture both without modifying the order.
- Verify Orders table/detail, fulfilled-order search/preselection and correct return links. Create at most the small fixture needed for a positive return check; preserve unrelated stock.
- One minimal stock request can cover creator/non-creator views, rapid-click protection, tiny evidence upload/removal and post-decision locking. Use a harmless test fixture/action and reconcile any approved stock change.
- Verify physical evidence cleanup and retained history/job result using authorized provider/storage evidence; keep retry/failure injection local.
- Reuse existing import/export jobs where possible; any new job must be tiny and counted. A job completing does not alone prove an actual downloaded file opens correctly.
- Check product links, English/Vietnamese representative states, desktop/mobile forms, footer and actual sign-out/unsaved behavior.
- Check relevant backend errors/logs once the flows settle, avoiding repeated cold-start requests, prolonged idle sessions or service keep-alives.
- Restore any temporary test-only presentation/settings where appropriate, reconcile fixture effects, sign out and close agent-created verification tabs.

If browser automation cannot verify a native dialog or download, request one precise user check. Keep that check unverified until the result arrives; never bypass browser access restrictions.

## 11. Rollback and recovery

- Document the previously healthy source revisions, deployment settings and schema version before release. Use an authorized backup/recovery method within the existing free setup before hosted migration; verify access to the resulting recovery artifact and protect its contents.
- Add schema objects without dropping/changing existing application data. Test migration failure rollback locally and confirm startup cannot serve partially migrated behavior.
- If the frontend fails, restore the prior frontend revision. If backend behavior fails, restore the prior compatible backend revision and verify health. Keep compatible additive tables/history; do not drop them merely to roll back code.
- Once a physical evidence delete completes, the file cannot be restored from removal metadata alone. Do not promise reversibility. Audit/replay history must remain intact.
- If queued cleanup exists, reverting to a worker that does not recognize its job kind could mark jobs failed. Provide a tested rollback path that retains cleanup support or safely preserves pending jobs for the fixed worker.
- Document how to inspect/retry a failed cleanup without restoring download access or running unbounded retries. Confirm the filename/object association before any recovery operation.
- Deployment rollback must not reset demo data, undo tester edits, recreate removed evidence or replay successful inventory mutations.

## 12. Deliverables and completion rule

Deliver:

1. Reviewed implementation and additive migrations for R1-R7.
2. Route/form/action/reference/translation coverage inventories.
3. Focused regression tests and full local gate results, including real browser/API evidence and screenshots.
4. QA report with requirement-to-test mapping, exact tested/published revisions, migration and rollback/recovery instructions, live usage counter and current provider-preflight evidence.
5. Updated user-facing guidance for Order ID versus document reference, return selection, evidence permissions and safe retry recovery.
6. Concise final summary of what changed, why, how it was tested and any explicit limitations.

**Completion is proven only when every agreed requirement is implemented, all required local gates pass, the exact revisions are published, and bounded live verification is complete.** An existing draft, narrow green test, local build, pushed commit or deployment Ready status alone is insufficient. Any missing or materially unverified requirement keeps the work incomplete until resolved or the user explicitly changes the scope.

## 13. Implementation checklist

- [ ] A: baseline and all coverage inventories recorded; defects reproduced; fixtures isolated.
- [ ] R1: all inventoried forms aligned and verified across locales/viewports/states.
- [ ] R2: searchable fulfilled orders, visible IDs, correct links and server validation verified.
- [ ] R3: Pending creator-only deletion, history, physical cleanup, decision races and failure recovery verified.
- [ ] R4: every mutation reviewed; immediate locks, replay/recovery and intentional repeat behavior verified.
- [ ] R5: all useful product references identify/link the correct permitted product; navigation verified.
- [ ] R6: app-controlled Vietnamese coverage complete across roles/routes/states; user data unchanged.
- [ ] R7: footer layout, red icon button, accessibility, unsaved guards and real sign-out verified.
- [ ] D: frontend lint/build/e2e and complete backend tests pass; real local integration, migration and reconciliation evidence recorded.
- [ ] E: diff reviewed, scoped commits pushed by user, current $0 capacity checked, backend/schema then frontend published and revisions verified.
- [ ] F: bounded live checks and cleanup completed; evidence/history/storage and inventory results reconciled.
- [ ] Final: deliverables present; every requirement has authoritative completion evidence; no material gap remains.
