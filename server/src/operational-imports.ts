import { createReadStream } from 'node:fs';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { parse } from 'csv-parse';
import type { Config } from './config.js';
import { withTransaction } from './db.js';
import { postInventoryEvent, type Movement } from './inventory-write.js';
import { withLocalFile } from './storage.js';
import { sha256File } from './file-integrity.js';

type Kind='OPENING_STOCK'|'ORDERS';
type Row={sourceRow:number;documentNumber:string;warehouseId:string;sku:string;
  quantity:string;amount:string|null;currency:'VND'|'USD'|null};
type CheckedRow=Row & {productId:string};
type CsvError={row:number;field:string;message:string};
type Database=pg.Pool|pg.PoolClient;
const id=/^[1-9]\d*$/;
const decimal=/^\d+(?:\.\d{1,6})?$/;
const money=/^\d+(?:\.\d{1,4})?$/;
const columns={
  OPENING_STOCK:['receipt_number','warehouse_id','sku','quantity','unit_cost','currency'],
  ORDERS:['order_number','warehouse_id','sku','quantity','unit_price','currency'],
} as const;

async function readCsv(path:string,kind:Kind) {
  const rows:Row[]=[],errors:CsvError[]=[];
  const expected=columns[kind];
  let line=1;
  const parser=createReadStream(path).pipe(parse({columns:(headers:string[])=>{
    if (headers.join(',')!==expected.join(',')) throw new Error('CSV_HEADER');
    return headers;
  },bom:true,skip_empty_lines:true,trim:true,max_record_size:1024*1024}));
  try {
    for await(const raw of parser) {
      line++;
      if(line>10001) {errors.push({row:line,field:'file',message:'Import at most 10,000 rows per file.'});break;}
      const documentNumber=String(raw[expected[0]] ?? '');
      const warehouseId=String(raw.warehouse_id ?? '');
      const sku=String(raw.sku ?? '');
      const quantity=String(raw.quantity ?? '');
      const amount=String(raw[expected[4]] ?? '') || null;
      const currency=String(raw.currency ?? '') || null;
      const invalid=(field:string,message:string) => errors.push({row:line,field,message});
      if(!documentNumber || documentNumber.length>80) invalid(expected[0],'Document number is required (maximum 80 characters).');
      else if(!id.test(warehouseId) || warehouseId.length>19 ||
          BigInt(warehouseId)>9223372036854775807n)
        invalid('warehouse_id','Warehouse ID must be a valid positive integer.');
      else if(!sku || sku.length>100) invalid('sku','SKU is required (maximum 100 characters).');
      else if(!decimal.test(quantity) || new Decimal(quantity).lte(0) ||
          new Decimal(quantity).gte('100000000000000'))
        invalid('quantity','Quantity must be positive, fit numeric(20,6), and have at most 6 decimal places.');
      else if((amount===null)!==(currency===null)) invalid(expected[4],'Cost or price and currency must be supplied together.');
      else if(amount!==null && (!money.test(amount) || new Decimal(amount).gte('10000000000000000')))
        invalid(expected[4],'Amount must fit numeric(20,4) with at most 4 decimal places.');
      else if(currency!==null && currency!=='VND' && currency!=='USD') invalid('currency','Currency must be VND or USD.');
      else rows.push({sourceRow:line,documentNumber,warehouseId,sku,quantity,amount,
        currency:currency as Row['currency']});
    }
  } catch(error) {
    errors.push({row:Math.max(line,1),field:'file',message:error instanceof Error && error.message==='CSV_HEADER'
      ? `CSV header must be: ${expected.join(',')}` : 'CSV could not be parsed.'});
  }
  if(line===1 && !errors.length) errors.push({row:1,field:'file',message:'CSV has no rows.'});
  return {rows,errors,totalRows:Math.max(0,line-1)};
}

