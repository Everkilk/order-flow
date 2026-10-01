import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../dist/app.js';
import { makePool } from '../dist/db.js';
import { passwordHash } from '../dist/auth.js';
import { logger } from '../dist/errors.js';
import { localDatabaseUrl, migrate, quoteIdentifier } from './db-lib.mjs';

const count=Number(process.env.BENCH_PRODUCTS ?? 10000);
if (!Number.isInteger(count) || count<1000 || count>1_000_000)
  throw new Error('BENCH_PRODUCTS must be an integer from 1,000 to 1,000,000.');
const url=localDatabaseUrl(),root=new URL(url);root.pathname='/postgres';
const admin=new pg.Client({connectionString:root.toString()});
const name='orderflow_search_bench_'+randomUUID().replaceAll('-','').slice(0,16);
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
  const category=(await client.query("INSERT INTO orderflow.categories(name) VALUES('Benchmark') RETURNING id")).rows[0].id;
  const unit=(await client.query("INSERT INTO orderflow.units(code,name,decimal_places) VALUES('EA','Each',0) RETURNING id")).rows[0].id;
  for(let start=1;start<=count;start+=10000) {
    const end=Math.min(start+9999,count);
    await client.query(`INSERT INTO orderflow.products(sku,name,category_id,unit_id)
      SELECT 'BENCH-'||lpad(n::text,7,'0'),
      CASE WHEN n%1000=0 THEN 'Large Screen Phone '||n ELSE 'Benchmark product '||n END,$3,$4
      FROM generate_series($1::integer,$2::integer) n`,[start,end,category,unit]);
    console.log(`Loaded ${end}/${count} products`);
  }
  await client.query('ANALYZE orderflow.products');
  const withStock=process.env.BENCH_STOCK==='1';
  if(withStock) {
    const warehouse=(await client.query("INSERT INTO orderflow.warehouses(code,name) VALUES('BENCH','Benchmark warehouse') RETURNING id")).rows[0].id;
    const supplier=(await client.query("INSERT INTO orderflow.suppliers(name) VALUES('Benchmark supplier') RETURNING id")).rows[0].id;
    for(let start=1;start<=count;start+=10000) {
      const end=Math.min(start+9999,count);
      await client.query(`INSERT INTO orderflow.inventory_balances(warehouse_id,product_id,on_hand)
        SELECT $3,n,CASE WHEN n%1000=0 THEN 0 ELSE 10 END
        FROM generate_series($1::integer,$2::integer) n`,
        [start,end,warehouse]);
      await client.query(`INSERT INTO orderflow.product_suppliers
        (product_id,supplier_id,primary_supplier,cost,currency)
        SELECT n,$3,true,2.5,'USD' FROM generate_series($1::integer,$2::integer) n`,
        [start,end,supplier]);
      await client.query(`INSERT INTO orderflow.low_stock_thresholds(warehouse_id,product_id,threshold)
        SELECT $3,n,11 FROM generate_series($1::integer,$2::integer) n WHERE n%100=0`,
        [start,end,warehouse]);
      if(end%100000===0 || end===count) console.log(`Loaded ${end}/${count} stock rows`);
    }
    await client.query('ANALYZE orderflow.inventory_balances');
    await client.query('ANALYZE orderflow.product_suppliers');
    await client.query('ANALYZE orderflow.low_stock_thresholds');
  }
  const hash=await passwordHash('Benchmark-password-2026!');
  await client.query(`INSERT INTO orderflow.users(email,display_name,password_hash,role,must_change_password)
    VALUES('benchmark@example.invalid','Benchmark', $1,'MANAGER',false)`,[hash]);
  const config={DATABASE_URL:url.toString(),NODE_ENV:'test',PORT:3000,HOST:'127.0.0.1',DATA_DIR:'data'};
  pool=makePool(config);
  server=createApp(pool,config).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const address=server.address();
  const base=`http://127.0.0.1:${address.port}`;
  const login=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:'benchmark@example.invalid',password:'Benchmark-password-2026!'})});
  if (!login.ok) throw new Error('Benchmark login failed.');
  const cookie=login.headers.get('set-cookie').split(';')[0];
  for (const [label,query] of [['exact SKU',`BENCH-${String(Math.ceil(count/2)).padStart(7,'0')}`],
    ['name prefix','Benchmark product 42'],['full text','large screen'],
    ['broad name','Benchmark'],['first page','']]) {
    const timings=[];
    for(let iteration=0;iteration<23;iteration++) {
      const start=performance.now();
      const response=await fetch(base+'/api/products?q='+encodeURIComponent(query)+'&limit=50',{headers:{Cookie:cookie}});
      if (!response.ok) throw new Error(`Search failed: ${label} (${response.status})`);
      await response.arrayBuffer();
      if(iteration>=3) timings.push(performance.now()-start);
    }
    timings.sort((a,b)=>a-b);
    console.log(`${label}: p50=${timings[9].toFixed(1)}ms p95=${timings[18].toFixed(1)}ms (${count} products)`);
  }
  const sample=`BENCH-${String(Math.ceil(count/2)).padStart(7,'0')}`;
  const parallel=await Promise.all(Array.from({length:200},async () => {
    const start=performance.now();
    const response=await fetch(base+'/api/products?q='+encodeURIComponent(sample),{headers:{Cookie:cookie}});
    if (!response.ok) throw new Error(`Parallel search failed: ${response.status}`);
    await response.arrayBuffer();
    return performance.now()-start;
  }));
  parallel.sort((a,b)=>a-b);
  console.log(`200 parallel exact-SKU requests: p50=${parallel[99].toFixed(1)}ms p95=${parallel[189].toFixed(1)}ms`);
  if(withStock) {
    for(const [label,path] of [['stock first page','/api/stock?warehouseId=1&limit=50'],
      ['available stock','/api/stock?warehouseId=1&availability=AVAILABLE&limit=50'],
      ['out-of-stock page','/api/stock?warehouseId=1&availability=OUT_OF_STOCK&limit=50'],
      ['dashboard','/api/dashboard'],['valuation','/api/reports/valuation?warehouseId=1'],
      ['low stock','/api/reports/low-stock?warehouseId=1&limit=50']]) {
      const timings=[];
      for(let iteration=0;iteration<13;iteration++) {
        const start=performance.now();
        const response=await fetch(base+path,{headers:{Cookie:cookie}});
        if(!response.ok) throw new Error(`${label} failed with HTTP ${response.status}`);
        await response.arrayBuffer();
        if(iteration>=3) timings.push(performance.now()-start);
      }
      timings.sort((a,b)=>a-b);
      console.log(`${label}: p50=${timings[4].toFixed(1)}ms p90=${timings[8].toFixed(1)}ms (${count} stock rows)`);
    }
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
