import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { makePool } from '../dist/db.js';
import { passwordHash } from '../dist/auth.js';
import { logger } from '../dist/errors.js';
import { localDatabaseUrl, migrate, quoteIdentifier } from './db-lib.mjs';

const count=Number(process.env.BENCH_MOVEMENTS ?? 1_000_000);
if (!Number.isInteger(count) || count<100_000 || count>10_000_000 || count%100!==0)
  throw new Error('BENCH_MOVEMENTS must be a multiple of 100 from 100,000 to 10,000,000.');
const url=localDatabaseUrl(),root=new URL(url);root.pathname='/postgres';
const admin=new pg.Client({connectionString:root.toString()});
const name='orderflow_movement_bench_'+randomUUID().replaceAll('-','').slice(0,16);
let client,pool,server,adminConnected=false;
try {
  logger.level='silent';
  await admin.connect();
  adminConnected=true;
  await admin.query('CREATE DATABASE '+quoteIdentifier(name));
  url.pathname='/'+name;
  client=new pg.Client({connectionString:url.toString()});
  await client.connect();
  await migrate(client,()=>{});
  const role=await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  if (!role.rows[0]?.rolsuper) throw new Error('Synthetic loading requires a local PostgreSQL superuser.');
  // This is an isolated read benchmark. Bypass write guards while seeding synthetic history;
  // real inventory commands and their guards are covered by the API and schema tests.
  await client.query('SET session_replication_role=replica');
  await client.query(`INSERT INTO orderflow.users(email,display_name,password_hash,role,must_change_password)
    VALUES('movement-benchmark@example.invalid','Benchmark',$1,'MANAGER',false)`,
    [await passwordHash('Benchmark-password-2026!')]);
  await client.query(`INSERT INTO orderflow.categories(name) VALUES('Benchmark')`);
  await client.query(`INSERT INTO orderflow.units(code,name,decimal_places) VALUES('EA','Each',0)`);
  await client.query(`INSERT INTO orderflow.warehouses(code,name)
    SELECT 'BM-'||n::text,'Benchmark warehouse '||n FROM generate_series(1,10) n`);
  await client.query(`INSERT INTO orderflow.products(sku,name,category_id,unit_id)
    SELECT 'MOV-'||lpad(n::text,4,'0'),'Movement product '||n,1,1
    FROM generate_series(1,1000) n`);
  await client.query(`INSERT INTO orderflow.receipts(receipt_number,kind,warehouse_id,created_by,status,posted_at)
    SELECT 'BM-R-'||n::text,'INBOUND',(n%10)+1,1,'POSTED',now()
    FROM generate_series(1,$1::integer) n`,[count/100]);
  await client.query(`INSERT INTO orderflow.inventory_events
    (event_type,actor_id,idempotency_key,reason,receipt_id,occurred_at)
    SELECT 'RECEIPT',1,gen_random_uuid(),'Benchmark synthetic receipt',n,
      now()-(n%730)*interval '1 day'
    FROM generate_series(1,$1::integer) n`,[count/100]);
  for(let start=1;start<=count;start+=250_000) {
    const end=Math.min(start+249_999,count);
    await client.query(`INSERT INTO orderflow.inventory_ledger
      (event_id,product_id,warehouse_id,on_hand_delta,reserved_delta,
       on_hand_before,reserved_before,on_hand_after,reserved_after,created_at)
      SELECT ((n-1)/100)+1,((n-1)%1000)+1,(((n-1)/100)%10)+1,
        1,0,0,0,1,0,now()-((((n-1)/100)+1)%730)*interval '1 day'
      FROM generate_series($1::bigint,$2::bigint) n`,[start,end]);
    console.log(`Loaded ${end}/${count} movements`);
  }
  await client.query('SET session_replication_role=origin');
  await client.query('ANALYZE orderflow.inventory_events');
  await client.query('ANALYZE orderflow.inventory_ledger');
  const config={DATABASE_URL:url.toString(),NODE_ENV:'test',PORT:3000,HOST:'127.0.0.1',DATA_DIR:'data'};
  pool=makePool(config);
  server=createApp(pool,config).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:'movement-benchmark@example.invalid',password:'Benchmark-password-2026!'})});
  if (!login.ok) throw new Error('Benchmark login failed.');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const now=new Date();
  const from=new Date(now.getTime()-7*86_400_000).toISOString();
  const to=new Date(now.getTime()+86_400_000).toISOString();
  const cases=[
    ['latest warehouse','/api/movements?warehouseId=2&limit=50'],
    ['warehouse and product','/api/movements?warehouseId=2&productId=1&limit=50'],
    ['warehouse and action','/api/movements?warehouseId=2&eventType=RECEIPT&limit=50'],
    ['document reference','/api/movements?reference=BM-R-100&limit=50'],
    ['recent date range','/api/movements?'+new URLSearchParams({warehouseId:'2',from,to,limit:'50'})],
    ['movement report','/api/reports/movements?'+new URLSearchParams({warehouseId:'2',from,to})],
  ];
  for(const [label,path] of cases) {
    const timings=[];
    for(let iteration=0;iteration<13;iteration++) {
      const start=performance.now();
      const response=await fetch(base+path,{headers:{Cookie:cookie}});
      if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
      const data=await response.json();
      if (!Array.isArray(data.items)) throw new Error(`${label} returned no items array`);
      if(iteration>=3) timings.push(performance.now()-start);
    }
    timings.sort((a,b)=>a-b);
    console.log(`${label}: p50=${timings[4].toFixed(1)}ms p90=${timings[8].toFixed(1)}ms (${count} movements)`);
  }
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  if(pool) await pool.end();
  if(client) await client.end();
  if(adminConnected) {
    await admin.query('DROP DATABASE IF EXISTS '+quoteIdentifier(name));
    await admin.end();
  }
}
