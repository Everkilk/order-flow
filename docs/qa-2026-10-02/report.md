# Usability and shared-demo QA — 2 October 2026

## State

Local implementation is prepared. Publication, current provider-capacity checks and hosted `DEMO-V2` setup are **pending**. No hosted mutation or live-data reset was performed during these local rehearsals. This report does not certify live completion.

Baseline: main, `b5d75bf2ee0ce04ad212b3917021fac0d8d8b5e5`. Earlier fixes and existing records are preserved. No schema migration, production password-policy change or role expansion is required.

## Requirements and evidence

| Requirement | Local result | Evidence / scope |
| --- | --- | --- |
| Exact zero trimming throughout the project | Passed | Decimal-string unit checks; rendered module checks; clean initial edit values and intermediate typing; valid preview cells; original upload bytes; real backend CSV downloads and formula/text protection |
| Return icon, breadcrumbs and browsing state | Passed | All 15 signed-in section/unknown-route cases; document details; import/export direct aliases; product/document later-page filters; stock scroll restoration; independent job pagers; state cleared at authentication boundaries |
| Protect unsaved edits | Passed | Supplier Back/sign-out/edit replacement; product/document popup Close/Escape; reference tab/attribute/threshold transitions; account forms independently dirty; pending upload, evidence and discrepancy edits; regression workflows save successfully |
| Mark all as read | Passed | API all-page isolation, prior timestamps, repeat operation and concurrent later arrival; UI failure/retry and list/badge/dashboard refresh |
| Sidebar icon sign-out / supplied logo | Passed locally | English/Vietnamese accessible names, keyboard sign-out, 44 px target, long account name and reachable mobile footer; exact logo copy, responsive screenshots |
| Broad data and ready accounts | Passed in isolated local rehearsal | 60 products, 180 stock rows, planned receipt/order/return/transfer/request states; four activated users including existing local Admin; all balances and ledger sums, transfer transit/quarantine and restrictions verified |
| Recovery / duplicates / cost ceilings | Passed locally | Dry run makes no calls; interruption/resume; completed repeat creates no duplicate business records; tester edits, namespace collision and pending ambiguity stop; cumulative rehearsal 812 requests, seven CSV tasks, 24,210 bytes |
| Publication / free-capacity gate / hosted dataset | Pending | Requires prepared commits pushed by user, provider source/readiness evidence, current usage/expiry observations and one bounded setup/live pass |

### Numeric presentation inventory

The frontend's API wrapper returns a presentation copy using the explicit allowlist in `frontend/src/lib/numbers.ts`; server API decimal strings and stored precision remain unchanged. Numeric attribute values already arrive as JSON numbers; arbitrary attribute strings/JSON remain opaque.

| Module | Audited numeric fields |
| --- | --- |
| Overview / Reports valuation | Per-currency amount; integer counts remain counts |
| Products / supplier editor | Selling price, supplier cost, warehouse on-hand/reserved/available; clean initial edit values |
| Stock | On-hand, reserved, available |
| Receipts / Orders / Returns | Line quantity and unit cost/price; returned/returnable quantities |
| Transfers / discrepancies | Requested/sent/received/in-transit/quarantined, reported/outstanding/resolved/accepted quantities; shortage/excess input values remain user-controlled |
| Approvals | Requested delta, counted quantity, observed on-hand, approved delta |
| Movements / movement reports | On-hand/reserved deltas; reference IDs untouched |
| References | Declared minimum/maximum and low/critical thresholds; integer unit decimal-place settings |
| Imports & exports | Valid quantity/selling_price/unit_cost/unit_price preview cells; invalid cells/errors opaque; export selling_price/on_hand/reserved/available/on_hand_delta/reserved_delta/threshold |
| Notifications | Known LOW_STOCK quantity prefix on display and new generated body; arbitrary messages unchanged |
| Users / other metadata | IDs, names, email, phone, roles and warehouse IDs untouched |

Forms registering independent dirty state: product editor, supplier editor, document creation, document line editor, transfer receipt/shortage/discrepancy resolution, evidence picker, stock-request creation/decision, reference creation/category attribute/threshold, import upload/export configuration, user creation/profile/password/warehouse access. The shell owns one route blocker and unload guard. Same-page filter/query changes preserve actual fields; transitions hiding a form explicitly confirm discard.

### Visual review

24 PNGs in `visuals/`: sign-in, product detail and sidebar at 1440/768/390/320 px in English and Vietnamese. Representative desktop, tablet, narrow mobile sidebar and sign-in images were inspected. Checks cover wrapping, page overflow, exact asset aspect ratio, icon size and footer reachability. Added a close control inside the mobile sidebar, since the open menu covered the original toggle.

The supplied wide logo is used unchanged for the favicon. Its fine details remain a known readability constraint at tiny browser-icon sizes; actual hosted browser-icon inspection is pending. Some older labels remain English when Vietnamese is selected; this change translates the new controls and does not claim complete translation of all existing UI text.

Source and served-build logo SHA-256: `8139e7cc0b579d9c13d0135817dc75d7efbbfd9e886653cae10e1ce0a8cb67c0`.

## Local gates

- Frontend lint: passed.
- Frontend production build: passed; assets `index-B6mQ5fvc.js`, `index-Ca-ey21V.css`.
- Frontend full browser suite: **60 passed**, zero failed (54.5 seconds), including the added direct-job aliases and reference child-form guards.
- Backend full `npm test`: passed — typecheck/build, 16 schema tests, 29 API tests, one local S3-compatible storage round-trip, one existing standalone demo test, two persistent-seed tests (49 total tests).
- Latest targeted deep-link/form checks: five passed.
- Isolated persistent seed: interruption after 18 completed steps then resume; **786 requests in resumed run, 812 cumulative**, seven CSV tasks, 24,210 uploaded bytes. A completed repeat created no duplicate records/jobs/events; edited records/collisions/ambiguous pending requests stopped.
- Seven CSV tasks represent **ten background jobs**: three validation jobs, three commit jobs and four exports. Hosted polling/health checks/streams/builds are additional activity.
- Git whitespace and staged credential-pattern reviews: passed. Scope review preserves unrelated historical handoff/QA/user files. Backend/setup commit: `0a14211`; the frontend commit contains this report and the remaining local changes. Published IDs will be recorded after the user's push.

Database tests create temporary localhost databases and remove them after the pass. Browser tests use local mocked APIs. The storage test uses a local S3-compatible stub; real AWS access and current hosted allowances remain unverified for this release.

## Hosted evidence to complete

1. Record prepared commit IDs and verified GitHub/Vercel/Render source revisions.
2. Record current plan/usage/spending/credit/database-expiry observations for all providers; verify budget remaining for setup and browser checks.
3. Apply once with private inputs and the original ignored checkpoint. Stop on account/namespace collision or ambiguous result.
4. Record actual dataset IDs/statuses, ready accounts, all 180 balances/ledger sums and four S3 downloads.
5. Run one bounded published UI/role pass: every requested feature, representative modules, both languages, responsive layout, history/deep-link behavior, dirty cancellation/discard and later unread notification.
6. Deliver tester guide and private credentials, close owned test sessions/tabs and update this report with actual consumption and unresolved limitations.

No hosted check may be marked passed solely from local output or a provider's Ready label.
