# OrderFlow: detailed usability and shared-demo plan

Prepared 2 October 2026. **The three scope decisions below are confirmed by the user.** This document plans the work and its acceptance checks. It does not certify that any implementation, test, deployment or dataset setup is complete.

## 1. Objective and boundaries

Make the existing shared demo easier to use and give testers enough realistic fictional data to exercise its workflows. Deliver all six requested improvements:

1. Remove unnecessary decimal zeros throughout the project.
2. Add the `←` return control and page breadcrumbs below Warehouse management.
3. Add Mark all as read to Notifications.
4. Move icon-only sign-out beside the account name in the sidebar footer.
5. Use the supplied logo consistently.
6. Create and import a broad set of products, stock, receipts, orders, returns, transfers and test accounts.

Keep the current Vercel frontend, Render API/database and private S3 storage. The dataset can be extended later; each hosted setup and test run must fit verified remaining free capacity. Preserve existing data, previous fixes, user files and accounts. The user publishes prepared commits through GitHub Desktop.

The working tree already contains changes related to these features. Review and finish those changes before adding replacements. Existing local changes are not proof of successful execution. Preserve `logo.png`, historical plans, handoff notes and prior QA evidence. Do not stage unrelated files.

## 2. Confirmed decisions

| Decision | Confirmed choice | Effect |
| --- | --- | --- |
| Decimal presentation | Trim trailing zeros only; preserve every meaningful digit | Quantities and money remain exact; no rounding or thousands separators |
| Dataset breadth | 60 bilingual products across six industries and three warehouses | A substantial starting collection, expandable without a new application limit |
| Staff password | User-approved replacement satisfying the existing 12-character minimum; accounts activated during setup | The Staff account is ready to use without relaxing the password policy |

Account passwords are private setup inputs and must not appear in committed plans, scripts, fixtures, logs or frontend assets. The agreed Staff password is retained in the chat and supplied privately at setup. Final passwords for the limited Staff and Viewer accounts will also be chosen privately.

Use zero trimming for quantities and money throughout. Do not add currency-specific rounding or thousands separators. Never silently round inventory arithmetic.

## 3. Phase A — establish the baseline

### Work

- Read the deployment/handoff notes, applicable repository instructions and existing QA report.
- Record branch, current commit, changed files and last verified hosted revisions.
- Review the existing local implementation and tests against this plan. Identify incomplete checks without overwriting work.
- Inventory numeric presentation, editable numeric inputs, preview cells, CSV columns and numeric notification templates across the frontend and server.
- Map every route, its parent section, allowed roles, filters, pagination and editable forms.
- Record the current account policy and document ownership/warehouse restrictions.
- Create a QA report with one row per requirement: not started, in progress, passed, failed or unverified; attach the actual evidence and environment.

### Precautions

Do not print environment files or credentials. Do not reset the normal local database. Treat older test results and provider screenshots as historical evidence. Run integration rehearsals against an isolated local database. Reuse existing test coverage where it genuinely proves the requirement.

### Exit check

Every requested feature has an implementation location, acceptance test and release dependency. The baseline distinguishes local changes from published behavior.

## 4. Phase B — decimal display across the project

### Work

- Use a shared exact decimal-string formatter or equivalent exact representation. Avoid converting decimal strings through JavaScript floating-point numbers.
- Audit Overview, Products/list/details/supplier pricing, Stock, Receipts, Orders, Returns, Transfers, Approvals, Movements, Reports, Imports & exports, Notifications and numeric reference/attribute fields.
- Apply formatting to quantities, reservations, availability, line prices/costs, valuation totals, movement deltas, thresholds and discrepancy quantities.
- Format initial edit values while preserving the user's active typing, including intermediate values such as `-` or `2.`.
- Format valid declared numeric preview cells; keep invalid cells and validation messages understandable.
- Format declared numeric columns in newly generated exports, preserving existing headers, encoding and formula escaping.
- Format quantities in newly generated low-stock messages. If old notification bodies are formatted for display, recognize only that specific known template.
- Leave original uploaded files and previously generated exports intact.

### Precautions

Do not alter database precision, arithmetic, API decimal types or validation rules merely to change presentation. IDs, SKUs, barcodes, document numbers, arbitrary JSON and free text must remain unchanged. Schema-declared numeric attributes need deliberate handling; do not recursively rewrite arbitrary attribute strings. Null/missing values keep their existing placeholder. Currency totals remain separate.

