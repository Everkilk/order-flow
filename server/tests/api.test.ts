import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { makePool, withTransaction } from '../src/db.js';
import { postInventoryEvent } from '../src/inventory-write.js';
import { runOneJob } from '../src/job-worker.js';
import { storagePath } from '../src/jobs.js';
import { passwordHash } from '../src/auth.js';
import { decimalText } from '../src/decimal-text.js';
import type { Config } from '../src/config.js';
import { readConfig } from '../src/config.js';
import { localDatabaseUrl, quoteIdentifier, migrate } from '../scripts/db-lib.mjs';
import { createExample } from '../scripts/example-data.mjs';

let admin: pg.Client, pool: pg.Pool, server: Server;
let databaseName = '', base = '', cookie = '', dataDirectory='';
let example: Awaited<ReturnType<typeof createExample>>;
let client: pg.Client;
let appConfig: Config;
const password = 'Test-manager-password-2026!';
async function request(path: string, method = 'GET', body?: unknown, auth = cookie) {
  const response = await fetch(base + path, {
    method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(auth ? { Cookie: auth } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, data: response.status === 204 ? null : await response.json() as any };
}

before(async () => {
  const url = localDatabaseUrl();
  const rootUrl = new URL(url); rootUrl.pathname = '/postgres';
  admin = new pg.Client({ connectionString: rootUrl.toString() });
  await admin.connect();
  databaseName = 'orderflow_api_test_' + randomUUID().replaceAll('-', '').slice(0, 16);
  await admin.query('CREATE DATABASE ' + quoteIdentifier(databaseName));
  url.pathname = '/' + databaseName;
  client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await migrate(client, () => {});
  example = await createExample(client, undefined, false);
  await client.query('UPDATE orderflow.users SET password_hash=$1,must_change_password=false WHERE id=$2', [await passwordHash(password), example.manager]);
  dataDirectory=await mkdtemp(join(tmpdir(),'orderflow-job-test-'));
  const config: Config = { DATABASE_URL: url.toString(), PORT: 3000, HOST:'127.0.0.1',
    DATA_DIR:dataDirectory, NODE_ENV: 'test' };
  appConfig=config;
  pool = makePool(config);
  await withTransaction(pool, async c => {
    await postInventoryEvent(c,{type:'OPENING',actorId:String(example.manager),key:randomUUID(),
      reason:'Example starting stock',source:{receiptId:String(example.receipt)},lines:[{
        warehouseId:String(example.warehouse),productId:String(example.product),onHandDelta:'10',reservedDelta:'0',
        receiptItemId:(await c.query('SELECT id::text FROM orderflow.receipt_items WHERE receipt_id=$1',[example.receipt])).rows[0].id,
      }]});
    await c.query("UPDATE orderflow.receipts SET status='POSTED',posted_at=now() WHERE id=$1",[example.receipt]);
  });
  server = createApp(pool, config).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  base = 'http://127.0.0.1:' + address.port;
});

after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (pool) await pool.end();
  if (client) await client.end();
  if (admin) {
    if (databaseName) await admin.query('DROP DATABASE ' + quoteIdentifier(databaseName));
    await admin.end();
  }
  if (dataDirectory.startsWith(tmpdir())) await rm(dataDirectory,{recursive:true,force:true});
});

test('health, login and session permission checks', async () => {
  assert.equal((await request('/health/ready')).response.status, 200);
  assert.equal((await request('/api/auth/me')).response.status, 401);
  const wrong = await request('/api/auth/login', 'POST', { email: example.prefix + '@example.invalid', password: 'wrong' });
  assert.equal(wrong.response.status, 401);
  const login = await request('/api/auth/login', 'POST', { email: example.prefix + '@example.invalid', password });
  assert.equal(login.response.status, 200);
  cookie = login.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.ok(cookie.startsWith('orderflow_session='));
  const me = await request('/api/auth/me');
  assert.equal(me.data.user.role, 'MANAGER');
});

test('failed logins for one account do not block another account at the same IP', async () => {
  const firstEmail=`limited-${randomUUID().slice(0,8)}@example.invalid`;
  const secondEmail=`unaffected-${randomUUID().slice(0,8)}@example.invalid`;
  for(const email of [firstEmail,secondEmail]) {
    const created=await request('/api/users','POST',{
      email,displayName:'Login limit test',role:'STAFF',password,
    });
    assert.equal(created.response.status,201);
  }
  for(let attempt=0;attempt<5;attempt++) {
    assert.equal((await request('/api/auth/login','POST',{
      email:firstEmail,password:'wrong',
    })).response.status,401);
  }
  assert.equal((await request('/api/auth/login','POST',{
    email:firstEmail,password,
  })).response.status,429);
  assert.equal((await request('/api/auth/login','POST',{
    email:secondEmail,password,
  })).response.status,200);
});

test('catalog creation validates attributes and returns searchable products', async () => {
  const bad = await request('/api/products', 'POST', { sku: 'bad-one', name: 'Bad Phone', categoryId: String(example.category), unitId: String(example.unit), attributes: { color: 'blue' } });
  assert.equal(bad.response.status, 422);
  const sku = 'PHONE-' + randomUUID().slice(0,8);
  const good = await request('/api/products', 'POST', { sku, name: 'Large Screen Phone',
    categoryId: String(example.category), unitId: String(example.unit),
    description:'A phone with a large screen',imageUrl:'https://example.invalid/phone.png',
    attributes: { screen_size_inches: 6.5 }, sellingPrice: '100.0000', sellingCurrency: 'USD' });
  assert.equal(good.response.status, 201);
  assert.equal(good.data.sellingPrice, '100.0000');
  assert.equal((await request('/api/products', 'POST', { sku, name: 'Duplicate', categoryId: String(example.category), unitId: String(example.unit), attributes: { screen_size_inches: 6 } })).response.status, 409);
  const found = await request('/api/products?q=' + encodeURIComponent('Large Screen'));
  assert.equal(found.response.status, 200);
  assert.ok(found.data.items.some((p: {sku:string}) => p.sku === sku));
  const detail = await request('/api/products/' + good.data.id);
  assert.equal(detail.data.id, good.data.id);
  assert.equal(detail.data.description,'A phone with a large screen');
  assert.equal(detail.data.imageUrl,'https://example.invalid/phone.png');
  assert.equal((await request('/api/products/999999999999999999999999999999')).response.status,400);
});

