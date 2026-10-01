// Rebuild the editable draw.io ERD from the installed PostgreSQL schema.
// Run with: node --env-file=.env scripts/export-erd.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';

const SCHEMA = 'orderflow';
const OUTPUT = new URL('../../docs/erd/orderflow.drawio', import.meta.url);

const groups = [
  {
    name: 'Identity & Catalog', color: '#2563eb', pale: '#eff6ff',
    columns: [
      ['users', 'sessions', 'user_warehouses', 'warehouses'],
      ['units', 'categories', 'category_attributes', 'products'],
      ['suppliers', 'product_suppliers', 'low_stock_thresholds'],
    ],
  },
  {
    name: 'Orders & Inventory', color: '#059669', pale: '#ecfdf5',
    columns: [
      ['orders', 'order_items', 'order_returns', 'order_return_items'],
      ['receipts', 'receipt_items', 'inventory_balances'],
      ['inventory_events', 'inventory_ledger'],
    ],
  },
  {
    name: 'Transfers & Approvals', color: '#d97706', pale: '#fffbeb',
    columns: [
      ['transfers', 'transfer_items', 'transfer_receipts', 'transfer_receipt_items'],
      ['transfer_discrepancies', 'discrepancy_resolutions', 'evidence_files', 'discrepancy_evidence'],
      ['stock_change_requests', 'stock_change_decisions', 'stock_request_evidence'],
    ],
  },
  {
    name: 'Notifications & Jobs', color: '#7c3aed', pale: '#f5f3ff',
    columns: [
      ['notifications', 'user_notification_preferences', 'push_subscriptions', 'telegram_links'],
      ['outbox_events', 'delivery_attempts', 'audit_events'],
      ['background_jobs', 'import_jobs', 'import_errors', 'export_jobs'],
    ],
  },
];
const groupByTable = new Map(groups.flatMap((group, i) => group.columns.flat().map(table => [table, i])));
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  .replaceAll('\n', '&#10;');
const attr = (key, value) => ` ${key}="${esc(value)}"`;
const geometry = (x, y, width, height, relative = false) =>
  `<mxGeometry x="${x}" y="${y}" width="${width}" height="${height}"${relative ? ' relative="1"' : ''} as="geometry"/>`;
const vertex = ({ id, parent = '1', value = '', style, x, y, width, height }) =>
  `<mxCell${attr('id', id)}${attr('value', value)}${attr('style', style)} vertex="1"${attr('parent', parent)}>${geometry(x, y, width, height)}</mxCell>`;
const edge = ({ id, source, target, value = '', color = '#94a3b8', faint = false, dashed = false, one = false }) => {
  const style = `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=0;` +
    `strokeColor=${color};strokeWidth=${faint ? 1 : 1.4};opacity=${faint ? 45 : 85};` +
    `fontColor=#334155;fontSize=10;labelBackgroundColor=#ffffff;` +
    `startArrow=${one ? 'ERone' : 'ERmany'};startFill=0;startSize=9;endArrow=ERone;endFill=0;endSize=9;` +
    (dashed ? 'dashed=1;' : '');
  return `<mxCell${attr('id', id)}${attr('value', value)}${attr('style', style)} edge="1" parent="1"${attr('source', source)}${attr('target', target)}><mxGeometry relative="1" as="geometry"/></mxCell>`;
};
const model = ({ cells, width, height }) => `<mxGraphModel dx="1900" dy="1100" grid="1" gridSize="10"` +
  ` guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1"` +
  ` pageWidth="${Math.ceil(width)}" pageHeight="${Math.ceil(height)}" background="#ffffff" math="0" shadow="0">` +
  `<root><mxCell id="0"/><mxCell id="1" parent="0"/>${cells.join('')}</root></mxGraphModel>`;
const diagram = (id, name, content) => `<diagram${attr('id', id)}${attr('name', name)}>${content}</diagram>`;