### Acceptance tests

| Case | Expected result |
| --- | --- |
| `9.000000`, `0.000000`, `-0.000000` | `9`, `0`, `0` |
| `2.125000`, `-2.125000` | `2.125`, `-2.125` |
| Very large integer plus meaningful fractional digits | Every digit retained exactly |
| `25.0000 USD`, padded VND valuation | Agreed money display; currency retained |
| Missing cost, null critical threshold | Existing missing-value presentation remains |
| SKU/barcode `000123`, name containing `9.000000`, arbitrary JSON | Text unchanged |
| Numeric input during typing and failed submission | Typed value and error retained; no cursor jump |
| Valid and invalid CSV preview cells | Only valid declared numeric cells formatted |
| Export with leading-zero text, Vietnamese names and formula-like text | Text/UTF-8/formula escaping preserved |
| Transfers with decimal zero excess/outstanding | Existing zero-excess and completed-resolution fixes still pass |

Check representative rendered fields in every listed module, not only the screenshots. Compare underlying stored quantities and ledger values before/after presentation changes.

### Achieved when

There is a completed project-wide inventory of numeric fields, all relevant displays follow the agreed rule, and exactness/opaque-text/input/export regressions pass.

## 5. Phase C — return icon, breadcrumbs and browsing state

### Work

- Place a consistent navigation row below Warehouse management. Use `←` alone for the button; add a translated accessible name and tooltip.
- Show `Products › Product details` and equivalent trails for document details, approvals and selected imports/exports. Parent segments are links; the current page is not a link.
- Show the current section on list pages. Overview has no return control.
- Return to a known previous page inside the app, restoring its search, filters, pagination and scroll position.
- For a detail opened directly, fall back to its parent list. For a directly opened list, fall back to Overview. Do not send users to an unrelated external page.
- Define browsing state per history entry, including separate import/export pagers. Clear it on sign-out/session expiry/account change.
- Integrate navigation with a shared unsaved-edit guard. Protect Back, breadcrumbs, sidebar links, dialog Close/Escape and sign-out wherever an editable form can lose data.

### Precautions

Browsing state must not store passwords, session tokens, file contents or unfinished form data. Guard implementations must cooperate when multiple forms share a page. Restore scroll after asynchronous content is available without preventing subsequent user scrolling. Preserve existing deep-link routing and role redirects.

### Acceptance tests

- Inspect all signed-in sections: Overview, Products, Stock, Receipts, Orders, Returns, Transfers, Approvals, Movements, Reports, Imports & exports, Reference data, Users, Notifications and unknown-route handling.
- Inspect every supported detail route, including `/imports/:id` and `/exports/:id` redirects into Jobs.
- Open a product from a filtered later page; return and check the filter, page and scroll.
- Repeat for a document list with a status filter, stock/warehouse filters, report/date filters, references and approvals.
- Move between import/export selections and return; neither pager is reset or overwritten by the other.
- Test direct detail URLs, refresh, browser Back/Forward, repeated visits and account changes.
- Change each form category, attempt each navigation exit, cancel and verify input remains. Accept discard and verify one navigation occurs. Save successfully and verify the next exit does not prompt.
- Check keyboard activation, visible focus, English/Vietnamese labels, long breadcrumbs and narrow screens.

### Achieved when

Navigation consistently explains location, returns safely and preserves relevant browsing state. Unsaved changes cannot be silently lost through the new controls.

## 6. Phase D — Mark all as read

### Work

- Put the action at the right of the Notifications page heading, wrapping below the heading on small screens.
- Mark every currently unread notification belonging to the signed-in user, including rows beyond the visible page.
- Keep notification rows and preserve timestamps of notifications already read.
- Use one authenticated operation with the existing origin protection and a defined database statement snapshot. Notifications created after that snapshot remain unread.
- Refresh the notification list, header badge and Overview unread count after success.
- Disable while busy or when no unread notifications remain. Show a clear failure with retry available; do not announce success after failure.

### Acceptance tests

