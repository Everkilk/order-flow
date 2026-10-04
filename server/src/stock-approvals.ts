import { Router } from 'express';
import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withMutation } from './mutations.js';
import { AppError } from './errors.js';
import { postInventoryEvent, runInventoryCommand } from './inventory-write.js';
import { notifyManagers, notifyUser } from './notifications.js';

const id=z.string().regex(/^[1-9]\d*$/);
const quantity=z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const requestInput=z.discriminatedUnion('requestType',[
  z.object({requestType:z.enum(['DAMAGE','LOSS']),warehouseId:id,productId:id,
    quantity,reason:z.string().trim().min(1).max(1000)}).strict(),
  z.object({requestType:z.literal('COUNT'),warehouseId:id,productId:id,
    countedQty:quantity,reason:z.string().trim().min(1).max(1000)}).strict(),
  z.object({requestType:z.literal('REVERSAL'),originalEventId:id,
    reason:z.string().trim().min(1).max(1000)}).strict(),
]);
const decisionInput=z.object({decision:z.enum(['APPROVED','REJECTED']),reason:z.string().trim().min(1).max(1000),
  reviewedBalanceVersion:id.optional()}).strict();

export function stockApprovalRoutes(pool: pg.Pool): Router {
  const router=Router();
  router.get('/stock-requests',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({pending:z.enum(['true','false']).optional(),cursor:id.optional(),
      limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT r.id::text,r.request_type AS "requestType",r.warehouse_id::text AS "warehouseId",
      r.product_id::text AS "productId",r.requested_by::text AS "requestedBy",r.reason,
      r.created_at AS "createdAt",d.decision,w.code AS warehouse,p.sku,p.name AS "productName"
      FROM orderflow.stock_change_requests r
      LEFT JOIN orderflow.stock_change_decisions d ON d.request_id=r.id
      LEFT JOIN orderflow.warehouses w ON w.id=r.warehouse_id
      LEFT JOIN orderflow.products p ON p.id=r.product_id
      WHERE ($1::bigint IS NULL OR r.id<$1)
      AND ($2::boolean IS NULL OR ($2 AND d.id IS NULL) OR (NOT $2 AND d.id IS NOT NULL))
      AND ($3 OR (r.requested_by=$5 AND
        (r.warehouse_id IS NULL OR r.warehouse_id=ANY($4::bigint[]))))
      ORDER BY r.id DESC LIMIT $6`,[input.cursor ?? null,input.pending==null?null:input.pending==='true',
        actor.role==='MANAGER',actor.warehouses,actor.id,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null});
  });
  router.post('/stock-requests',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=requestInput.parse(req.body),actor=res.locals.actor as Actor;
    const row=await withMutation(pool,req,actor,async c => {
      let warehouseId:string|null=null,productId:string|null=null,delta:string|null=null;
      let counted:string|null=null,observed:string|null=null,version:string|null=null,eventId:string|null=null;
      if (input.requestType==='REVERSAL') {
        eventId=input.originalEventId;
        const original=await c.query(`SELECT e.event_type,l.warehouse_id::text FROM orderflow.inventory_events e
          JOIN orderflow.inventory_ledger l ON l.event_id=e.id WHERE e.id=$1`,[eventId]);
        if (!original.rowCount || !['OPENING','RECEIPT','ADJUSTMENT'].includes(original.rows[0].event_type))
          throw new AppError(422,'INVALID_EVENT','This event cannot be reversed.');
        if (original.rows.some(line=>!warehouseAllowed(actor,line.warehouse_id)))
          throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
      } else {
        warehouseId=input.warehouseId; productId=input.productId;
        if (!warehouseAllowed(actor,warehouseId)) throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
        const balance=await c.query(`SELECT on_hand::text,version::text FROM orderflow.inventory_balances
          WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE`,[warehouseId,productId]);
        if (!balance.rowCount) throw new AppError(404,'NOT_FOUND','Stock balance not found.');
        if (input.requestType==='COUNT') {
          counted=input.countedQty;observed=balance.rows[0].on_hand;version=balance.rows[0].version;
        } else {
          delta='-'+new Decimal(input.quantity).toFixed(6);
          if (new Decimal(input.quantity).isZero()) throw new AppError(422,'INVALID_QUANTITY','Quantity must be positive.');
        }
      }
      const created=await c.query(`INSERT INTO orderflow.stock_change_requests
        (request_type,warehouse_id,product_id,requested_by,requested_delta,counted_qty,
         observed_on_hand,observed_version,original_event_id,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id::text,request_type AS "requestType",created_at AS "createdAt"`,
        [input.requestType,warehouseId,productId,actor.id,delta,counted,observed,version,eventId,input.reason]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'STOCK_REQUEST_CREATE','stock_change_request',$2)`,[actor.id,created.rows[0].id]);
      await notifyManagers(c,{eventClass:'STOCK_APPROVAL',title:'Stock change needs review',
        body:`${input.requestType} request #${created.rows[0].id} is ready for review.`,
        targetPath:`/stock-requests/${created.rows[0].id}`,dedupeKey:`stock-request:${created.rows[0].id}`});
      return created.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/stock-requests/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const requestId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT r.id::text,r.request_type AS "requestType",r.warehouse_id::text AS "warehouseId",
      r.product_id::text AS "productId",r.requested_by::text AS "requestedBy",
      r.requested_delta::text AS "requestedDelta",r.counted_qty::text AS "countedQty",
      r.observed_on_hand::text AS "observedOnHand",r.observed_version::text AS "observedVersion",
      r.original_event_id::text AS "originalEventId",r.reason,
      d.id::text AS "decisionId",d.decision,d.approved_delta::text AS "approvedDelta",
      d.reason AS "decisionReason",d.created_at AS "decidedAt",w.code AS warehouse,
      p.sku,p.name AS "productName"
      FROM orderflow.stock_change_requests r LEFT JOIN orderflow.stock_change_decisions d ON d.request_id=r.id
      LEFT JOIN orderflow.warehouses w ON w.id=r.warehouse_id
      LEFT JOIN orderflow.products p ON p.id=r.product_id
      WHERE r.id=$1`,[requestId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Stock request not found.');
    const row=found.rows[0];
    if (actor.role!=='MANAGER' && (actor.id!==row.requestedBy ||
        (row.warehouseId && !warehouseAllowed(actor,row.warehouseId))))
      throw new AppError(403,'FORBIDDEN','This request is not permitted.');
    res.json(row);
  });
  router.post('/stock-requests/:id/decision',requireRole('MANAGER'),async(req,res) => {
    const requestId=id.parse(req.params.id),commandKey=z.uuid().parse(req.headers['idempotency-key']),
      input=decisionInput.parse(req.body),actor=res.locals.actor as Actor;
    const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'STOCK_DECISION',
      targetId:requestId,input},async c => {
      const found=await c.query(`SELECT id::text,request_type,warehouse_id::text,product_id::text,
        requested_by::text,requested_delta::text,counted_qty::text,
        observed_version::text,original_event_id::text
        FROM orderflow.stock_change_requests WHERE id=$1 FOR UPDATE`,[requestId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Stock request not found.');
      const item=found.rows[0];
      const prior=await c.query('SELECT 1 FROM orderflow.stock_change_decisions WHERE request_id=$1',[requestId]);
      if (prior.rowCount) throw new AppError(409,'ALREADY_DECIDED','Stock request already has a decision.');
      let delta:string|null=null,version:string|null=null;
      if (input.decision==='APPROVED' && item.request_type!=='REVERSAL') {
        if (!input.reviewedBalanceVersion) throw new AppError(400,'VERSION_REQUIRED','Review the current balance version.');
        const balance=await c.query(`SELECT on_hand::text,version::text FROM orderflow.inventory_balances
          WHERE warehouse_id=$1 AND product_id=$2 FOR UPDATE`,[item.warehouse_id,item.product_id]);
        if (!balance.rowCount || balance.rows[0].version!==input.reviewedBalanceVersion ||
          (item.request_type==='COUNT' && item.observed_version!==balance.rows[0].version))
          throw new AppError(409,'STALE_BALANCE','Stock changed; review it again.');
        version=balance.rows[0].version;
        delta=item.request_type==='COUNT'
          ? new Decimal(item.counted_qty).minus(balance.rows[0].on_hand).toFixed(6) : item.requested_delta;
      }
      const decision=await c.query(`INSERT INTO orderflow.stock_change_decisions
        (request_id,manager_id,decision,approved_delta,reviewed_balance_version,reason)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
        [requestId,actor.id,input.decision,delta,version,input.reason]);
      const decisionId=decision.rows[0].id as string;
      let eventId:string|null=null;
      if (input.decision==='APPROVED') {
        if (item.request_type==='REVERSAL') {
          const originals=await c.query(`SELECT warehouse_id::text,product_id::text,
            (-sum(on_hand_delta))::text AS hand,(-sum(reserved_delta))::text AS reserved
            FROM orderflow.inventory_ledger WHERE event_id=$1 GROUP BY warehouse_id,product_id`,[item.original_event_id]);
          eventId=await postInventoryEvent(c,{type:'REVERSAL',actorId:actor.id,key:commandKey,
            reason:input.reason,source:{decisionId,reversalOfEventId:item.original_event_id},
            lines:originals.rows.map(line=>({warehouseId:line.warehouse_id,productId:line.product_id,
              onHandDelta:line.hand,reservedDelta:line.reserved}))});
        } else {
          eventId=await postInventoryEvent(c,{type:'ADJUSTMENT',actorId:actor.id,key:commandKey,
            reason:input.reason,source:{decisionId},lines:new Decimal(delta!).isZero()?[]:[{
              warehouseId:item.warehouse_id,productId:item.product_id,onHandDelta:delta!,reservedDelta:'0'}]});
        }
      } else await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'STOCK_REQUEST_REJECT','stock_change_decision',$2)`,[actor.id,decisionId]);
      await notifyUser(c,item.requested_by,{
        eventClass:'APPROVAL_DECISION',title:`Stock request ${input.decision.toLowerCase()}`,
        body:`Stock request #${requestId} was ${input.decision.toLowerCase()}.`,
        targetPath:`/stock-requests/${requestId}`,dedupeKey:`stock-decision:${decisionId}`,
      });
      return {status:200,response:{id:decisionId,requestId,decision:input.decision,eventId}};
    });
    res.status(result.status).json(result.response);
  });
  return router;
}
