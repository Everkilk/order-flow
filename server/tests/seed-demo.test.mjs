import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Decimal } from 'decimal.js';
import { localDatabaseUrl, migrate, quoteIdentifier } from '../scripts/db-lib.mjs';
import { createApp } from '../dist/app.js';
import { makePool } from '../dist/db.js';
import { readConfig } from '../dist/config.js';
import { passwordHash } from '../dist/auth.js';
import { runOneJob } from '../dist/job-worker.js';
import { logger } from '../dist/errors.js';
import { seedDemo, validateTarget } from '../scripts/seed-demo.mjs';
import * as dataset from '../scripts/demo-dataset.mjs';

test('dry run performs no network calls and manifests the agreed dataset',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=()=>{throw new Error('Dry run must not contact any server.');};
  try {
    const summary=await seedDemo({apply:false});
    assert.equal(summary.products,60);assert.equal(summary.stockRows,180);
    assert.equal(summary.receipts,12);assert.equal(summary.orders,24);assert.equal(summary.returns,6);assert.equal(summary.transfers,12);assert.equal(summary.requests,6);
    assert.equal(summary.zeroOnHand,6);assert.equal(summary.fullyReserved,3);assert.equal(summary.lowStock,6);
    assert.ok(summary.balances.every(row=>new Decimal(row.available).gte(0)));
    for(const industry of dataset.categories.keys()) assert.equal(dataset.products.filter(p=>p.category===industry).length,10);
    assert.ok(dataset.products.every(p=>p.name.includes(' / ')));
    for(const doc of [...dataset.opening,...dataset.receipts,...dataset.orders]) for(const line of doc.items) {
      const product=dataset.products[line.product],unit=dataset.units.find(u=>u.key===product.unit);
      assert.ok(new Decimal(line.quantity).decimalPlaces()<=unit.decimalPlaces);
    }
    assert.throws(()=>validateTarget('https://example.com/'),/Unsupported/);
    assert.throws(()=>validateTarget('https://user:secret@order-flow-khaki-phi.vercel.app/'),/Unsupported/);
  } finally {globalThis.fetch=original;}
});

test('shared demo rehearses normal APIs, resumes a checkpoint, reconciles ledger and rejects tester changes',async()=>{
  const url=localDatabaseUrl(),adminUrl=new URL(url);adminUrl.pathname='/postgres';
  const admin=new pg.Client({connectionString:adminUrl.toString()});
  const name='orderflow_seed_test_'+randomUUID().replaceAll('-','').slice(0,16);
  const directory=await mkdtemp(join(tmpdir(),'orderflow-seed-test-'));
  const password='Local-seed-'+randomUUID();
  const oldLogLevel=logger.level;logger.level='silent';
  let client,pool,server;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE '+quoteIdentifier(name));
    url.pathname='/'+name;client=new pg.Client({connectionString:url.toString()});await client.connect();await migrate(client,()=>{});
    await client.query(`INSERT INTO orderflow.users(email,display_name,role,password_hash,must_change_password)
      VALUES('admin@example.com','Local seed manager','MANAGER',$1,false)`,[await passwordHash(password)]);
    const config=readConfig({DATABASE_URL:url.toString(),NODE_ENV:'test',DATA_DIR:directory,HOST:'127.0.0.1',PORT:'3000'});
    pool=makePool(config);server=createApp(pool,config).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const options={apply:true,target:`http://127.0.0.1:${server.address().port}`,dataset:dataset.version,checkpoint:join(directory,'checkpoint.json'),
      passwords:{admin:password,staff:password+'staff',north:password+'north',viewer:password+'viewer'},tick:()=>runOneJob(pool,config)};
    await assert.rejects(seedDemo({...options,stopAfter:18}),/Controlled stop/);
    const partial=JSON.parse(await readFile(options.checkpoint,'utf8'));
    assert.equal(Object.keys(partial.steps).length,18);assert.equal(partial.pending,undefined);
    const result=await seedDemo(options);
    assert.equal(result.complete,true);assert.ok(result.requests<1000);assert.ok(result.totalRequests<1000);assert.equal(result.jobs,7);assert.ok(result.uploadedBytes<2*1024*1024);
    const counts=async()=>{
      const tables=['users','products','receipts','receipt_items','orders','order_items','order_returns','order_return_items','transfers','transfer_items','stock_change_requests','stock_change_decisions','inventory_events','inventory_ledger','import_jobs','export_jobs','background_jobs'];
      const counts={};
      for(const table of tables) counts[table]=(await client.query(`SELECT count(*)::int AS count FROM orderflow.${table}`)).rows[0].count;
      return counts;
    };
    const before=await counts();
    assert.equal(before.users,4);assert.equal(before.products,60);assert.equal(before.receipts,12);assert.equal(before.orders,24);
    assert.equal(before.order_returns,6);assert.equal(before.transfers,12);assert.equal(before.stock_change_requests,6);
    assert.equal(before.import_jobs,3);assert.equal(before.export_jobs,4);
    const discrepancy=(await client.query('SELECT kind,status,count(*)::int AS count FROM orderflow.discrepancy_status GROUP BY kind,status')).rows;
    assert.equal(discrepancy.find(row=>row.kind==='SHORTAGE' && row.status==='OPEN').count,1);
    assert.equal(discrepancy.find(row=>row.kind==='EXCESS' && row.status==='OPEN').count,1);
    const repeat=await seedDemo(options);
    assert.equal(repeat.complete,true);assert.deepEqual(await counts(),before);
    const checkpointText=await readFile(options.checkpoint,'utf8');
    for(const secret of Object.values(options.passwords)) assert.ok(!checkpointText.includes(secret));
    assert.ok(!checkpointText.includes('orderflow_session='));
    await client.query(`UPDATE orderflow.products SET name='Tester changed this product',revision=revision+1 WHERE id=$1`,[result.ids.products[0]]);
    await assert.rejects(seedDemo(options),/Demo record changed/);
    assert.deepEqual(await counts(),before);
    const collisions=join(directory,'collision.json');
    await assert.rejects(seedDemo({...options,checkpoint:collisions}),/namespace already exists/);
    const ambiguous=JSON.parse(checkpointText);ambiguous.pending='simulated-ambiguous-upload';
    const {writeFile}=await import('node:fs/promises');await writeFile(options.checkpoint,JSON.stringify(ambiguous));
    await assert.rejects(seedDemo(options),/Ambiguous operation/);
    assert.deepEqual(await counts(),before);
    console.log(`Demo rehearsal: ${result.requests} requests in resumed run, ${result.totalRequests} cumulative requests including interruption, ${result.jobs} CSV tasks, ${result.uploadedBytes} uploaded bytes; rerun created no business records.`);
  } finally {
    if(server) await new Promise(resolve=>server.close(resolve));
    if(pool) await pool.end();if(client) await client.end();
    await admin.query('DROP DATABASE IF EXISTS '+quoteIdentifier(name));await admin.end();
    // mkdtemp returned this absolute path under the OS temporary directory.
    assert.ok(directory.startsWith(tmpdir()));await rm(directory,{recursive:true,force:true});logger.level=oldLogLevel;
  }
});
