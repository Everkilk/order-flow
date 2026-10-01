import { Router } from 'express';
import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { AppError } from './errors.js';
import { postInventoryEvent, runInventoryCommand } from './inventory-write.js';
import { notifyManagers } from './notifications.js';

const id=z.string().regex(/^[1-9]\d*$/);
const quantity=z.string().regex(/^\d+(?:\.\d{1,6})?$/);
const shortage=z.object({transferItemId:id,quantity,reason:z.string().trim().min(1).max(1000)}).strict();
const resolution=z.object({resolutionType:z.enum(['LOSS','DISPATCH_CORRECTION','LATER_RECEIPT','ACCEPT_EXCESS','RETURN_EXCESS']),
  quantity,reason:z.string().trim().min(1).max(1000),laterReceiptItemId:id.optional()}).strict();

export function discrepancyRoutes(pool: pg.Pool): Router {
  const router=Router();
  router.post('/transfers/:id/shortages',requireRole('STAFF','MANAGER'),async(req,res) => {
    const transferId=id.parse(req.params.id),commandKey=z.uuid().parse(req.headers['idempotency-key']),
      input=shortage.parse(req.body),actor=res.locals.actor as Actor;
    const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'SHORTAGE_REPORT',
      targetId:transferId,input},async c => {
      const found=await c.query(`SELECT destination_warehouse_id::text,status FROM orderflow.transfers WHERE id=$1 FOR UPDATE`,[transferId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Transfer not found.');
      if (!warehouseAllowed(actor,found.rows[0].destination_warehouse_id))
        throw new AppError(403,'FORBIDDEN','Destination warehouse access is required.');
      if (!['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(found.rows[0].status))
        throw new AppError(409,'INVALID_STATUS','Transfer is not open for shortages.');
      const item=await c.query(`SELECT b.in_transit_qty::text FROM orderflow.transfer_items i
        JOIN orderflow.transfer_item_balances b ON b.transfer_item_id=i.id
        WHERE i.id=$1 AND i.transfer_id=$2 FOR UPDATE OF i`,[input.transferItemId,transferId]);
      if (!item.rowCount) throw new AppError(422,'INVALID_ITEM','Item does not belong to this transfer.');
      const prior=await c.query(`SELECT coalesce(sum(outstanding_qty),0)::text AS reported
        FROM orderflow.discrepancy_status WHERE transfer_item_id=$1 AND kind='SHORTAGE'`,[input.transferItemId]);
      if (new Decimal(input.quantity).plus(prior.rows[0].reported).gt(item.rows[0].in_transit_qty))
        throw new AppError(409,'EXCEEDS_TRANSIT','Shortage exceeds unaccounted in-transit quantity.');
      const created=await c.query(`INSERT INTO orderflow.transfer_discrepancies
        (transfer_item_id,kind,reported_qty,reported_by,reason)
        VALUES($1,'SHORTAGE',$2,$3,$4) RETURNING id::text`,
        [input.transferItemId,input.quantity,actor.id,input.reason]);
      await c.query("UPDATE orderflow.transfers SET status='DISPUTED' WHERE id=$1",[transferId]);
      await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'SHORTAGE_REPORT','transfer_discrepancy',$2)`,[actor.id,created.rows[0].id]);
      await notifyManagers(c,{eventClass:'TRANSFER_DISCREPANCY',title:'Transfer shortage needs review',
        body:`Transfer #${transferId} has a reported shortage.`,targetPath:`/transfers/${transferId}`,
        dedupeKey:`transfer-discrepancy:${created.rows[0].id}`});
      return {status:201,response:{id:created.rows[0].id,transferId,kind:'SHORTAGE',status:'OPEN'}};
    });
    res.status(result.status).json(result.response);
  });
  router.get('/transfers/:id/discrepancies',requireRole('STAFF','MANAGER'),async(req,res) => {
    const transferId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT source_warehouse_id::text,destination_warehouse_id::text FROM orderflow.transfers WHERE id=$1`,[transferId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Transfer not found.');
    if (!warehouseAllowed(actor,found.rows[0].source_warehouse_id) && !warehouseAllowed(actor,found.rows[0].destination_warehouse_id))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const list=await pool.query(`SELECT d.id::text,d.transfer_item_id::text AS "transferItemId",d.kind,
      d.reported_qty::text AS "reportedQty",d.resolved_qty::text AS "resolvedQty",
      d.outstanding_qty::text AS "outstandingQty",d.status,d.reason
      FROM orderflow.discrepancy_status d JOIN orderflow.transfer_items i ON i.id=d.transfer_item_id
      WHERE i.transfer_id=$1 ORDER BY d.id`,[transferId]);
    res.json({items:list.rows});
  });
  router.post('/discrepancies/:id/resolve',requireRole('MANAGER'),async(req,res) => {
    const discrepancyId=id.parse(req.params.id),commandKey=z.uuid().parse(req.headers['idempotency-key']),
      input=resolution.parse(req.body),actor=res.locals.actor as Actor;
    const result=await runInventoryCommand(pool,{key:commandKey,actorId:actor.id,action:'DISCREPANCY_RESOLVE',
      targetId:discrepancyId,input},async c => {
      const location=await c.query(`SELECT t.id::text AS transfer_id FROM orderflow.transfer_discrepancies d
        JOIN orderflow.transfer_items i ON i.id=d.transfer_item_id
        JOIN orderflow.transfers t ON t.id=i.transfer_id WHERE d.id=$1`,[discrepancyId]);
      if (!location.rowCount) throw new AppError(404,'NOT_FOUND','Discrepancy not found.');
      const transferId=location.rows[0].transfer_id as string;
      const transfer=await c.query(`SELECT source_warehouse_id::text,destination_warehouse_id::text,status
        FROM orderflow.transfers WHERE id=$1 FOR UPDATE`,[transferId]);
      if (!['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(transfer.rows[0].status))
        throw new AppError(409,'INVALID_STATUS','Transfer is not open for resolution.');
      const found=await c.query(`SELECT d.transfer_item_id::text,d.kind,d.outstanding_qty::text,
        i.product_id::text FROM orderflow.discrepancy_status d
        JOIN orderflow.transfer_items i ON i.id=d.transfer_item_id WHERE d.id=$1 FOR UPDATE OF i`,[discrepancyId]);
      const discrepancy=found.rows[0];
      if (new Decimal(input.quantity).gt(discrepancy.outstanding_qty))
        throw new AppError(409,'EXCEEDS_DISCREPANCY','Resolution exceeds outstanding quantity.');
      const shortageTypes=['LOSS','DISPATCH_CORRECTION','LATER_RECEIPT'];
      if ((discrepancy.kind==='SHORTAGE')!==shortageTypes.includes(input.resolutionType))
        throw new AppError(422,'INVALID_RESOLUTION','Resolution type does not match the discrepancy.');
      if ((input.resolutionType==='LATER_RECEIPT')!==Boolean(input.laterReceiptItemId))
        throw new AppError(422,'INVALID_RECEIPT','Later receipt item is required only for later receipt resolutions.');
      const inserted=await c.query(`INSERT INTO orderflow.discrepancy_resolutions
        (discrepancy_id,manager_id,resolution_type,quantity,later_receipt_item_id,idempotency_key,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
        [discrepancyId,actor.id,input.resolutionType,input.quantity,input.laterReceiptItemId ?? null,commandKey,input.reason]);
      const resolutionId=inserted.rows[0].id as string;
      let eventId:string|null=null;
      if (input.resolutionType==='DISPATCH_CORRECTION' || input.resolutionType==='ACCEPT_EXCESS') {
        eventId=await postInventoryEvent(c,{type:'TRANSFER_RESOLUTION',actorId:actor.id,key:commandKey,
          reason:input.reason,source:{resolutionId},lines:[{warehouseId:input.resolutionType==='DISPATCH_CORRECTION'
            ? transfer.rows[0].source_warehouse_id : transfer.rows[0].destination_warehouse_id,
          productId:discrepancy.product_id,onHandDelta:input.quantity,reservedDelta:'0'}]});
      } else await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
        VALUES($1,'DISCREPANCY_RESOLVE','discrepancy_resolution',$2)`,[actor.id,resolutionId]);
      const balances=await c.query(`SELECT coalesce(bool_or(in_transit_qty<>0),false) AS transit,
        coalesce(bool_or(quarantined_qty<>0),false) AS quarantine
        FROM orderflow.transfer_item_balances WHERE transfer_id=$1`,[transferId]);
      const open=await c.query(`SELECT 1 FROM orderflow.discrepancy_status d JOIN orderflow.transfer_items i
        ON i.id=d.transfer_item_id WHERE i.transfer_id=$1 AND d.outstanding_qty>0 LIMIT 1`,[transferId]);
      const status=open.rowCount || balances.rows[0].quarantine ? 'DISPUTED'
        : balances.rows[0].transit ? 'PARTIALLY_RECEIVED' : 'RESOLVED';
      await c.query('UPDATE orderflow.transfers SET status=$2 WHERE id=$1',[transferId,status]);
      return {status:200,response:{id:resolutionId,discrepancyId,transferId,status,eventId}};
    });
    res.status(result.status).json(result.response);
  });
  return router;
}
