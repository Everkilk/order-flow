import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withMutation } from './mutations.js';
import { AppError } from './errors.js';
import { postInventoryEvent, runInventoryCommand, type Movement } from './inventory-write.js';
import { notifyUser } from './notifications.js';

const id=z.string().regex(/^[1-9]\d*$/);
const quantity=z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const draft=z.object({orderNumber:z.string().trim().min(1).max(80),note:z.string().max(1000).nullable().optional(),
  assignedTo:id.nullable().optional()}).strict();
const items=z.object({expectedRevision:z.number().int().min(0),items:z.array(z.object({
  productId:id,warehouseId:id,quantity,unitPrice:z.string().regex(/^\d+(?:\.\d{1,4})?$/).nullable().optional(),
  currency:z.enum(['VND','USD']).nullable().optional()}).strict()).min(1).max(200)}).strict();
const key=z.uuid();

function checkOwner(actor: Actor, order: {created_by:string;assigned_to:string|null}) {
  if (actor.role!=='MANAGER' && actor.id!==order.created_by && actor.id!==order.assigned_to)
    throw new AppError(403,'FORBIDDEN','This order belongs to another staff member.');
}

export function orderRoutes(pool: pg.Pool): Router {
  const router=Router();
  router.get('/orders',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({status:z.enum(['DRAFT','CONFIRMED','FULFILLED','CANCELLED']).optional(),
      q:z.string().trim().max(120).optional(),id:id.optional(),
      cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT o.id::text,o.order_number AS "orderNumber",o.status,
      o.created_by::text AS "createdBy",o.assigned_to::text AS "assignedTo",o.created_at AS "createdAt"
      FROM orderflow.orders o WHERE ($1::text IS NULL OR o.status=$1)
      AND ($2::bigint IS NULL OR o.id<$2)
      AND ($7::text IS NULL OR position(lower($7) in lower(o.order_number))>0 OR o.id::text=$7)
      AND ($8::bigint IS NULL OR o.id=$8)
      AND ($3::text IN ('MANAGER','VIEWER') OR (o.created_by=$4 OR o.assigned_to=$4))
      AND ($3::text='MANAGER' OR (
        ($3::text='STAFF' AND NOT EXISTS(SELECT 1 FROM orderflow.order_items oi
          WHERE oi.order_id=o.id AND oi.warehouse_id<>ALL($5::bigint[])))
        OR ($3::text='VIEWER' AND EXISTS(SELECT 1 FROM orderflow.order_items oi
          WHERE oi.order_id=o.id AND oi.warehouse_id=ANY($5::bigint[]))
          AND NOT EXISTS(SELECT 1 FROM orderflow.order_items oi
          WHERE oi.order_id=o.id AND oi.warehouse_id<>ALL($5::bigint[])))))
      ORDER BY o.id DESC LIMIT $6`,[input.status ?? null,input.cursor ?? null,actor.role,actor.id,actor.warehouses,input.limit+1,input.q ?? null,input.id ?? null]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null});
  });
  router.post('/orders',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=draft.parse(req.body),actor=res.locals.actor as Actor;
    if (input.assignedTo && actor.role!=='MANAGER') throw new AppError(403,'FORBIDDEN','Only managers assign orders.');
    const row=await withMutation(pool,req,actor,async c => {
      if (input.assignedTo) {
        const user=await c.query('SELECT active,role FROM orderflow.users WHERE id=$1',[input.assignedTo]);
        if (!user.rowCount || !user.rows[0].active || user.rows[0].role!=='STAFF')
          throw new AppError(422,'INVALID_ASSIGNEE','Assign an active staff member.');
      }
      const created=await c.query(`INSERT INTO orderflow.orders(order_number,created_by,assigned_to,note)
        VALUES($1,$2,$3,$4) RETURNING id::text,order_number AS "orderNumber",status,revision`,
        [input.orderNumber,actor.id,input.assignedTo ?? null,input.note ?? null]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'ORDER_CREATE','order',$2)`,[actor.id,created.rows[0].id]);
      if(input.assignedTo) await notifyUser(c,input.assignedTo,{
        eventClass:'ORDER_ASSIGNED',title:'Order assigned',
        body:`Order ${input.orderNumber} is assigned to you.`,
        targetPath:`/orders/${created.rows[0].id}`,
        dedupeKey:`order-assigned:${created.rows[0].id}`,
      });
      return created.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/orders/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const orderId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT id::text,order_number AS "orderNumber",created_by::text,
      assigned_to::text,status,note,revision,created_at AS "createdAt",confirmed_at AS "confirmedAt",
      fulfilled_at AS "fulfilledAt",cancelled_at AS "cancelledAt" FROM orderflow.orders WHERE id=$1`,[orderId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Order not found.');
    const order=found.rows[0];
    if (actor.role==='STAFF') checkOwner(actor,order);
    const lines=await pool.query(`SELECT i.id::text,i.product_id::text AS "productId",p.sku,p.name,
      i.warehouse_id::text AS "warehouseId",w.code AS warehouse,i.quantity::text,
      i.unit_price::text AS "unitPrice",i.currency,returned.qty::text AS "returnedQty",
      (i.quantity-returned.qty)::text AS "returnableQty"
      FROM orderflow.order_items i JOIN orderflow.products p ON p.id=i.product_id
      JOIN orderflow.warehouses w ON w.id=i.warehouse_id
      CROSS JOIN LATERAL (SELECT coalesce(sum(ri.quantity),0) AS qty
        FROM orderflow.order_return_items ri JOIN orderflow.order_returns r ON r.id=ri.return_id
        WHERE ri.order_item_id=i.id AND r.status='POSTED') returned
      WHERE i.order_id=$1 ORDER BY i.id`,[orderId]);
    if (lines.rows.some(line=>!warehouseAllowed(actor,line.warehouseId)))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    res.json({id:order.id,orderNumber:order.orderNumber,createdBy:order.created_by,assignedTo:order.assigned_to,
      status:order.status,note:order.note,revision:order.revision,createdAt:order.createdAt,
      confirmedAt:order.confirmedAt,fulfilledAt:order.fulfilledAt,cancelledAt:order.cancelledAt,items:lines.rows});
  });
  router.put('/orders/:id/items',requireRole('STAFF','MANAGER'),async(req,res) => {
    const orderId=id.parse(req.params.id),input=items.parse(req.body),actor=res.locals.actor as Actor;
    if (new Set(input.items.map(line=>line.warehouseId+':'+line.productId)).size!==input.items.length)
      throw new AppError(422,'DUPLICATE_ITEM','A warehouse and product pair appears more than once.');
    for (const line of input.items) {
      if (!warehouseAllowed(actor,line.warehouseId)) throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
      if ((line.unitPrice==null)!==(line.currency==null))
        throw new AppError(422,'INVALID_PRICE','Price and currency must be provided together.');
    }
    const revision=await withMutation(pool,req,actor,async c => {
      const found=await c.query('SELECT status,revision,created_by::text,assigned_to::text FROM orderflow.orders WHERE id=$1 FOR UPDATE',[orderId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Order not found.');
      checkOwner(actor,found.rows[0]);
      if (found.rows[0].status!=='DRAFT') throw new AppError(409,'INVALID_STATUS','Only draft orders can change.');
      if (Number(found.rows[0].revision)!==input.expectedRevision) throw new AppError(409,'STALE_REVISION','Order has changed.');
      await c.query('DELETE FROM orderflow.order_items WHERE order_id=$1',[orderId]);
      for (const line of input.items) await c.query(`INSERT INTO orderflow.order_items
        (order_id,product_id,warehouse_id,quantity,unit_price,currency) VALUES($1,$2,$3,$4,$5,$6)`,
        [orderId,line.productId,line.warehouseId,line.quantity,line.unitPrice ?? null,line.currency ?? null]);
      const changed=await c.query('UPDATE orderflow.orders SET revision=revision+1 WHERE id=$1 RETURNING revision',[orderId]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'ORDER_ITEMS_SET','order',$2)`,[actor.id,orderId]);
      return Number(changed.rows[0].revision);
    });
    res.json({revision});
  });
  for (const action of ['confirm','fulfill','cancel'] as const) router.post(`/orders/:id/${action}`,
    requireRole('STAFF','MANAGER'),async(req,res) => {
      const orderId=id.parse(req.params.id),commandKey=key.parse(req.headers['idempotency-key']),actor=res.locals.actor as Actor;
      const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'ORDER_'+action.toUpperCase(),
        targetId:orderId,input:{}},async c => {
        const found=await c.query(`SELECT order_number,status,note,created_by::text,assigned_to::text
          FROM orderflow.orders WHERE id=$1 FOR UPDATE`,[orderId]);
        if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Order not found.');
        const order=found.rows[0]; checkOwner(actor,order);
        const expected=action==='confirm'?'DRAFT':action==='cancel' && order.status==='DRAFT'?'DRAFT':'CONFIRMED';
        if (order.status!==expected) throw new AppError(409,'INVALID_STATUS',`Order must be ${expected.toLowerCase()}.`);
        const lines=await c.query(`SELECT i.id::text,i.product_id::text,i.warehouse_id::text,i.quantity::text,
          p.active AS product_active,w.active AS warehouse_active FROM orderflow.order_items i
          JOIN orderflow.products p ON p.id=i.product_id JOIN orderflow.warehouses w ON w.id=i.warehouse_id
          WHERE i.order_id=$1 ORDER BY i.warehouse_id,i.product_id`,[orderId]);
        if (action==='confirm' && !lines.rowCount) throw new AppError(422,'EMPTY_ORDER','Order needs at least one item.');
        if (lines.rows.some(line=>!warehouseAllowed(actor,line.warehouse_id)))
          throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
        if (action==='confirm' && lines.rows.some(line=>!line.product_active || !line.warehouse_active))
          throw new AppError(422,'INACTIVE_REFERENCE','Order contains an inactive product or warehouse.');
        let eventId:string|null=null;
        if (!(action==='cancel' && order.status==='DRAFT')) {
          const type=action==='confirm'?'ORDER_CONFIRM':action==='fulfill'?'ORDER_FULFILL':'ORDER_CANCEL';
          const movements:Movement[]=lines.rows.map(line=>({warehouseId:line.warehouse_id,productId:line.product_id,
            onHandDelta:action==='fulfill'?'-'+line.quantity:'0',
            reservedDelta:action==='confirm'?line.quantity:'-'+line.quantity,orderItemId:line.id}));
          eventId=await postInventoryEvent(c,{type,actorId:actor.id,key:commandKey,reason:`${type} ${order.order_number}`,
            source:{orderId},lines:movements});
        }
        const status=action==='confirm'?'CONFIRMED':action==='fulfill'?'FULFILLED':'CANCELLED';
        const timestamp=action==='confirm'?'confirmed_at':action==='fulfill'?'fulfilled_at':'cancelled_at';
        await c.query(`UPDATE orderflow.orders SET status=$2,${timestamp}=clock_timestamp()${expected==='DRAFT'?',revision=revision+1':''} WHERE id=$1`,[orderId,status]);
        if (!eventId) await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
          VALUES($1,'ORDER_CANCEL_DRAFT','order',$2)`,[actor.id,orderId]);
        if(order.assigned_to && (action==='confirm' || action==='cancel'))
          await notifyUser(c,order.assigned_to,{
            eventClass:action==='confirm'?'ORDER_READY':'ORDER_CANCELLED',
            title:action==='confirm'?'Order ready for fulfillment':'Order cancelled',
            body:`Order ${order.order_number} is ${status.toLowerCase()}.`,
            targetPath:`/orders/${orderId}`,
            dedupeKey:`order-${action}:${orderId}`,
          });
        return {status:200,response:{id:orderId,status,eventId}};
      });
      res.status(result.status).json(result.response);
    });
  return router;
}