1. More than one page of unread rows becomes read in one operation.
2. Another user's rows remain unchanged; unauthenticated and disallowed-origin requests are rejected.
3. Already-read timestamps remain unchanged. Repeating the operation is harmless.
4. A controlled concurrent notification arriving after the operation snapshot remains unread.
5. Network/server failure leaves the action usable for retry and does not falsely clear counts.
6. Successful retry updates list, badge and Overview; rows remain visible after refresh.
7. Busy/zero-unread states and English/Vietnamese layout are correct.

Use a new demo account for hosted bulk-read testing so Admin's existing unread state is preserved.

## 7. Phase E — sidebar sign-out and logo

### Work

- Move sign-out to the account footer; use a recognizable door-and-arrow icon with no visible text label.
- Provide English/Vietnamese accessible names, tooltips, visible keyboard focus and a target at least 44 × 44 pixels.
- Keep the account name/role readable and the footer reachable with a long menu or small viewport.
- Confirm discard before leaving a dirty form. Prevent double submission and handle an unsuccessful logout according to the existing session behavior.
- Use `logo.png` unchanged on sign-in, the sidebar and the browser icon. Preserve transparency/aspect ratio and readable OrderFlow text.
- Start with about 112-pixel sidebar and 160-pixel sign-in widths, then verify actual readability. Remove unused old favicon references.

### Precautions

The supplied logo depicts a warehouse and delivery truck, suitable for the inventory theme. Its fine lines and wide shape may be hard to read at favicon size; inspect the actual browser icon before choosing whether a separate simplified version needs user approval. Do not redraw or crop the supplied logo without approval.

### Acceptance tests

- Compare the served logo to the supplied file and inspect light/dark backgrounds.
- Inspect sign-in, sidebar, account footer, breadcrumbs and Notifications at desktop 1440 px, tablet 768 px and mobile 390 px, plus a narrow 320 px layout.
- Test long account names, menu scrolling, both languages and browser zoom.
- Verify icon-only buttons have correct names and focus; test keyboard sign-out.
- Cancel sign-out with a dirty form, then accept discard. Verify protected pages reject the ended session and browsing/cache state does not carry to another account.
- Verify logo/favicon URLs return successfully and deep-link refresh still works.

## 8. Phase F — broad fictional demo dataset

### Proposed starting manifest

Use stable `DEMO-V2` identifiers and bilingual names. Finalize the manifest before setup so expected counts and stock can be calculated independently.

| Area | Proposed starting collection |
| --- | --- |
| Products | 60: ten each in Electronics, Apparel, Food & beverages, Hardware & construction, Beauty & household, Stationery & office |
| Warehouses | Main, North and South; bilingual display names |
| Suppliers | Six fictional suppliers, invented contact details |
| Units/attributes | Piece/pair/set/box and metre/kg/litre; whole/fractional quantities; colour, numeric size, material and capacity examples |
| Stock | 180 product/warehouse rows; six zero on-hand, six positive low-stock and three positive fully reserved examples; exact fractions |
| Receipts | 12: three posted opening-stock, six posted inbound, three inbound drafts |
| Orders | 24: six draft, six confirmed, eight fulfilled, four cancelled |
| Returns | Six linked to eligible fulfilled lines: three posted, three draft |
| Transfers | 12: two each draft, sent, partially received, disputed, received and resolved; shortage and excess examples |
| Stock requests | Six: two pending, two approved, two rejected |
| Jobs | Three real imports: products, opening stock and draft orders; four completed exports: products, stock, movements and low stock |
| Pricing | USD and VND examples; two products deliberately without primary supplier cost |
| Notifications | Actual workflow alerts generated by the examples |

No new product-count restriction is added. Extend the manifest in later bounded batches. Creating unlimited hosted data in one run cannot be reconciled with the $0 requirement.

### Accounts

Retain Admin. Add `staff@example.com` with Staff access to the three new warehouses, `staff.north@example.com` with North-only Staff access and `viewer@example.com` with existing read-only permissions. Supply final passwords privately and activate through the normal password-change flow during setup, so testers can sign in immediately.

Do not assume every Staff user can edit every document: assign intended ownership and verify warehouse/source/destination restrictions. Viewer gets only the capabilities already supported by the existing application; this plan does not silently broaden roles.

### Setup sequence