test('reference maintenance, product revision, and stock pagination', async () => {
  const category = await request('/api/categories','POST',{name:'Accessories '+randomUUID().slice(0,6)});
  assert.equal(category.response.status,201);
  const attribute = await request('/api/categories/'+category.data.id+'/attributes','POST',
    {key:'material',label:'Material',dataType:'string',required:true,allowedValues:['wood','metal']});
  assert.equal(attribute.response.status,201);
  const unit = await request('/api/units','POST',{code:'PC'+randomUUID().slice(0,5),name:'Pieces',decimalPlaces:0});
  assert.equal(unit.response.status,201);
  const warehouse = await request('/api/warehouses','POST',{code:'W'+randomUUID().slice(0,6),name:'Secondary'});
  assert.equal(warehouse.response.status,201);
  const supplier = await request('/api/suppliers','POST',{name:'Example supplier'});
  assert.equal(supplier.response.status,201);
  const product = await request('/api/products','POST',{sku:'ITEM-'+randomUUID().slice(0,8),name:'Wooden stand',
    categoryId:category.data.id,unitId:unit.data.id,attributes:{material:'wood'}});
  assert.equal(product.response.status,201);
  assert.equal((await request('/api/products/'+product.data.id,'PUT',{sku:product.data.sku,name:'Metal stand',categoryId:category.data.id,
    unitId:unit.data.id,attributes:{material:'metal'},active:true,expectedRevision:0})).response.status,200);
  assert.equal((await request('/api/products/'+product.data.id,'PUT',{sku:product.data.sku,name:'Stale stand',categoryId:category.data.id,
    unitId:unit.data.id,attributes:{material:'metal'},active:true,expectedRevision:0})).response.status,409);
  assert.equal((await request('/api/products/'+product.data.id+'/suppliers/'+supplier.data.id,'PUT',{primarySupplier:true,cost:'40.0000',currency:'USD'})).response.status,204);
  const detailed=await request('/api/products/'+product.data.id);
  assert.equal(detailed.data.suppliers[0].cost,'40.0000');
  assert.equal((await request('/api/warehouses/'+warehouse.data.id+'/thresholds/'+product.data.id,'PUT',{threshold:'5'})).response.status,204);
  const receiptNumber=randomUUID();
  const receipt=await request('/api/receipts','POST',{receiptNumber,kind:'INBOUND',warehouseId:warehouse.data.id});
  assert.equal(receipt.response.status,201);
  assert.equal((await request('/api/receipts/'+receipt.data.id+'/items','PUT',
    {expectedRevision:0,items:[{productId:product.data.id,quantity:'3'}]})).response.status,200);
  const post=await fetch(base+'/api/receipts/'+receipt.data.id+'/post',
    {method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()}});
  assert.equal(post.status,200);
  const first=await request('/api/stock?limit=1');
  assert.equal(first.response.status,200);
  assert.ok(first.data.nextCursor);
  const second=await request('/api/stock?limit=1&cursor='+encodeURIComponent(first.data.nextCursor));
  assert.equal(second.response.status,200);
  assert.notEqual(first.data.items[0].productId,second.data.items[0].productId);
  const movements=await request('/api/movements?warehouseId='+warehouse.data.id);
  assert.equal(movements.data.items[0].onHandDelta,'3.000000');
  assert.equal(movements.data.items[0].receiptId,receipt.data.id);
  const filtered=await request('/api/movements?'+new URLSearchParams({
    warehouseId:warehouse.data.id,sku:product.data.sku,eventType:'RECEIPT',
    actorId:String(example.manager),reference:receiptNumber,
    from:new Date(Date.now()-60_000).toISOString(),
    to:new Date(Date.now()+60_000).toISOString(),
  }));
  assert.equal(filtered.response.status,200);
  assert.equal(filtered.data.items.length,1);
  assert.equal(filtered.data.items[0].receiptId,receipt.data.id);
  assert.equal((await request('/api/movements?reference=missing-reference')).data.items.length,0);
  assert.equal((await request('/api/movements?from=2026-01-02T00%3A00%3A00Z&to=2026-01-01T00%3A00%3A00Z')).response.status,400);
  const valuation=await request('/api/reports/valuation?warehouseId='+warehouse.data.id);
  assert.equal(valuation.response.status,200);
  assert.equal(valuation.data.method,'PRIMARY_SUPPLIER_COST');
  assert.equal(valuation.data.currencyTotals[0].currency,'USD');
  assert.equal(Number(valuation.data.currencyTotals[0].amount),120);
  const dashboard=await request('/api/dashboard');
  assert.equal(dashboard.response.status,200);
  assert.ok(dashboard.data.work);
  assert.ok(dashboard.data.valuation);
  const expectedOrders=await client.query("SELECT count(*)::text AS count FROM orderflow.orders WHERE status='CONFIRMED'");
  const expectedTransfers=await client.query("SELECT count(*)::text AS count FROM orderflow.transfers WHERE status IN ('SENT','PARTIALLY_RECEIVED','DISPUTED')");
  assert.equal(dashboard.data.work.orders.awaitingFulfillment,expectedOrders.rows[0].count);
  assert.equal(dashboard.data.work.transfers.awaitingReceipt,expectedTransfers.rows[0].count);
});

test('stock availability filter treats fully reserved units as out of stock', async () => {
  const product=await request('/api/products','POST',{
    sku:'AVAIL-'+randomUUID().slice(0,8),name:'Availability test product',
    categoryId:String(example.category),unitId:String(example.unit),
    attributes:{screen_size_inches:6.5},
  });
  assert.equal(product.response.status,201);
  const warehouse=await request('/api/warehouses','POST',{
    code:'AVAIL-'+randomUUID().slice(0,8),name:'Availability warehouse',
  });
  assert.equal(warehouse.response.status,201);
  const receipt=await request('/api/receipts','POST',{
    receiptNumber:'AVAIL-'+randomUUID(),kind:'INBOUND',warehouseId:warehouse.data.id,
  });
  assert.equal(receipt.response.status,201);
  assert.equal((await request(`/api/receipts/${receipt.data.id}/items`,'PUT',{
    expectedRevision:0,items:[{productId:product.data.id,quantity:'2'}],
  })).response.status,200);
  assert.equal((await fetch(base+`/api/receipts/${receipt.data.id}/post`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  })).status,200);
  const stockPath=`/api/stock?warehouseId=${warehouse.data.id}&productId=${product.data.id}`;
  assert.equal((await request(stockPath+'&availability=AVAILABLE')).data.items.length,1);
  assert.equal((await request(stockPath+'&availability=OUT_OF_STOCK')).data.items.length,0);
  const order=await request('/api/orders','POST',{orderNumber:'AVAIL-'+randomUUID()});
  assert.equal(order.response.status,201);
  assert.equal((await request(`/api/orders/${order.data.id}/items`,'PUT',{
    expectedRevision:0,items:[{productId:product.data.id,warehouseId:warehouse.data.id,quantity:'2'}],
  })).response.status,200);
  assert.equal((await fetch(base+`/api/orders/${order.data.id}/confirm`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  })).status,200);
  const zero=await request(stockPath+'&availability=OUT_OF_STOCK');
  assert.equal(zero.data.items.length,1);
  assert.equal(zero.data.items[0].onHand,'2.000000');
  assert.equal(zero.data.items[0].available,'0.000000');
  assert.equal((await request(stockPath+'&availability=AVAILABLE')).data.items.length,0);
  assert.equal((await request(stockPath+'&availability=invalid')).response.status,400);
});

test('warehouse assignments restrict viewers and manager actions', async () => {
  const created = await request('/api/users', 'POST', { email: 'viewer-' + randomUUID().slice(0,8) + '@example.invalid', displayName: 'Test viewer', role: 'VIEWER', password });
  assert.equal(created.response.status, 201);
  const assign = await request('/api/users/' + created.data.id + '/warehouses', 'PUT', { warehouseIds: [String(example.warehouse)] });
  assert.equal(assign.response.status, 204);
  const user = await client.query('SELECT email FROM orderflow.users WHERE id=$1', [created.data.id]);
  await client.query('UPDATE orderflow.users SET must_change_password=false WHERE id=$1', [created.data.id]);
  const login = await request('/api/auth/login', 'POST', { email: user.rows[0].email, password });
  const viewerCookie = login.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const users=await request('/api/users?role=VIEWER');
  assert.equal(users.response.status,200);
  assert.ok(users.data.items.some((item:{id:string})=>item.id===created.data.id));
  const userDetail=await request('/api/users/'+created.data.id);
  assert.deepEqual(userDetail.data.warehouseIds,[String(example.warehouse)]);
  assert.equal((await request('/api/users','GET',undefined,viewerCookie)).response.status,403);
  assert.equal((await request('/api/warehouses','GET',undefined,viewerCookie)).data.items.length, 1);
  assert.equal((await request('/api/categories','POST',{name:'Denied'},viewerCookie)).response.status, 403);
  const detail = await request('/api/products/' + example.product, 'GET', undefined, viewerCookie);
  assert.equal(detail.data.stock.length, 1);
  const dashboard=await request('/api/dashboard','GET',undefined,viewerCookie);
  assert.equal(dashboard.response.status,200);
  assert.equal(dashboard.data.stock.stockRows,'1');
  assert.equal(dashboard.data.work,undefined);
  assert.equal(dashboard.data.valuation,undefined);
  assert.equal((await request('/api/reports/valuation','GET',undefined,viewerCookie)).response.status,403);
  const receipts=await request('/api/receipts','GET',undefined,viewerCookie);
  assert.equal(receipts.response.status,403);
  assert.equal((await request('/api/orders','GET',undefined,viewerCookie)).response.status,403);
  assert.equal((await request('/api/transfers','GET',undefined,viewerCookie)).response.status,403);
  assert.equal((await request('/api/movements','GET',undefined,viewerCookie)).response.status,403);
  assert.equal((await request('/api/reports/movements?warehouseId='+example.warehouse+'&from=2026-01-01T00%3A00%3A00Z&to=2026-01-02T00%3A00%3A00Z','GET',undefined,viewerCookie)).response.status,403);
  const temporaryPassword='Temporary-viewer-password-2026!';
  assert.equal((await request('/api/users/'+created.data.id+'/reset-password','POST',
    {temporaryPassword})).response.status,204);
  assert.equal((await request('/api/auth/me','GET',undefined,viewerCookie)).response.status, 401);
  const resetLogin=await request('/api/auth/login','POST',{email:user.rows[0].email,password:temporaryPassword});
  assert.equal(resetLogin.response.status,200);
  const temporaryCookie=resetLogin.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.equal((await request('/api/stock','GET',undefined,temporaryCookie)).response.status,403);
  assert.equal((await request('/api/auth/change-password','POST',{
    currentPassword:temporaryPassword,newPassword:'Updated-viewer-password-2026!',
  },temporaryCookie)).response.status,204);
});

