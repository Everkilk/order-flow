import { cleanupUpload } from './upload-cleanup.js';
import { randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { parse } from 'csv-parse';
import { Router, type RequestHandler } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import { withMutation } from './mutations.js';
import { AppError } from './errors.js';
import { sha256File } from './file-integrity.js';
import { prepareWrite, publishFile,  withLocalFile, openStoredStream } from './storage.js';
export { storagePath } from './storage.js';

const id=z.string().regex(/^[1-9]\d*$/);
const exportInput=z.object({kind:z.enum(['PRODUCTS','STOCK','MOVEMENTS','REPORT']),
  warehouseId:id.optional()}).strict();
const maxFileBytes=20*1024*1024;
const previewLimit=20;

async function receiveCsv(req: import('express').Request, path: string) {
  let filename='',contentType='';
  if (!req.headers['content-type']?.startsWith('multipart/form-data;'))
    throw new AppError(415,'INVALID_CONTENT_TYPE','Upload a multipart CSV file in the file field.');
  await new Promise<void>((resolveUpload,rejectUpload) => {
    let parser:Busboy.Busboy;
    try {parser=Busboy({headers:req.headers,limits:{fileSize:maxFileBytes,files:1,fields:0,parts:2}});}
    catch {rejectUpload(new AppError(415,'INVALID_CONTENT_TYPE','Upload a multipart CSV file in the file field.'));return;}
    let saved:Promise<void>|null=null,limited=false,seen=false;
    parser.on('file',(field,file,info) => {
      seen=true;
      filename=info.filename;contentType=info.mimeType;
      if (field!=='file' || !info.filename.toLowerCase().endsWith('.csv')) {
        file.resume();
        limited=true;
        return;
      }
      file.on('limit',()=>{limited=true;});
      saved=pipeline(file,createWriteStream(path,{flags:'wx'}));
    });
    parser.on('error',rejectUpload);
    parser.on('filesLimit',()=>{limited=true;});
    parser.on('fieldsLimit',()=>{limited=true;});
    parser.on('partsLimit',()=>{limited=true;});
    parser.on('close',() => {
      if (!seen || !saved) return rejectUpload(new AppError(400,'INVALID_UPLOAD','Provide one .csv file in the file field.'));
      saved.then(()=>limited ? rejectUpload(new AppError(413,'CSV_TOO_LARGE','CSV must be at most 20 MB.')) : resolveUpload(),rejectUpload);
    });
    req.on('aborted',()=>rejectUpload(new AppError(400,'UPLOAD_ABORTED','Upload was interrupted.')));
    req.pipe(parser);
  });
  return {filename,contentType};
}

async function readCsvPreview(path:string) {
  const source=createReadStream(path);
  const parser=source.pipe(parse({bom:true,skip_empty_lines:true,trim:true,
    relax_column_count:true,max_record_size:1024*1024}));
  let columns:string[]=[];
  const rows:{rowNumber:number;values:string[]}[]=[];
  let hasMore=false;
  try {
    for await (const values of parser as AsyncIterable<string[]>) {
      if (!columns.length) {columns=values;continue;}
      if (rows.length===previewLimit) {hasMore=true;break;}
      rows.push({rowNumber:rows.length+2,values});
    }
  } finally {parser.destroy();source.destroy();}
  return {columns,rows,hasMore};
}

export function jobRoutes(pool: pg.Pool,config: Config): Router {
  const router=Router();
  const uploadImport=(kind:'PRODUCTS'|'OPENING_STOCK'|'ORDERS'):RequestHandler => async(req,res) => {
    const actor=res.locals.actor as Actor,key=`imports/${randomUUID()}.csv`,path=await prepareWrite(config,key);
    let fingerprint: string,metadata:{filename:string;contentType:string};
    try { metadata=await receiveCsv(req,path); fingerprint=await sha256File(path); await publishFile(config,key); }
    catch(error) { await cleanupUpload(pool,config,key,actor.id);throw error; }
    try {
      let created=false;
      const row=await withMutation(pool,req,actor,async c => {
        created=true;
        const job=await c.query(`INSERT INTO orderflow.background_jobs(kind,requested_by,dedupe_key)
          VALUES('IMPORT_VALIDATE',$1,$2) RETURNING id::text`,[actor.id,`import-validate:${key}`]);
        const importJob=await c.query(`INSERT INTO orderflow.import_jobs
          (job_id,uploaded_by,kind,storage_key,commit_key)
          VALUES($1,$2,$3,$4,$5) RETURNING id::text,kind,commit_key::text AS "commitKey",status`,
          [job.rows[0].id,actor.id,kind,key,randomUUID()]);
        return importJob.rows[0];
      },{fingerprint,...metadata});
      if(!created) await cleanupUpload(pool,config,key,actor.id);
      res.status(202).json(row);
    } catch(error) { await cleanupUpload(pool,config,key,actor.id);throw error; }
  };
  router.post('/imports/products',requireRole('MANAGER'),uploadImport('PRODUCTS'));
  router.post('/imports/opening-stock',requireRole('MANAGER'),uploadImport('OPENING_STOCK'));
  router.post('/imports/orders',requireRole('STAFF','MANAGER'),uploadImport('ORDERS'));
  router.get('/imports',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT i.id::text,i.kind,i.status,i.validated_rows AS "validatedRows",
      j.created_at AS "createdAt" FROM orderflow.import_jobs i
      JOIN orderflow.background_jobs j ON j.id=i.job_id
      WHERE ($1::bigint IS NULL OR i.id<$1)
        AND ($2 OR (i.kind='ORDERS' AND i.uploaded_by=$3))
      ORDER BY i.id DESC LIMIT $4`,[input.cursor ?? null,actor.role==='MANAGER',actor.id,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit?rows.at(-1)?.id ?? null:null});
  });
  router.get('/imports/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const importId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT i.id::text,i.kind,i.status,i.validated_rows AS "validatedRows",
      i.commit_key::text AS "commitKey",i.uploaded_by::text AS "uploadedBy",
      coalesce(cj.status,j.status) AS "jobStatus",
      coalesce(cj.last_error_code,j.last_error_code) AS "lastErrorCode"
      FROM orderflow.import_jobs i JOIN orderflow.background_jobs j ON j.id=i.job_id
      LEFT JOIN orderflow.background_jobs cj ON cj.dedupe_key='import-commit:'||i.id::text
      WHERE i.id=$1`,[importId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Import not found.');
    if (actor.role!=='MANAGER' && (found.rows[0].kind!=='ORDERS' || found.rows[0].uploadedBy!==actor.id))
      throw new AppError(403,'FORBIDDEN','This import is not permitted.');
    const errors=await pool.query(`SELECT row_number AS "rowNumber",field,message FROM orderflow.import_errors
      WHERE import_id=$1 ORDER BY row_number,id LIMIT 100`,[importId]);
    const {uploadedBy,...output}=found.rows[0];
    res.json({...output,errors:errors.rows});
  });
  router.get('/imports/:id/preview',requireRole('STAFF','MANAGER'),async(req,res) => {
    const importId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT kind,status,uploaded_by::text AS "uploadedBy",
      storage_key AS "storageKey",validated_sha256 AS "validatedSha256"
      FROM orderflow.import_jobs WHERE id=$1`,[importId]);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Import not found.');
    const imported=found.rows[0];
    if (actor.role!=='MANAGER' && (imported.kind!=='ORDERS' || imported.uploadedBy!==actor.id))
      throw new AppError(403,'FORBIDDEN','This import is not permitted.');
    if (!['READY','INVALID','COMMITTED','FAILED'].includes(imported.status))
      throw new AppError(409,'IMPORT_NOT_VALIDATED','Wait for import validation before reviewing rows.');
    let preview:Awaited<ReturnType<typeof readCsvPreview>>;
    try {
      preview=await withLocalFile(config,imported.storageKey,async path => {
        if(imported.validatedSha256 && await sha256File(path)!==imported.validatedSha256)
          throw new AppError(409,'CSV_CHANGED','CSV changed after validation. Upload it again.');
        const result=await readCsvPreview(path);
        if(imported.validatedSha256 && await sha256File(path)!==imported.validatedSha256)
          throw new AppError(409,'CSV_CHANGED','CSV changed after validation. Upload it again.');
        return result;
      });
    }
    catch(error) {
      if(error instanceof AppError) throw error;
      if (error && typeof error==='object' && 'code' in error && error.code==='ENOENT')
        throw new AppError(410,'FILE_MISSING','Import file is unavailable.');
      throw new AppError(422,'CSV_PREVIEW_UNAVAILABLE','CSV rows could not be previewed.');
    }
    const errors=await pool.query(`SELECT row_number AS "rowNumber",field,message
      FROM orderflow.import_errors WHERE import_id=$1 AND row_number<=$2
      ORDER BY row_number,id`,[importId,previewLimit+1]);
    res.json({...preview,errors:errors.rows});
  });
  router.post('/imports/:id/commit',requireRole('STAFF','MANAGER'),async(req,res) => {
    const importId=id.parse(req.params.id),key=z.uuid().parse(req.headers['idempotency-key']),actor=res.locals.actor as Actor;
    const outcome=await withMutation(pool,req,actor,async c => {
      const found=await c.query(`SELECT status,kind,uploaded_by::text,commit_key::text
        FROM orderflow.import_jobs WHERE id=$1 FOR UPDATE`,[importId]);
      if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Import not found.');
      if (actor.role!=='MANAGER' && (found.rows[0].kind!=='ORDERS' || found.rows[0].uploaded_by!==actor.id))
        throw new AppError(403,'FORBIDDEN','This import is not permitted.');
      if (found.rows[0].commit_key!==key) throw new AppError(409,'IDEMPOTENCY_CONFLICT','Use the commit key from the import.');
      if (found.rows[0].status==='COMMITTED') return {status:'COMMITTED'};
      if (found.rows[0].status!=='READY') throw new AppError(409,'IMPORT_NOT_READY','Validate the import before committing.');
      await c.query(`INSERT INTO orderflow.background_jobs(kind,requested_by,dedupe_key,payload)
        VALUES('IMPORT_COMMIT',$1,$2,$3) ON CONFLICT(dedupe_key) DO NOTHING`,
        [actor.id,`import-commit:${importId}`,JSON.stringify({importId})]);
      return {status:'QUEUED'};
    });
    // The stored replay result records the original enqueue. The job may have
    // progressed by the time the client retries a lost response.
    const current=await pool.query('SELECT status FROM orderflow.import_jobs WHERE id=$1',[importId]);
    res.status(202).json({status: current.rows[0]?.status==='COMMITTED' ? 'COMMITTED' : current.rows[0]?.status==='FAILED' ? 'FAILED' : outcome.status});
  });
  router.post('/exports',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=exportInput.parse(req.body),actor=res.locals.actor as Actor;
    if (input.kind!=='PRODUCTS' && !input.warehouseId)
      throw new AppError(400,'WAREHOUSE_REQUIRED','Select a warehouse for this export.');
    if (input.warehouseId && !warehouseAllowed(actor,input.warehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const row=await withMutation(pool,req,actor,async c => {
      const job=await c.query(`INSERT INTO orderflow.background_jobs
        (kind,requested_by,dedupe_key,payload) VALUES('EXPORT_CSV',$1,$2,$3) RETURNING id::text`,
        [actor.id,`export:${randomUUID()}`,JSON.stringify(input)]);
      const output=await c.query(`INSERT INTO orderflow.export_jobs
        (job_id,requested_by,kind,format,filters) VALUES($1,$2,$3,'CSV',$4)
        RETURNING id::text,kind,format`,[job.rows[0].id,actor.id,input.kind,JSON.stringify(input)]);
      return output.rows[0];
    });
    res.status(202).json(row);
  });
  router.get('/exports',requireRole('STAFF','MANAGER'),async(req,res) => {
    const input=z.object({cursor:id.optional(),limit:z.coerce.number().int().min(1).max(100).default(25)}).strict().parse(req.query);
    const actor=res.locals.actor as Actor;
    const result=await pool.query(`SELECT e.id::text,e.kind,e.format,j.status,
      e.storage_key IS NOT NULL AS ready,j.created_at AS "createdAt"
      FROM orderflow.export_jobs e JOIN orderflow.background_jobs j ON j.id=e.job_id
      WHERE ($1::bigint IS NULL OR e.id<$1) AND ($2 OR e.requested_by=$3)
        AND ($2 OR e.filters->>'warehouseId' IS NULL OR (e.filters->>'warehouseId')::bigint=ANY($4::bigint[]))
      ORDER BY e.id DESC LIMIT $5`,[input.cursor ?? null,actor.role==='MANAGER',actor.id,actor.warehouses,input.limit+1]);
    const rows=result.rows.slice(0,input.limit);
    res.json({items:rows,nextCursor:result.rows.length>input.limit?rows.at(-1)?.id ?? null:null});
  });
  router.get('/exports/:id',requireRole('STAFF','MANAGER'),async(req,res) => {
    const exportId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT e.id::text,e.kind,e.format,e.filters,j.status,j.last_error_code AS "lastErrorCode",
      e.storage_key IS NOT NULL AS "ready" FROM orderflow.export_jobs e
      JOIN orderflow.background_jobs j ON j.id=e.job_id WHERE e.id=$1 AND (e.requested_by=$2 OR $3)`,
      [exportId,actor.id,actor.role==='MANAGER']);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Export not found.');
    if (found.rows[0].filters.warehouseId && !warehouseAllowed(actor,found.rows[0].filters.warehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    const {filters,...output}=found.rows[0];
    res.json(output);
  });
  router.get('/exports/:id/file',requireRole('STAFF','MANAGER'),async(req,res) => {
    const exportId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT e.storage_key,e.filters,j.status FROM orderflow.export_jobs e
      JOIN orderflow.background_jobs j ON j.id=e.job_id
      WHERE e.id=$1 AND (e.requested_by=$2 OR $3)`,[exportId,actor.id,actor.role==='MANAGER']);
    if (!found.rowCount) throw new AppError(404,'NOT_FOUND','Export not found.');
    if (found.rows[0].filters.warehouseId && !warehouseAllowed(actor,found.rows[0].filters.warehouseId))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
    if (found.rows[0].status!=='DONE' || !found.rows[0].storage_key)
      throw new AppError(409,'EXPORT_NOT_READY','Export is still processing.');
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="orderflow-${exportId}.csv"`);
    const source=await openStoredStream(config,found.rows[0].storage_key);
    source.on('error',error=>{
      if (!res.headersSent) res.status(500).end();else res.destroy(error);
    }).pipe(res);
  });
  return router;
}
