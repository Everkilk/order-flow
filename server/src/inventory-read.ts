import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireActor, requireRole, warehouseAllowed, type Actor } from './auth.js';
import { AppError } from './errors.js';

const id = z.string().regex(/^[1-9]\d*$/);
const filters = z.object({ warehouseId:id.optional(),productId:id.optional(),cursor:id.optional(),
  limit:z.coerce.number().int().min(1).max(100).default(50) }).strict();
const stockFilters = filters.extend({
  cursor:z.string().regex(/^[1-9]\d*:[1-9]\d*$/).optional(),
  availability:z.enum(['AVAILABLE','OUT_OF_STOCK']).optional(),
});
const movementFilters = filters.extend({
  sku:z.string().trim().min(1).max(100).optional(),
  eventType:z.enum(['OPENING','RECEIPT','ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL',
    'ORDER_RETURN','TRANSFER_SEND','TRANSFER_RECEIVE','TRANSFER_RESOLUTION','ADJUSTMENT','REVERSAL']).optional(),
  actorId:id.optional(),reference:z.string().trim().min(1).max(160).optional(),
  from:z.iso.datetime({offset:true}).optional(),to:z.iso.datetime({offset:true}).optional(),
});

async function eventIdsForReference(pool:pg.Pool, reference:string):Promise<string[]> {
  const result=await pool.query(`SELECT id::text FROM orderflow.inventory_events
    WHERE order_id=(SELECT id FROM orderflow.orders WHERE order_number=$1)
    UNION ALL
    SELECT id::text FROM orderflow.inventory_events
    WHERE receipt_id=(SELECT id FROM orderflow.receipts WHERE receipt_number=$1)
    UNION ALL
    SELECT id::text FROM orderflow.inventory_events
    WHERE order_return_id=(SELECT id FROM orderflow.order_returns WHERE return_number=$1)
    UNION ALL
    SELECT id::text FROM orderflow.inventory_events
    WHERE transfer_id=(SELECT id FROM orderflow.transfers WHERE transfer_number=$1)
    UNION ALL
    SELECT e.id::text FROM orderflow.inventory_events e
    JOIN orderflow.transfer_receipts tr ON tr.id=e.transfer_receipt_id
    JOIN orderflow.transfers t ON t.id=tr.transfer_id WHERE t.transfer_number=$1
    UNION ALL
    SELECT e.id::text FROM orderflow.inventory_events e
    JOIN orderflow.discrepancy_resolutions r ON r.id=e.resolution_id
    JOIN orderflow.transfer_discrepancies d ON d.id=r.discrepancy_id
    JOIN orderflow.transfer_items ti ON ti.id=d.transfer_item_id
    JOIN orderflow.transfers t ON t.id=ti.transfer_id WHERE t.transfer_number=$1`,[reference]);
  return [...new Set(result.rows.map(row=>String(row.id)))];
}