test('orders reserve, fulfil, cancel and reject overselling with idempotent retries', async () => {
  const command = async (orderId:string, action:string, key:string) => {
    const response=await fetch(`${base}/api/orders/${orderId}/${action}`,{
      method:'POST',headers:{Cookie:cookie,'Idempotency-Key':key},
    });
    return {response,data:await response.json() as any};
  };
  const create = async (quantity:string) => {
    const order=await request('/api/orders','POST',{orderNumber:randomUUID()});
    assert.equal(order.response.status,201);
    const updated=await request(`/api/orders/${order.data.id}/items`,'PUT',
      {expectedRevision:0,items:[{productId:String(example.product),warehouseId:String(example.warehouse),quantity}]});
    assert.equal(updated.response.status,200);
    return order.data.id as string;
  };
  const first=await create('7');
  const confirmKey=randomUUID();
  const confirmed=await command(first,'confirm',confirmKey);
  assert.equal(confirmed.response.status,200);
  assert.equal(confirmed.data.status,'CONFIRMED');
  assert.deepEqual((await command(first,'confirm',confirmKey)).data,confirmed.data);
  const second=await create('4');
  assert.equal((await command(second,'confirm',randomUUID())).response.status,409);
  const current=await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product);
  assert.equal(current.data.items[0].onHand,'10.000000');
  assert.equal(current.data.items[0].reserved,'7.000000');
  const fulfilled=await command(first,'fulfill',randomUUID());
  assert.equal(fulfilled.response.status,200,JSON.stringify(fulfilled.data));
  const after=await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product);
  assert.equal(after.data.items[0].onHand,'3.000000');
  assert.equal(after.data.items[0].reserved,'0.000000');
  assert.equal((await command(second,'confirm',randomUUID())).response.status,409);
  const third=await create('2');
  assert.equal((await command(third,'confirm',randomUUID())).response.status,200);
  assert.equal((await command(third,'cancel',randomUUID())).response.status,200);
  const finalStock=await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product);
  assert.equal(finalStock.data.items[0].onHand,'3.000000');
  assert.equal(finalStock.data.items[0].reserved,'0.000000');
  const draftOrder=await create('1');
  const cancelled=await command(draftOrder,'cancel',randomUUID());
  assert.equal(cancelled.response.status,200);
  assert.equal(cancelled.data.eventId,null);
});

test('returns restore stock once and cannot exceed fulfilled quantity', async () => {
  const order=await request('/api/orders','POST',{orderNumber:randomUUID()});
  const orderId=order.data.id as string;
  assert.equal((await request(`/api/orders/${orderId}/items`,'PUT',{
    expectedRevision:0,items:[{productId:String(example.product),warehouseId:String(example.warehouse),quantity:'2'}],
  })).response.status,200);
  for (const action of ['confirm','fulfill']) {
    const response=await fetch(`${base}/api/orders/${orderId}/${action}`,{
      method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
    });
    assert.equal(response.status,200);
  }
  const detail=await request(`/api/orders/${orderId}`);
  const orderItemId=detail.data.items[0].id;
  const makeReturn=async (amount:string) => {
    const created=await request('/api/returns','POST',{returnNumber:randomUUID(),orderId,
      warehouseId:String(example.warehouse),reason:'Customer returned item'});
    assert.equal(created.response.status,201);
    const saved=await request(`/api/returns/${created.data.id}/items`,'PUT',{
      expectedRevision:0,items:[{orderItemId,quantity:amount}],
    });
    assert.equal(saved.response.status,200);
    return created.data.id as string;
  };
  const first=await makeReturn('1');
  const post=await fetch(`${base}/api/returns/${first}/post`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  });
  assert.equal(post.status,200);
  const second=await makeReturn('2');
  const over=await fetch(`${base}/api/returns/${second}/post`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  });
  assert.equal(over.status,409);
  const stock=await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product);
  assert.equal(stock.data.items[0].onHand,'2.000000');
});

test('transfers move stock through in-transit state without creating extra stock', async () => {
  const destination=await request('/api/warehouses','POST',{code:'DEST-'+randomUUID().slice(0,8),name:'Destination'});
  assert.equal(destination.response.status,201);
  const created=await request('/api/transfers','POST',{transferNumber:randomUUID(),
    sourceWarehouseId:String(example.warehouse),destinationWarehouseId:destination.data.id});
  assert.equal(created.response.status,201);
  const transferId=created.data.id as string;
  const saved=await request(`/api/transfers/${transferId}/items`,'PUT',{
    expectedRevision:0,items:[{productId:String(example.product),requestedQty:'1'}],
  });
  assert.equal(saved.response.status,200);
  const sendKey=randomUUID();
  const send=await fetch(`${base}/api/transfers/${transferId}/send`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':sendKey},
  });
  assert.equal(send.status,200);
  const inTransit=await request('/api/transfers/'+transferId);
  assert.equal(inTransit.data.items[0].inTransitQty,'1.000000');
  const afterSend=await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product);
  assert.equal(afterSend.data.items[0].onHand,'1.000000');
  const receiveKey=randomUUID();
  const body={items:[{transferItemId:inTransit.data.items[0].id,acceptedQty:'1',quarantinedQty:'0'}]};
  const receive=await fetch(`${base}/api/transfers/${transferId}/receive`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':receiveKey,'Content-Type':'application/json'},
    body:JSON.stringify(body),
  });
  assert.equal(receive.status,200,JSON.stringify(await receive.json()));
  const done=await request('/api/transfers/'+transferId);
  assert.equal(done.data.status,'RECEIVED');
  assert.equal(done.data.items[0].inTransitQty,'0.000000');
  const destinationStock=await request('/api/stock?warehouseId='+destination.data.id+'&productId='+example.product);
  assert.equal(destinationStock.data.items[0].onHand,'1.000000');
});

test('transfer excess is quarantined until a manager resolves it', async () => {
  const destination=await request('/api/warehouses','POST',{code:'QUAR-'+randomUUID().slice(0,8),name:'Quarantine destination'});
  const created=await request('/api/transfers','POST',{transferNumber:randomUUID(),
    sourceWarehouseId:String(example.warehouse),destinationWarehouseId:destination.data.id});
  const transferId=created.data.id as string;
  assert.equal((await request(`/api/transfers/${transferId}/items`,'PUT',{
    expectedRevision:0,items:[{productId:String(example.product),requestedQty:'1'}],
  })).response.status,200);
  const send=await fetch(`${base}/api/transfers/${transferId}/send`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  });
  assert.equal(send.status,200);
  const detail=await request(`/api/transfers/${transferId}`);
  const receive=await fetch(`${base}/api/transfers/${transferId}/receive`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({items:[{transferItemId:detail.data.items[0].id,acceptedQty:'1',
      quarantinedQty:'1',excessReason:'Unexpected extra item'}]}),
  });
  assert.equal(receive.status,200,JSON.stringify(await receive.json()));
  const disputed=await request(`/api/transfers/${transferId}`);
  assert.equal(disputed.data.status,'DISPUTED');
  assert.equal(disputed.data.items[0].quarantinedQty,'1.000000');
  const discrepancies=await request(`/api/transfers/${transferId}/discrepancies`);
  assert.equal(discrepancies.data.items[0].kind,'EXCESS');
  const resolve=await fetch(`${base}/api/discrepancies/${discrepancies.data.items[0].id}/resolve`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({resolutionType:'ACCEPT_EXCESS',quantity:'1',reason:'Confirmed received'}),
  });
  assert.equal(resolve.status,200,JSON.stringify(await resolve.json()));
  const resolved=await request(`/api/transfers/${transferId}`);
  assert.equal(resolved.data.status,'RESOLVED');
  const stock=await request('/api/stock?warehouseId='+destination.data.id+'&productId='+example.product);
  assert.equal(stock.data.items[0].onHand,'2.000000');
});