1. Provide a dry run displaying intended counts, actors, dependencies and final inventory without network requests or writes.
2. Require an explicit target, manifest version and nonsecret checkpoint; reject unsupported hosts and conflicting namespaces/accounts.
3. Create or safely reuse verified reference records, then account assignments/activation.
4. Import products through the actual CSV validation/commit flow; link suppliers and costs through normal APIs.
5. Import opening stock, then create inbound receipts and post only planned posted examples.
6. Import draft orders, create remaining orders and advance their intended statuses through normal commands.
7. Create returns only against eligible fulfilled quantities.
8. Create transfers and complete the planned dispatch/receive/dispute/resolution paths.
9. Create stock requests and planned decisions using current balance versions.
10. Complete the four planned exports. Verify real downloads and the final manifest.

### Precautions

- Never write balances directly, bypass workflow checks or run the seed automatically on API startup.
- Never replace/reset an existing user's password or delete historical posted documents to recover.
- Use stable command keys and a checkpoint recording IDs/results/fingerprints without secrets.
- Reuse completed operations. Stop on tester edits, collisions or uncertain outcomes; inspect the original request/job before retrying.
- Do not re-upload an uncertain job or assume a timeout means no write occurred.
- Keep operations sequential. Wait for the current job to reach a terminal state and stop its polling.
- Shared examples remain changed when testers complete them. Provide an expandable setup method, not automatic resets that erase their work.

### Local rehearsal and acceptance tests

- Run the complete normal API/CSV setup against an isolated local database and local file storage.
- Assert the exact new-record counts/status mix without counting old fixtures.
- Independently predict every on-hand/reserved/available balance; compare all 180 rows and every ledger sum.
- Check reservations, fulfilled quantities, eligible returns, transit, quarantined excess and resolved discrepancies. Check the planned zero/low/fully-reserved counts after all transitions.
- Verify unit precision, missing-cost valuation and separate currencies.
- Sign in as all new roles; verify normal work and explicit denied API actions, warehouse isolation and ownership restrictions.
- Stop safely between steps and resume. Repeat a completed run and assert zero duplicate users, documents, movements, stock or jobs.
- Simulate account/namespace collisions, tester edits and ambiguous pending requests; each must stop safely.
- Assert dry run performs no network calls or writes; checkpoints/logs contain no passwords/cookies.

### Hosted verification

Reconcile through read-only APIs after setup. Use planned transitions for browser checks and account for their final effects in the manifest. Perform bulk-read testing before a planned notification-producing transition so the later unread notification can be checked without adding an unnecessary job. Do not consume all open drafts during verification; leave useful workflows for testers.

## 9. Free-hosting precautions and execution budget

Before each hosted phase, inspect current account dashboards for remaining capacity, service plans, credit expiry, database expiry and enabled spending behavior. Historical $0 screenshots do not establish present capacity.

Proposed ceiling for the initial hosted setup plus its verification: **1,000 explicit API requests, eight CSV jobs, 256 KiB per uploaded CSV, 2 MiB of new uploads and 60 minutes of active execution**, sequentially. This is a ceiling, not a quota to consume. Include retries and script verification reads; record browser/background traffic separately because it also uses provider capacity. Count deployments/builds as additional provider usage. If the local rehearsal exceeds the ceiling, reduce or split the work before live execution.

Stop before any ceiling or verified provider allowance is exhausted. Leave a recorded checkpoint, reassess capacity and continue only within a new bounded phase. Stop if current capacity cannot be verified, an unexpected charge appears, deployments fail or reconciliation fails. Do not enable paid resources, upgrade plans or add keepalive/load-test traffic.

