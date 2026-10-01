import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { Router, type Request } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireRole, warehouseAllowed, type Actor } from './auth.js';
import type { Config } from './config.js';
import { withTransaction } from './db.js';
import { AppError } from './errors.js';
import { prepareWrite, publishFile, removeStoredFile, storedFileExists, openStoredStream } from './storage.js';

const id=z.string().regex(/^[1-9]\d*$/);
const maxBytes=5*1024*1024;
type Target='discrepancy'|'stock-request';
type Database=pg.Pool|pg.PoolClient;
function actualType(bytes:Buffer):string|null {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if(bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255) return 'image/jpeg';
  if(bytes.subarray(0,5).toString('ascii')==='%PDF-') return 'application/pdf';
  return null;
}
async function receiveEvidence(req:Request,path:string) {
  if(!req.headers['content-type']?.startsWith('multipart/form-data;'))
    throw new AppError(415,'INVALID_CONTENT_TYPE','Upload a multipart PNG, JPEG, or PDF file.');
  return new Promise<{filename:string;contentType:string;sha256:string}>((done,fail) => {
    let parser:Busboy.Busboy;
    try {parser=Busboy({headers:req.headers,limits:{fileSize:maxBytes,files:1,fields:0,parts:2}});}
    catch {fail(new AppError(415,'INVALID_CONTENT_TYPE','Upload a multipart PNG, JPEG, or PDF file.'));return;}
    let saved:Promise<void>|null=null,filename='',limited=false,seen=false;
    parser.on('file',(field,file,info) => {
      seen=true;
      if(field!=='file' || !info.filename || info.filename.length>200) {
        limited=true;file.resume();return;
      }
      filename=info.filename.replace(/[^\w .-]/g,'_').slice(0,200);
      file.on('limit',()=>{limited=true;});
      saved=pipeline(file,createWriteStream(path,{flags:'wx'}));
    });
    parser.on('error',fail);
    parser.on('filesLimit',()=>{limited=true;});
    parser.on('fieldsLimit',()=>{limited=true;});
    parser.on('partsLimit',()=>{limited=true;});
    parser.on('close',() => {
      if(!seen || !saved) return fail(new AppError(400,'INVALID_UPLOAD','Provide one file in the file field.'));
      saved.then(async() => {
        if(limited) throw new AppError(413,'FILE_TOO_LARGE','Evidence must be one file of at most 5 MB.');
        const bytes=await readFile(path);
        const contentType=actualType(bytes);
        if(!contentType) throw new AppError(415,'UNSUPPORTED_FILE','Evidence must be PNG, JPEG, or PDF.');
        done({filename,contentType,sha256:createHash('sha256').update(bytes).digest('hex')});
      }).catch(fail);
    });
    req.on('aborted',()=>fail(new AppError(400,'UPLOAD_ABORTED','Upload was interrupted.')));
    req.pipe(parser);
  });
}
async function checkTarget(db:Database,target:Target,targetId:string,actor:Actor) {
  if(target==='discrepancy') {
    const found=await db.query(`SELECT t.source_warehouse_id::text AS source,
      t.destination_warehouse_id::text AS destination
      FROM orderflow.transfer_discrepancies d
      JOIN orderflow.transfer_items i ON i.id=d.transfer_item_id
      JOIN orderflow.transfers t ON t.id=i.transfer_id WHERE d.id=$1`,[targetId]);
    if(!found.rowCount) throw new AppError(404,'NOT_FOUND','Discrepancy not found.');
    if(!warehouseAllowed(actor,found.rows[0].source) &&
        !warehouseAllowed(actor,found.rows[0].destination))
      throw new AppError(403,'FORBIDDEN','Warehouse access is required.');
  } else {
    const found=await db.query(`SELECT warehouse_id::text AS "warehouseId",
      requested_by::text AS "requestedBy" FROM orderflow.stock_change_requests WHERE id=$1`,[targetId]);
    if(!found.rowCount) throw new AppError(404,'NOT_FOUND','Stock request not found.');
    if(actor.role!=='MANAGER' && (actor.id!==found.rows[0].requestedBy ||
        (found.rows[0].warehouseId && !warehouseAllowed(actor,found.rows[0].warehouseId))))
      throw new AppError(403,'FORBIDDEN','This request is not permitted.');
  }
}