test('stock approvals apply reviewed corrections and reject stale counts', async () => {
  const add=async (amount:string) => {
    const receipt=await request('/api/receipts','POST',{receiptNumber:randomUUID(),kind:'INBOUND',warehouseId:String(example.warehouse)});
    assert.equal(receipt.response.status,201);
    assert.equal((await request(`/api/receipts/${receipt.data.id}/items`,'PUT',{
      expectedRevision:0,items:[{productId:String(example.product),quantity:amount}],
    })).response.status,200);
    const response=await fetch(`${base}/api/receipts/${receipt.data.id}/post`,{
      method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
    });
    assert.equal(response.status,200);
    return await response.json() as {eventId:string};
  };
  await add('5');
  const stock=async () => (await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product)).data.items[0];
  const damage=await request('/api/stock-requests','POST',{requestType:'DAMAGE',warehouseId:String(example.warehouse),
    productId:String(example.product),quantity:'1',reason:'Damaged unit'});
  assert.equal(damage.response.status,201);
  const decided=await fetch(`${base}/api/stock-requests/${damage.data.id}/decision`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({decision:'APPROVED',reason:'Damage verified',reviewedBalanceVersion:(await stock()).version}),
  });
  assert.equal(decided.status,200,JSON.stringify(await decided.json()));
  assert.equal((await stock()).onHand,'4.000000');
  const count=await request('/api/stock-requests','POST',{requestType:'COUNT',warehouseId:String(example.warehouse),
    productId:String(example.product),countedQty:'4',reason:'Physical count'});
  assert.equal(count.response.status,201);
  const staleVersion=(await stock()).version;
  const receipt=await add('1');
  const stale=await fetch(`${base}/api/stock-requests/${count.data.id}/decision`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({decision:'APPROVED',reason:'Count checked',reviewedBalanceVersion:staleVersion}),
  });
  assert.equal(stale.status,409);
  const reversal=await request('/api/stock-requests','POST',{requestType:'REVERSAL',
    originalEventId:receipt.eventId,reason:'Duplicate receipt'});
  assert.equal(reversal.response.status,201);
  const reverse=await fetch(`${base}/api/stock-requests/${reversal.data.id}/decision`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({decision:'APPROVED',reason:'Duplicate confirmed'}),
  });
  assert.equal(reverse.status,200,JSON.stringify(await reverse.json()));
  assert.equal((await stock()).onHand,'4.000000');
});

test('competing order confirmations cannot reserve the same final stock', async () => {
  const create=async () => {
    const order=await request('/api/orders','POST',{orderNumber:randomUUID()});
    assert.equal(order.response.status,201);
    assert.equal((await request(`/api/orders/${order.data.id}/items`,'PUT',{
      expectedRevision:0,items:[{productId:String(example.product),warehouseId:String(example.warehouse),quantity:'3'}],
    })).response.status,200);
    return order.data.id as string;
  };
  const ids=await Promise.all([create(),create()]);
  const results=await Promise.all(ids.map(orderId=>fetch(`${base}/api/orders/${orderId}/confirm`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  })));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const stock=(await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product)).data.items[0];
  assert.equal(stock.onHand,'4.000000');
  assert.equal(stock.reserved,'3.000000');
  const winner=ids[results.findIndex(result=>result.status===200)];
  const cancel=await fetch(`${base}/api/orders/${winner}/cancel`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  });
  assert.equal(cancel.status,200);
});

test('crossing a stock threshold creates a readable notification', async () => {
  assert.equal((await request(`/api/warehouses/${example.warehouse}/thresholds/${example.product}`,'PUT',
    {threshold:'3'})).response.status,204);
  const order=await request('/api/orders','POST',{orderNumber:randomUUID()});
  assert.equal((await request(`/api/orders/${order.data.id}/items`,'PUT',{
    expectedRevision:0,items:[{productId:String(example.product),warehouseId:String(example.warehouse),quantity:'2'}],
  })).response.status,200);
  const confirm=await fetch(`${base}/api/orders/${order.data.id}/confirm`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  });
  assert.equal(confirm.status,200);
  const list=await request('/api/notifications');
  assert.equal(list.response.status,200);
  const alert=list.data.items.find((item:{eventClass:string})=>item.eventClass==='LOW_STOCK');
  assert.ok(alert);
  assert.equal(alert.readAt,null);
  assert.equal((await request(`/api/notifications/${alert.id}/read`,'POST')).response.status,204);
  const refreshed=await request('/api/notifications');
  assert.ok(refreshed.data.items.find((item:{id:string})=>item.id===alert.id).readAt);
  const low=await request('/api/reports/low-stock?warehouseId='+example.warehouse);
  assert.equal(low.response.status,200);
  assert.ok(low.data.items.some((item:{productId:string})=>item.productId===String(example.product)));
  const from=encodeURIComponent(new Date(Date.now()-3600_000).toISOString());
  const to=encodeURIComponent(new Date(Date.now()+3600_000).toISOString());
  const movements=await request(`/api/reports/movements?warehouseId=${example.warehouse}&from=${from}&to=${to}`);
  assert.equal(movements.response.status,200);
  assert.ok(movements.data.items.length>0);
});

test('bulk read covers every page for only the current user and preserves prior timestamps', async () => {
  const other=await request('/api/users','POST',{email:`read-${randomUUID()}@example.invalid`,displayName:'Read isolation',role:'VIEWER',password});
  assert.equal(other.response.status,201);
  const prefix=randomUUID();
  await client.query(`INSERT INTO orderflow.notifications(user_id,event_class,title,body,dedupe_key)
    SELECT $1,'TEST','Bulk read','Unread notification',$2||n FROM generate_series(1,30) n`,[example.manager,prefix]);
  await client.query(`INSERT INTO orderflow.notifications(user_id,event_class,title,body,dedupe_key)
    VALUES($1,'TEST','Other user','Keep unread',$2)`,[other.data.id,prefix]);
  const old=(await client.query(`SELECT id,read_at FROM orderflow.notifications WHERE user_id=$1 AND read_at IS NOT NULL LIMIT 1`,[example.manager])).rows[0];
  assert.ok(old);
  assert.equal((await request('/api/notifications/read-all','POST',{},'')).response.status,401);
  assert.equal((await request('/api/notifications/read-all','POST',{userId:other.data.id})).response.status,400);
  assert.equal((await request('/api/notifications/read-all','POST',{})).response.status,204);
  assert.equal((await request('/api/notifications/unread-count')).data.count,0);
  assert.equal((await client.query('SELECT read_at FROM orderflow.notifications WHERE id=$1',[old.id])).rows[0].read_at.toISOString(),old.read_at.toISOString());
  assert.equal((await client.query('SELECT count(*)::int AS count FROM orderflow.notifications WHERE user_id=$1 AND read_at IS NULL',[other.data.id])).rows[0].count,1);
  const timestamp=(await client.query('SELECT read_at FROM orderflow.notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1',[example.manager])).rows[0].read_at.toISOString();
  assert.equal((await request('/api/notifications/read-all','POST',{})).response.status,204);
  assert.equal((await client.query('SELECT read_at FROM orderflow.notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1',[example.manager])).rows[0].read_at.toISOString(),timestamp);
  await client.query(`INSERT INTO orderflow.notifications(user_id,event_class,title,body,dedupe_key)
    VALUES($1,'TEST','Later arrival','Keep unread',$2)`,[example.manager,randomUUID()]);
  assert.equal((await request('/api/notifications/unread-count')).data.count,1);
});

