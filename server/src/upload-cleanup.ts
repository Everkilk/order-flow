import type pg from 'pg';
import type { Config } from './config.js';
import { removeStoredFile } from './storage.js';

// Rollback/replay candidates have no business attachment. Failed deletion is
// retried by the existing bounded worker, never silently left in storage.
export async function cleanupUpload(pool: pg.Pool, config: Config, storageKey: string, actorId: string) {
  try { await removeStoredFile(config, storageKey); }
  catch {
    await pool.query(`INSERT INTO orderflow.background_jobs(kind,requested_by,dedupe_key,payload)
      VALUES('UPLOAD_DELETE',$1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING`,
      [actorId, 'upload-delete:'+storageKey, JSON.stringify({storageKey})]);
  }
}
