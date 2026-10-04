# Seven-issue coverage inventory

This inventory is based on the current route and form source. The screenshots in `layouts/` show the rendered layouts; the test log and report record actual pass/fail results. Dynamic business values remain untranslated.

## Mutations and duplicate protection

| Area | Writes reviewed | Protection |
|---|---|---|
| Authentication | Sign in, sign out, change own password | Immediate form/button lock; session result controls navigation. Credentials are excluded from persisted recovery. |
| Users | Create, edit, activate/deactivate, assign warehouses, reset password | Immediate form/button lock; server replay for administrative writes. |
| Catalog | Category, attribute, product create/edit, supplier link | Immediate form/button lock; server replay. |
| Reference data | Unit, supplier, warehouse, stock thresholds | Immediate form/button lock; server replay. |
| Documents | Receipt/order/return/transfer creation and line saves | Immediate form/button lock; server replay. |
| Inventory actions | Receipt post; order confirm/fulfill/cancel; return post; transfer send/receive; shortage/discrepancy resolution; stock decision | Immediate confirm/action lock; existing inventory command replay with actor/permission snapshot. |
| Stock requests | Create request; upload/delete evidence | Immediate form/confirm lock; server replay, request row lock, owner/state check and cleanup job. |
| Data jobs | Three CSV uploads, import commit, exports | Immediate form/action lock; server replay and existing job dedupe. Completed import status is returned on retry after worker progress. |
| Notifications | Mark one/read all | Immediate action lock; server replay; new notifications remain unread after an old read-all replay. |

The replay header is optional for older deployed clients during the backend-first transition. Such older clients retain their previous semantics until the frontend deployment completes. Recovery records live in the browser session for 24 hours; server replay results are retained for 30 days and trimmed in bounded batches.

## Form layout and product navigation

| Surface | Layout/reference check |
|---|---|
| Receipt, order, return and transfer detail editors | Full-width product picker/helper/link; aligned quantity, warehouse, cost/price/currency/remove rows; EN/VI at 1440, 1024, 390 and 320 px. |
| Transfer receiving and discrepancy | Aligned receipt quantities and document context; product links in discrepancy/read state. |
| Stock request and evidence | Mobile fields, readable product and warehouse, upload/delete controls and history. |
| Reference data and thresholds | Tabs contained on mobile; warehouse and product controls within viewport. |
| Users, imports/exports, reports | Inputs/selects remain within viewport; long labels and localized text. |
| Stock, movements, low-stock report and document item rows | Name and SKU use actual product ID links; related warehouse codes display where available. |

Product links use the existing product route, preserve ordinary keyboard/new-tab behavior and the application's unsaved-change guard. Missing/inaccessible references are displayed without guessing an ID.

## Translation states

Routes reviewed: Overview, Products, Stock, Receipts, Orders, Returns, Transfers, Approvals, Movements, Reports, Imports & exports, Reference data, Users, Notifications, sign-in, password change and not-found. The shared dictionary and error mapper cover headings, controls, statuses, roles, helper text, empty/loading states, confirmation text, known API/CSV errors, notification templates, footer/accessibility labels and displayed dates. English/Vietnamese screenshots and route navigation tests cover both languages. Native file picker chrome follows the browser/OS language.

## Order identity, permissions and evidence

Orders show both the unique document number and internal Order ID. Return selection queries permitted fulfilled orders, searches by reference or exact internal ID, shows both values and status, and limits warehouses to those on the selected order. API tests cover ID 29 versus document ORD-25, non-fulfilled/unauthorized orders, warehouse and quantity enforcement.

Stock-request evidence is deletable by its creator only while Pending. The API enforces this even if a client renders a stale button. A deletion makes the file unavailable immediately, records immutable removal history, and queues physical storage cleanup with bounded retries. Approved/rejected requests lock upload and delete; unrelated transfer evidence keeps its current rules.
