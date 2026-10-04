import { createHash, randomBytes } from 'node:crypto';
import type { Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Actor } from './auth.js';
import { withTransaction } from './db.js';
import { AppError } from './errors.js';
import { Router } from 'express';
import { requireActor } from './auth.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => JSON.stringify(key) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

export function mutationRecoveryRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.get('/submissions/:key', requireActor, async(req,res) => {
    const key = z.uuid().parse(req.params.key), actor = res.locals.actor as Actor;
    const result = await withTransaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mutation:'+key]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
      const found = await client.query(`SELECT actor_id::text,access_context,result FROM orderflow.mutation_results WHERE key=$1`,[key]);
      if(found.rowCount) {
        const row=found.rows[0];
        const access=canonical({role:actor.role,warehouses:[...actor.warehouses].sort()});
        if(row.actor_id!==actor.id || row.access_context!==access) throw new AppError(403,'FORBIDDEN','This request is not permitted.');
        return {state:'COMMITTED',result:row.result.void ? null : row.result.value};
      }
      const command=await client.query('SELECT actor_id::text,access_context,response FROM orderflow.api_commands WHERE idempotency_key=$1',[key]);
      if(command.rowCount) {
        const row=command.rows[0];
        const warehouses=[...actor.warehouses].sort((a,b)=>BigInt(a)<BigInt(b)?-1:1);
        if(row.actor_id!==actor.id || row.access_context?.role!==actor.role || JSON.stringify(row.access_context?.warehouses)!==JSON.stringify(warehouses))
          throw new AppError(403,'FORBIDDEN','This request is not permitted.');
        return {state:'COMMITTED',result:row.response};
      }
      return {state:'UNCONFIRMED',result:null};
    });
    res.json(result);
  });
  return router;
}

// Store only a salted fingerprint and result, never submitted credentials or file bytes.
// The mutation and its replay result commit together, including after a lost response.
export async function withMutation<T>(pool: pg.Pool, req: Request, actor: Actor,
  work: (client: pg.PoolClient) => Promise<T>, input: unknown = req.body): Promise<T> {
  const supplied = req.headers['idempotency-key'];
  if (!supplied) return withTransaction(pool, work); // Compatibility with previously deployed clients.
  const key = z.uuid().parse(supplied);
  const operation = req.method + ' ' + req.path;
  const access = canonical({ role: actor.role, warehouses: [...actor.warehouses].sort() });
  const fingerprint = (salt: string) => createHash('sha256').update(salt).update(canonical(input)).digest('hex');
  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['mutation:' + key]);
    const prior = await client.query(`SELECT actor_id::text,operation,access_context,salt,request_hash,result
      FROM orderflow.mutation_results WHERE key=$1`, [key]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      if (row.actor_id !== actor.id || row.operation !== operation || row.request_hash !== fingerprint(row.salt))
        throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This submission belongs to another request.');
      if (row.access_context !== access)
        throw new AppError(403, 'PERMISSION_CHANGED', 'Your access changed. Refresh before continuing.');
      return (row.result.void ? undefined : row.result.value) as T;
    }
    // Client recovery lasts 24 hours. Retain results for 30 days and trim in small
    // indexed batches, using the existing service rather than another paid worker.
    await client.query(`DELETE FROM orderflow.mutation_results WHERE key IN (
      SELECT key FROM orderflow.mutation_results WHERE created_at<now()-interval '30 days'
      ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
    const value = await work(client);
    const salt = randomBytes(32).toString('hex');
    await client.query(`INSERT INTO orderflow.mutation_results
      (key,actor_id,operation,access_context,salt,request_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [key, actor.id, operation, access, salt, fingerprint(salt), JSON.stringify({ void: value === undefined, value: value ?? null })]);
    return value;
  });
}
