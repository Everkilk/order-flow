import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { localDatabaseUrl, migrate, quoteIdentifier } from '../scripts/db-lib.mjs';

test('standalone demo runs against the backend stock migrations and rolls back its data',async () => {
  const url=localDatabaseUrl(),adminUrl=new URL(url);adminUrl.pathname='/postgres';
  const admin=new pg.Client({connectionString:adminUrl.toString()});
  const name='orderflow_demo_test_'+randomUUID().replaceAll('-','').slice(0,16);
  await admin.connect();
  let db;
  try {
    await admin.query('CREATE DATABASE '+quoteIdentifier(name));
    url.pathname='/'+name;
    db=new pg.Client({connectionString:url.toString()});
    await db.connect();
    await migrate(db,()=>{});
    const {stdout}=await promisify(execFile)(process.execPath,['scripts/db-demo.mjs'],{
      cwd:new URL('../',import.meta.url),env:{...process.env,DATABASE_URL:url.toString()},timeout:30_000,
    });
    assert.match(stdout,/Fulfilled order: 7 phones remain/);
    assert.match(stdout,/All example rows were rolled back/);
    const count=await db.query('SELECT count(*)::integer AS count FROM orderflow.products');
    assert.equal(count.rows[0].count,0);
  } finally {
    if (db) await db.end();
    await admin.query('DROP DATABASE IF EXISTS '+quoteIdentifier(name));
    await admin.end();
  }
});
