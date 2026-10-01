import { Router } from 'express';
import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withTransaction } from './db.js';
import { AppError } from './errors.js';
import { postInventoryEvent, runInventoryCommand } from './inventory-write.js';

const id=z.string().regex(/^[1-9]\d*$/);
const quantity=z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const draft=z.object({returnNumber:z.string().trim().min(1).max(80),orderId:id,warehouseId:id,
  reason:z.string().trim().min(1).max(1000)}).strict();
const items=z.object({expectedRevision:z.number().int().min(0),items:z.array(z.object({orderItemId:id,quantity}).strict()).min(1).max(200)}).strict();

export function returnRoutes(pool: pg.Pool): Router {
  const router=Router();
  router.get('/returns',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({status:z.enum(['DRAFT','POSTED']).optional(),cursor:id.optional(),
      limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT r.id::text,r.return_number AS "returnNumber",
      r.order_id::text AS "orderId",r.warehouse_id::text AS "warehouseId",
      r.status,r.reason,r.created_at AS "createdAt"
      FROM orderflow.order_returns r
      WHERE ($1::text IS NULL OR r.status=$1) AND ($2::bigint IS NULL OR r.id<$2)
        AND ($3 OR (r.received_by=$4 AND r.warehouse_id=ANY($5::bigint[])))
      ORDER BY r.id DESC LIMIT $6`,[input.status ?? null,input.cursor ?? null,
      actor.role==='MANAGER',actor.id,actor.warehouses,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null});
  });
  router.post('/returns',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=draft.parse(req.body),actor=res.locals.actor as Actor;
    if (!warehouseAllowed(actor,input.warehouseId)) throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const row=await withTransaction(pool,async c => {
      const order=await c.query('SELECT status,created_by::text,assigned_to::text FROM orderflow.orders WHERE id=$1',[input.orderId]);
      if (!order.rowCount) throw new AppError(404,'NOT_FOUND','Order not found.');
      if (order.rows[0].status!=='FULFILLED') throw new AppError(409,'INVALID_STATUS','Only fulfilled orders can have returns.');
      if (actor.role==='STAFF' && ![order.rows[0].created_by,order.rows[0].assigned_to].includes(actor.id))
        throw new AppError(403,'FORBIDDEN','This order belongs to another staff member.');
      const created=await c.query(`INSERT INTO orderflow.order_returns
        (return_number,order_id,warehouse_id,received_by,reason) VALUES($1,$2,$3,$4,$5)
        RETURNING id::text,return_number AS "returnNumber",order_id::text AS "orderId",status,revision`,
        [input.returnNumber,input.orderId,input.warehouseId,actor.id,input.reason]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'RETURN_CREATE','order_return',$2)`,[actor.id,created.rows[0].id]);
      return created.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/returns/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const returnId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT id::text,return_number AS "returnNumber",order_id::text AS "orderId",
      warehouse_id::text AS "warehouseId",received_by::text AS "receivedBy",status,reason,revision
      FROM orderflow.order_returns WHERE id=$1`,[returnId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Return not found.');
    if (!warehouseAllowed(actor,found.rows[0].warehouseId) ||
        (actor.role==='STAFF' && found.rows[0].receivedBy!==actor.id))
      throw new AppError(403,'FORBIDDEN','This return is not permitted.');
    const lines=await pool.query(`SELECT ri.id::text,ri.order_item_id::text AS "orderItemId",
      oi.product_id::text AS "productId",p.sku,p.name,ri.quantity::text
      FROM orderflow.order_return_items ri JOIN orderflow.order_items oi ON oi.id=ri.order_item_id
      JOIN orderflow.products p ON p.id=oi.product_id
      WHERE ri.return_id=$1 ORDER BY ri.id`,[returnId]);
    res.json({...found.rows[0],items:lines.rows});
  });
  router.put('/returns/:id/items',requireRole('STAFF','MANAGER'),async(req,res) => {
    const returnId=id.parse(req.params.id),input=items.parse(req.body),actor=res.locals.actor as Actor;
    if (new Set(input.items.map(line=>line.orderItemId)).size!==input.items.length)
      throw new AppError(422,'DUPLICATE_ITEM','An order item appears more than once.');
    const revision=await withTransaction(pool,async c => {
      const found=await c.query(`SELECT order_id::text,warehouse_id::text,received_by::text,status,revision
        FROM orderflow.order_returns WHERE id=$1 FOR UPDATE`,[returnId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Return not found.');
      const doc=found.rows[0];
      if (!warehouseAllowed(actor,doc.warehouse_id) || (actor.role==='STAFF' && actor.id!==doc.received_by))
        throw new AppError(403,'FORBIDDEN','This return is not permitted.');
      if (doc.status!=='DRAFT') throw new AppError(409,'INVALID_STATUS','Only draft returns can change.');
      if (Number(doc.revision)!==input.expectedRevision) throw new AppError(409,'STALE_REVISION','Return has changed.');
      await c.query('DELETE FROM orderflow.order_return_items WHERE return_id=$1',[returnId]);
      for (const line of input.items) {
        const original=await c.query(`SELECT id FROM orderflow.order_items WHERE id=$1 AND order_id=$2 AND warehouse_id=$3`,
          [line.orderItemId,doc.order_id,doc.warehouse_id]);
        if (!original.rowCount) throw new AppError(422,'INVALID_ITEM','Return item does not belong to this order and warehouse.');
        await c.query(`INSERT INTO orderflow.order_return_items(return_id,order_id,order_item_id,quantity)
          VALUES($1,$2,$3,$4)`,[returnId,doc.order_id,line.orderItemId,line.quantity]);
      }
      const updated=await c.query('UPDATE orderflow.order_returns SET revision=revision+1 WHERE id=$1 RETURNING revision',[returnId]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'RETURN_ITEMS_SET','order_return',$2)`,[actor.id,returnId]);
      return Number(updated.rows[0].revision);
    });
    res.json({revision});
  });
  router.post('/returns/:id/post',requireRole('STAFF','MANAGER'),async(req,res) => {
    const returnId=id.parse(req.params.id),commandKey=z.uuid().parse(req.headers['idempotency-key']),actor=res.locals.actor as Actor;
    const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'RETURN_POST',targetId:returnId,input:{}},async c => {
      const found=await c.query(`SELECT r.order_id::text,r.warehouse_id::text,r.received_by::text,r.status,r.reason,
        o.status AS order_status FROM orderflow.order_returns r JOIN orderflow.orders o ON o.id=r.order_id
        WHERE r.id=$1 FOR UPDATE OF r,o`,[returnId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Return not found.');
      const doc=found.rows[0];
      if (!warehouseAllowed(actor,doc.warehouse_id) || (actor.role==='STAFF' && actor.id!==doc.received_by))
        throw new AppError(403,'FORBIDDEN','This return is not permitted.');
      if (doc.status!=='DRAFT' || doc.order_status!=='FULFILLED')
        throw new AppError(409,'INVALID_STATUS','Return or order is not ready.');
      const lines=await c.query(`SELECT ri.id::text,ri.order_item_id::text,ri.quantity::text,
        oi.product_id::text,oi.warehouse_id::text,oi.quantity::text AS original_qty
        FROM orderflow.order_return_items ri JOIN orderflow.order_items oi ON oi.id=ri.order_item_id
        WHERE ri.return_id=$1 ORDER BY oi.id FOR UPDATE OF oi`,[returnId]);
      if (!lines.rowCount) throw new AppError(422,'EMPTY_RETURN','Return needs at least one item.');
      for (const line of lines.rows) {
        if (line.warehouse_id!==doc.warehouse_id) throw new AppError(422,'INVALID_ITEM','Return warehouse does not match the order item.');
        const prior=await c.query(`SELECT coalesce(sum(l.on_hand_delta),0)::text AS returned
          FROM orderflow.inventory_ledger l JOIN orderflow.order_return_items ri ON ri.id=l.return_item_id
          WHERE ri.order_item_id=$1`,[line.order_item_id]);
        if (new Decimal(prior.rows[0].returned).plus(line.quantity).gt(line.original_qty))
          throw new AppError(409,'RETURN_EXCEEDS_ORDER','Return exceeds the fulfilled quantity.');
      }
      const eventId=await postInventoryEvent(c,{type:'ORDER_RETURN',actorId:actor.id,key:commandKey,reason:doc.reason,
        source:{returnId},lines:lines.rows.map(line=>({warehouseId:doc.warehouse_id,productId:line.product_id,
          onHandDelta:line.quantity,reservedDelta:'0',returnItemId:line.id}))});
      await c.query("UPDATE orderflow.order_returns SET status='POSTED',revision=revision+1 WHERE id=$1",[returnId]);
      return {status:200,response:{id:returnId,status:'POSTED',eventId}};
    });
    res.status(result.status).json(result.response);
  });
  return router;
}