Render Free services sleep after inactivity and have ephemeral local files; S3 remains the durable file store. Render currently documents a 30-day free database lifetime and possible supplementary bandwidth/build charges depending on payment/spend settings. See [Render Free documentation](https://render.com/docs/free). Vercel's Hobby allowance must be checked for the actual project/account: [Hobby documentation](https://vercel.com/docs/plans/hobby). AWS credit/time expiry and usage depend on the account: [AWS Free Tier plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html). These references were checked on 2 October 2026; account dashboards remain necessary.

Record database expiry and arrange an export of demo data before it expires if the demo must continue. An expiring credit balance is not permanent free hosting.

## 10. Local test gates and publication

Run tests against the final reviewed changes, record their exact result and fix failures before preparing release commits:

| Gate | Command/location | What it establishes |
| --- | --- | --- |
| Frontend static checks | `npm run lint`, `npm run build` in `frontend` | Source checks and deployable bundle |
| Browser regressions | `npm run test:e2e` in `frontend` | Rendered controls, navigation/state, formatting and errors; note mocked APIs |
| Server suite | `npm test` in `server` | Types, schema/API/storage and local demo/recovery tests |
| Change review | `git diff --check` and targeted diff review | Whitespace, scope, accidental credentials/unrelated files |
| Visual review | Saved local screenshots inspected at agreed sizes/languages | Layout, logo readability, focus and wrapping |

Deploy compatible backend changes before exercising the new frontend endpoint. Prepare reviewable commits, then tell the user exactly what is ready to push through GitHub Desktop. After their push, verify remote commit, Render readiness/source and Vercel production source/served assets. A provider's Ready label alone does not prove the complete workflow.

If publication fails, inspect that deployment without repeated blind redeploys. Prefer a source correction; if rollback is necessary, restore compatible frontend/backend versions. Do not roll back by deleting seeded stock/history. For partly completed dataset setup, preserve the checkpoint and repair forward through normal commands.

## 11. Final hosted checks and completion evidence

Perform one bounded browser/API pass covering:

- All requested controls on the published revision, not merely the local build.
- Representative numbers in every module, clean inputs, real previews and downloaded CSVs.
- Navigation/history/direct-link recovery, both languages and desktop/tablet/mobile layout.
- Notification bulk read/count refresh and a later unread workflow alert using a demo account.
- Sign-in/sign-out, restricted Staff and Viewer behavior, deep-link refresh and unsaved cancellation/discard.
- Exact dataset/account/status counts, inventory/ledger reconciliation and working S3 exports.

Simulate destructive/failure/concurrency cases locally; do not inject live provider outages or perform load tests. If browser automation cannot verify a native dialog/download, request one precise manual check and record it as pending until the user confirms. Never label unexecuted checks as passed.

Deliver:

1. This plan with confirmed decisions and an execution checklist.
2. Reviewed commits and evidence of their published revisions.
3. A QA report listing passed, failed and unverified cases, fixes and remaining limitations.
4. A nonsecret dataset manifest mapping stable labels to actual IDs/statuses and final stock.
5. A tester guide explaining accounts/roles, useful open examples, shared-data behavior, cold starts and future expansion.
6. Private account credentials and a nonsecret setup checkpoint/recovery guide.
7. Before/after provider usage observations and the actual database/credit expiry dates.

**Completion rule:** all six improvements are published and usable, required local gates pass, planned accounts/data are verified, stock reconciles, hosted checks have evidence, and any material unverified requirement is resolved or explicitly accepted by the user. Do not declare the live demo complete from local tests alone.

## 12. Execution checklist

Local execution evidence is recorded in `qa-2026-10-02/report.md`; setup and recovery instructions are in `demo-setup-recovery.md`. Checked items below refer to local work only. Hosted publication and setup remain pending.

- [x] Review current local work, baseline, route/form map and numeric inventory.
- [x] Finish decimal presentation; verify every module, inputs, previews, messages and exports locally.
- [x] Finish return/breadcrumb navigation, browsing-state restoration and unsaved guards locally.
- [x] Finish bulk notification read with isolation, concurrency and failure/retry tests locally.
- [x] Finish sidebar sign-out and logo; inspect all screen sizes and both languages locally.
- [x] Finalize the dataset manifest, accounts, ownership and independent expected balances.
- [x] Rehearse complete setup, interruption/resume, repeat and safe-stop cases locally.
- [x] Pass final frontend/server suites and visual/whitespace review; complete the staged credential review before commit.
- [x] Prepare compatible backend/frontend commits for the user's GitHub Desktop push (publication still pending).
- [ ] Verify published backend/frontend revisions and readiness.
- [ ] Verify current free capacity, spending behavior and expiry dates.
- [ ] Apply the dataset within the budget and preserve its checkpoint.
- [ ] Complete bounded hosted feature/role/download checks and inventory reconciliation.
- [ ] Deliver tester guide, manifest, credentials privately, usage observations and QA report.
- [ ] Audit all six requirements against actual published evidence before sign-off.