test('a notification committed after the bulk statement starts stays unread', async () => {
  const inserted=await client.query(`INSERT INTO orderflow.notifications(user_id,event_class,title,body,dedupe_key)
    VALUES($1,'TEST','Locked row','Bulk snapshot test',$2) RETURNING id`,[example.manager,randomUUID()]);
  const lock=await pool.connect();
  let pending;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT id FROM orderflow.notifications WHERE id=$1 FOR UPDATE',[inserted.rows[0].id]);
    pending=request('/api/notifications/read-all','POST',{});
    let waiting=false;
    for(let attempt=0;attempt<50;attempt++) {
      const state=await client.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query LIKE 'UPDATE orderflow.notifications SET read_at=clock_timestamp()%'`);
      if(state.rowCount) {waiting=true;break;}
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(waiting,'The same bulk update must be blocked with its snapshot established.');
    const later=await client.query(`INSERT INTO orderflow.notifications(user_id,event_class,title,body,dedupe_key)
      VALUES($1,'TEST','Concurrent arrival','Keep unread',$2) RETURNING id`,[example.manager,randomUUID()]);
    await lock.query('COMMIT');
    assert.equal((await pending).response.status,204);
    assert.equal((await client.query('SELECT read_at FROM orderflow.notifications WHERE id=$1',[later.rows[0].id])).rows[0].read_at,null);
  } finally {await lock.query('ROLLBACK');lock.release();if(pending) await pending;}
});

test('notification stream announces a new stored notification', async () => {
  assert.equal((await request('/api/notifications/stream','GET',undefined,'')).response.status,401);
  const controller=new AbortController();
  const deadline=setTimeout(()=>controller.abort(),10_000);
  try {
    const stream=await fetch(base+'/api/notifications/stream',{headers:{Cookie:cookie},signal:controller.signal});
    assert.equal(stream.status,200);
    assert.match(stream.headers.get('content-type') ?? '',/text\/event-stream/);
    const inserted=await client.query(`INSERT INTO orderflow.notifications
      (user_id,event_class,title,body,dedupe_key) VALUES($1,'TEST','Stream test','Committed notification',$2)
      RETURNING id::text`,[example.manager,randomUUID()]);
    const reader=stream.body!.getReader();
    const decoder=new TextDecoder();
    let text='';
    while (!text.includes('event: notification')) {
      const chunk=await reader.read();
      if (chunk.done) break;
      text+=decoder.decode(chunk.value,{stream:true});
    }
    assert.match(text,/event: notification/);
    assert.match(text,new RegExp(`id: ${inserted.rows[0].id}\\n`));
  } finally {clearTimeout(deadline);controller.abort();}
});

test('product CSV import validates before commit and export runs in the worker', async () => {
  const sku='IMPORT-'+randomUUID().slice(0,8);
  const csv='sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json\n'
    +`${sku},Imported phone,${example.category},${example.unit},,,100.00,USD,"{""screen_size_inches"":6.5}"\n`;
  const form=new FormData();
  form.append('file',new Blob([csv],{type:'text/csv'}),'products.csv');
  const uploaded=await fetch(base+'/api/imports/products',{method:'POST',headers:{Cookie:cookie},body:form});
  assert.equal(uploaded.status,202,await uploaded.clone().text());
  const upload=await uploaded.json() as {id:string;commitKey:string};
  assert.equal((await request('/api/imports/'+upload.id+'/preview')).response.status,409);
  assert.equal(await runOneJob(pool,appConfig),true);
  const validated=await request('/api/imports/'+upload.id);
  assert.equal(validated.data.status,'READY',JSON.stringify(validated.data));
  assert.equal(validated.data.validatedRows,1);
  const preview=await request('/api/imports/'+upload.id+'/preview');
  assert.equal(preview.response.status,200);
  assert.equal(preview.data.columns[0],'sku');
  assert.equal(preview.data.rows[0].rowNumber,2);
  assert.equal(preview.data.rows[0].values[0],sku);
  assert.equal(preview.data.hasMore,false);
  const committed=await fetch(base+'/api/imports/'+upload.id+'/commit',{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':upload.commitKey},
  });
  assert.equal(committed.status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  const done=await request('/api/imports/'+upload.id);
  assert.equal(done.data.status,'COMMITTED');
  assert.ok((await request('/api/products?q='+sku)).data.items.some((item:{sku:string})=>item.sku===sku));
  const queued=await request('/api/exports','POST',{kind:'PRODUCTS'});
  assert.equal(queued.response.status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/exports/'+queued.data.id)).data.status,'DONE');
  const file=await fetch(base+'/api/exports/'+queued.data.id+'/file',{headers:{Cookie:cookie}});
  assert.equal(file.status,200);
  assert.ok((await file.text()).includes(sku));
  const notices=await request('/api/notifications');
  const classes=new Set(notices.data.items.map((item:{eventClass:string})=>item.eventClass));
  for(const expected of ['IMPORT_VALIDATED','IMPORT_COMPLETE','EXPORT_COMPLETE'])
    assert.ok(classes.has(expected),expected);
  const exportState=await client.query('SELECT job_id,storage_key FROM orderflow.export_jobs WHERE id=$1',
    [queued.data.id]);
  await client.query(`UPDATE orderflow.background_jobs
    SET status='PROCESSING',lease_until=now()-interval '1 second' WHERE id=$1`,
    [exportState.rows[0].job_id]);
  assert.equal(await runOneJob(pool,appConfig),true);
  const retried=await client.query('SELECT storage_key FROM orderflow.export_jobs WHERE id=$1',
    [queued.data.id]);
  assert.equal(retried.rows[0].storage_key,exportState.rows[0].storage_key);
});

test('new CSV exports trim only numeric columns and preserve large decimal and text values', async () => {
  assert.equal(decimalText('9999999999999999.123400'),'9999999999999999.1234');
  assert.equal(decimalText('-0.000000'),'0');
  const sku='001000-'+randomUUID();
  const product=await request('/api/products','POST',{sku,name:'=SUM(1+1)',categoryId:String(example.category),unitId:String(example.unit),
    barcode:'000000012345',attributes:{screen_size_inches:6.5},sellingPrice:'9999999999999999.1234',sellingCurrency:'USD'});
  assert.equal(product.response.status,201);
  const exported=await request('/api/exports','POST',{kind:'PRODUCTS'});
  assert.equal(exported.response.status,202);assert.equal(await runOneJob(pool,appConfig),true);
  const response=await fetch(base+'/api/exports/'+exported.data.id+'/file',{headers:{Cookie:cookie}});
  assert.equal(response.status,200);
  const csv=await response.text(),row=csv.split('\n').find(line=>line.includes(sku));
  assert.ok(row);assert.ok(row.includes("'=SUM(1+1)"));assert.ok(row.includes('000000012345'));assert.ok(row.includes('9999999999999999.1234'));
  assert.ok(csv.startsWith('id,sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json'));
  const detail=await request('/api/products/'+product.data.id);
  assert.equal(detail.data.sellingPrice,'9999999999999999.1234');assert.equal(detail.data.barcode,'000000012345');
});

test('opening-stock and staff order CSV imports validate and commit once', async () => {
  const sku='OPEN-'+randomUUID().slice(0,8);
  const product=await request('/api/products','POST',{sku,name:'Opening import product',
    categoryId:String(example.category),unitId:String(example.unit),
    attributes:{screen_size_inches:6.5}});
  assert.equal(product.response.status,201);
  const warehouse=await request('/api/warehouses','POST',{code:'IMP-'+randomUUID().slice(0,8),
    name:'Import warehouse'});
  assert.equal(warehouse.response.status,201);
  const upload=async(path:string,csv:string,auth:string) => {
    const form=new FormData();
    form.append('file',new Blob([csv],{type:'text/csv'}),'batch.csv');
    const response=await fetch(base+path,{method:'POST',headers:{Cookie:auth},body:form});
    return {response,data:await response.json() as any};
  };
  const commit=async(importId:string,key:string,auth:string) => fetch(base+'/api/imports/'+importId+'/commit',{
    method:'POST',headers:{Cookie:auth,'Idempotency-Key':key},
  });
  const receiptNumber='OPEN-'+randomUUID();
  const openingCsv='receipt_number,warehouse_id,sku,quantity,unit_cost,currency\n'
    +`${receiptNumber},${warehouse.data.id},${sku},5,2.50,USD\n`;
  const opening=await upload('/api/imports/opening-stock',openingCsv,cookie);
  assert.equal(opening.response.status,202,JSON.stringify(opening.data));
  assert.equal(opening.data.kind,'OPENING_STOCK');
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+opening.data.id)).data.status,'READY');
  assert.equal((await commit(opening.data.id,opening.data.commitKey,cookie)).status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+opening.data.id)).data.status,'COMMITTED');
  assert.equal((await commit(opening.data.id,opening.data.commitKey,cookie)).status,202);
  const stock=await request(`/api/stock?warehouseId=${warehouse.data.id}&productId=${product.data.id}`);
  assert.equal(stock.data.items[0].onHand,'5.000000');
  const duplicateCsv='receipt_number,warehouse_id,sku,quantity,unit_cost,currency\n'
    +`OPEN-${randomUUID()},${warehouse.data.id},${sku},5,,\n`;
  const duplicate=await upload('/api/imports/opening-stock',duplicateCsv,cookie);
  assert.equal(duplicate.response.status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  const invalid=await request('/api/imports/'+duplicate.data.id);
  assert.equal(invalid.data.status,'INVALID');
  assert.equal(invalid.data.errors[0].field,'sku');
  const invalidPreview=await request('/api/imports/'+duplicate.data.id+'/preview');
  assert.equal(invalidPreview.data.rows[0].values[2],sku);
  assert.equal(invalidPreview.data.errors[0].field,'sku');
  const staffEmail='import-staff-'+randomUUID().slice(0,8)+'@example.invalid';
  const staff=await request('/api/users','POST',{email:staffEmail,displayName:'Import staff',
    role:'STAFF',password});
  assert.equal(staff.response.status,201);
  assert.equal((await request('/api/users/'+staff.data.id+'/warehouses','PUT',{
    warehouseIds:[warehouse.data.id]})).response.status,204);
  await client.query('UPDATE orderflow.users SET must_change_password=false WHERE id=$1',[staff.data.id]);
  const signedIn=await request('/api/auth/login','POST',{email:staffEmail,password});
  const staffCookie=signedIn.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.equal((await upload('/api/imports/opening-stock',openingCsv,staffCookie)).response.status,403);
  assert.equal((await request('/api/imports/'+opening.data.id,'GET',undefined,staffCookie)).response.status,403);
  assert.equal((await request('/api/imports/'+opening.data.id+'/preview','GET',undefined,staffCookie)).response.status,403);
  const orderNumber='ORDER-'+randomUUID();
  const orderCsv='order_number,warehouse_id,sku,quantity,unit_price,currency\n'
    +`${orderNumber},${warehouse.data.id},${sku},2,3.00,USD\n`;
  const order=await upload('/api/imports/orders',orderCsv,staffCookie);
  assert.equal(order.response.status,202,JSON.stringify(order.data));
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+order.data.id,'GET',undefined,staffCookie)).data.status,'READY');
  const orderPreview=await request('/api/imports/'+order.data.id+'/preview','GET',undefined,staffCookie);
  assert.equal(orderPreview.response.status,200);
  assert.equal(orderPreview.data.rows[0].values[0],orderNumber);
  assert.equal((await commit(order.data.id,order.data.commitKey,staffCookie)).status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  const completed=await request('/api/imports/'+order.data.id,'GET',undefined,staffCookie);
  assert.equal(completed.data.status,'COMMITTED');
  const staffNotices=await request('/api/notifications','GET',undefined,staffCookie);
  assert.ok(staffNotices.data.items.some((item:{eventClass:string})=>item.eventClass==='IMPORT_COMPLETE'));
  const orders=await request('/api/orders','GET',undefined,staffCookie);
  assert.ok(orders.data.items.some((item:{orderNumber:string;status:string})=>
    item.orderNumber===orderNumber && item.status==='DRAFT'));
  const conflictingNumber='ORDER-'+randomUUID();
  const conflictCsv='order_number,warehouse_id,sku,quantity,unit_price,currency\n'
    +`${conflictingNumber},${warehouse.data.id},${sku},1,,\n`;
  const pending=await upload('/api/imports/orders',conflictCsv,staffCookie);
  assert.equal(pending.response.status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+pending.data.id,'GET',undefined,staffCookie)).data.status,'READY');
  assert.equal((await request('/api/orders','POST',{orderNumber:conflictingNumber},staffCookie)).response.status,201);
  assert.equal((await commit(pending.data.id,pending.data.commitKey,staffCookie)).status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  const failed=await request('/api/imports/'+pending.data.id,'GET',undefined,staffCookie);
  assert.equal(failed.data.status,'FAILED');
  assert.equal(failed.data.lastErrorCode,'IMPORT_DATA_CHANGED');
});

test('reported transfer shortage stays out of stock until resolved as loss', async () => {
  const destination=await request('/api/warehouses','POST',{code:'SHORT-'+randomUUID().slice(0,8),name:'Shortage destination'});
  const transfer=await request('/api/transfers','POST',{transferNumber:randomUUID(),
    sourceWarehouseId:String(example.warehouse),destinationWarehouseId:destination.data.id});
  assert.equal(transfer.response.status,201);
  assert.equal((await request(`/api/transfers/${transfer.data.id}/items`,'PUT',{
    expectedRevision:0,items:[{productId:String(example.product),requestedQty:'1'}],
  })).response.status,200);
  const sent=await fetch(`${base}/api/transfers/${transfer.data.id}/send`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
  });
  assert.equal(sent.status,200);
  const detail=await request(`/api/transfers/${transfer.data.id}`);
  const shortage=await fetch(`${base}/api/transfers/${transfer.data.id}/shortages`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({transferItemId:detail.data.items[0].id,quantity:'1',reason:'Package arrived empty'}),
  });
  assert.equal(shortage.status,201);
  const shortageId=(await shortage.json() as {id:string}).id;
  assert.equal((await request(`/api/transfers/${transfer.data.id}`)).data.status,'DISPUTED');
  const bytes=Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3]);
  const evidenceForm=new FormData();
  evidenceForm.append('file',new Blob([bytes],{type:'image/png'}),'signed-transfer.png');
  const evidence=await fetch(base+'/api/evidence/discrepancies/'+shortageId,{
    method:'POST',headers:{Cookie:cookie},body:evidenceForm});
  assert.equal(evidence.status,201,await evidence.clone().text());
  const evidenceId=(await evidence.json() as {id:string}).id;
  const attachments=await request('/api/evidence/discrepancies/'+shortageId);
  assert.equal(attachments.data.items[0].id,evidenceId);
  assert.equal((await request('/api/evidence/'+evidenceId+'/file','GET',undefined,'')).response.status,401);
  const download=await fetch(base+'/api/evidence/'+evidenceId+'/file',{headers:{Cookie:cookie}});
  assert.equal(download.status,200);
  assert.deepEqual(new Uint8Array(await download.arrayBuffer()),bytes);
  const resolution=await fetch(`${base}/api/discrepancies/${shortageId}/resolve`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({resolutionType:'LOSS',quantity:'1',reason:'Carrier loss confirmed'}),
  });
  assert.equal(resolution.status,200,await resolution.clone().text());
  assert.equal((await request(`/api/transfers/${transfer.data.id}`)).data.status,'RESOLVED');
  const stock=await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product);
  assert.equal(stock.data.items[0].onHand,'3.000000');
});

test('an unchanged count records approval without a fake stock movement', async () => {
  const stock=(await request('/api/stock?warehouseId='+example.warehouse+'&productId='+example.product)).data.items[0];
  const count=await request('/api/stock-requests','POST',{requestType:'COUNT',warehouseId:String(example.warehouse),
    productId:String(example.product),countedQty:stock.onHand,reason:'Cycle count matched'});
  assert.equal(count.response.status,201);
  const document=new FormData();
  document.append('file',new Blob(['%PDF-1.4\n%%EOF\n'],{type:'application/pdf'}),'count-sheet.pdf');
  const uploaded=await fetch(base+'/api/evidence/stock-requests/'+count.data.id,{
    method:'POST',headers:{Cookie:cookie},body:document});
  assert.equal(uploaded.status,201,await uploaded.clone().text());
  assert.equal((await request('/api/evidence/stock-requests/'+count.data.id)).data.items.length,1);
  const decision=await fetch(`${base}/api/stock-requests/${count.data.id}/decision`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID(),'Content-Type':'application/json'},
    body:JSON.stringify({decision:'APPROVED',reviewedBalanceVersion:stock.version,reason:'Count verified'}),
  });
  assert.equal(decision.status,200,await decision.clone().text());
  const result=await decision.json() as {eventId:string};
  const ledger=await client.query('SELECT count(*)::integer AS count FROM orderflow.inventory_ledger WHERE event_id=$1',[result.eventId]);
  assert.equal(ledger.rows[0].count,0);
});

test('invalid product CSV shows row errors and cannot be committed', async () => {
  const malformed=await fetch(base+'/api/imports/products',{
    method:'POST',headers:{Cookie:cookie,'Content-Type':'multipart/form-data;'},body:''});
  assert.equal(malformed.status,415);
  const csv='sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json\n'
    +`BAD-${randomUUID().slice(0,8)},Bad product,999999,${example.unit},,,,,{}\n`;
  const form=new FormData();form.append('file',new Blob([csv],{type:'text/csv'}),'invalid.csv');
  const upload=await fetch(base+'/api/imports/products',{method:'POST',headers:{Cookie:cookie},body:form});
  assert.equal(upload.status,202);
  const importJob=await upload.json() as {id:string;commitKey:string};
  assert.equal(await runOneJob(pool,appConfig),true);
  const detail=await request('/api/imports/'+importJob.id);
  assert.equal(detail.data.status,'INVALID');
  assert.equal(detail.data.errors[0].rowNumber,2);
  const commit=await fetch(`${base}/api/imports/${importJob.id}/commit`,{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':importJob.commitKey},
  });
  assert.equal(commit.status,409);
});

test('an edited CSV cannot be previewed or committed after validation', async () => {
  const sku='FINGERPRINT-'+randomUUID().slice(0,8);
  const header='sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json\n';
  const row=(name:string)=>`${sku},${name},${example.category},${example.unit},,,,,"{""screen_size_inches"":6.5}"\n`;
  const form=new FormData();
  form.append('file',new Blob([header+row('Reviewed product')],{type:'text/csv'}),'products.csv');
  const upload=await fetch(base+'/api/imports/products',{method:'POST',headers:{Cookie:cookie},body:form});
  assert.equal(upload.status,202);
  const imported=await upload.json() as {id:string;commitKey:string};
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+imported.id)).data.status,'READY');
  const file=await client.query('SELECT storage_key,validated_sha256 FROM orderflow.import_jobs WHERE id=$1',
    [imported.id]);
  assert.match(file.rows[0].validated_sha256,/^[0-9a-f]{64}$/);
  await writeFile(storagePath(appConfig,file.rows[0].storage_key),header+row('Changed product'));
  const preview=await request('/api/imports/'+imported.id+'/preview');
  assert.equal(preview.response.status,409);
  assert.equal(preview.data.error.code,'CSV_CHANGED');
  const commit=await fetch(base+'/api/imports/'+imported.id+'/commit',{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':imported.commitKey},
  });
  assert.equal(commit.status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  const result=await request('/api/imports/'+imported.id);
  assert.equal(result.data.status,'FAILED');
  assert.equal(result.data.lastErrorCode,'CSV_CHANGED');
  assert.equal((await request('/api/products?q='+sku)).data.items.some((p:{sku:string})=>p.sku===sku),false);

  const orderNumber='FINGERPRINT-'+randomUUID();
  const orderHeader='order_number,warehouse_id,sku,quantity,unit_price,currency\n';
  const orderRow=(quantity:string)=>`${orderNumber},${example.warehouse},${example.prefix},${quantity},,\n`;
  const orderForm=new FormData();
  orderForm.append('file',new Blob([orderHeader+orderRow('1')],{type:'text/csv'}),'orders.csv');
  const orderUpload=await fetch(base+'/api/imports/orders',{
    method:'POST',headers:{Cookie:cookie},body:orderForm,
  });
  assert.equal(orderUpload.status,202);
  const orderImport=await orderUpload.json() as {id:string;commitKey:string};
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+orderImport.id)).data.status,'READY');
  const orderFile=await client.query('SELECT storage_key FROM orderflow.import_jobs WHERE id=$1',
    [orderImport.id]);
  await writeFile(storagePath(appConfig,orderFile.rows[0].storage_key),orderHeader+orderRow('2'));
  assert.equal((await fetch(base+'/api/imports/'+orderImport.id+'/commit',{
    method:'POST',headers:{Cookie:cookie,'Idempotency-Key':orderImport.commitKey},
  })).status,202);
  assert.equal(await runOneJob(pool,appConfig),true);
  const failedOrder=await request('/api/imports/'+orderImport.id);
  assert.equal(failedOrder.data.status,'FAILED');
  assert.equal(failedOrder.data.lastErrorCode,'CSV_CHANGED');
  assert.equal((await client.query('SELECT 1 FROM orderflow.orders WHERE order_number=$1',
    [orderNumber])).rowCount,0);
});

test('queued product import stops when uploader loses manager access', async () => {
  const email='import-manager-'+randomUUID().slice(0,8)+'@example.invalid';
  const created=await request('/api/users','POST',{email,displayName:'Import manager',
    role:'MANAGER',password});
  assert.equal(created.response.status,201);
  await client.query('UPDATE orderflow.users SET must_change_password=false WHERE id=$1',[created.data.id]);
  const signedIn=await request('/api/auth/login','POST',{email,password});
  const secondCookie=signedIn.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const sku='REVOKED-'+randomUUID().slice(0,8);
  const csv='sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json\n'
    +`${sku},Revoked import,${example.category},${example.unit},,,,,"{""screen_size_inches"":6.5}"\n`;
  const form=new FormData();
  form.append('file',new Blob([csv],{type:'text/csv'}),'products.csv');
  const uploaded=await fetch(base+'/api/imports/products',{
    method:'POST',headers:{Cookie:secondCookie},body:form});
  assert.equal(uploaded.status,202,await uploaded.clone().text());
  const job=await uploaded.json() as {id:string;commitKey:string};
  assert.equal(await runOneJob(pool,appConfig),true);
  assert.equal((await request('/api/imports/'+job.id)).data.status,'READY');
  const queued=await fetch(base+'/api/imports/'+job.id+'/commit',{
    method:'POST',headers:{Cookie:secondCookie,'Idempotency-Key':job.commitKey},
  });
  assert.equal(queued.status,202);
  assert.equal((await request('/api/users/'+created.data.id,'PATCH',{role:'STAFF'})).response.status,204);
  assert.equal(await runOneJob(pool,appConfig),true);
  const result=await request('/api/imports/'+job.id);
  assert.equal(result.data.status,'FAILED');
  assert.equal(result.data.lastErrorCode,'IMPORT_PERMISSION_CHANGED');
  assert.equal((await request('/api/products?q='+sku)).data.items.length,0);
  const notice=await request('/api/notifications','GET',undefined,secondCookie);
  assert.ok(notice.data.items.some((item:{eventClass:string})=>item.eventClass==='IMPORT_FAILED'));
});

test('assigned work and decisions create durable notifications for the right users', async () => {
  const destination=await request('/api/warehouses','POST',{
    code:'NOTIFY-'+randomUUID().slice(0,8),name:'Notification destination'});
  assert.equal(destination.response.status,201);
  const email='notify-staff-'+randomUUID().slice(0,8)+'@example.invalid';
  const created=await request('/api/users','POST',{email,displayName:'Notification staff',
    role:'STAFF',password});
  assert.equal(created.response.status,201);
  assert.equal((await request('/api/users/'+created.data.id+'/warehouses','PUT',{
    warehouseIds:[String(example.warehouse),destination.data.id]})).response.status,204);
  await client.query('UPDATE orderflow.users SET must_change_password=false WHERE id=$1',[created.data.id]);
  const signedIn=await request('/api/auth/login','POST',{email,password});
  const staffCookie=signedIn.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  const order=await request('/api/orders','POST',{orderNumber:'NOTIFY-'+randomUUID(),
    assignedTo:created.data.id});
  assert.equal(order.response.status,201);
  assert.equal((await request('/api/orders/'+order.data.id+'/items','PUT',{
    expectedRevision:0,items:[{productId:String(example.product),
      warehouseId:String(example.warehouse),quantity:'1'}]})).response.status,200);
  const action=async(path:string,auth:string,body?:unknown) => fetch(base+path,{
    method:'POST',headers:{Cookie:auth,'Idempotency-Key':randomUUID(),
      ...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  assert.equal((await action('/api/orders/'+order.data.id+'/confirm',cookie)).status,200);
  assert.equal((await action('/api/orders/'+order.data.id+'/cancel',cookie)).status,200);
  const stockRequest=await request('/api/stock-requests','POST',{
    requestType:'DAMAGE',warehouseId:String(example.warehouse),productId:String(example.product),
    quantity:'1',reason:'Damaged wrapper'},staffCookie);
  assert.equal(stockRequest.response.status,201);
  assert.equal((await action('/api/stock-requests/'+stockRequest.data.id+'/decision',cookie,{
    decision:'REJECTED',reason:'No physical damage found'})).status,200);
  const transfer=await request('/api/transfers','POST',{transferNumber:'NOTIFY-'+randomUUID(),
    sourceWarehouseId:String(example.warehouse),destinationWarehouseId:destination.data.id});
  assert.equal(transfer.response.status,201);
  assert.equal((await request('/api/transfers/'+transfer.data.id+'/items','PUT',{
    expectedRevision:0,items:[{productId:String(example.product),requestedQty:'1'}]})).response.status,200);
  assert.equal((await action('/api/transfers/'+transfer.data.id+'/send',cookie)).status,200);
  const staffFeed=await request('/api/notifications','GET',undefined,staffCookie);
  const classes=new Set(staffFeed.data.items.map((item:{eventClass:string})=>item.eventClass));
  for(const expected of ['ORDER_ASSIGNED','ORDER_READY','ORDER_CANCELLED',
    'APPROVAL_DECISION','TRANSFER_RECEIVE']) assert.ok(classes.has(expected),expected);
  const detail=await request('/api/transfers/'+transfer.data.id);
  assert.equal((await action('/api/transfers/'+transfer.data.id+'/receive',staffCookie,{
    items:[{transferItemId:detail.data.items[0].id,acceptedQty:'1',quarantinedQty:'0'}],
  })).status,200);
  const managerFeed=await request('/api/notifications');
  assert.ok(managerFeed.data.items.some((item:{eventClass:string})=>item.eventClass==='TRANSFER_PROGRESS'));
});

test('staff cannot read another staff member’s documents or request evidence', async () => {
  const makeStaff=async(label:string) => {
    const email=`${label}-${randomUUID().slice(0,8)}@example.invalid`;
    const created=await request('/api/users','POST',{email,displayName:label,role:'STAFF',password});
    assert.equal(created.response.status,201);
    assert.equal((await request(`/api/users/${created.data.id}/warehouses`,'PUT',{
      warehouseIds:[String(example.warehouse)],
    })).response.status,204);
    await client.query('UPDATE orderflow.users SET must_change_password=false WHERE id=$1',[created.data.id]);
    const login=await request('/api/auth/login','POST',{email,password});
    assert.equal(login.response.status,200);
    return login.response.headers.get('set-cookie')?.split(';')[0] ?? '';
  };
  const owner=await makeStaff('owner');
  const colleague=await makeStaff('colleague');
  const receipt=await request('/api/receipts','POST',{
    receiptNumber:'PRIVATE-'+randomUUID(),kind:'INBOUND',warehouseId:String(example.warehouse),
  },owner);
  assert.equal(receipt.response.status,201);
  assert.equal((await request(`/api/receipts/${receipt.data.id}`,'GET',undefined,owner)).response.status,200);
  assert.equal((await request(`/api/receipts/${receipt.data.id}`,'GET',undefined,colleague)).response.status,403);
  const colleagueReceipts=await request('/api/receipts','GET',undefined,colleague);
  assert.equal(colleagueReceipts.data.items.some((item:{id:string})=>item.id===receipt.data.id),false);
  assert.equal((await request(`/api/receipts/${receipt.data.id}`)).response.status,200);

  const stockRequest=await request('/api/stock-requests','POST',{
    requestType:'DAMAGE',warehouseId:String(example.warehouse),productId:String(example.product),
    quantity:'1',reason:'Damaged carton',
  },owner);
  assert.equal(stockRequest.response.status,201);
  assert.equal((await request(`/api/stock-requests/${stockRequest.data.id}`,'GET',undefined,owner)).response.status,200);
  assert.equal((await request(`/api/stock-requests/${stockRequest.data.id}`,'GET',undefined,colleague)).response.status,403);
  const colleagueRequests=await request('/api/stock-requests','GET',undefined,colleague);
  assert.equal(colleagueRequests.data.items.some((item:{id:string})=>item.id===stockRequest.data.id),false);
  const evidenceForm=new FormData();
  evidenceForm.append('file',new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,1])],
    {type:'image/png'}),'damage.png');
  const uploaded=await fetch(base+`/api/evidence/stock-requests/${stockRequest.data.id}`,{
    method:'POST',headers:{Cookie:owner},body:evidenceForm,
  });
  assert.equal(uploaded.status,201);
  const evidence=await uploaded.json() as {id:string};
  assert.equal((await request(`/api/evidence/stock-requests/${stockRequest.data.id}`,
    'GET',undefined,colleague)).response.status,403);
  const privateFile=await fetch(base+`/api/evidence/${evidence.id}/file`,{
    headers:{Cookie:colleague},
  });
  assert.equal(privateFile.status,403);
  assert.equal((await request(`/api/evidence/stock-requests/${stockRequest.data.id}`)).response.status,200);

  const priorReturn=await client.query(`SELECT id::text FROM orderflow.order_returns
    WHERE received_by=$1 AND warehouse_id=$2 LIMIT 1`,[example.manager,example.warehouse]);
  assert.ok(priorReturn.rowCount);
  assert.equal((await request(`/api/returns/${priorReturn.rows[0].id}`,
    'GET',undefined,colleague)).response.status,403);
  assert.equal((await request(`/api/returns/${priorReturn.rows[0].id}`)).response.status,200);
});

test('API shutdown closes an open notification stream', async () => {
  const shutdown=new AbortController();
  const localServer=createApp(pool,appConfig,shutdown.signal).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>localServer.once('listening',resolve));
  const address=localServer.address();
  assert.ok(address && typeof address!=='string');
  const clientAbort=new AbortController();
  const deadline=setTimeout(()=>clientAbort.abort(),5000);
  try {
    const stream=await fetch(`http://127.0.0.1:${address.port}/api/notifications/stream`,{
      headers:{Cookie:cookie},signal:clientAbort.signal,
    });
    assert.equal(stream.status,200);
    const reader=stream.body!.getReader();
    assert.equal((await reader.read()).done,false);
    shutdown.abort();
    assert.equal((await reader.read()).done,true);
    await new Promise<void>((resolve,reject)=>localServer.close(error=>error?reject(error):resolve()));
  } finally {
    clearTimeout(deadline);
    clientAbort.abort();
    shutdown.abort();
    localServer.closeAllConnections();
    if (localServer.listening) localServer.close();
  }
});

