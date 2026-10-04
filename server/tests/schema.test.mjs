import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect, localDatabaseUrl, quoteIdentifier, migrate } from '../scripts/db-lib.mjs';
import { createExample, createOrder } from '../scripts/example-data.mjs';

let admin, db, url, name, created = false, ex;
const clients = new Set();
const newClient = async () => { const c = await connect(url); clients.add(c); return c; };
const scalar = async (sql, args=[]) => Object.values((await db.query(sql,args)).rows[0])[0];
const fail = async (work, code='23514') => assert.rejects(work, error => error.code===code);
const stock = async (product=ex.product,warehouse=ex.warehouse) => (await db.query(
  'SELECT on_hand::numeric::float8 AS on_hand,reserved::numeric::float8 AS reserved,available::float8 AS available FROM orderflow.inventory_balances WHERE product_id=$1 AND warehouse_id=$2',
  [product,warehouse])).rows[0];
async function product(quantity=10) {
  const p=await scalar(`INSERT INTO orderflow.products(sku,name,category_id,unit_id,attributes)
    VALUES($1,'Test phone',$2,$3,'{"screen_size_inches":6.1}') RETURNING id`,[randomUUID(),ex.category,ex.unit]);
  if(quantity>0) {
    const r=await scalar(`INSERT INTO orderflow.receipts(receipt_number,kind,warehouse_id,created_by) VALUES($1,'INBOUND',$2,$3) RETURNING id`,[randomUUID(),ex.warehouse,ex.manager]);
    await db.query('INSERT INTO orderflow.receipt_items(receipt_id,product_id,quantity) VALUES($1,$2,$3)',[r,p,quantity]);
    await db.query('SELECT orderflow.post_receipt($1,$2,$3)',[r,ex.manager,randomUUID()]);
  }
  return p;
}
async function transaction(work) {
  await db.query('BEGIN');
  try { const value=await work(); await db.query('COMMIT'); return value; }
  catch(error) { await db.query('ROLLBACK'); throw error; }
}

before(async () => {
  url=localDatabaseUrl(); const adminUrl=new URL(url); adminUrl.pathname='/postgres';
  admin=await connect(adminUrl);
  name=`orderflow_schema_test_${randomUUID().replaceAll('-','').slice(0,16)}`;
  await admin.query(`CREATE DATABASE ${quoteIdentifier(name)}`); created=true;
  url.pathname=`/${name}`; db=await newClient();
  await migrate(db,()=>{},'004_revisions.sql');
  // Prove re-running the migration runner skips identical migrations.
  await migrate(db,()=>{},'004_revisions.sql');
  ex=await transaction(()=>createExample(db));
});
after(async () => {
  for(const c of clients) await c.end().catch(()=>{});
  if(created) await admin.query(`DROP DATABASE ${quoteIdentifier(name)}`);
  if(admin) await admin.end();
});