async function checkRows(db:Database,kind:Kind,actorId:string,rows:Row[]) {
  const errors:CsvError[]=[],checked:CheckedRow[]=[];
  const user=await db.query('SELECT active,role FROM orderflow.users WHERE id=$1',[actorId]);
  const role=user.rows[0]?.role as string|undefined;
  if(!user.rows[0]?.active || (kind==='OPENING_STOCK' && role!=='MANAGER') ||
      (kind==='ORDERS' && role!=='MANAGER' && role!=='STAFF'))
    return {errors:[{row:1,field:'file',message:'Uploader no longer has permission to commit this import.'}],checked};
  const assignments=role==='STAFF'
    ? new Set((await db.query('SELECT warehouse_id::text AS id FROM orderflow.user_warehouses WHERE user_id=$1',
      [actorId])).rows.map(row=>String(row.id))) : null;
  const warehouseCache=new Map<string,boolean>(),productCache=new Map<string,{id:string;active:boolean;places:number}|null>();
  const documentCache=new Map<string,boolean>(),documentWarehouse=new Map<string,string>();
  const documentSize=new Map<string,number>(),pairs=new Set<string>();
  for(const row of rows) {
    const invalid=(field:string,message:string) => errors.push({row:row.sourceRow,field,message});
    if(!warehouseCache.has(row.warehouseId)) {
      const found=await db.query('SELECT active FROM orderflow.warehouses WHERE id=$1 FOR SHARE',
        [row.warehouseId]);
      warehouseCache.set(row.warehouseId,Boolean(found.rows[0]?.active));
    }
    if(!warehouseCache.get(row.warehouseId)) invalid('warehouse_id','Warehouse does not exist or is inactive.');
    if(assignments && !assignments.has(row.warehouseId)) invalid('warehouse_id','Uploader is not assigned to this warehouse.');
    if(!productCache.has(row.sku)) {
      const found=await db.query(`SELECT p.id::text,p.active,u.decimal_places AS places
        FROM orderflow.products p JOIN orderflow.units u ON u.id=p.unit_id
        WHERE p.sku=$1 FOR SHARE OF p`,[row.sku]);
      productCache.set(row.sku,found.rows[0] ?? null);
    }
    const product=productCache.get(row.sku);
    if(!product?.active) invalid('sku','Product does not exist or is inactive.');
    else if(new Decimal(row.quantity).decimalPlaces()>product.places)
      invalid('quantity','Quantity has more decimal places than the product unit allows.');
    const pair=`${row.documentNumber}:\0:${row.warehouseId}:\0:${row.sku}`;
    if(pairs.has(pair)) invalid('sku','Product appears twice in this document and warehouse.');
    pairs.add(pair);
    const priorWarehouse=documentWarehouse.get(row.documentNumber);
    if(kind==='OPENING_STOCK' && priorWarehouse && priorWarehouse!==row.warehouseId)
      invalid('warehouse_id','One opening receipt must use one warehouse.');
    documentWarehouse.set(row.documentNumber,row.warehouseId);
    const size=(documentSize.get(row.documentNumber) ?? 0)+1;
    documentSize.set(row.documentNumber,size);
    if(size>200) invalid('file','A document may contain at most 200 lines.');
    if(!documentCache.has(row.documentNumber)) {
      const table=kind==='OPENING_STOCK'?'receipts':'orders';
      const column=kind==='OPENING_STOCK'?'receipt_number':'order_number';
      const existing=await db.query(`SELECT 1 FROM orderflow.${table} WHERE ${column}=$1`,[row.documentNumber]);
      documentCache.set(row.documentNumber,Boolean(existing.rowCount));
    }
    if(documentCache.get(row.documentNumber)) invalid(columns[kind][0],'Document number already exists.');
    if(kind==='OPENING_STOCK' && product?.id) {
      const history=await db.query(`SELECT 1 FROM orderflow.inventory_ledger
        WHERE warehouse_id=$1 AND product_id=$2 LIMIT 1`,[row.warehouseId,product.id]);
      if(history.rowCount) invalid('sku','Opening stock already exists for this warehouse and product.');
    }
    if(product?.id) checked.push({...row,productId:product.id});
  }
  return {errors,checked};
}

export async function validateOperationalImport(pool:pg.Pool,config:Config,jobId:string,kind:Kind) {
  const found=await pool.query('SELECT id::text,storage_key,uploaded_by::text FROM orderflow.import_jobs WHERE job_id=$1 AND kind=$2',
    [jobId,kind]);
  if(!found.rowCount) throw new Error('IMPORT_JOB_MISSING');
  const job=found.rows[0];
  await pool.query("UPDATE orderflow.import_jobs SET status='VALIDATING' WHERE id=$1",[job.id]);
  await withLocalFile(config,job.storage_key,async path => {
  const fingerprint=await sha256File(path);
  const parsed=await readCsv(path,kind);
  if(await sha256File(path)!==fingerprint) throw new Error('CSV_CHANGED');
  const checked=await checkRows(pool,kind,job.uploaded_by,parsed.rows);
  const errors=[...parsed.errors,...checked.errors];
  await withTransaction(pool,async c => {
    await c.query('DELETE FROM orderflow.import_errors WHERE import_id=$1',[job.id]);
    for(const error of errors.slice(0,1000)) await c.query(`INSERT INTO orderflow.import_errors
      (import_id,row_number,field,message) VALUES($1,$2,$3,$4)`,[job.id,error.row,error.field,error.message]);
    await c.query(`UPDATE orderflow.import_jobs
      SET status=$2,validated_rows=$3,validated_sha256=$4 WHERE id=$1`,
      [job.id,errors.length?'INVALID':'READY',parsed.totalRows,fingerprint]);
  });
  });
}

