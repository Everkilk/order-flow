import { createHash } from 'node:crypto';
import type pg from 'pg';
import { Decimal } from 'decimal.js';
import { AppError } from './errors.js';
import { withTransaction } from './db.js';
import { decimalText } from './decimal-text.js';

type Source = { orderId?: string; receiptId?: string; returnId?: string; transferId?: string;
  transferReceiptId?: string; resolutionId?: string; decisionId?: string; reversalOfEventId?: string };
export type Movement = { warehouseId: string; productId: string; onHandDelta: string; reservedDelta: string;
  orderItemId?: string; receiptItemId?: string; returnItemId?: string; transferItemId?: string; transferReceiptItemId?: string };
type EventType = 'OPENING' | 'RECEIPT' | 'ORDER_CONFIRM' | 'ORDER_CANCEL' | 'ORDER_FULFILL' |
  'ORDER_RETURN' | 'TRANSFER_SEND' | 'TRANSFER_RECEIVE' | 'TRANSFER_RESOLUTION' | 'ADJUSTMENT' | 'REVERSAL';

const quantity = (value: Decimal) => value.toFixed(6);
const pairKey = (line: Movement) => `${line.warehouseId}:${line.productId}`;

export async function postInventoryEvent(client: pg.PoolClient, event: {
  type: EventType; actorId: string; key: string; reason: string; source: Source; lines: Movement[];
}): Promise<string> {
  const rows = [...event.lines].sort((a, b) =>
    BigInt(a.warehouseId) < BigInt(b.warehouseId) ? -1 : BigInt(a.warehouseId) > BigInt(b.warehouseId) ? 1 :
      BigInt(a.productId) < BigInt(b.productId) ? -1 : BigInt(a.productId) > BigInt(b.productId) ? 1 : 0);
  const created = await client.query(`INSERT INTO orderflow.inventory_events
    (event_type,actor_id,idempotency_key,reason,order_id,receipt_id,order_return_id,transfer_id,
     transfer_receipt_id,resolution_id,decision_id,reversal_of_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id::text`,
    [event.type,event.actorId,event.key,event.reason,event.source.orderId ?? null,event.source.receiptId ?? null,
      event.source.returnId ?? null,event.source.transferId ?? null,event.source.transferReceiptId ?? null,
      event.source.resolutionId ?? null,event.source.decisionId ?? null,event.source.reversalOfEventId ?? null]);
  const eventId = created.rows[0].id as string;
  const balances = new Map<string, { hand: Decimal; reserved: Decimal; initialAvailable: Decimal; places: number;
    warehouseId: string; productId: string }>();
  for (const line of rows) {
    const key = pairKey(line);
    if (balances.has(key)) continue;
    await client.query(`INSERT INTO orderflow.inventory_balances(warehouse_id,product_id)
      VALUES($1,$2) ON CONFLICT DO NOTHING`,[line.warehouseId,line.productId]);
    const result = await client.query(`SELECT b.on_hand,b.reserved,u.decimal_places FROM orderflow.inventory_balances b
      JOIN orderflow.products p ON p.id=b.product_id JOIN orderflow.units u ON u.id=p.unit_id
      WHERE b.warehouse_id=$1 AND b.product_id=$2 FOR UPDATE OF b`,[line.warehouseId,line.productId]);
    const row = result.rows[0];
    if (!row) throw new AppError(422,'INVALID_REFERENCE','Product or warehouse does not exist.');
    balances.set(key,{hand:new Decimal(row.on_hand),reserved:new Decimal(row.reserved),
      initialAvailable:new Decimal(row.on_hand).minus(row.reserved),places:row.decimal_places,
      warehouseId:line.warehouseId,productId:line.productId});
  }
  if (event.type==='OPENING') {
    for (const state of balances.values()) {
      const prior=await client.query(`SELECT 1 FROM orderflow.inventory_ledger
        WHERE warehouse_id=$1 AND product_id=$2 LIMIT 1`,[state.warehouseId,state.productId]);
      if (prior.rowCount) throw new AppError(409,'OPENING_ALREADY_EXISTS',
        'Opening stock already exists for this warehouse and product.');
    }
  }
  for (const line of rows) {
    const state = balances.get(pairKey(line))!;
    const handDelta = new Decimal(line.onHandDelta), reservedDelta = new Decimal(line.reservedDelta);
    if (!handDelta.isFinite() || !reservedDelta.isFinite() ||
        handDelta.decimalPlaces() > state.places || reservedDelta.decimalPlaces() > state.places ||
        handDelta.decimalPlaces() > 6 || reservedDelta.decimalPlaces() > 6 ||
        (handDelta.isZero() && reservedDelta.isZero()))
      throw new AppError(422,'INVALID_QUANTITY','Movement quantity is invalid for its unit.');
    const nextHand = state.hand.plus(handDelta), nextReserved = state.reserved.plus(reservedDelta);
    if (nextHand.isNegative() || nextReserved.isNegative() || nextReserved.gt(nextHand))
      throw new AppError(409,'INSUFFICIENT_STOCK','Movement would make stock or available quantity negative.');
    await client.query(`UPDATE orderflow.inventory_balances SET on_hand=$3,reserved=$4,version=version+1,
      updated_at=clock_timestamp() WHERE warehouse_id=$1 AND product_id=$2`,
      [line.warehouseId,line.productId,quantity(nextHand),quantity(nextReserved)]);
    await client.query(`INSERT INTO orderflow.inventory_ledger
      (event_id,product_id,warehouse_id,order_item_id,receipt_item_id,return_item_id,transfer_item_id,
       transfer_receipt_item_id,on_hand_delta,reserved_delta,on_hand_before,reserved_before,on_hand_after,reserved_after)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [eventId,line.productId,line.warehouseId,line.orderItemId ?? null,line.receiptItemId ?? null,
        line.returnItemId ?? null,line.transferItemId ?? null,line.transferReceiptItemId ?? null,
        quantity(handDelta),quantity(reservedDelta),quantity(state.hand),quantity(state.reserved),
        quantity(nextHand),quantity(nextReserved)]);
    state.hand = nextHand; state.reserved = nextReserved;
  }
  for (const state of balances.values()) {
    const threshold=await client.query(`SELECT t.threshold::text,t.critical_threshold::text,p.sku,w.code
      FROM orderflow.low_stock_thresholds t JOIN orderflow.products p ON p.id=t.product_id
      JOIN orderflow.warehouses w ON w.id=t.warehouse_id
      WHERE t.warehouse_id=$1 AND t.product_id=$2`,[state.warehouseId,state.productId]);
    if (!threshold.rowCount) continue;
    const limit=new Decimal(threshold.rows[0].threshold);
    const available=state.hand.minus(state.reserved);
    if (!state.initialAvailable.gt(limit) || available.gt(limit)) continue;
    const title=`Low stock: ${threshold.rows[0].sku}`;
    const body=`${decimalText(quantity(available))} available in ${threshold.rows[0].code}.`;
    await client.query(`INSERT INTO orderflow.notifications
      (user_id,event_id,event_class,title,body,target_path,dedupe_key)
      SELECT u.id,$1,'LOW_STOCK',$2,$3,$4,$5 FROM orderflow.users u
      WHERE u.active AND (u.role='MANAGER' OR EXISTS (
        SELECT 1 FROM orderflow.user_warehouses uw WHERE uw.user_id=u.id AND uw.warehouse_id=$6))
      ON CONFLICT(user_id,dedupe_key) DO NOTHING`,
      [eventId,title,body,`/stock?warehouseId=${state.warehouseId}&productId=${state.productId}`,
        `low-stock:${state.warehouseId}:${state.productId}:${eventId}`,state.warehouseId]);
  }
  return eventId;
}

export async function runInventoryCommand<T extends object>(pool: pg.Pool, command: {
  key: string; actorId: string; action: string; targetId: string; input: object;
}, work: (client: pg.PoolClient) => Promise<{status: number; response: T}>): Promise<{status: number; response: T}> {
  const requestHash = createHash('sha256').update(JSON.stringify(command.input)).digest('hex');
  return withTransaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[command.key]);
    const permissions = await client.query(`SELECT role,coalesce((SELECT jsonb_agg(warehouse_id::text ORDER BY warehouse_id)
      FROM orderflow.user_warehouses WHERE user_id=u.id),'[]'::jsonb) AS warehouses
      FROM orderflow.users u WHERE id=$1 AND active`,[command.actorId]);
    if (!permissions.rowCount) throw new AppError(403,'FORBIDDEN','This action is not permitted.');
    const access = permissions.rows[0];
    const prior = await client.query(`SELECT actor_id::text,action,target_id,request_hash,status,response,access_context
      FROM orderflow.api_commands WHERE idempotency_key=$1`,[command.key]);
    if (prior.rowCount) {
      const row = prior.rows[0];
      if (row.actor_id !== command.actorId || row.action !== command.action ||
          row.target_id !== command.targetId || row.request_hash !== requestHash)
        throw new AppError(409,'IDEMPOTENCY_CONFLICT','This idempotency key belongs to another request.');
      if (row.access_context?.role!==access.role || JSON.stringify(row.access_context?.warehouses)!==JSON.stringify(access.warehouses))
        throw new AppError(403,'PERMISSION_CHANGED','Your access changed. Refresh before continuing.');
      return {status:row.status,response:row.response as T};
    }
    const result = await work(client);
    await client.query(`INSERT INTO orderflow.api_commands
      (idempotency_key,actor_id,action,target_id,request_hash,status,response,access_context)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [command.key,command.actorId,command.action,command.targetId,requestHash,result.status,JSON.stringify(result.response),JSON.stringify(access)]);
    return result;
  });
}