function domainDetail(group, index, tables, fks) {
  const native = new Set(group.columns.flat());
  const external = [...new Set(fks.filter(f => native.has(f.from_table) && !native.has(f.to_table))
    .map(f => f.to_table))].sort();
  const panel = [];
  const nodes = [];
  const edges = [];
  const ids = new Map();
  panel.push(vertex({ id: `d${index}_title`, value: group.name.toUpperCase(), x: 45, y: 28,
    width: 1020, height: 40,
    style: `rounded=0;whiteSpace=wrap;html=0;fillColor=${group.color};strokeColor=${group.color};fontColor=#ffffff;fontStyle=1;fontSize=19;align=left;spacingLeft=14;` }));
  panel.push(vertex({ id: `d${index}_legend`, value: 'PK = primary key   FK = foreign key   UQ = unique column   ? = nullable   Arrow points from child to parent',
    x: 48, y: 77, width: 1290, height: 25,
    style: 'rounded=0;html=0;strokeColor=none;fillColor=none;fontColor=#475569;fontSize=11;align=left;' }));

  let maxY = 115;
  group.columns.forEach((column, col) => {
    let y = 120;
    const x = 45 + col * 365;
    for (const name of column) {
      const table = tables.get(name);
      const h = 34 + table.columns.length * 18 + 10;
      const groupId = `d${index}_t_${name}`;
      ids.set(name, groupId);
      nodes.push(vertex({ id: groupId, value: '', x, y, width: 320, height: h,
        style: 'group;container=1;collapsible=0;strokeColor=none;fillColor=none;' }));
      nodes.push(vertex({ id: `${groupId}_header`, parent: groupId, value: name.toUpperCase(), x: 0, y: 0, width: 320, height: 34,
        style: `rounded=0;whiteSpace=wrap;html=0;fillColor=${group.color};strokeColor=${group.color};fontColor=#ffffff;fontStyle=1;fontSize=13;align=left;spacingLeft=10;` }));
      const lines = table.columns.map(c => {
        const keys = [c.pk && 'PK', c.fk && 'FK', c.uq && 'UQ'].filter(Boolean).join(',');
        return `${keys ? `[${keys}] ` : ''}${c.name} : ${c.type}${c.required ? '' : ' ?'}`;
      });
      nodes.push(vertex({ id: `${groupId}_body`, parent: groupId, value: lines.join('\n'),
        x: 0, y: 34, width: 320, height: h - 34,
        style: `rounded=0;whiteSpace=wrap;html=0;fillColor=${group.pale};strokeColor=${group.color};fontColor=#0f172a;fontFamily=Consolas;fontSize=10;align=left;verticalAlign=top;spacingTop=7;spacingLeft=8;` }));
      y += h + 35;
    }
    maxY = Math.max(maxY, y);
  });
  let externalY = 120;
  for (const name of external) {
    const id = `d${index}_external_${name}`;
    ids.set(name, id);
    nodes.push(vertex({ id, value: `EXTERNAL  ${name.toUpperCase()}`, x: 1145, y: externalY,
      width: 265, height: 48,
      style: 'rounded=1;arcSize=12;dashed=1;whiteSpace=wrap;html=0;fillColor=#f8fafc;strokeColor=#64748b;fontColor=#334155;fontSize=11;fontStyle=1;align=center;' }));
    externalY += 72;
  }
  maxY = Math.max(maxY, externalY);
  for (const fk of fks.filter(f => native.has(f.from_table))) {
    edges.push(edge({ id: `d${index}_fk_${fk.id}`, source: ids.get(fk.from_table), target: ids.get(fk.to_table),
      value: fk.from_cols.join(', '), color: native.has(fk.to_table) ? group.color : '#64748b',
      dashed: !native.has(fk.to_table), one: fk.unique }));
  }
  return model({ cells: [...panel, ...edges, ...nodes], width: 1450, height: maxY + 45 });
}

