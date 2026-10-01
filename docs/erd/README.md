# OrderFlow database ERD

## Combined approved logical ERD

The three Mermaid ERDs in `docs/system-design.md` are merged into one diagram:

- [Editable draw.io file](system-design-combined-erd.drawio)
- [Single-page PNG](system-design-combined-erd.png)
- [Combined Mermaid source](system-design-combined-erd.mmd)

This diagram contains 19 distinct tables, 96 distinct fields, and all 28 relationships shown in those three ERDs. Repeated tables are merged by column name; column types, key markers, relationship labels, and cardinalities are preserved. Catalog tables are blue, order/history tables green, transfer tables orange, and shared tables slate. It represents the approved logical diagrams; the additional supporting records described in prose are covered by the physical ERD below. The original system design document is unchanged.

## Full physical database ERD

[Open the editable draw.io diagram](orderflow.drawio). It has six page tabs:

| Page | Contents | PNG |
| --- | --- | --- |
| Overview | All 42 tables and all 85 foreign key relationships | [overview.png](png/overview.png) |
| Identity & Catalog | Users, warehouses, products, categories, and attributes | [catalog.png](png/catalog.png) |
| Orders & Inventory | Orders, receipts, returns, balances, events, and ledger | [orders-inventory.png](png/orders-inventory.png) |
| Transfers & Approvals | Transfers, discrepancy evidence and resolutions, stock change approvals | [transfers-approvals.png](png/transfers-approvals.png) |
| Notifications & Jobs | Notification delivery, audit events, imports, exports, and jobs | [notifications-jobs.png](png/notifications-jobs.png) |
| Views | The three derived database views and the tables they read | [views.png](png/views.png) |

The detail pages show every table column, its database type, and whether it is a primary key (`PK`), foreign key (`FK`), single-column unique key (`UQ`), or nullable (`?`). An `EXTERNAL_` box represents a table fully drawn on another page. The dashed connection to it is still a real foreign key. The overview is an index, so use the detail pages to read individual columns and relationships.

To export another PNG, open `orderflow.drawio` in draw.io or [diagrams.net](https://app.diagrams.net/), choose a page tab, then use **File → Export as → PNG**. Set the zoom/scale as needed. The PNGs in `png/` are ready to use.

This file was generated from the installed PostgreSQL `orderflow` schema. SQL migrations in `server/migrations` remain the database source of truth. To rebuild the editable ERD after applying new migrations, run `npm run db:erd` from `server/`. The generator is `server/scripts/export-erd.mjs`; it checks that every table has a page. Regeneration overwrites `orderflow.drawio`, so save a separate copy for manual annotations. The diagram focuses on tables, columns, keys, foreign keys, and views; see the migrations for indexes, checks, and triggers.
