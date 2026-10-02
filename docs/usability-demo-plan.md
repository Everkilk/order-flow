# OrderFlow usability and shared demo rollout

Agreed on 2 October 2026. This is the execution record for the plan discussed in this chat.

## Required result

1. Remove redundant decimal zeros throughout the application, including inputs, previews, generated low-stock notifications and newly generated CSV exports. Keep every meaningful digit, currency and original uploaded byte. Preserve identifiers, barcodes, document numbers, arbitrary attributes and free text.
2. Add an icon-only `←` Back button and breadcrumbs below Warehouse management on every signed-in page. Overview has no Back button. Detail breadcrumbs link to their section. Back uses known internal history and restores filters, pagination and scroll; direct links fall back to the parent section or Overview. Job selections retain both independent pagers. Clear memory at authentication boundaries.
3. Add Mark all as read at the Notifications heading. Mark every unread notification for the current user across every page. Keep rows, preserve prior read timestamps, leave later arrivals unread, refresh list/badge/dashboard, and report failure with retry available.
4. Move sign-out to the account area in the sidebar. Use only a door/arrow icon, a translated accessible name and tooltip, a 44-pixel target, and a reachable footer on small screens. Protect navigation and sign-out from unsaved edits with a single confirmation.
5. Use the supplied logo unchanged on sign-in, sidebar and browser icon. Keep readable OrderFlow text, transparency and aspect ratio. The source is 258 × 128 pixels; sidebar image 112 pixels wide, sign-in 160 pixels wide.
6. Populate a broad fictional shared dataset through normal APIs and CSV workflows, with ready-to-use Staff, limited Staff and Viewer accounts. Preserve existing accounts and records. Verify stock and ledger arithmetic and role restrictions before declaring the demo usable.

## Decisions

Numbers trim zeros only; no rounding or thousands separators. Examples: `9.000000 → 9`, `2.125000 → 2.125`, `25.0000 USD → 25 USD`. Missing values retain their placeholders; zero remains zero. Database precision and inventory arithmetic stay unchanged.

Back and sign-out show icons only. Their English/Vietnamese names remain available to keyboard and assistive technology users. Navigation state contains only browsing settings; never passwords, cookies, uploaded files or unsaved form values.

Accounts are activated during setup using the existing password-change flow. Passwords meet the existing minimum of 12 characters and are supplied privately at execution time, never committed or included in the frontend.

## Dataset manifest

Namespace: `DEMO-V2`. The starting collection can be expanded with a new reviewed manifest; it does not add a product limit to the application.

| Item | Starting collection |
| --- | --- |
| Products | 60; ten in each of Electronics, Apparel, Food & beverages, Hardware & construction, Beauty & household, Stationery & office |
| Warehouses | Main Warehouse / Kho chính; North Branch / Chi nhánh miền Bắc; South Branch / Chi nhánh miền Nam |
| Suppliers | Six fictional suppliers using example.invalid addresses |
| Units | Piece, pair, set, box, metre, kilogram and litre; whole and fractional units |
| Stock | 180 product/warehouse rows; six zero on-hand, six positive below threshold, three positive fully reserved rows and exact fractions |
| Receipts | Three posted opening receipts, six posted inbound receipts and three inbound drafts |
| Orders | Six drafts, six confirmed, eight fulfilled and four cancelled |
| Returns | Three posted and three drafts linked to eligible fulfilled orders |
| Transfers | Two each: draft, sent, partial receipt, disputed, received and resolved |
| Stock requests | Two pending, two approved, two rejected |
| Imports | Real products, opening-stock and Staff draft-order CSV imports |
| Exports | Products, Stock, Movements and Low stock report examples |
| Notifications | Real workflow notifications; current Admin notification state is not cleared by testing |

Product and reference names are bilingual. Category attributes exercise colour, numeric size, material and numeric capacity. Product variants remain separate SKUs in the existing model. USD and VND totals stay separate. Two products deliberately lack a primary supplier cost.

`staff@example.com` has Staff access to all three new demo warehouses. `staff.north@example.com` is Staff with access to North only. `viewer@example.com` is read-only with access to all three. Existing Admin is retained. Documents use the intended Staff owners and warehouse assignments, so the accounts can continue suitable workflows without widening production permissions.

## Implementation and precautions

The frontend formats an explicit allowlist of decimal API fields into a presentation copy. Uploaded preview rows and arbitrary JSON are opaque; numeric preview cells are formatted separately only when that cell has no validation error. The backend trims only declared numeric export columns and new low-stock notification quantities. Formula escaping, UTF-8, headers, original files and API decimal types are preserved.

Navigation uses a memory store scoped to a browser history entry. The shell owns one unsaved-change blocker, while individual editable forms register dirty state and clean it after successful saving. Cancellation preserves the form. New browser controls need visible focus and translated labels.

Bulk read is one authenticated, origin-protected SQL update limited to the session user and unread rows. Its statement snapshot excludes later notifications. It requires no schema migration and remains compatible with the previous frontend.