function overview(tables, fks) {
  const panels = [];
  const nodes = [];
  const edges = [];
  const ids = new Map();
  panels.push(vertex({ id: 'overview_title', value: 'ORDERFLOW  /  COMPLETE DATABASE ERD',
    x: 40, y: 22, width: 1680, height: 45,
    style: 'rounded=0;fillColor=#0f172a;strokeColor=#0f172a;fontColor=#ffffff;fontStyle=1;fontSize=21;align=left;spacingLeft=15;' }));
  panels.push(vertex({ id: 'overview_legend', value: `${tables.size} tables  /  ${fks.length} foreign keys  /  arrows show child to parent  /  use the detail tabs for all columns`,
    x: 45, y: 71, width: 1660, height: 25,
    style: 'rounded=0;fillColor=none;strokeColor=none;fontColor=#475569;fontSize=12;align=left;' }));
  groups.forEach((group, col) => {
    const x = 45 + col * 425;
    panels.push(vertex({ id: `overview_group_${col}`, value: group.name.toUpperCase(), x, y: 112,
      width: 380, height: 42,
      style: `rounded=0;fillColor=${group.color};strokeColor=${group.color};fontColor=#ffffff;fontStyle=1;fontSize=14;align=left;spacingLeft=12;` }));
    group.columns.flat().forEach((name, row) => {
      const id = `overview_${name}`;
      ids.set(name, id);
      nodes.push(vertex({ id, value: `${name.toUpperCase()}   (${tables.get(name).columns.length} columns)`,
        x, y: 173 + row * 63, width: 380, height: 45,
        style: `rounded=1;arcSize=10;whiteSpace=wrap;html=0;fillColor=${group.pale};strokeColor=${group.color};fontColor=#0f172a;fontStyle=1;fontSize=12;align=left;spacingLeft=12;` }));
    });
  });
  for (const fk of fks) edges.push(edge({ id: `overview_fk_${fk.id}`, source: ids.get(fk.from_table),
    target: ids.get(fk.to_table), faint: true, one: fk.unique }));
  return model({ cells: [...panels, ...edges, ...nodes], width: 1760, height: 950 });
}

