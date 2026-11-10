import type pg from 'pg';
import {verify} from '@node-rs/argon2';
import type {Config} from './config.js';
import {withTransaction} from './db.js';
import {listStoredObjects} from './storage.js';
import {publicDemoInfo} from './demo-limits.js';

export async function initializeDemoStorage(pool:pg.Pool,config:Config) {
  if(!config.DEMO_MODE)return;
  for(const account of publicDemoInfo(config).accounts??[]) {
    const found=(await pool.query('SELECT password_hash,role,active,must_change_password FROM orderflow.users WHERE lower(email)=lower($1)',[account.email])).rows[0];
    if(!account.password || !found?.active || found.must_change_password || found.role!==account.role || !await verify(found.password_hash,account.password))throw new Error('Public demo account configuration does not match the database.');
  }
  await withTransaction(pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(742019,12)');
    const state=await c.query('SELECT storage_initialized FROM orderflow.demo_state WHERE singleton FOR UPDATE');
    if(state.rows[0]?.storage_initialized)return;
    const files=await listStoredObjects(config);
    for(const file of files)await c.query(`INSERT INTO orderflow.demo_storage_objects(storage_key,bytes,state,created_at)
      VALUES($1,$2,'STORED',$3) ON CONFLICT(storage_key) DO NOTHING`,[file.key,file.bytes,file.createdAt]);
    await c.query(`INSERT INTO orderflow.demo_storage_objects(storage_key,bytes,state)
      SELECT storage_key,0,'MISSING' FROM (
        SELECT storage_key FROM orderflow.evidence_files UNION SELECT storage_key FROM orderflow.import_jobs
        UNION SELECT storage_key FROM orderflow.export_jobs WHERE storage_key IS NOT NULL
      ) objects ON CONFLICT(storage_key) DO NOTHING`);
    await c.query('UPDATE orderflow.demo_state SET storage_initialized=true WHERE singleton');
  });
}

export async function demoMaintenance(pool:pg.Pool,config:Config) {
  if(!config.DEMO_MODE)return;
  const claim=await pool.query(`UPDATE orderflow.demo_state SET maintenance_at=now() WHERE singleton AND storage_initialized
    AND (maintenance_at IS NULL OR maintenance_at<now()-interval '1 minute') RETURNING singleton`);
  if(!claim.rowCount)return;
  await pool.query(`DELETE FROM orderflow.sessions WHERE id IN (
    SELECT id FROM orderflow.sessions WHERE expires_at<=now() OR revoked_at IS NOT NULL LIMIT 1000)`);
  const files=await pool.query(`SELECT o.storage_key FROM orderflow.demo_storage_objects o WHERE state IN ('RESERVED','STORED','DELETING') AND (
    state='DELETING' OR (state='RESERVED' AND updated_at<now()-interval '10 minutes')
    OR (storage_key LIKE 'exports/%' AND EXISTS(SELECT 1 FROM orderflow.export_jobs e WHERE e.storage_key=o.storage_key AND e.expires_at<=now()))
    OR (storage_key LIKE 'imports/%' AND created_at<now()-interval '7 days' AND EXISTS(
      SELECT 1 FROM orderflow.import_jobs i WHERE i.storage_key=o.storage_key AND i.status IN ('COMMITTED','INVALID','FAILED')))
    OR (created_at<now()-interval '7 days' AND NOT EXISTS(SELECT 1 FROM orderflow.evidence_files f WHERE f.storage_key=o.storage_key)
      AND NOT EXISTS(SELECT 1 FROM orderflow.import_jobs i WHERE i.storage_key=o.storage_key)
      AND NOT EXISTS(SELECT 1 FROM orderflow.export_jobs e WHERE e.storage_key=o.storage_key))
  ) ORDER BY created_at LIMIT 20`);
  for(const {storage_key:key} of files.rows)await pool.query(`INSERT INTO orderflow.background_jobs(kind,dedupe_key,payload)
    VALUES('UPLOAD_DELETE',$1,$2) ON CONFLICT(dedupe_key) DO UPDATE SET status='PENDING',attempts=0,available_at=now(),last_error_code=NULL
    WHERE orderflow.background_jobs.status='DEAD' AND orderflow.background_jobs.available_at<now()-interval '1 hour'`,['demo-cleanup:'+key,JSON.stringify({storageKey:key})]);
}
