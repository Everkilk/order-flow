import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { Config } from './config.js';
import { withTransaction } from './db.js';
import { logger } from './errors.js';
import { withLocalFile, prepareWrite, publishFile, removeStoredFile, storedFileExists } from './storage.js';
import { validateOperationalImport, commitOperationalImport } from './operational-imports.js';
import { notifyUser } from './notifications.js';
import { sha256File } from './file-integrity.js';
import { decimalText } from './decimal-text.js';

const id=z.string().regex(/^[1-9]\d*$/).refine(value=>
  value.length<=19 && BigInt(value)<=9223372036854775807n);
const csvRow=z.object({sku:z.string().trim().min(1).max(100),name:z.string().trim().min(1).max(300),
  category_id:id,unit_id:id,barcode:z.string().trim().max(100).optional(),
  description:z.string().max(5000).optional(),selling_price:z.string().regex(/^\d+(?:\.\d{1,4})?$/)
    .refine(value=>new Decimal(value).lt('10000000000000000')).optional(),
  selling_currency:z.enum(['VND','USD']).optional(),attributes_json:z.string().optional()}).strict();
type ProductRow=z.infer<typeof csvRow> & {attributes:Record<string,unknown>;sourceRow:number};
const productColumns=['sku','name','category_id','unit_id','barcode','description','selling_price','selling_currency','attributes_json'];

async function readProductCsv(path:string):Promise<{rows:ProductRow[];errors:{row:number;field:string;message:string}[];totalRows:number}> {
  const rows:ProductRow[]=[],errors:{row:number;field:string;message:string}[]=[];
  const seen=new Set<string>(),seenBarcodes=new Set<string>();
  let rowNumber=1;
  const parser=createReadStream(path).pipe(parse({columns:(headers:string[])=>{
    if (headers.join(',')!==productColumns.join(',')) throw new Error('CSV_HEADER');
    return headers;
  },bom:true,skip_empty_lines:true,trim:true,max_record_size:1024*1024}));
  try {
    for await (const raw of parser) {
      rowNumber++;
      if (rowNumber>10001) { errors.push({row:rowNumber,field:'file',message:'Import at most 10,000 rows per file.'});break; }
      const candidate:Record<string,unknown>={};
      for (const column of productColumns) {
        const value=String(raw[column] ?? '');
        if (value!=='' || ['sku','name','category_id','unit_id'].includes(column)) candidate[column]=value;
      }
      const parsed=csvRow.safeParse(candidate);
      if (!parsed.success) {
        errors.push({row:rowNumber,field:parsed.error.issues[0]?.path.join('.') ?? 'row',
          message:parsed.error.issues[0]?.message ?? 'Invalid row.'});continue;
      }
      let attributes:Record<string,unknown>={};
      try {
        if (parsed.data.attributes_json) {
          const value:unknown=JSON.parse(parsed.data.attributes_json);
          if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
          attributes=value as Record<string,unknown>;
        }
      } catch {errors.push({row:rowNumber,field:'attributes_json',message:'Attributes must be a JSON object.'});continue;}
      if (Boolean(parsed.data.selling_price)!==Boolean(parsed.data.selling_currency)) {
        errors.push({row:rowNumber,field:'selling_price',message:'Price and currency must be provided together.'});continue;
      }
      if (seen.has(parsed.data.sku)) {errors.push({row:rowNumber,field:'sku',message:'Duplicate SKU in CSV.'});continue;}
      if (parsed.data.barcode && seenBarcodes.has(parsed.data.barcode)) {
        errors.push({row:rowNumber,field:'barcode',message:'Duplicate barcode in CSV.'});continue;
      }
      seen.add(parsed.data.sku);
      if(parsed.data.barcode) seenBarcodes.add(parsed.data.barcode);
      rows.push({...parsed.data,attributes,sourceRow:rowNumber});
    }
  } catch(error) {
    errors.push({row:Math.max(rowNumber,1),field:'file',message:error instanceof Error && error.message==='CSV_HEADER'
      ? `CSV header must be: ${productColumns.join(',')}` : 'CSV could not be parsed.'});
  }
  if (rowNumber===1 && !errors.length) errors.push({row:1,field:'file',message:'CSV has no product rows.'});
  return {rows,errors,totalRows:Math.max(0,rowNumber-1)};
}