function viewsPage(views) {
  const cells = [];
  cells.push(vertex({ id: 'views_title', value: 'DERIVED VIEWS  /  LIVE QUERY RESULTS', x: 40, y: 25, width: 1430, height: 45,
    style: 'fillColor=#0f172a;strokeColor=#0f172a;fontColor=#ffffff;fontSize=19;fontStyle=1;align=left;spacingLeft=14;' }));
  const dependencies = {
    current_inventory: ['inventory_balances', 'products', 'warehouses', 'low_stock_thresholds'],
    discrepancy_status: ['transfer_discrepancies', 'discrepancy_resolutions'],
    transfer_item_balances: ['transfer_items', 'transfer_receipt_items', 'transfer_discrepancies', 'discrepancy_resolutions'],
  };
  views.forEach((view, i) => {
    const y = 110 + i * 390;
    const id = `view_${view.name}`;
    const lines = view.columns.map(c => `${c.name} : ${c.type}`).join('\n');
    cells.push(vertex({ id, value: `${view.name.toUpperCase()}\n${lines}`, x: 55, y, width: 500, height: Math.max(100, 36 + view.columns.length * 17),
      style: 'rounded=1;arcSize=8;whiteSpace=wrap;html=0;fillColor=#e0f2fe;strokeColor=#0284c7;strokeWidth=2;fontColor=#0f172a;fontFamily=Consolas;fontSize=11;align=left;verticalAlign=top;spacingTop=9;spacingLeft=10;' }));
    (dependencies[view.name] ?? []).forEach((table, n) => {
      const source = `view_source_${view.name}_${n}`;
      cells.push(vertex({ id: source, value: table.toUpperCase(), x: 810, y: y + n * 70, width: 360, height: 48,
        style: 'rounded=1;arcSize=10;fillColor=#f1f5f9;strokeColor=#64748b;fontColor=#334155;fontSize=12;fontStyle=1;align=center;' }));
      cells.push(edge({ id: `view_edge_${view.name}_${n}`, source: id, target: source, value: 'reads', color: '#0284c7', dashed: true }));
    });
  });
  return model({ cells, width: 1250, height: 1320 });
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
try {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in server/.env');
  await client.connect();
  const tableRows = (await client.query(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='r' ORDER BY c.relname`, [SCHEMA])).rows;
  const columnRows = (await client.query(`
    SELECT c.relname AS table_name,a.attname AS name,
      format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,a.attnum
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`, [SCHEMA])).rows;
  const keyRows = (await client.query(`
    SELECT c.relname AS table_name,a.attname AS column_name,co.contype AS kind,
      cardinality(co.conkey)=1 AS single_column
    FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN LATERAL unnest(co.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
    WHERE n.nspname=$1 AND co.contype IN ('p','u','f')`, [SCHEMA])).rows;
  const fkRows = (await client.query(`
    SELECT co.oid::text AS id,child.relname AS from_table,parent.relname AS to_table,
      ARRAY(SELECT a.attname FROM unnest(co.conkey) WITH ORDINALITY AS k(attnum,ord)
        JOIN pg_attribute a ON a.attrelid=co.conrelid AND a.attnum=k.attnum ORDER BY k.ord)::text[] AS from_cols,
      EXISTS(SELECT 1 FROM pg_constraint uq WHERE uq.conrelid=co.conrelid AND uq.contype IN ('p','u')
        AND uq.conkey=co.conkey) AS unique
    FROM pg_constraint co JOIN pg_class child ON child.oid=co.conrelid
    JOIN pg_class parent ON parent.oid=co.confrelid
    JOIN pg_namespace n ON n.oid=co.connamespace
    WHERE n.nspname=$1 AND co.contype='f' ORDER BY child.relname,parent.relname,co.conname`, [SCHEMA])).rows;
  const viewRows = (await client.query(`
    SELECT c.relname AS view_name,a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnum
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname=$1 AND c.relkind='v' ORDER BY c.relname,a.attnum`, [SCHEMA])).rows;

  const tables = new Map(tableRows.map(row => [row.name, { name: row.name, columns: [] }]));
  for (const row of columnRows) tables.get(row.table_name).columns.push({ ...row, pk: false, fk: false, uq: false });
  for (const row of keyRows) {
    const col = tables.get(row.table_name)?.columns.find(c => c.name === row.column_name);
    if (col) {
      if (row.kind === 'p') col.pk = true;
      if (row.kind === 'f') col.fk = true;
      if (row.kind === 'u' && row.single_column) col.uq = true;
    }
  }
  const ungrouped = [...tables.keys()].filter(name => !groupByTable.has(name));
  const missing = [...groupByTable.keys()].filter(name => !tables.has(name));
  if (ungrouped.length || missing.length) throw new Error(`Update ERD groups for schema changes. Ungrouped: ${ungrouped}; absent: ${missing}`);
  if (fkRows.some(row => !tables.has(row.from_table) || !tables.has(row.to_table))) throw new Error('Foreign key references a table outside the diagram.');
  const views = [...new Set(viewRows.map(row => row.view_name))].map(name => ({ name,
    columns: viewRows.filter(row => row.view_name === name) }));
  const pages = [diagram('overview', 'Overview', overview(tables, fkRows)),
    ...groups.map((group, index) => diagram(`domain_${index}`, group.name, domainDetail(group, index, tables, fkRows))),
    diagram('views', 'Views', viewsPage(views))];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<mxfile host="app.diagrams.net" agent="OrderFlow ERD export" version="24.7.17" type="device" pages="${pages.length}">` +
    pages.join('') + `</mxfile>\n`;
  await mkdir(new URL('../../docs/erd/', import.meta.url), { recursive: true });
  await writeFile(OUTPUT, xml, 'utf8');
  console.log(`Wrote ${OUTPUT.pathname}: ${tables.size} tables, ${fkRows.length} foreign keys, ${views.length} views, ${pages.length} pages.`);
} catch (error) {
  console.error(`ERD export failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