test('production settings enforce origin and secure session cookies', async () => {
  const origin='https://orderflow.example.invalid';
  const production=readConfig({NODE_ENV:'production',HOST:'127.0.0.1',PORT:'3000',
    DATABASE_URL:appConfig.DATABASE_URL,DATA_DIR:dataDirectory,APP_ORIGIN:origin});
  const localServer=createApp(pool,production).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>localServer.once('listening',resolve));
  const address=localServer.address();
  assert.ok(address && typeof address!=='string');
  const localBase=`http://127.0.0.1:${address.port}`;
  const loginBody=JSON.stringify({email:example.prefix+'@example.invalid',password});
  try {
    assert.equal((await fetch(localBase+'/health/ready')).status,200);
    const rejected=await fetch(localBase+'/api/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json'},body:loginBody,
    });
    assert.equal(rejected.status,403);
    const accepted=await fetch(localBase+'/api/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:loginBody,
    });
    assert.equal(accepted.status,200);
    const session=accepted.headers.get('set-cookie') ?? '';
    assert.match(session,/\bHttpOnly\b/);
    assert.match(session,/\bSecure\b/);
    assert.match(session,/SameSite=Strict/);
  } finally {
    await new Promise<void>(resolve=>localServer.close(()=>resolve()));
  }
});