export async function commitOperationalImport(pool:pg.Pool,config:Config,importId:string,kind:Kind) {
  const found=await pool.query('SELECT storage_key,validated_sha256 FROM orderflow.import_jobs WHERE id=$1 AND kind=$2',[importId,kind]);
  if(!found.rowCount) throw new Error('IMPORT_JOB_MISSING');
  await withLocalFile(config,found.rows[0].storage_key,async path => {
  const fingerprint=found.rows[0].validated_sha256 as string|null;
  if(fingerprint && await sha256File(path)!==fingerprint) throw new Error('CSV_CHANGED');
  const parsed=await readCsv(path,kind);
  if(fingerprint && await sha256File(path)!==fingerprint) throw new Error('CSV_CHANGED');
  if(parsed.errors.length) throw new Error('CSV_CHANGED');
  await withTransaction(pool,async c => {
    const job=await c.query('SELECT status,uploaded_by::text FROM orderflow.import_jobs WHERE id=$1 FOR UPDATE',
      [importId]);
    if(job.rows[0]?.status==='COMMITTED') return;
    if(job.rows[0]?.status!=='READY') throw new Error('IMPORT_NOT_READY');
    const actorId=job.rows[0].uploaded_by as string;
    const checked=await checkRows(c,kind,actorId,parsed.rows);
    if(checked.errors.length || checked.checked.length!==parsed.rows.length)
      throw new Error('IMPORT_DATA_CHANGED');
    const groups=new Map<string,CheckedRow[]>();
    for(const row of checked.checked) groups.set(row.documentNumber,
      [...(groups.get(row.documentNumber) ?? []),row]);
    for(const [documentNumber,lines] of groups) {
      if(kind==='OPENING_STOCK') {
        const created=await c.query(`INSERT INTO orderflow.receipts
          (receipt_number,kind,warehouse_id,created_by) VALUES($1,'OPENING',$2,$3) RETURNING id::text`,
          [documentNumber,lines[0]!.warehouseId,actorId]);
        const receiptId=created.rows[0].id as string;
        const movements:Movement[]=[];
        for(const line of lines) {
          const item=await c.query(`INSERT INTO orderflow.receipt_items
            (receipt_id,product_id,quantity,unit_cost,currency) VALUES($1,$2,$3,$4,$5)
            RETURNING id::text`,[receiptId,line.productId,line.quantity,line.amount,line.currency]);
          movements.push({warehouseId:line.warehouseId,productId:line.productId,
            onHandDelta:line.quantity,reservedDelta:'0',receiptItemId:item.rows[0].id});
        }
        await postInventoryEvent(c,{type:'OPENING',actorId,key:randomUUID(),
          reason:`Opening stock import #${importId}`,source:{receiptId},lines:movements});
        await c.query("UPDATE orderflow.receipts SET status='POSTED',posted_at=clock_timestamp() WHERE id=$1",
          [receiptId]);
      } else {
        const created=await c.query(`INSERT INTO orderflow.orders(order_number,created_by)
          VALUES($1,$2) RETURNING id::text`,[documentNumber,actorId]);
        for(const line of lines) await c.query(`INSERT INTO orderflow.order_items
          (order_id,product_id,warehouse_id,quantity,unit_price,currency)
          VALUES($1,$2,$3,$4,$5,$6)`,[created.rows[0].id,line.productId,line.warehouseId,
          line.quantity,line.amount,line.currency]);
      }
    }
    await c.query("UPDATE orderflow.import_jobs SET status='COMMITTED',committed_at=clock_timestamp() WHERE id=$1",
      [importId]);
    await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id,details)
      VALUES($1,'IMPORT_COMMIT','import_job',$2,$3)`,[actorId,importId,JSON.stringify({
        kind,rows:parsed.rows.length,documents:groups.size,
      })]);
  });
  });
}