export function evidenceRoutes(pool:pg.Pool,config:Config):Router {
  const router=Router();
  const targets:{path:string;type:Target;link:string;column:string}[]=[
    {path:'/evidence/discrepancies/:id',type:'discrepancy',
      link:'discrepancy_evidence',column:'discrepancy_id'},
    {path:'/evidence/stock-requests/:id',type:'stock-request',
      link:'stock_request_evidence',column:'request_id'},
  ];
  for(const target of targets) {
    router.get(target.path,requireRole('STAFF','MANAGER'),async(req,res) => {
      const targetId=id.parse(req.params.id),actor=res.locals.actor as Actor;
      await checkTarget(pool,target.type,targetId,actor);
      const found=await pool.query(`SELECT f.id::text,f.filename,f.content_type AS "contentType",
        f.sha256,f.created_at AS "createdAt",f.uploaded_by::text AS "uploadedBy"
        FROM orderflow.${target.link} link JOIN orderflow.evidence_files f ON f.id=link.file_id
        WHERE link.${target.column}=$1 ORDER BY f.id`,[targetId]);
      res.json({items:found.rows});
    });
    router.post(target.path,requireRole('STAFF','MANAGER'),async(req,res) => {
      const targetId=id.parse(req.params.id),actor=res.locals.actor as Actor;
      await checkTarget(pool,target.type,targetId,actor);
      const key=`evidence/${randomUUID()}.bin`,path=await prepareWrite(config,key);
      let metadata:{filename:string;contentType:string;sha256:string};
      try {metadata=await receiveEvidence(req,path);await publishFile(config,key);}
      catch(error) {await removeStoredFile(config,key).catch(()=>{});throw error;}
      try {
        const row=await withTransaction(pool,async c => {
          await checkTarget(c,target.type,targetId,actor);
          const inserted=await c.query(`INSERT INTO orderflow.evidence_files
            (uploaded_by,storage_key,filename,content_type,sha256) VALUES($1,$2,$3,$4,$5)
            RETURNING id::text,filename,content_type AS "contentType",sha256,
              created_at AS "createdAt"`,
            [actor.id,key,metadata.filename,metadata.contentType,metadata.sha256]);
          await c.query(`INSERT INTO orderflow.${target.link}(${target.column},file_id)
            VALUES($1,$2)`,[targetId,inserted.rows[0].id]);
          await c.query(`INSERT INTO orderflow.audit_events(actor_id,action,entity_type,entity_id)
            VALUES($1,'EVIDENCE_UPLOAD','evidence_file',$2)`,[actor.id,inserted.rows[0].id]);
          return inserted.rows[0];
        });
        res.status(201).json(row);
      } catch(error) {await removeStoredFile(config,key).catch(()=>{});throw error;}
    });
  }
  router.get('/evidence/:id/file',requireRole('STAFF','MANAGER'),async(req,res) => {
    const fileId=id.parse(req.params.id),actor=res.locals.actor as Actor;
    const found=await pool.query(`SELECT f.storage_key,f.filename,f.content_type,
      (SELECT discrepancy_id::text FROM orderflow.discrepancy_evidence WHERE file_id=f.id LIMIT 1) AS discrepancy,
      (SELECT request_id::text FROM orderflow.stock_request_evidence WHERE file_id=f.id LIMIT 1) AS request
      FROM orderflow.evidence_files f WHERE f.id=$1`,[fileId]);
    if(!found.rowCount) throw new AppError(404,'NOT_FOUND','Evidence not found.');
    const row=found.rows[0];
    if(row.discrepancy) await checkTarget(pool,'discrepancy',row.discrepancy,actor);
    else if(row.request) await checkTarget(pool,'stock-request',row.request,actor);
    else throw new AppError(404,'NOT_FOUND','Evidence not found.');
    if(!await storedFileExists(config,row.storage_key)) throw new AppError(410,'FILE_MISSING','Evidence file is unavailable.');
    res.attachment(row.filename);
    res.type(row.content_type);
    const source=await openStoredStream(config,row.storage_key);
    source.on('error',error=>{
      if(!res.headersSent) res.status(500).end();else res.destroy(error);
    }).pipe(res);
  });
  return router;
}