export function inventoryReadRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.get('/stock',requireActor,async(req,res) => {
    const input=stockFilters.parse(req.query), actor=res.locals.actor as Actor;
    if (input.warehouseId && !warehouseAllowed(actor,input.warehouseId)) throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const availabilityClause=input.availability==='AVAILABLE' ? 'AND b.available>0'
      : input.availability==='OUT_OF_STOCK' ? 'AND b.available=0' : '';
    const result=await pool.query(`SELECT b.warehouse_id::text AS "warehouseId",w.code AS warehouse,b.product_id::text AS "productId",
      p.sku,p.name,b.on_hand::text AS "onHand",b.reserved::text AS reserved,b.available::text AS available,b.version::text AS version
      FROM orderflow.inventory_balances b JOIN orderflow.products p ON p.id=b.product_id
      JOIN orderflow.warehouses w ON w.id=b.warehouse_id
      WHERE ($1::bigint IS NULL OR b.warehouse_id=$1) AND ($2::bigint IS NULL OR b.product_id=$2)
        AND ($3 OR b.warehouse_id=ANY($4::bigint[]))
        AND ($5::bigint IS NULL OR (b.warehouse_id,b.product_id)>($5::bigint,$6::bigint))
        ${availabilityClause}
      ORDER BY b.warehouse_id,b.product_id LIMIT $7`,
      [input.warehouseId ?? null,input.productId ?? null,actor.role==='MANAGER',actor.warehouses,
        input.cursor ? input.cursor.split(':')[0] : null,input.cursor ? input.cursor.split(':')[1] : null,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    const last=rows.at(-1);
    res.json({ items:rows,nextCursor:result.rows.length>input.limit && last ? last.warehouseId+':'+last.productId : null });
  });
  router.get('/movements',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=movementFilters.parse(req.query), actor=res.locals.actor as Actor;
    if (input.warehouseId && !warehouseAllowed(actor,input.warehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    if (input.from && input.to && new Date(input.to)<=new Date(input.from))
      throw new AppError(400,'INVALID_RANGE','The end of the date range must follow the start.');
    const values:unknown[]=[];
    const parameter=(value:unknown) => {values.push(value);return `$${values.length}`;};
    const where:string[]=[];
    if (input.warehouseId) where.push(`l.warehouse_id=${parameter(input.warehouseId)}`);
    else if (actor.role!=='MANAGER') where.push(`l.warehouse_id=ANY(${parameter(actor.warehouses)}::bigint[])`);
    if (input.productId) where.push(`l.product_id=${parameter(input.productId)}`);
    if (input.sku) where.push(`l.product_id=(SELECT id FROM orderflow.products WHERE sku=${parameter(input.sku)})`);
    if (input.cursor) where.push(`l.id<${parameter(input.cursor)}`);
    if (input.from) where.push(`l.created_at>=${parameter(input.from)}::timestamptz`);
    if (input.to) where.push(`l.created_at<${parameter(input.to)}::timestamptz`);
    if (input.eventType) where.push(`e.event_type=${parameter(input.eventType)}`);
    if (input.actorId) where.push(`e.actor_id=${parameter(input.actorId)}`);
    if (input.reference) {
      const eventIds=await eventIdsForReference(pool,input.reference);
      if (!eventIds.length) return res.json({items:[],nextCursor:null});
      where.push(`l.event_id=ANY(${parameter(eventIds)}::bigint[])`);
    }
    const limit=parameter(input.limit+1);
    const result=await pool.query(`WITH page AS MATERIALIZED (
      SELECT l.id,l.event_id,l.product_id,l.warehouse_id,l.on_hand_delta,l.reserved_delta,
        l.on_hand_before,l.on_hand_after,l.reserved_before,l.reserved_after,
        e.event_type,e.actor_id,e.reason,e.occurred_at,e.order_id,e.receipt_id,
        e.order_return_id,e.transfer_id,e.transfer_receipt_id,e.resolution_id,e.decision_id
      FROM orderflow.inventory_ledger l JOIN orderflow.inventory_events e ON e.id=l.event_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY l.id DESC LIMIT ${limit}
    ) SELECT page.id::text,page.event_id::text AS "eventId",
      page.product_id::text AS "productId",page.warehouse_id::text AS "warehouseId",
      page.on_hand_delta::text AS "onHandDelta",page.reserved_delta::text AS "reservedDelta",
      page.on_hand_before::text AS "onHandBefore",page.on_hand_after::text AS "onHandAfter",
      page.reserved_before::text AS "reservedBefore",page.reserved_after::text AS "reservedAfter",
      page.event_type AS "eventType",page.actor_id::text AS "actorId",page.reason,
      page.occurred_at AS "occurredAt",page.order_id::text AS "orderId",
      page.receipt_id::text AS "receiptId",page.order_return_id::text AS "returnId",
      page.transfer_id::text AS "transferId",page.transfer_receipt_id::text AS "transferReceiptId",
      page.resolution_id::text AS "resolutionId",page.decision_id::text AS "decisionId"
      FROM page ORDER BY page.id DESC`,values);
    const rows=result.rows.slice(0,input.limit);
    res.json({ items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null });
  });
  return router;
}
