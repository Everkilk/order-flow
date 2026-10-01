import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withTransaction } from './db.js';
import { AppError } from './errors.js';
import { postInventoryEvent, runInventoryCommand } from './inventory-write.js';

const id = z.string().regex(/^[1-9]\d*$/);
const quantity = z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const draft = z.object({ receiptNumber:z.string().trim().min(1).max(80), kind:z.enum(['OPENING','INBOUND']),
  warehouseId:id,supplierId:id.nullable().optional(),note:z.string().max(1000).nullable().optional() }).strict();
const items = z.object({ expectedRevision:z.number().int().min(0), items:z.array(z.object({
  productId:id,quantity,unitCost:z.string().regex(/^\d+(?:\.\d{1,4})?$/).nullable().optional(),
  currency:z.enum(['VND','USD']).nullable().optional() }).strict()).min(1).max(200) }).strict();
const keyHeader = z.uuid();

export function receiptRoutes(pool: pg.Pool): Router {
  const router = Router();
  router.get('/receipts',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({status:z.enum(['DRAFT','POSTED']).optional(),warehouseId:id.optional(),
      cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    if (input.warehouseId && !warehouseAllowed(actor,input.warehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const result=await pool.query(`SELECT r.id::text,r.receipt_number AS "receiptNumber",r.kind,
      r.warehouse_id::text AS "warehouseId",r.status,r.created_at AS "createdAt"
      FROM orderflow.receipts r WHERE ($1::text IS NULL OR r.status=$1)
      AND ($2::bigint IS NULL OR r.warehouse_id=$2) AND ($3::bigint IS NULL OR r.id<$3)
      AND ($4 OR (r.warehouse_id=ANY($5::bigint[]) AND r.created_by=$6))
      ORDER BY r.id DESC LIMIT $7`,
      [input.status ?? null,input.warehouseId ?? null,input.cursor ?? null,
        actor.role==='MANAGER',actor.warehouses,actor.id,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null});
  });
  router.post('/receipts',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=draft.parse(req.body), actor=res.locals.actor as Actor;
    if (!warehouseAllowed(actor,input.warehouseId) || (input.kind==='OPENING' && actor.role!=='MANAGER'))
      throw new AppError(403,'FORBIDDEN','This receipt is not permitted.');
    const row=await withTransaction(pool,async c => {
      const created=await c.query(`INSERT INTO orderflow.receipts(receipt_number,kind,warehouse_id,supplier_id,created_by,note)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text,receipt_number AS "receiptNumber",kind,
        warehouse_id::text AS "warehouseId",status,revision`,
        [input.receiptNumber,input.kind,input.warehouseId,input.supplierId ?? null,actor.id,input.note ?? null]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'RECEIPT_CREATE','receipt',$2)`,[actor.id,created.rows[0].id]);
      return created.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/receipts/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const receiptId=id.parse(req.params.id), actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT id::text,receipt_number AS "receiptNumber",kind,warehouse_id::text AS "warehouseId",
      supplier_id::text AS "supplierId",created_by::text AS "createdBy",status,note,revision,
      created_at AS "createdAt",posted_at AS "postedAt" FROM orderflow.receipts WHERE id=$1`,[receiptId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Receipt not found.');
    const receipt=found.rows[0];
    if (!warehouseAllowed(actor,receipt.warehouseId) ||
        (actor.role==='STAFF' && receipt.createdBy!==actor.id))
      throw new AppError(403,'FORBIDDEN','This receipt is not permitted.');
    const lines=await pool.query(`SELECT i.id::text,i.product_id::text AS "productId",p.sku,p.name,
      u.code AS unit,i.quantity::text,i.unit_cost::text AS "unitCost",i.currency
      FROM orderflow.receipt_items i JOIN orderflow.products p ON p.id=i.product_id
      JOIN orderflow.units u ON u.id=p.unit_id WHERE i.receipt_id=$1 ORDER BY i.id`,[receiptId]);
    res.json({...receipt,items:lines.rows});
  });
  router.put('/receipts/:id/items',requireRole('STAFF','MANAGER'),async(req,res) => {
    const receiptId=id.parse(req.params.id),input=items.parse(req.body),actor=res.locals.actor as Actor;
    if (new Set(input.items.map(line=>line.productId)).size!==input.items.length)
      throw new AppError(422,'DUPLICATE_ITEM','A product appears more than once.');
    for(const line of input.items) if ((line.unitCost==null)!==(line.currency==null))
      throw new AppError(422,'INVALID_COST','Cost and currency must be provided together.');
    const revision=await withTransaction(pool,async c => {
      const found=await c.query(`SELECT warehouse_id::text,kind,status,revision,created_by::text
        FROM orderflow.receipts WHERE id=$1 FOR UPDATE`,[receiptId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Receipt not found.');
      const receipt=found.rows[0];
      if (!warehouseAllowed(actor,receipt.warehouse_id) ||
          (receipt.kind==='OPENING' && actor.role!=='MANAGER') ||
          (actor.role==='STAFF' && receipt.created_by!==actor.id))
        throw new AppError(403,'FORBIDDEN','This receipt is not permitted.');
      if (receipt.status!=='DRAFT') throw new AppError(409,'INVALID_STATUS','Only draft receipts can change.');
      if (Number(receipt.revision)!==input.expectedRevision) throw new AppError(409,'STALE_REVISION','Receipt has changed.');
      await c.query('DELETE FROM orderflow.receipt_items WHERE receipt_id=$1',[receiptId]);
      for (const line of input.items) await c.query(`INSERT INTO orderflow.receipt_items
        (receipt_id,product_id,quantity,unit_cost,currency) VALUES($1,$2,$3,$4,$5)`,
        [receiptId,line.productId,line.quantity,line.unitCost ?? null,line.currency ?? null]);
      const updated=await c.query('UPDATE orderflow.receipts SET revision=revision+1 WHERE id=$1 RETURNING revision',[receiptId]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'RECEIPT_ITEMS_SET','receipt',$2)`,[actor.id,receiptId]);
      return Number(updated.rows[0].revision);
    });
    res.json({revision});
  });
  router.post('/receipts/:id/post',requireRole('STAFF','MANAGER'),async(req,res) => {
    const receiptId=id.parse(req.params.id), key=keyHeader.parse(req.headers['idempotency-key']), actor=res.locals.actor as Actor;
    const result=await runInventoryCommand(pool,{key,actorId:actor.id,action:'RECEIPT_POST',targetId:receiptId,input:{}},async c => {
      const found=await c.query(`SELECT receipt_number,kind,warehouse_id::text,created_by::text,status,note
        FROM orderflow.receipts WHERE id=$1 FOR UPDATE`,[receiptId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Receipt not found.');
      const receipt=found.rows[0];
      if (!warehouseAllowed(actor,receipt.warehouse_id) ||
          (receipt.kind==='OPENING' && actor.role!=='MANAGER') ||
          (actor.role==='STAFF' && receipt.created_by!==actor.id))
        throw new AppError(403,'FORBIDDEN','This receipt is not permitted.');
      if (receipt.status!=='DRAFT') throw new AppError(409,'INVALID_STATUS','Receipt is already posted.');
      const lines=await c.query(`SELECT i.id::text,i.product_id::text,i.quantity::text,p.active AS product_active,
        w.active AS warehouse_active FROM orderflow.receipt_items i
        JOIN orderflow.products p ON p.id=i.product_id JOIN orderflow.warehouses w ON w.id=$2
        WHERE i.receipt_id=$1 ORDER BY i.product_id`,[receiptId,receipt.warehouse_id]);
      if (!lines.rowCount) throw new AppError(422,'EMPTY_RECEIPT','Receipt needs at least one item.');
      if (lines.rows.some(line=>!line.product_active || !line.warehouse_active))
        throw new AppError(422,'INACTIVE_REFERENCE','Receipt contains an inactive product or warehouse.');
      const eventId=await postInventoryEvent(c,{type:receipt.kind==='OPENING'?'OPENING':'RECEIPT',actorId:actor.id,
        key,reason:receipt.note?.trim() || `Post receipt ${receipt.receipt_number}`,source:{receiptId},
        lines:lines.rows.map(line=>({warehouseId:receipt.warehouse_id,productId:line.product_id,
          onHandDelta:line.quantity,reservedDelta:'0',receiptItemId:line.id}))});
      await c.query(`UPDATE orderflow.receipts SET status='POSTED',posted_at=clock_timestamp(),revision=revision+1 WHERE id=$1`,[receiptId]);
      return {status:200,response:{id:receiptId,status:'POSTED',eventId}};
    });
    res.status(result.status).json(result.response);
  });
  return router;
}
