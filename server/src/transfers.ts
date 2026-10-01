import { Router } from 'express';
import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withTransaction } from './db.js';
import { AppError } from './errors.js';
import { postInventoryEvent, runInventoryCommand } from './inventory-write.js';
import { notifyManagers, notifyUser, notifyWarehouseStaff } from './notifications.js';

const id=z.string().regex(/^[1-9]\d*$/);
const quantity=z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const draft=z.object({transferNumber:z.string().trim().min(1).max(80),sourceWarehouseId:id,
  destinationWarehouseId:id,note:z.string().max(1000).nullable().optional()}).strict();
const items=z.object({expectedRevision:z.number().int().min(0),items:z.array(z.object({
  productId:id,requestedQty:quantity}).strict()).min(1).max(200)}).strict();
const received=z.object({documentRef:z.string().max(100).nullable().optional(),
  note:z.string().max(1000).nullable().optional(),items:z.array(z.object({transferItemId:id,
    acceptedQty:quantity,quarantinedQty:quantity,excessReason:z.string().trim().min(1).max(1000).optional(),
  }).strict()).min(1).max(200)}).strict();

export function transferRoutes(pool: pg.Pool): Router {
  const router=Router();
  router.get('/transfers',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({status:z.enum(['DRAFT','SENT','PARTIALLY_RECEIVED','DISPUTED','RECEIVED','RESOLVED','CANCELLED']).optional(),
      cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT t.id::text,t.transfer_number AS "transferNumber",
      t.source_warehouse_id::text AS "sourceWarehouseId",
      t.destination_warehouse_id::text AS "destinationWarehouseId",t.status,t.created_at AS "createdAt"
      FROM orderflow.transfers t WHERE ($1::text IS NULL OR t.status=$1)
      AND ($2::bigint IS NULL OR t.id<$2)
      AND ($3 OR t.source_warehouse_id=ANY($4::bigint[]) OR t.destination_warehouse_id=ANY($4::bigint[]))
      ORDER BY t.id DESC LIMIT $5`,
      [input.status ?? null,input.cursor ?? null,actor.role==='MANAGER',actor.warehouses,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit ? rows.at(-1)?.id ?? null : null});
  });
  router.post('/transfers',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=draft.parse(req.body),actor=res.locals.actor as Actor;
    if (input.sourceWarehouseId===input.destinationWarehouseId)
      throw new AppError(422,'INVALID_WAREHOUSE','Source and destination must differ.');
    if (!warehouseAllowed(actor,input.sourceWarehouseId)) throw new AppError(403,'FORBIDDEN','Source warehouse access is required.');
    const row=await withTransaction(pool,async c => {
      const warehouses=await c.query(`SELECT id::text,active FROM orderflow.warehouses WHERE id=ANY($1::bigint[])`,
        [[input.sourceWarehouseId,input.destinationWarehouseId]]);
      if (warehouses.rowCount!==2 || warehouses.rows.some(w=>!w.active))
        throw new AppError(422,'INVALID_WAREHOUSE','Both warehouses must be active.');
      const created=await c.query(`INSERT INTO orderflow.transfers
        (transfer_number,source_warehouse_id,destination_warehouse_id,created_by,note)
        VALUES($1,$2,$3,$4,$5) RETURNING id::text,transfer_number AS "transferNumber",status,revision`,
        [input.transferNumber,input.sourceWarehouseId,input.destinationWarehouseId,actor.id,input.note ?? null]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'TRANSFER_CREATE','transfer',$2)`,[actor.id,created.rows[0].id]);
      return created.rows[0];
    });
    res.status(201).json(row);
  });
  router.get('/transfers/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const transferId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT id::text,transfer_number AS "transferNumber",source_warehouse_id::text AS "sourceWarehouseId",
      destination_warehouse_id::text AS "destinationWarehouseId",created_by::text AS "createdBy",
      status,note,revision,created_at AS "createdAt",sent_at AS "sentAt"
      FROM orderflow.transfers WHERE id=$1`,[transferId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Transfer not found.');
    const transfer=found.rows[0];
    if (!warehouseAllowed(actor,transfer.sourceWarehouseId) && !warehouseAllowed(actor,transfer.destinationWarehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const lines=await pool.query(`SELECT i.id::text,i.product_id::text AS "productId",p.sku,p.name,
      i.requested_qty::text AS "requestedQty",
      i.sent_qty::text AS "sentQty",b.received_qty::text AS "receivedQty",b.in_transit_qty::text AS "inTransitQty",
      b.quarantined_qty::text AS "quarantinedQty" FROM orderflow.transfer_items i
      JOIN orderflow.transfer_item_balances b ON b.transfer_item_id=i.id
      JOIN orderflow.products p ON p.id=i.product_id WHERE i.transfer_id=$1 ORDER BY i.id`,[transferId]);
    res.json({...transfer,items:lines.rows});
  });
  router.put('/transfers/:id/items',requireRole('STAFF','MANAGER'),async(req,res) => {
    const transferId=id.parse(req.params.id),input=items.parse(req.body),actor=res.locals.actor as Actor;
    if (new Set(input.items.map(line=>line.productId)).size!==input.items.length)
      throw new AppError(422,'DUPLICATE_ITEM','A product appears more than once.');
    const revision=await withTransaction(pool,async c => {
      const found=await c.query(`SELECT source_warehouse_id::text,created_by::text,status,revision
        FROM orderflow.transfers WHERE id=$1 FOR UPDATE`,[transferId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Transfer not found.');
      const doc=found.rows[0];
      if (!warehouseAllowed(actor,doc.source_warehouse_id) || (actor.role==='STAFF' && doc.created_by!==actor.id))
        throw new AppError(403,'FORBIDDEN','This transfer is not permitted.');
      if (doc.status!=='DRAFT') throw new AppError(409,'INVALID_STATUS','Only draft transfers can change.');
      if (Number(doc.revision)!==input.expectedRevision) throw new AppError(409,'STALE_REVISION','Transfer has changed.');
      await c.query('DELETE FROM orderflow.transfer_items WHERE transfer_id=$1',[transferId]);
      for (const line of input.items) await c.query(`INSERT INTO orderflow.transfer_items
        (transfer_id,product_id,requested_qty) VALUES($1,$2,$3)`,[transferId,line.productId,line.requestedQty]);
      const changed=await c.query('UPDATE orderflow.transfers SET revision=revision+1 WHERE id=$1 RETURNING revision',[transferId]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'TRANSFER_ITEMS_SET','transfer',$2)`,[actor.id,transferId]);
      return Number(changed.rows[0].revision);
    });
    res.json({revision});
  });
  router.post('/transfers/:id/send',requireRole('STAFF','MANAGER'),async(req,res) => {
    const transferId=id.parse(req.params.id),commandKey=z.uuid().parse(req.headers['idempotency-key']),actor=res.locals.actor as Actor;
    const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'TRANSFER_SEND',targetId:transferId,input:{}},async c => {
      const found=await c.query(`SELECT transfer_number,source_warehouse_id::text,
        destination_warehouse_id::text,created_by::text,status
        FROM orderflow.transfers WHERE id=$1 FOR UPDATE`,[transferId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Transfer not found.');
      const doc=found.rows[0];
      if (!warehouseAllowed(actor,doc.source_warehouse_id) || (actor.role==='STAFF' && doc.created_by!==actor.id))
        throw new AppError(403,'FORBIDDEN','This transfer is not permitted.');
      if (doc.status!=='DRAFT') throw new AppError(409,'INVALID_STATUS','Transfer must be a draft.');
      const lines=await c.query(`SELECT i.id::text,i.product_id::text,i.requested_qty::text,p.active
        FROM orderflow.transfer_items i JOIN orderflow.products p ON p.id=i.product_id
        WHERE i.transfer_id=$1 ORDER BY i.product_id`,[transferId]);
      if (!lines.rowCount) throw new AppError(422,'EMPTY_TRANSFER','Transfer needs at least one item.');
      if (lines.rows.some(line=>!line.active)) throw new AppError(422,'INACTIVE_PRODUCT','Transfer contains an inactive product.');
      await c.query('UPDATE orderflow.transfer_items SET sent_qty=requested_qty WHERE transfer_id=$1',[transferId]);
      const eventId=await postInventoryEvent(c,{type:'TRANSFER_SEND',actorId:actor.id,key:commandKey,
        reason:`Send transfer ${doc.transfer_number}`,source:{transferId},lines:lines.rows.map(line=>({
          warehouseId:doc.source_warehouse_id,productId:line.product_id,onHandDelta:'-'+line.requested_qty,
          reservedDelta:'0',transferItemId:line.id}))});
      await c.query("UPDATE orderflow.transfers SET status='SENT',sent_at=clock_timestamp(),revision=revision+1 WHERE id=$1",[transferId]);
      await notifyWarehouseStaff(c,doc.destination_warehouse_id,{
        eventClass:'TRANSFER_RECEIVE',title:'Transfer awaiting receipt',
        body:`Transfer ${doc.transfer_number} is ready to receive.`,
        targetPath:`/transfers/${transferId}`,dedupeKey:`transfer-receive:${transferId}`,
      });
      return {status:200,response:{id:transferId,status:'SENT',eventId}};
    });
    res.status(result.status).json(result.response);
  });
  router.post('/transfers/:id/receive',requireRole('STAFF','MANAGER'),async(req,res) => {
    const transferId=id.parse(req.params.id),commandKey=z.uuid().parse(req.headers['idempotency-key']),
      input=received.parse(req.body),actor=res.locals.actor as Actor;
    if (new Set(input.items.map(line=>line.transferItemId)).size!==input.items.length)
      throw new AppError(422,'DUPLICATE_ITEM','A transfer item appears more than once.');
    const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'TRANSFER_RECEIVE',
      targetId:transferId,input},async c => {
      const found=await c.query(`SELECT destination_warehouse_id::text,created_by::text,status FROM orderflow.transfers
        WHERE id=$1 FOR UPDATE`,[transferId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Transfer not found.');
      const doc=found.rows[0];
      if (!warehouseAllowed(actor,doc.destination_warehouse_id)) throw new AppError(403,'FORBIDDEN','Destination warehouse access is required.');
      if (!['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(doc.status))
        throw new AppError(409,'INVALID_STATUS','Transfer is not open for receiving.');
      const receipt=await c.query(`INSERT INTO orderflow.transfer_receipts
        (transfer_id,received_by,idempotency_key,document_ref,note) VALUES($1,$2,$3,$4,$5)
        RETURNING id::text`,[transferId,actor.id,commandKey,input.documentRef ?? null,input.note ?? null]);
      const receiptId=receipt.rows[0].id as string;
      const movements=[];
      for (const line of input.items) {
        const item=await c.query(`SELECT i.product_id::text,b.in_transit_qty::text FROM orderflow.transfer_items i
          JOIN orderflow.transfer_item_balances b ON b.transfer_item_id=i.id
          WHERE i.id=$1 AND i.transfer_id=$2 FOR UPDATE OF i`,[line.transferItemId,transferId]);
        if (!item.rowCount) throw new AppError(422,'INVALID_ITEM','Item does not belong to this transfer.');
        const accepted=new Decimal(line.acceptedQty),quarantined=new Decimal(line.quarantinedQty);
        if (accepted.isZero() && quarantined.isZero()) throw new AppError(422,'EMPTY_ITEM','Receipt item needs an accepted or excess quantity.');
        if (accepted.gt(item.rows[0].in_transit_qty)) throw new AppError(409,'EXCEEDS_TRANSIT','Accepted quantity exceeds in-transit stock.');
        if (quarantined.gt(0) && !line.excessReason)
          throw new AppError(422,'EXCESS_REASON_REQUIRED','Explain why the excess was quarantined.');
        const inserted=await c.query(`INSERT INTO orderflow.transfer_receipt_items
          (receipt_id,transfer_id,transfer_item_id,counted_qty,accepted_qty,quarantined_qty)
          VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
          [receiptId,transferId,line.transferItemId,accepted.plus(quarantined).toFixed(6),line.acceptedQty,line.quarantinedQty]);
        if (accepted.gt(0)) movements.push({warehouseId:doc.destination_warehouse_id,
          productId:item.rows[0].product_id,onHandDelta:line.acceptedQty,reservedDelta:'0',
          transferReceiptItemId:inserted.rows[0].id as string});
        if (quarantined.gt(0)) {
          const discrepancy=await c.query(`INSERT INTO orderflow.transfer_discrepancies
          (transfer_item_id,receipt_item_id,kind,reported_qty,reported_by,reason)
          VALUES($1,$2,'EXCESS',$3,$4,$5) RETURNING id::text`,
          [line.transferItemId,inserted.rows[0].id,line.quarantinedQty,actor.id,line.excessReason]);
          await notifyManagers(c,{eventClass:'TRANSFER_DISCREPANCY',title:'Transfer excess needs review',
            body:`Transfer #${transferId} has quarantined excess stock.`,targetPath:`/transfers/${transferId}`,
            dedupeKey:`transfer-discrepancy:${discrepancy.rows[0].id}`});
        }
      }
      const eventId=await postInventoryEvent(c,{type:'TRANSFER_RECEIVE',actorId:actor.id,key:commandKey,
        reason:input.note?.trim() || `Receive transfer ${transferId}`,source:{transferReceiptId:receiptId},lines:movements});
      const balances=await c.query(`SELECT coalesce(bool_or(in_transit_qty<>0),false) AS transit,
        coalesce(bool_or(quarantined_qty<>0),false) AS quarantine FROM orderflow.transfer_item_balances WHERE transfer_id=$1`,[transferId]);
      const open=await c.query(`SELECT 1 FROM orderflow.discrepancy_status d JOIN orderflow.transfer_items i
        ON i.id=d.transfer_item_id WHERE i.transfer_id=$1 AND d.outstanding_qty>0 LIMIT 1`,[transferId]);
      const status=open.rowCount || balances.rows[0].quarantine ? 'DISPUTED' : balances.rows[0].transit ? 'PARTIALLY_RECEIVED' : 'RECEIVED';
      await c.query('UPDATE orderflow.transfers SET status=$2 WHERE id=$1',[transferId,status]);
      await notifyUser(c,doc.created_by,{
        eventClass:'TRANSFER_PROGRESS',title:'Transfer received',
        body:`Transfer #${transferId} is now ${status.toLowerCase()}.`,
        targetPath:`/transfers/${transferId}`,dedupeKey:`transfer-progress:${receiptId}`,
      });
      return {status:200,response:{id:receiptId,transferId,status,eventId}};
    });
    res.status(result.status).json(result.response);
  });
  return router;
}