async function validateImport(pool:pg.Pool,config:Config,jobId:string) {
  const found=await pool.query(`SELECT id::text,kind,storage_key,uploaded_by::text
    FROM orderflow.import_jobs WHERE job_id=$1`,[jobId]);
  if (!found.rowCount) throw new Error('IMPORT_JOB_MISSING');
  if(found.rows[0].kind==='OPENING_STOCK' || found.rows[0].kind==='ORDERS')
    return validateOperationalImport(pool,config,jobId,found.rows[0].kind);
  const importId=found.rows[0].id as string;
  await pool.query("UPDATE orderflow.import_jobs SET status='VALIDATING' WHERE id=$1",[importId]);
  await withLocalFile(config,found.rows[0].storage_key,async path => {
  const fingerprint=await sha256File(path);
  const parsed=await readProductCsv(path);
  if (await sha256File(path)!==fingerprint) throw new Error('CSV_CHANGED');
  const uploader=await pool.query('SELECT active,role FROM orderflow.users WHERE id=$1',
    [found.rows[0].uploaded_by]);
  if(!uploader.rows[0]?.active || uploader.rows[0].role!=='MANAGER')
    parsed.errors.push({row:1,field:'file',message:'Uploader no longer has permission to commit this import.'});
  for (const row of parsed.rows) {
    const rowNumber=row.sourceRow;
    const reference=await pool.query(`SELECT EXISTS(SELECT 1 FROM orderflow.categories WHERE id=$1 AND active) AS category,
      EXISTS(SELECT 1 FROM orderflow.units WHERE id=$2) AS unit,
      EXISTS(SELECT 1 FROM orderflow.products WHERE sku=$3) AS sku,
      EXISTS(SELECT 1 FROM orderflow.products WHERE barcode=$4) AS barcode`,
      [row.category_id,row.unit_id,row.sku,row.barcode ?? null]);
    if (!reference.rows[0].category) parsed.errors.push({row:rowNumber,field:'category_id',message:'Category does not exist or is inactive.'});
    if (!reference.rows[0].unit) parsed.errors.push({row:rowNumber,field:'unit_id',message:'Unit does not exist.'});
    if (reference.rows[0].sku) parsed.errors.push({row:rowNumber,field:'sku',message:'SKU already exists.'});
    if (reference.rows[0].barcode) parsed.errors.push({row:rowNumber,field:'barcode',message:'Barcode already exists.'});
    if (reference.rows[0].category) {
      try {await pool.query('SELECT orderflow.validate_attributes($1,$2::jsonb)',[row.category_id,JSON.stringify(row.attributes)]);}
      catch {parsed.errors.push({row:rowNumber,field:'attributes_json',message:'Attributes do not match category definitions.'});}
    }
  }
  await withTransaction(pool,async c => {
    await c.query('DELETE FROM orderflow.import_errors WHERE import_id=$1',[importId]);
    for (const error of parsed.errors.slice(0,1000)) await c.query(`INSERT INTO orderflow.import_errors
      (import_id,row_number,field,message) VALUES($1,$2,$3,$4)`,[importId,error.row,error.field,error.message]);
    await c.query(`UPDATE orderflow.import_jobs
      SET status=$2,validated_rows=$3,validated_sha256=$4 WHERE id=$1`,
      [importId,parsed.errors.length?'INVALID':'READY',parsed.totalRows,fingerprint]);
  });
  });
}