The dataset utility defaults to a dry run with no network calls or writes. Applying requires an explicit supported target, dataset version, private passwords and checkpoint. Hosted execution also requires verified free-tier capacity. It creates references, activates accounts, validates/commits CSVs, and advances documents through existing command APIs. It never inserts balances directly or runs automatically on deployment.

The checkpoint contains nonsecret IDs, operation results, keys and record fingerprints. Completed work is reused. Changed records or account/namespace collisions stop execution. An operation with an ambiguous outcome remains pending and stops automatic recovery; inspect its original result before continuing. Never re-upload an uncertain job, replace a tested account, reset shared data or delete posted history to recover.

Rehearsals run only against an isolated local PostgreSQL database guarded by the existing localhost check. Posted records are reconciled against the inventory ledger, while the independent manifest predicts final on-hand, reserved and available values.

## Free demo bounds

Before hosted deployment/seeding, inspect current Vercel, Render and AWS account usage and billing settings. Prior $0 observations do not prove current headroom. Render Free PostgreSQL expiry must also be checked. Stop if available capacity cannot be verified or paid capacity is required.

The initial hosted seed and its verification use one sequential process, at most 1,000 explicit API requests, eight CSV jobs, 256 KiB per uploaded CSV, 2 MiB of new uploads and 60 minutes of active execution before reassessment. Stop polling terminal jobs. A timeout keeps the same job and checkpoint. Close test sessions/tabs after verification and do not add keepalive traffic.

The local interrupted/resumed rehearsal used 812 cumulative explicit requests, seven CSV tasks and 24,210 uploaded bytes. Three imports each require validation and commit, plus four exports: ten background jobs in total. Provider background health checks, builds and normal application notification streams are additional provider activity; these execution ceilings do not replace the provider's actual allowances.

Official references: [Render Free](https://render.com/docs/free), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [AWS Free Tier plans](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier-plans.html).

## Validation gates

| Area | Required evidence |
| --- | --- |
| Decimal display | Whole/fraction/negative/negative-zero/null/large exact values; identifiers and free text unchanged; API storage precision retained |
| Inputs and previews | Clean initial values, editable intermediate/invalid values, validation errors preserved, original upload bytes unchanged |
| CSV exports | Existing headers and encoding, trimmed numeric columns, precise large decimals, formula escaping, leading-zero text retained |
| Notifications | All pages, user isolation, prior timestamps, repeat operation, concurrent arrival after statement snapshot, UI failure/retry and all three count views |
| Navigation | Every signed-in route, detail/selected-job breadcrumbs, direct-link fallback, filtered later-page restoration, independent job pagination and scroll |
| Unsaved changes | Back, sidebar navigation, dialog Close/Escape and sign-out; cancellation retains input; successful save/accepted discard does not prompt again |
| Branding/sign-out | Correct assets and aspect ratio, readable sidebar/footer, keyboard focus, mobile/tablet/desktop, English/Vietnamese labels and wrapping |
| Dataset | Exact counts and statuses, real IDs, unit precision, eligible returns, reserved/transit/quarantine arithmetic, nonnegative availability and every ledger sum |
| Accounts | Ready-to-use activation, correct Staff ownership, North restrictions, Viewer read access and denied writes |
| Recovery and cost | Dry run has no network/writes; interrupted checkpoint resumes; repeat creates no records/jobs/events; tester changes, collisions and ambiguous operations stop; ceilings hold |

Required local commands: frontend lint, build and full browser test suite; server full test suite including the persistent demo rehearsal; Git diff whitespace check. Browser tests use local mocked APIs; database/API/rehearsal tests use temporary local databases and filesystem storage, not hosted services.

## Release sequence and completion

1. Implement and validate locally, including the persistent dataset rehearsal. Record actual passed, failed and unverified checks.
2. Prepare compatible backend and frontend commits. The user pushes them through GitHub Desktop.
3. Verify backend readiness and frontend publication against those commits. Do not seed during failed deployment.
4. Recheck provider capacity and existing namespace/account collisions. Apply the reviewed dataset once with its checkpoint.
5. Perform bounded hosted checks on desktop/tablet/mobile and both languages. Check representative numeric fields across every module, Back restoration and direct links, all three new roles, bulk read using a new demo account, and completed exports. Use planned fixture transitions for live form checks and finish the specified status mix.
6. Reconcile hosted balances, reservations, transfer transit/quarantine, statuses and ledger totals. Verify new arrivals remain unread after bulk read without clearing Admin's historical notifications.
7. Deliver published commit evidence, the nonsecret dataset manifest, test results and tester guide. Provide passwords privately in the chat. Report any remaining failure or unverified requirement explicitly.

Completion requires every requested feature published, the new dataset and accounts usable, all required local gates passing, and hosted evidence for the agreed scope. Local tests alone do not establish hosted completion.