test('frontend list and detail contracts expose recoverable jobs and document context', async () => {
  const [returns,imports,exports,orders,requests,movements]=await Promise.all([
    request('/api/returns?limit=10'),request('/api/imports?limit=10'),
    request('/api/exports?limit=10'),request('/api/orders?limit=10'),
    request('/api/stock-requests?limit=10'),request('/api/movements?limit=10'),
  ]);
  for(const item of [returns,imports,exports,orders,requests,movements]) {
    assert.equal(item.response.status,200);
    assert.ok(Array.isArray(item.data.items));
    assert.ok('nextCursor' in item.data);
  }
  assert.ok(returns.data.items.length>0);
  assert.ok(imports.data.items.length>0);
  assert.ok(exports.data.items.length>0);
  assert.ok(orders.data.items.length>0);
  assert.ok(requests.data.items.length>0);
  assert.ok(movements.data.items.length>0);
  const order=await request(`/api/orders/${orders.data.items[0].id}`);
  assert.equal(order.response.status,200);
  if(order.data.items.length) {
    assert.equal(typeof order.data.items[0].sku,'string');
    assert.equal(typeof order.data.items[0].returnableQty,'string');
  }
  const stockRequest=await request(`/api/stock-requests/${requests.data.items[0].id}`);
  assert.equal(stockRequest.response.status,200);
  assert.ok('decisionReason' in stockRequest.data);
  assert.match(movements.data.items[0].eventId,/^[1-9]\d*$/);
});
