# Shared OrderFlow demo guide

Deployment and demo-data setup are pending until the release verification records completion. The following identifies the planned `DEMO-V2` collection.

All sample business data is fictional. Everyone shares it, so a workflow another tester completes will remain completed. Use the document number to agree which draft or open example each person will test.

| Account | Access |
| --- | --- |
| Existing Admin | Manage the entire application and review stock changes/disputes |
| staff@example.com | Staff in Main, North and South demo warehouses |
| staff.north@example.com | Staff in North demo warehouse only |
| viewer@example.com | View products, stock, reports and notifications in the three demo warehouses |

Passwords are shared privately in the chat. No first-login password change is planned for these sample accounts.

Search Products for `DEMO-V2` or an English/Vietnamese name. Product SKUs range from `DEMO-V2-P001` through `DEMO-V2-P060`. Use the warehouse filter to distinguish new demo stock from earlier testing records.

| Try | Starting examples |
| --- | --- |
| Edit an item as Admin | Any DEMO-V2 product; meaningful numbers remain exact and unnecessary zeros are hidden |
| Check decimal stock | Fractional units such as canvas fabric, rice, milk, timber, paint and drawing paper |
| Compare availability | Main P001–P006 have zero on hand; Main P009–P011 are fully reserved; Main P015–P020 are low stock |
| Post an inbound receipt | DEMO-V2-REC-07, REC-08, REC-09 are drafts |
| Confirm an order | DEMO-V2-ORD-01 through ORD-06 are drafts created by main Staff |
| Fulfill an order | ORD-07 through ORD-12 are confirmed and already reserve stock |
| Inspect completed orders | ORD-13 through ORD-20 are fulfilled; ORD-21 through ORD-24 are cancelled |
| Post an eligible return | DEMO-V2-RET-4, RET-5, RET-6 are drafts linked to fulfilled orders |
| Dispatch a transfer | DEMO-V2-TRF-01 and TRF-02 are drafts |
| Receive a sent transfer | TRF-03 and TRF-04 are sent |
| Finish a partial receipt | TRF-05 and TRF-06 each still have quantity in transit |
| Review a dispute as Admin | TRF-07 has a shortage; TRF-08 has quarantined excess |
| Inspect completed transfers | TRF-09/TRF-10 are received; TRF-11/TRF-12 are resolved |
| Review a stock request | Reasons beginning DEMO-V2-REQ-1 and REQ-2 are pending counts; REQ-3/4 are approved damage; REQ-5/6 are rejected losses |
| Review real import examples | Products, opening-stock and Staff draft-order imports are committed |
| Download exports as Staff | Products, Main Stock, Main Movements and Main Low stock report examples are ready |
| Clear your unread alerts | Notifications → Mark all as read; rows stay visible and later updates stay unread |
| Test Back | Open a record from a filtered later list page, then use ←; try opening a detail URL directly as well |
| Test unsaved changes | Change a form field, use ← or sign-out, and Cancel the discard confirmation; then confirm the field remains |

Main Staff cannot edit documents owned only by North Staff merely because both can access the warehouse. Use a document owned by your account; Admin can inspect the whole collection. North Staff can work with North receipts/orders/returns and transfers involving North, with receive/dispatch actions still governed by destination/source permissions.

Keep currency totals separate. Some products deliberately have no primary supplier cost to demonstrate missing-cost valuation. Draft documents do not change inventory. Posted actions append history and should not be reset or edited directly.

On free hosting, the backend may take time to wake after inactivity. Wait for the original operation or job to finish before retrying; a delayed response alone does not prove failure.

Setup and expansion instructions are in `demo-setup-recovery.md`. The initial setup checks bulk read using the new Staff account before exports generate later unread alerts. It preserves Admin's previous alert state. Testing can change the shared starting examples; no automatic reset runs when the API starts.