async function commitImport(pool:pg.Pool,config:Config,importId:string) {
  const found=await pool.query('SELECT kind,storage_key,validated_sha256 FROM orderflow.import_jobs WHERE id=$1',[importId]);
  if (!found.rowCount) throw new Error('IMPORT_JOB_MISSING');
  if(found.rows[0].kind==='OPENING_STOCK' || found.rows[0].kind==='ORDERS')
    return commitOperationalImport(pool,config,importId,found.rows[0].kind);
  await withLocalFile(config,found.rows[0].storage_key,async path => {
  const fingerprint=found.rows[0].validated_sha256 as string|null;
  if (fingerprint && await sha256File(path)!==fingerprint) throw new Error('CSV_CHANGED');
  const parsed=await readProductCsv(path);
  if (fingerprint && await sha256File(path)!==fingerprint) throw new Error('CSV_CHANGED');
  if (parsed.errors.length) throw new Error('CSV_CHANGED');
  await withTransaction(pool,async c => {
    const job=await c.query(`SELECT status,uploaded_by::text FROM orderflow.import_jobs WHERE id=$1 FOR UPDATE`,[importId]);
    if (job.rows[0]?.status!=='READY') throw new Error('IMPORT_NOT_READY');
    const uploader=await c.query('SELECT active,role FROM orderflow.users WHERE id=$1 FOR SHARE',
      [job.rows[0].uploaded_by]);
    if(!uploader.rows[0]?.active || uploader.rows[0].role!=='MANAGER')
      throw new Error('IMPORT_PERMISSION_CHANGED');
    for (const row of parsed.rows) await c.query(`INSERT INTO orderflow.products
      (sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[row.sku,row.name,row.category_id,row.unit_id,
        row.barcode ?? null,row.description ?? null,row.selling_price ?? null,
        row.selling_currency ?? null,JSON.stringify(row.attributes)]);
    await c.query("UPDATE orderflow.import_jobs SET status='COMMITTED',committed_at=clock_timestamp() WHERE id=$1",[importId]);
    await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id,details)
      VALUES($1,'PRODUCT_IMPORT','import_job',$2,$3)`,
      [job.rows[0].uploaded_by,importId,JSON.stringify({rows:parsed.rows.length})]);
  });
  });
}

const safeCell=(value:unknown) => {
  const text=String(value ?? '');
  return /^(?:[=+@\t\r\n]|-(?!\d+(?:\.\d+)?$))/.test(text) ? `'${text}` : text;
};

async function exportCsv(pool:pg.Pool,config:Config,jobId:string) {
  const found=await pool.query(`SELECT id::text,kind,filters,storage_key FROM orderflow.export_jobs WHERE job_id=$1`,[jobId]);
  if (!found.rowCount) throw new Error('EXPORT_JOB_MISSING');
  const job=found.rows[0],warehouseId=job.filters.warehouseId as string|undefined;
  if(job.storage_key) {
    if(await storedFileExists(config,job.storage_key)) return;
  }
  const key=`exports/${randomUUID()}.csv`,path=await prepareWrite(config,key);
  const columns=job.kind==='PRODUCTS'
    ? ['id','sku','name','category_id','unit_id','barcode','description','selling_price','selling_currency','attributes_json']
    : job.kind==='STOCK' ? ['product_id','sku','name','on_hand','reserved','available']
    : job.kind==='MOVEMENTS' ? ['id','product_id','event_type','on_hand_delta','reserved_delta','created_at']
    : ['product_id','sku','name','available','threshold'];
  const formatter=stringify({header:true,columns});
  const numericColumns=new Set(['selling_price','on_hand','reserved','available','on_hand_delta','reserved_delta','threshold']);
  const done=pipeline(formatter,createWriteStream(path,{flags:'wx'}));
  try {
    let cursor='0';
    while (true) {
      const result=job.kind==='PRODUCTS'
        ? await pool.query(`SELECT id::text,sku,name,category_id::text,unit_id::text,barcode,description,
          selling_price::text,selling_currency,attributes::text AS attributes_json
          FROM orderflow.products WHERE id>$1 ORDER BY id LIMIT 1000`,[cursor])
        : job.kind==='STOCK'
          ? await pool.query(`SELECT b.product_id::text,p.sku,p.name,b.on_hand::text,b.reserved::text,b.available::text
            FROM orderflow.inventory_balances b JOIN orderflow.products p ON p.id=b.product_id
            WHERE b.warehouse_id=$1 AND b.product_id>$2 ORDER BY b.product_id LIMIT 1000`,[warehouseId,cursor])
          : job.kind==='MOVEMENTS'
            ? await pool.query(`SELECT l.id::text,l.product_id::text,e.event_type,l.on_hand_delta::text,
              l.reserved_delta::text,l.created_at::text FROM orderflow.inventory_ledger l
              JOIN orderflow.inventory_events e ON e.id=l.event_id
              WHERE l.warehouse_id=$1 AND l.id>$2 ORDER BY l.id LIMIT 1000`,[warehouseId,cursor])
            : await pool.query(`SELECT t.product_id::text,p.sku,p.name,b.available::text,t.threshold::text
              FROM orderflow.low_stock_thresholds t JOIN orderflow.inventory_balances b USING(warehouse_id,product_id)
              JOIN orderflow.products p ON p.id=t.product_id
              WHERE t.warehouse_id=$1 AND t.product_id>$2 AND b.available<=t.threshold
              ORDER BY t.product_id LIMIT 1000`,[warehouseId,cursor]);
      for (const row of result.rows) {
        const cells=columns.map(column=>safeCell(numericColumns.has(column) && typeof row[column]==='string' ? decimalText(row[column]) : row[column]));
        if (!formatter.write(cells)) await once(formatter,'drain');
      }
      if (result.rows.length<1000) break;
      cursor=String(result.rows.at(-1)[job.kind==='PRODUCTS'||job.kind==='MOVEMENTS'?'id':'product_id']);
    }
    formatter.end();
    await done;
    await publishFile(config,key);
    await pool.query(`UPDATE orderflow.export_jobs SET storage_key=$2,expires_at=now()+interval '7 days' WHERE id=$1`,
      [job.id,key]);
  } catch(error) {formatter.destroy();await done.catch(()=>{});await removeStoredFile(config,key).catch(()=>{});throw error;}
}

