import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireActor, sessionHashFromCookie, type Actor } from './auth.js';
import { logger } from './errors.js';

const id=z.string().regex(/^[1-9]\d*$/);
const filters=z.object({cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const streamCursor=z.string().regex(/^(0|[1-9]\d*)$/);

export async function notifyManagers(client: pg.PoolClient, data: {
  eventClass:string;title:string;body:string;targetPath:string;dedupeKey:string;
}) {
  await client.query(`INSERT INTO orderflow.notifications
    (user_id,event_class,title,body,target_path,dedupe_key)
    SELECT id,$1,$2,$3,$4,$5 FROM orderflow.users WHERE role='MANAGER' AND active
    ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    [data.eventClass,data.title,data.body,data.targetPath,data.dedupeKey]);
}

export async function notifyUser(client:pg.PoolClient,userId:string,data:{
  eventClass:string;title:string;body:string;targetPath:string;dedupeKey:string;
}) {
  await client.query(`INSERT INTO orderflow.notifications
    (user_id,event_class,title,body,target_path,dedupe_key)
    SELECT id,$2,$3,$4,$5,$6 FROM orderflow.users WHERE id=$1 AND active
    ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    [userId,data.eventClass,data.title,data.body,data.targetPath,data.dedupeKey]);
}

export async function notifyWarehouseStaff(client:pg.PoolClient,warehouseId:string,data:{
  eventClass:string;title:string;body:string;targetPath:string;dedupeKey:string;
}) {
  await client.query(`INSERT INTO orderflow.notifications
    (user_id,event_class,title,body,target_path,dedupe_key)
    SELECT u.id,$2,$3,$4,$5,$6 FROM orderflow.users u
    JOIN orderflow.user_warehouses uw ON uw.user_id=u.id
    WHERE uw.warehouse_id=$1 AND u.active AND u.role='STAFF'
    ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
    [warehouseId,data.eventClass,data.title,data.body,data.targetPath,data.dedupeKey]);
}

export function notificationRoutes(pool: pg.Pool, shutdownSignal?: AbortSignal): Router {
  const router=Router();
  router.get('/notifications/stream',requireActor,async(req,res) => {
    const actor=res.locals.actor as Actor;
    const tokenHash=sessionHashFromCookie(req.headers.cookie);
    if (!tokenHash) return res.status(401).end();
    const supplied=req.query.since ?? req.headers['last-event-id'];
    const since=supplied===undefined
      ? (await pool.query('SELECT id::text FROM orderflow.notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 1',[actor.id])).rows[0]?.id ?? '0'
      : streamCursor.parse(supplied);
    let last=since,closed=false,busy=false;
    res.status(200);
    res.setHeader('Content-Type','text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control','no-cache, no-transform');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    res.flushHeaders();
    res.write('retry: 3000\n: connected\n\n');
    const closeForShutdown=()=>{closed=true;res.end();};
    if (shutdownSignal?.aborted) {closeForShutdown();return;}
    shutdownSignal?.addEventListener('abort',closeForShutdown,{once:true});
    const poll=async () => {
      if (closed || busy) return;
      busy=true;
      try {
        const result=await pool.query(`SELECT EXISTS(
          SELECT 1 FROM orderflow.sessions s JOIN orderflow.users u ON u.id=s.user_id
          WHERE s.token_hash=$1 AND s.user_id=$2 AND s.revoked_at IS NULL
            AND s.expires_at>now() AND u.active
        ) AS valid, (
          SELECT id::text FROM orderflow.notifications WHERE user_id=$2 AND id>$3
          ORDER BY id DESC LIMIT 1
        ) AS latest`,[tokenHash,actor.id,last]);
        if (closed) return;
        if (!result.rows[0].valid) {res.end();return;}
        const latest=result.rows[0].latest as string|null;
        if (latest) {
          last=latest;
          res.write(`id: ${latest}\nevent: notification\ndata: ${JSON.stringify({latestId:latest})}\n\n`);
        }
      } catch(error) {
        logger.error({err:error,requestId:res.locals.requestId},'notification stream failed');
        res.end();
      } finally {busy=false;}
    };
    const pollTimer=setInterval(()=>{void poll();},3000);
    const heartbeatTimer=setInterval(()=>{if(!closed) res.write(': heartbeat\n\n');},15000);
    res.on('close',()=>{
      closed=true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      shutdownSignal?.removeEventListener('abort',closeForShutdown);
    });
  });
  router.get('/notifications',requireActor,async(req,res) => {
    const input=filters.parse(req.query),actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT id::text,event_id::text AS "eventId",event_class AS "eventClass",
      title,body,target_path AS "targetPath",created_at AS "createdAt",read_at AS "readAt"
      FROM orderflow.notifications WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2)
      ORDER BY id DESC LIMIT $3`,[actor.id,input.cursor ?? null,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null});
  });
  router.get('/notifications/unread-count',requireActor,async(_req,res) => {
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT count(*)::integer AS count FROM orderflow.notifications
      WHERE user_id=$1 AND read_at IS NULL`,[actor.id]);
    res.json({count:result.rows[0].count});
  });
  router.post('/notifications/:id/read',requireActor,async(req,res) => {
    const notificationId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    await pool.query(`UPDATE orderflow.notifications SET read_at=coalesce(read_at,clock_timestamp())
      WHERE id=$1 AND user_id=$2`,[notificationId,actor.id]);
    res.status(204).end();
  });
  return router;
}