test('migration 011 upgrades populated data once during concurrent startup',async()=>{
  const upgradeName=`orderflow_upgrade_test_${randomUUID().replaceAll('-','').slice(0,16)}`;
  const upgradeUrl=new URL(url);upgradeUrl.pathname='/'+upgradeName;
  await admin.query(`CREATE DATABASE ${quoteIdentifier(upgradeName)}`);
  let first,second;
  try {
    first=await connect(upgradeUrl);second=await connect(upgradeUrl);
    await migrate(first,()=>{},'010_stock_availability.sql');
    const sample=await createExample(first,undefined,false);
    const before=(await first.query('SELECT sku,name FROM orderflow.products WHERE id=$1',[sample.product])).rows[0];
    await first.query('CREATE TABLE orderflow.evidence_removals (blocker integer)');
    await assert.rejects(migrate(first,()=>{}),/011_submission_evidence\.sql/);
    assert.equal((await first.query("SELECT count(*)::int AS count FROM public.orderflow_schema_migrations WHERE filename='011_submission_evidence.sql'")).rows[0].count,0);
    assert.equal((await first.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='orderflow' AND table_name='mutation_results'")).rows[0].count,0);
    await first.query('DROP TABLE orderflow.evidence_removals');
    await Promise.all([migrate(first,()=>{}),migrate(second,()=>{})]);
    const after=(await first.query('SELECT sku,name FROM orderflow.products WHERE id=$1',[sample.product])).rows[0];
    assert.deepEqual(after,before);
    assert.equal((await first.query("SELECT count(*)::int AS count FROM public.orderflow_schema_migrations WHERE filename='011_submission_evidence.sql'")).rows[0].count,1);
    assert.equal((await first.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema='orderflow' AND table_name IN ('mutation_results','evidence_removals')")).rows[0].count,2);
  } finally {
    await first?.end();await second?.end();
    await admin.query(`DROP DATABASE ${quoteIdentifier(upgradeName)}`);
  }
});

test('category values reject unknown keys, missing required values, wrong types and bounds',async()=>{
  for(const attrs of [{dpi:460,screen_size_inches:6.1},{color:'silver'},{screen_size_inches:'6.1'},{screen_size_inches:-1},{screen_size_inches:null}]) {
    await fail(()=>db.query(`INSERT INTO orderflow.products(sku,name,category_id,unit_id,attributes)
      VALUES($1,'Invalid',$2,$3,$4)`,[randomUUID(),ex.category,ex.unit,attrs]));
  }
  await fail(()=>db.query(`INSERT INTO orderflow.category_attributes(category_id,key,label,data_type,required)
    VALUES($1,'new_required','New required','number',true)`,[ex.category]));
  assert.equal(await scalar('SELECT count(*)::int FROM orderflow.category_attributes WHERE category_id=$1 AND key=$2',[ex.category,'new_required']),0);
});

test('balances and posted history reject direct mutation',async()=>{
  await fail(()=>db.query('UPDATE orderflow.inventory_balances SET on_hand=99 WHERE product_id=$1',[ex.product]));
  await fail(()=>db.query('UPDATE orderflow.inventory_ledger SET on_hand_delta=99 WHERE product_id=$1',[ex.product]));
  await fail(()=>db.query('DELETE FROM orderflow.inventory_events WHERE receipt_id=$1',[ex.receipt]));
  await fail(()=>db.query('UPDATE orderflow.receipt_items SET quantity=11 WHERE receipt_id=$1',[ex.receipt]));
  await fail(()=>db.query('UPDATE orderflow.users SET active=false WHERE id=$1',[ex.manager]));
});

test('confirmation reserves, retry is harmless, fulfilment deducts exactly once',async()=>{
  const p=await product(); const o=await createOrder(db,ex,3,p); const key=randomUUID();
  const id=await scalar('SELECT orderflow.confirm_order($1,$2,$3)',[o,ex.manager,key]);
  assert.deepEqual(await stock(p),{on_hand:10,reserved:3,available:7});
  assert.equal(await scalar('SELECT orderflow.confirm_order($1,$2,$3)',[o,ex.manager,key]),id);
  const fk=randomUUID(); await db.query('SELECT orderflow.fulfill_order($1,$2,$3)',[o,ex.manager,fk]);
  await db.query('SELECT orderflow.fulfill_order($1,$2,$3)',[o,ex.manager,fk]);
  assert.deepEqual(await stock(p),{on_hand:7,reserved:0,available:7});
  await fail(()=>db.query('SELECT orderflow.cancel_order($1,$2,$3)',[o,ex.manager,randomUUID()]));
  await fail(()=>db.query('UPDATE orderflow.order_items SET quantity=1 WHERE order_id=$1',[o]));
});

test('cancellation releases reserved stock',async()=>{
  const p=await product(); const o=await createOrder(db,ex,4,p);
  await db.query('SELECT orderflow.confirm_order($1,$2,$3)',[o,ex.manager,randomUUID()]);
  await db.query('SELECT orderflow.cancel_order($1,$2,$3)',[o,ex.manager,randomUUID()]);
  assert.deepEqual(await stock(p),{on_hand:10,reserved:0,available:10});
});

test('one unavailable line rolls back the entire multi-item confirmation',async()=>{
  const a=await product(); const b=await product(0); const o=await createOrder(db,ex,4,a);
  await db.query('INSERT INTO orderflow.order_items(order_id,product_id,warehouse_id,quantity) VALUES($1,$2,$3,1)',[o,b,ex.warehouse]);
  await fail(()=>db.query('SELECT orderflow.confirm_order($1,$2,$3)',[o,ex.manager,randomUUID()]));
  assert.deepEqual(await stock(a),{on_hand:10,reserved:0,available:10});
  assert.equal(await scalar('SELECT status FROM orderflow.orders WHERE id=$1',[o]),'DRAFT');
  assert.equal(await scalar('SELECT count(*)::int FROM orderflow.inventory_events WHERE order_id=$1',[o]),0);
});

test('parallel confirmations cannot both reserve the last item',async()=>{
  const p=await product(1); const a=await createOrder(db,ex,1,p); const b=await createOrder(db,ex,1,p);
  const c1=await newClient(); const c2=await newClient();
  const results=await Promise.allSettled([
    c1.query('SELECT orderflow.confirm_order($1,$2,$3)',[a,ex.manager,randomUUID()]),
    c2.query('SELECT orderflow.confirm_order($1,$2,$3)',[b,ex.manager,randomUUID()])]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'23514');
  assert.deepEqual(await stock(p),{on_hand:1,reserved:1,available:0});
});

test('parallel duplicate requests return the same event',async()=>{
  const p=await product(2); const o=await createOrder(db,ex,1,p); const key=randomUUID();
  const c1=await newClient(); const c2=await newClient();
  const [a,b]=await Promise.all([c1.query('SELECT orderflow.confirm_order($1,$2,$3) AS id',[o,ex.manager,key]),c2.query('SELECT orderflow.confirm_order($1,$2,$3) AS id',[o,ex.manager,key])]);
  assert.equal(a.rows[0].id,b.rows[0].id);
  assert.deepEqual(await stock(p),{on_hand:2,reserved:1,available:1});
});

test('returns cannot exceed fulfilled quantity',async()=>{
  const p=await product(); const o=await createOrder(db,ex,2,p);
  await db.query('SELECT orderflow.confirm_order($1,$2,$3)',[o,ex.manager,randomUUID()]);
  await db.query('SELECT orderflow.fulfill_order($1,$2,$3)',[o,ex.manager,randomUUID()]);
  const original=await scalar('SELECT id FROM orderflow.order_items WHERE order_id=$1',[o]);
  const make=async(q)=>transaction(async()=>{
    const r=await scalar(`INSERT INTO orderflow.order_returns(return_number,order_id,warehouse_id,received_by,reason)
      VALUES($1,$2,$3,$4,'Test return') RETURNING id`,[randomUUID(),o,ex.warehouse,ex.manager]);
    await db.query('INSERT INTO orderflow.order_return_items(return_id,order_id,order_item_id,quantity) VALUES($1,$2,$3,$4)',[r,o,original,q]);
    await db.query('SELECT orderflow.post_order_return($1,$2,$3)',[r,ex.manager,randomUUID()]);
  });
  await make(1); await fail(()=>make(2));
  assert.deepEqual(await stock(p),{on_hand:9,reserved:0,available:9});
});

test('status changes without complete stock events cannot commit',async()=>{
  const p=await product(); const o=await createOrder(db,ex,1,p);
  await fail(()=>transaction(()=>db.query("UPDATE orderflow.orders SET status='CONFIRMED' WHERE id=$1",[o])));
  await fail(()=>transaction(()=>db.query(`INSERT INTO orderflow.inventory_events(event_type,actor_id,idempotency_key,reason,order_id)
    VALUES('ORDER_CONFIRM',$1,$2,'Incomplete event',$3)`,[ex.manager,randomUUID(),o])));
});

test('transfer shortage stays in transit and resolution cannot exceed it',async()=>{
  const p=await product(10);
  const dest=await scalar('INSERT INTO orderflow.warehouses(code,name) VALUES($1,$2) RETURNING id',[randomUUID(),'Destination']);
  const transfer=await scalar(`INSERT INTO orderflow.transfers(transfer_number,source_warehouse_id,destination_warehouse_id,created_by)
    VALUES($1,$2,$3,$4) RETURNING id`,[randomUUID(),ex.warehouse,dest,ex.manager]);
  const item=await scalar('INSERT INTO orderflow.transfer_items(transfer_id,product_id,requested_qty) VALUES($1,$2,10) RETURNING id',[transfer,p]);
  await db.query('SELECT orderflow.send_transfer($1,$2,$3)',[transfer,ex.manager,randomUUID()]);
  const receive=async(q)=>transaction(async()=>{
    const receipt=await scalar('INSERT INTO orderflow.transfer_receipts(transfer_id,received_by,idempotency_key) VALUES($1,$2,$3) RETURNING id',[transfer,ex.manager,randomUUID()]);
    const line=await scalar(`INSERT INTO orderflow.transfer_receipt_items(receipt_id,transfer_id,transfer_item_id,counted_qty,accepted_qty,quarantined_qty)
      VALUES($1,$2,$3,$4,$4,0) RETURNING id`,[receipt,transfer,item,q]);
    const e=await scalar(`INSERT INTO orderflow.inventory_events(event_type,actor_id,idempotency_key,reason,transfer_receipt_id)
      VALUES('TRANSFER_RECEIVE',$1,$2,'Counted receipt',$3) RETURNING id`,[ex.manager,randomUUID(),receipt]);
    await db.query(`INSERT INTO orderflow.inventory_ledger(event_id,product_id,warehouse_id,transfer_receipt_item_id,on_hand_delta,reserved_delta)
      VALUES($1,$2,$3,$4,$5,0)`,[e,p,dest,line,q]);
  });
  await receive(8); await fail(()=>receive(3));
  assert.equal(await scalar('SELECT in_transit_qty::float8 FROM orderflow.transfer_item_balances WHERE transfer_item_id=$1',[item]),2);
  const d=await scalar(`INSERT INTO orderflow.transfer_discrepancies(transfer_item_id,kind,reported_qty,reported_by,reason)
    VALUES($1,'SHORTAGE',2,$2,'Two units missing') RETURNING id`,[item,ex.manager]);
  await db.query("UPDATE orderflow.transfers SET status='DISPUTED' WHERE id=$1",[transfer]);
  await fail(()=>db.query("UPDATE orderflow.transfers SET status='RESOLVED' WHERE id=$1",[transfer]));
  await db.query(`INSERT INTO orderflow.discrepancy_resolutions(discrepancy_id,manager_id,resolution_type,quantity,idempotency_key,reason)
    VALUES($1,$2,'LOSS',2,$3,'Reviewed signed documents')`,[d,ex.manager,randomUUID()]);
  await fail(()=>db.query(`INSERT INTO orderflow.discrepancy_resolutions(discrepancy_id,manager_id,resolution_type,quantity,idempotency_key,reason)
    VALUES($1,$2,'LOSS',1,$3,'Duplicate loss')`,[d,ex.manager,randomUUID()]));
  await db.query("UPDATE orderflow.transfers SET status='RESOLVED' WHERE id=$1",[transfer]);
  assert.deepEqual(await stock(p,dest),{on_hand:8,reserved:0,available:8});
});

test('count approvals require a current reviewed balance and post its actual difference',async()=>{
  const p=await product(10);
  const request=await scalar(`INSERT INTO orderflow.stock_change_requests(request_type,warehouse_id,product_id,requested_by,
    counted_qty,observed_on_hand,observed_version,reason) VALUES('COUNT',$1,$2,$3,9,10,1,'Physical count') RETURNING id`,[ex.warehouse,p,ex.manager]);
  const r=await scalar(`INSERT INTO orderflow.receipts(receipt_number,kind,warehouse_id,created_by) VALUES($1,'INBOUND',$2,$3) RETURNING id`,[randomUUID(),ex.warehouse,ex.manager]);
  await db.query('INSERT INTO orderflow.receipt_items(receipt_id,product_id,quantity) VALUES($1,$2,2)',[r,p]);
  await db.query('SELECT orderflow.post_receipt($1,$2,$3)',[r,ex.manager,randomUUID()]);
  const approve=async(version,delta)=>transaction(async()=>{
    const decision=await scalar(`INSERT INTO orderflow.stock_change_decisions(request_id,manager_id,decision,approved_delta,reviewed_balance_version,reason)
      VALUES($1,$2,'APPROVED',$3,$4,'Reviewed latest balance') RETURNING id`,[request,ex.manager,delta,version]);
    const event=await scalar(`INSERT INTO orderflow.inventory_events(event_type,actor_id,idempotency_key,reason,decision_id)
      VALUES('ADJUSTMENT',$1,$2,'Count correction',$3) RETURNING id`,[ex.manager,randomUUID(),decision]);
    await db.query(`INSERT INTO orderflow.inventory_ledger(event_id,product_id,warehouse_id,on_hand_delta,reserved_delta)
      VALUES($1,$2,$3,$4,0)`,[event,p,ex.warehouse,delta]);
  });
  await fail(()=>approve(1,-1));
  await fail(()=>approve(2,-1));
  await approve(2,-3);
  assert.deepEqual(await stock(p),{on_hand:9,reserved:0,available:9});
});

test('excess remains quarantined until a manager posts a matching resolution',async()=>{
  const p=await product(2);
  const dest=await scalar('INSERT INTO orderflow.warehouses(code,name) VALUES($1,$2) RETURNING id',[randomUUID(),'Excess destination']);
  const t=await scalar(`INSERT INTO orderflow.transfers(transfer_number,source_warehouse_id,destination_warehouse_id,created_by)
    VALUES($1,$2,$3,$4) RETURNING id`,[randomUUID(),ex.warehouse,dest,ex.manager]);
  const item=await scalar('INSERT INTO orderflow.transfer_items(transfer_id,product_id,requested_qty) VALUES($1,$2,2) RETURNING id',[t,p]);
  await db.query('SELECT orderflow.send_transfer($1,$2,$3)',[t,ex.manager,randomUUID()]);
  await transaction(async()=>{
    const receipt=await scalar('INSERT INTO orderflow.transfer_receipts(transfer_id,received_by,idempotency_key) VALUES($1,$2,$3) RETURNING id',[t,ex.manager,randomUUID()]);
    const line=await scalar(`INSERT INTO orderflow.transfer_receipt_items(receipt_id,transfer_id,transfer_item_id,counted_qty,accepted_qty,quarantined_qty)
      VALUES($1,$2,$3,3,2,1) RETURNING id`,[receipt,t,item]);
    const event=await scalar(`INSERT INTO orderflow.inventory_events(event_type,actor_id,idempotency_key,reason,transfer_receipt_id)
      VALUES('TRANSFER_RECEIVE',$1,$2,'Extra phone quarantined',$3) RETURNING id`,[ex.manager,randomUUID(),receipt]);
    await db.query(`INSERT INTO orderflow.inventory_ledger(event_id,product_id,warehouse_id,transfer_receipt_item_id,on_hand_delta,reserved_delta)
      VALUES($1,$2,$3,$4,2,0)`,[event,p,dest,line]);
  });
  assert.deepEqual(await stock(p,dest),{on_hand:2,reserved:0,available:2});
  assert.equal(await scalar('SELECT quarantined_qty::float8 FROM orderflow.transfer_item_balances WHERE transfer_item_id=$1',[item]),1);
  const dispute=await scalar(`INSERT INTO orderflow.transfer_discrepancies(transfer_item_id,kind,reported_qty,reported_by,reason)
    VALUES($1,'EXCESS',1,$2,'Extra unit received') RETURNING id`,[item,ex.manager]);
  const resolve=async(post)=>transaction(async()=>{
    const resolution=await scalar(`INSERT INTO orderflow.discrepancy_resolutions(discrepancy_id,manager_id,resolution_type,quantity,idempotency_key,reason)
      VALUES($1,$2,'ACCEPT_EXCESS',1,$3,'Verified external origin and ownership') RETURNING id`,[dispute,ex.manager,randomUUID()]);
    if(post) {
      const event=await scalar(`INSERT INTO orderflow.inventory_events(event_type,actor_id,idempotency_key,reason,resolution_id)
        VALUES('TRANSFER_RESOLUTION',$1,$2,'Accept verified excess',$3) RETURNING id`,[ex.manager,randomUUID(),resolution]);
      await db.query('INSERT INTO orderflow.inventory_ledger(event_id,product_id,warehouse_id,on_hand_delta,reserved_delta) VALUES($1,$2,$3,1,0)',[event,p,dest]);
    }
  });
  await fail(()=>resolve(false)); await resolve(true);
  assert.deepEqual(await stock(p,dest),{on_hand:3,reserved:0,available:3});
  assert.equal(await scalar('SELECT quarantined_qty::float8 FROM orderflow.transfer_item_balances WHERE transfer_item_id=$1',[item]),0);
});

test('approved receipt reversal appends the opposite movement without editing history',async()=>{
  const p=await product(2);
  const original=await scalar('SELECT event_id FROM orderflow.inventory_ledger WHERE product_id=$1',[p]);
  await transaction(async()=>{
    const request=await scalar(`INSERT INTO orderflow.stock_change_requests(request_type,requested_by,original_event_id,reason)
      VALUES('REVERSAL',$1,$2,'Wrong receipt') RETURNING id`,[ex.manager,original]);
    const decision=await scalar(`INSERT INTO orderflow.stock_change_decisions(request_id,manager_id,decision,reason)
      VALUES($1,$2,'APPROVED','Reviewed') RETURNING id`,[request,ex.manager]);
    const e=await scalar(`INSERT INTO orderflow.inventory_events(event_type,actor_id,idempotency_key,reason,decision_id,reversal_of_event_id)
      VALUES('REVERSAL',$1,$2,'Reverse incorrect receipt',$3,$4) RETURNING id`,[ex.manager,randomUUID(),decision,original]);
    await db.query('INSERT INTO orderflow.inventory_ledger(event_id,product_id,warehouse_id,on_hand_delta,reserved_delta) VALUES($1,$2,$3,-2,0)',[e,p,ex.warehouse]);
  });
  assert.deepEqual(await stock(p),{on_hand:0,reserved:0,available:0});
  assert.equal(await scalar('SELECT count(*)::int FROM orderflow.inventory_ledger WHERE product_id=$1',[p]),2);
});

test('viewer commands and fractional piece quantities are rejected',async()=>{
  const viewer=await scalar(`INSERT INTO orderflow.users(email,display_name,password_hash,role)
    VALUES($1,'Viewer','DEMO_ONLY_NO_LOGIN','VIEWER') RETURNING id`,[`${randomUUID()}@example.invalid`]);
  const p=await product(); const o=await createOrder(db,ex,1,p);
  await fail(()=>db.query('SELECT orderflow.confirm_order($1,$2,$3)',[o,viewer,randomUUID()]),'42501');
  await fail(()=>db.query('UPDATE orderflow.order_items SET quantity=0.5 WHERE order_id=$1',[o]));
});

test('ledger totals reconcile with every current balance',async()=>{
  const count=await scalar(`SELECT count(*)::int FROM orderflow.inventory_balances b
    LEFT JOIN (SELECT product_id,warehouse_id,sum(on_hand_delta) h,sum(reserved_delta) r
      FROM orderflow.inventory_ledger GROUP BY product_id,warehouse_id) l USING(product_id,warehouse_id)
    WHERE b.on_hand<>coalesce(l.h,0) OR b.reserved<>coalesce(l.r,0)`);
  assert.equal(count,0);
});

test('the pgAdmin lesson executes and rolls back all example rows',async()=>{
  const before=await scalar('SELECT count(*)::int FROM orderflow.products');
  const sql=await readFile(new URL('../examples/inventory-lesson.sql',import.meta.url),'utf8');
  const results=await db.query(sql);
  const snapshots=results.find(r=>r.fields?.some(f=>f.name==='explanation'));
  assert.equal(snapshots.rows.length,5);
  assert.equal(Number(snapshots.rows[4].on_hand),7);
  assert.equal(await scalar('SELECT count(*)::int FROM orderflow.products'),before);
});