export async function runOneJob(pool:pg.Pool,config:Config):Promise<boolean> {
  const claimed=await withTransaction(pool,async c => c.query(`WITH next AS (
    SELECT id FROM orderflow.background_jobs WHERE
      (status='PENDING' AND available_at<=now()) OR (status='PROCESSING' AND lease_until<now())
    ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE orderflow.background_jobs j SET status='PROCESSING',attempts=attempts+1,
      lease_until=now()+interval '5 minutes' FROM next WHERE j.id=next.id
    RETURNING j.id::text,j.kind,j.payload,j.attempts,j.requested_by::text`));
  if (!claimed.rowCount) return false;
  const job=claimed.rows[0];
  const heartbeat=setInterval(()=>{
    pool.query(`UPDATE orderflow.background_jobs SET lease_until=now()+interval '5 minutes'
      WHERE id=$1 AND status='PROCESSING'`,[job.id]).catch(error=>logger.error({err:error,jobId:job.id},'job heartbeat failed'));
  },60_000).unref();
  try {
    if (job.kind==='IMPORT_VALIDATE') await validateImport(pool,config,job.id);
    else if (job.kind==='IMPORT_COMMIT') await commitImport(pool,config,id.parse(job.payload.importId));
    else if (job.kind==='EXPORT_CSV') await exportCsv(pool,config,job.id);
    else if (job.kind==='EVIDENCE_DELETE') await removeStoredFile(config,z.string().regex(/^evidence\/[0-9a-f-]{36}\.bin$/).parse(job.payload.storageKey));
    else if (job.kind==='UPLOAD_DELETE') await removeStoredFile(config,z.string().regex(/^(?:evidence\/[0-9a-f-]{36}\.bin|imports\/[0-9a-f-]{36}\.csv)$/).parse(job.payload.storageKey));
    else throw new Error('UNKNOWN_JOB_KIND');
    await withTransaction(pool,async c => {
      await c.query(`UPDATE orderflow.background_jobs SET status='DONE',lease_until=NULL WHERE id=$1`,[job.id]);
      if(job.kind==='IMPORT_VALIDATE' || job.kind==='IMPORT_COMMIT') {
        const importId=job.kind==='IMPORT_VALIDATE'
          ? (await c.query('SELECT id::text FROM orderflow.import_jobs WHERE job_id=$1',[job.id])).rows[0]?.id
          : job.payload.importId;
        const imported=await c.query(`SELECT uploaded_by::text,status,validated_rows FROM orderflow.import_jobs
          WHERE id=$1`,[importId]);
        if(imported.rowCount) await notifyUser(c,imported.rows[0].uploaded_by,{
          eventClass:job.kind==='IMPORT_VALIDATE'?'IMPORT_VALIDATED':'IMPORT_COMPLETE',
          title:job.kind==='IMPORT_VALIDATE'?'Import validation complete':'Import committed',
          body:job.kind==='IMPORT_VALIDATE'
            ? (imported.rows[0].status==='READY'?'Import is ready to commit.':'Import has validation errors.')
            : `Imported ${imported.rows[0].validated_rows} rows.`,
          targetPath:`/imports/${importId}`,
          dedupeKey:`import-${job.kind}:${importId}`,
        });
      } else if(job.kind==='EXPORT_CSV') {
        const exported=await c.query(`SELECT id::text,requested_by::text FROM orderflow.export_jobs
          WHERE job_id=$1`,[job.id]);
        if(exported.rowCount) await notifyUser(c,exported.rows[0].requested_by,{
          eventClass:'EXPORT_COMPLETE',title:'Export ready',
          body:'Your CSV export is ready to download.',
          targetPath:`/exports/${exported.rows[0].id}`,
          dedupeKey:`export-complete:${exported.rows[0].id}`,
        });
      }
    });
  } catch(error) {
    logger.error({err:error,jobId:job.id,kind:job.kind},'background job failed');
    const dbCode=error && typeof error==='object' && 'code' in error ? String(error.code) : '';
    const known=error instanceof Error ? error.message : '';
    const permanent=['CSV_CHANGED','IMPORT_NOT_READY','IMPORT_DATA_CHANGED','IMPORT_JOB_MISSING',
      'IMPORT_PERMISSION_CHANGED',
      'UNKNOWN_JOB_KIND'].includes(known) || ['23505','23503','23514','22003'].includes(dbCode);
    const code=dbCode ? ('DB_'+dbCode) : /^[A-Z_]+$/.test(known) ? known : 'JOB_FAILED';
    const dead=permanent || job.attempts>=3;
    await withTransaction(pool,async c => {
      await c.query(`UPDATE orderflow.background_jobs SET status=$2,lease_until=NULL,
        available_at=now()+($3::integer * interval '1 minute'),last_error_code=$4 WHERE id=$1`,
        [job.id,dead?'DEAD':'PENDING',2**job.attempts,code]);
      if (!dead) return;
      if(job.kind.startsWith('IMPORT')) {
        const importId=job.kind==='IMPORT_VALIDATE'
          ? (await c.query('SELECT id::text FROM orderflow.import_jobs WHERE job_id=$1',[job.id])).rows[0]?.id
          : job.payload.importId;
        if(importId) {
          const imported=await c.query(`UPDATE orderflow.import_jobs SET status='FAILED' WHERE id=$1
            RETURNING uploaded_by::text`,[importId]);
          if(imported.rowCount) await notifyUser(c,imported.rows[0].uploaded_by,{
            eventClass:'IMPORT_FAILED',title:'Import failed',
            body:'The import could not be completed. Review its status.',
            targetPath:`/imports/${importId}`,dedupeKey:`import-failed:${importId}`,
          });
        }
      } else if(job.kind==='EXPORT_CSV') {
        const exported=await c.query(`SELECT id::text,requested_by::text FROM orderflow.export_jobs
          WHERE job_id=$1`,[job.id]);
        if(exported.rowCount) await notifyUser(c,exported.rows[0].requested_by,{
          eventClass:'EXPORT_FAILED',title:'Export failed',
          body:'The export could not be completed. Review its status.',
          targetPath:`/exports/${exported.rows[0].id}`,
          dedupeKey:`export-failed:${exported.rows[0].id}`,
        });
      }
    });
  } finally {clearInterval(heartbeat);}
  return true;
}
