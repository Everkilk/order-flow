import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { makePool, withTransaction } from '../dist/db.js';
import { passwordHash } from '../dist/auth.js';
import { postInventoryEvent } from '../dist/inventory-write.js';
import { logger } from '../dist/errors.js';
import { localDatabaseUrl, migrate, quoteIdentifier } from './db-lib.mjs';

const count=Number(process.env.BENCH_ORDERS ?? 200);
if(!Number.isInteger(count) || count<1 || count>500)
  throw new Error('BENCH_ORDERS must be an integer from 1 to 500.');
const url=localDatabaseUrl(),root=new URL(url);root.pathname='/postgres';
const admin=new pg.Client({connectionString:root.toString()});
const name='orderflow_order_bench_'+randomUUID().replaceAll('-','').slice(0,16);
let client,pool,server,connected=false;
try {
  logger.level='silent';
  await admin.connect();
  connected=true;
  await admin.query('CREATE DATABASE '+quoteIdentifier(name));
  url.pathname='/'+name;
  client=new pg.Client({connectionString:url.toString()});
  await client.connect();
  await migrate(client,()=>{});
  const manager=(await client.query(`INSERT INTO orderflow.users
    (email,display_name,password_hash,role,must_change_password)
    VALUES('orders-benchmark@example.invalid','Benchmark',$1,'MANAGER',false)
    RETURNING id::text`,[await passwordHash('Benchmark-password-2026!')])).rows[0].id;
  const category=(await client.query("INSERT INTO orderflow.categories(name) VALUES('Benchmark') RETURNING id")).rows[0].id;
  const unit=(await client.query("INSERT INTO orderflow.units(code,name,decimal_places) VALUES('EA','Each',0) RETURNING id")).rows[0].id;
  const warehouse=(await client.query("INSERT INTO orderflow.warehouses(code,name) VALUES('BENCH','Benchmark') RETURNING id")).rows[0].id;
  await client.query(`INSERT INTO orderflow.products(sku,name,category_id,unit_id)
    SELECT 'ORDER-BENCH-'||n::text,'Order benchmark product '||n,$2,$3
    FROM generate_series(1,$1::integer) n`,[count,category,unit]);
  const receipt=(await client.query(`INSERT INTO orderflow.receipts
    (receipt_number,kind,warehouse_id,created_by)
    VALUES('ORDER-BENCH-OPENING','OPENING',$1,$2) RETURNING id::text`,[warehouse,manager])).rows[0].id;
  const items=await client.query(`INSERT INTO orderflow.receipt_items(receipt_id,product_id,quantity)
    SELECT $1,id,10 FROM orderflow.products ORDER BY id
    RETURNING id::text,product_id::text`,[receipt]);
  const config={DATABASE_URL:url.toString(),NODE_ENV:'test',PORT:3000,HOST:'127.0.0.1',DATA_DIR:'data'};
  pool=makePool(config);
  await withTransaction(pool,async c => {
    await postInventoryEvent(c,{type:'OPENING',actorId:manager,key:randomUUID(),
      reason:'Benchmark starting stock',source:{receiptId:receipt},
      lines:items.rows.map(row=>({warehouseId:String(warehouse),productId:row.product_id,
        onHandDelta:'10',reservedDelta:'0',receiptItemId:row.id}))});
    await c.query("UPDATE orderflow.receipts SET status='POSTED',posted_at=now() WHERE id=$1",[receipt]);
  });
  await client.query(`INSERT INTO orderflow.orders(order_number,created_by)
    SELECT 'ORDER-BENCH-'||n::text,$2 FROM generate_series(1,$1::integer) n`,[count,manager]);
  await client.query(`INSERT INTO orderflow.order_items(order_id,product_id,warehouse_id,quantity)
    SELECT o.id,p.id,$1,1 FROM orderflow.orders o JOIN orderflow.products p
      ON p.sku=o.order_number
    WHERE o.order_number LIKE 'ORDER-BENCH-%'`,[warehouse]);
  const orders=await client.query('SELECT id::text FROM orderflow.orders ORDER BY id');
  if(orders.rowCount!==count) throw new Error('Benchmark order setup failed.');
  server=createApp(pool,config).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:'orders-benchmark@example.invalid',password:'Benchmark-password-2026!'})});
  if(!login.ok) throw new Error('Benchmark login failed.');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const timings=await Promise.all(orders.rows.map(async order => {
    const start=performance.now();
    const response=await fetch(base+'/api/orders/'+order.id+'/confirm',{
      method:'POST',headers:{Cookie:cookie,'Idempotency-Key':randomUUID()},
    });
    const body=await response.json();
    if(!response.ok) throw new Error(`Order ${order.id} failed with HTTP ${response.status}: ${body.error?.code}`);
    return performance.now()-start;
  }));
  timings.sort((a,b)=>a-b);
  const state=await client.query(`SELECT count(*)::integer AS count,sum(reserved)::text AS reserved
    FROM orderflow.inventory_balances WHERE warehouse_id=$1 AND reserved=1`,[warehouse]);
  if(state.rows[0].count!==count) throw new Error('Benchmark reservations did not all commit.');
  console.log(`${count} parallel order confirmations: p50=${timings[Math.floor((count-1)*0.5)].toFixed(1)}ms `
    +`p95=${timings[Math.floor((count-1)*0.95)].toFixed(1)}ms max=${timings.at(-1).toFixed(1)}ms`);
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  if(pool) await pool.end();
  if(client) await client.end();
  if(connected) {
    await admin.query('DROP DATABASE IF EXISTS '+quoteIdentifier(name));
    await admin.end();
  }
}
