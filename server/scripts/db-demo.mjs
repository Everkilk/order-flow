import { randomUUID } from 'node:crypto';
import { connect, reportError } from './db-lib.mjs';
import { createExample, createOrder } from './example-data.mjs';
import { postInventoryEvent } from '../dist/inventory-write.js';

let client;
try {
  client = await connect();
  await client.query('BEGIN');
  const ex = await createExample(client, undefined, false);
  const receiptItem = (await client.query('SELECT id::text FROM orderflow.receipt_items WHERE receipt_id=$1',[ex.receipt])).rows[0].id;
  await postInventoryEvent(client,{type:'OPENING',actorId:String(ex.manager),key:randomUUID(),
    reason:'Example starting stock',source:{receiptId:String(ex.receipt)},lines:[{
      warehouseId:String(ex.warehouse),productId:String(ex.product),onHandDelta:'10',reservedDelta:'0',receiptItemId:receiptItem,
    }]});
  await client.query("UPDATE orderflow.receipts SET status='POSTED',posted_at=clock_timestamp() WHERE id=$1",[ex.receipt]);
  const show = async (label) => {
    console.log(label);
    console.table((await client.query(`SELECT sku,on_hand,reserved,available FROM orderflow.current_inventory
      WHERE product_id=$1 AND warehouse_id=$2`,[ex.product,ex.warehouse])).rows);
  };
  await show('Opening stock: 10 phones');
  const order = await createOrder(client,ex,3);
  const confirmKey = randomUUID();
  const orderItem = (await client.query('SELECT id::text FROM orderflow.order_items WHERE order_id=$1',[order])).rows[0].id;
  await postInventoryEvent(client,{type:'ORDER_CONFIRM',actorId:String(ex.manager),key:confirmKey,
    reason:'Confirm example order',source:{orderId:String(order)},lines:[{
      warehouseId:String(ex.warehouse),productId:String(ex.product),onHandDelta:'0',reservedDelta:'3',orderItemId:orderItem,
    }]});
  await client.query("UPDATE orderflow.orders SET status='CONFIRMED',confirmed_at=clock_timestamp() WHERE id=$1",[order]);
  await show('Confirmed order for 3 phones');
  const existing = await client.query('SELECT id FROM orderflow.inventory_events WHERE idempotency_key=$1',[confirmKey]);
  if (!existing.rowCount) throw new Error('The confirmation key was not recorded.');
  await show('The confirmation key is recorded for safe API retries');
  await postInventoryEvent(client,{type:'ORDER_FULFILL',actorId:String(ex.manager),key:randomUUID(),
    reason:'Fulfil example order',source:{orderId:String(order)},lines:[{
      warehouseId:String(ex.warehouse),productId:String(ex.product),onHandDelta:'-3',reservedDelta:'-3',orderItemId:orderItem,
    }]});
  await client.query("UPDATE orderflow.orders SET status='FULFILLED',fulfilled_at=clock_timestamp() WHERE id=$1",[order]);
  await show('Fulfilled order: 7 phones remain');
  for (const [label,attributes] of [
    ['Unknown attribute dpi',{screen_size_inches:6.1,dpi:460}],
    ['Missing required screen size',{color:'silver'}]
  ]) {
    await client.query('SAVEPOINT invalid_product');
    try {
      await client.query(`INSERT INTO orderflow.products(sku,name,category_id,unit_id,attributes)
        VALUES($1,'Invalid example',$2,$3,$4)`,[randomUUID(),ex.category,ex.unit,attributes]);
      throw new Error('Expected product validation to reject this example.');
    } catch (error) {
      if (error.code !== '23514') throw error;
      console.log(`${label}: rejected — ${error.message}`);
    } finally { await client.query('ROLLBACK TO SAVEPOINT invalid_product'); }
  }
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  console.log('Ledger history:');
  console.table((await client.query(`SELECT e.event_type,l.on_hand_delta,l.reserved_delta,l.on_hand_after,l.reserved_after
    FROM orderflow.inventory_ledger l JOIN orderflow.inventory_events e ON e.id=l.event_id
    WHERE l.product_id=$1 ORDER BY l.id`,[ex.product])).rows);
  await client.query('ROLLBACK');
  console.log('Example complete. All example rows were rolled back. Identity sequences may have advanced.');
} catch (error) {
  if (client) await client.query('ROLLBACK').catch(() => {});
  reportError(error);
} finally { if (client) await client.end(); }
