import pg from 'pg';
import type {RequestHandler} from 'express';
import type {Config} from './config.js';
import {AppError} from './errors.js';
import {withTransaction} from './db.js';
import {createReadStream} from 'node:fs';
import {parse} from 'csv-parse';

export function demoLimits(config:Config) {
  return {csvRows:config.DEMO_CSV_ROWS??200,csvBytes:config.DEMO_CSV_BYTES??256*1024,
    evidenceBytes:config.DEMO_EVIDENCE_BYTES??2*1024*1024,exportBytes:config.DEMO_EXPORT_BYTES??2*1024*1024,
    storageBytes:config.DEMO_STORAGE_BYTES??50*1024*1024,transferBytes:config.DEMO_TRANSFER_BYTES??1024*1024*1024,
    databaseBytes:config.DEMO_DATABASE_BYTES??200*1024*1024,cooldownSeconds:config.DEMO_JOB_COOLDOWN_SECONDS??10};
}
export function publicDemoInfo(config:Config) {
  if(!config.DEMO_MODE)return {enabled:false};
  return {enabled:true,accountChangesAllowed:false,notifications:'poll',limits:demoLimits(config),accounts:[
    {role:'MANAGER',email:'admin@example.com',password:config.DEMO_MANAGER_PASSWORD},
    {role:'STAFF',email:'staff@example.com',password:config.DEMO_STAFF_PASSWORD},
    {role:'VIEWER',email:'viewer@example.com',password:config.DEMO_VIEWER_PASSWORD},
  ]};
}
export async function checkDemoDatabase(db:pg.Pool|pg.PoolClient,config:Config) {
  if(!config.DEMO_MODE)return;
  const size=(await db.query('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes;
  if(BigInt(size)>=BigInt(demoLimits(config).databaseBytes))throw new AppError(429,'DEMO_DATABASE_LIMIT','The demo database is full. You can still browse existing data.');
}
export async function validateDemoCsv(config:Config,path:string) {
  if(!config.DEMO_MODE)return;
  let rows=0;
  try {
    for await(const _row of createReadStream(path).pipe(parse({bom:true,skip_empty_lines:true,relax_column_count:true,max_record_size:demoLimits(config).csvBytes}))) {
      if(++rows>demoLimits(config).csvRows+1)throw new AppError(413,'DEMO_CSV_ROWS',`CSV imports are limited to ${demoLimits(config).csvRows} rows in this demo.`);
    }
  } catch(error) {if(error instanceof AppError)throw error;throw new AppError(400,'DEMO_CSV_INVALID','The CSV file could not be read. Check its format and try again.');}
}
export function demoRequestGate(config:Config,account=false):RequestHandler {
  let minute=-1,total=0,logins=0;
  const accounts=new Map<string,number>();
  return (req,res,next)=>{
    if(!config.DEMO_MODE)return next();
    const now=Math.floor(Date.now()/60000);
    if(now!==minute){minute=now;total=0;logins=0;accounts.clear();}
    const actor=res.locals.actor;
    let exceeded=false;
    if(account && actor){const count=(accounts.get(actor.id)??0)+1;accounts.set(actor.id,count);exceeded=count>(config.DEMO_ACCOUNT_REQUESTS_PER_MINUTE??120);}
    if(!account){total++;exceeded=total>(config.DEMO_REQUESTS_PER_MINUTE??300);if(req.path==='/auth/login'){logins++;exceeded ||= logins>(config.DEMO_LOGINS_PER_MINUTE??20);}}
    if(exceeded){res.setHeader('Retry-After',String(60-Math.floor(Date.now()/1000)%60));return next(new AppError(429,'DEMO_REQUEST_LIMIT','Please slow down and try again shortly.'));}
    next();
  };
}
export const isDemoAccountChange=(method:string,path:string)=>!['GET','HEAD','OPTIONS'].includes(method) &&
  (path==='/auth/change-password' || path==='/users' || path.startsWith('/users/'));
export function demoWriteGate(pool:pg.Pool,config:Config):RequestHandler {
  return async(req,res,next)=>{
    if(!config.DEMO_MODE)return next();
    if(isDemoAccountChange(req.method,req.path))throw new AppError(403,'DEMO_ACCOUNT_PROTECTED','Account settings are read-only in this shared demo.');
    if(req.method==='GET' && req.path==='/notifications/stream')throw new AppError(403,'DEMO_POLL_NOTIFICATIONS','This demo checks notifications while you are active.');
    if(res.locals.actor && !['GET','HEAD','OPTIONS'].includes(req.method) && !['/auth/login','/auth/logout'].includes(req.path))await checkDemoDatabase(pool,config);
    next();
  };
}
export async function admitDemoJob(client:pg.PoolClient,config:Config,actorId:string) {
  if(!config.DEMO_MODE)return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('demo-job:'||$1,0))",[actorId]);
  const active=await client.query(`SELECT 1 FROM orderflow.background_jobs WHERE requested_by=$1
    AND kind IN ('IMPORT_VALIDATE','IMPORT_COMMIT','EXPORT_CSV') AND status IN ('PENDING','PROCESSING') LIMIT 1`,[actorId]);
  if(active.rowCount)throw new AppError(409,'DEMO_JOB_BUSY','This account already has a file job running. Wait for it to finish.');
  const recent=await client.query(`SELECT 1 FROM orderflow.demo_job_admissions WHERE actor_id=$1
    AND last_started_at>clock_timestamp()-($2::integer*interval '1 second')`,[actorId,demoLimits(config).cooldownSeconds]);
  if(recent.rowCount)throw new AppError(429,'DEMO_JOB_COOLDOWN',`Wait ${demoLimits(config).cooldownSeconds} seconds between file jobs. There is no daily job limit.`);
  await client.query(`INSERT INTO orderflow.demo_job_admissions(actor_id,last_started_at) VALUES($1,clock_timestamp())
    ON CONFLICT(actor_id) DO UPDATE SET last_started_at=excluded.last_started_at`,[actorId]);
}
function requirePool(pool:pg.Pool|undefined):pg.Pool {if(!pool)throw new AppError(503,'DEMO_STORAGE_NOT_READY','Demo file accounting is unavailable.');return pool;}
const accountingPools=new WeakMap<pg.Pool,pg.Pool>();
// Uploads may hold a business transaction while reserving durable usage. Keep
// two separate connections available so a busy business pool cannot deadlock it.
function accountingPool(pool:pg.Pool|undefined) {
  const primary=requirePool(pool);let accounting=accountingPools.get(primary);
  if(!accounting){accounting=new pg.Pool({...primary.options,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:1000,allowExitOnIdle:true,application_name:'orderflow-demo-accounting'});accountingPools.set(primary,accounting);}
  return accounting;
}
export async function closeDemoAccounting(pool:pg.Pool) {
  const accounting=accountingPools.get(pool);if(accounting){accountingPools.delete(pool);await accounting.end();}
}
async function locked<T>(pool:pg.Pool|undefined,work:(client:pg.PoolClient)=>Promise<T>) {
  return withTransaction(accountingPool(pool),async c=>{
    await c.query('SELECT pg_advisory_xact_lock(742019,12)');
    const state=await c.query('SELECT storage_initialized FROM orderflow.demo_state WHERE singleton');
    if(!state.rows[0]?.storage_initialized)throw new AppError(503,'DEMO_STORAGE_NOT_READY','Demo files are being prepared. Please try again shortly.');
    return work(c);
  });
}
async function transfer(c:pg.PoolClient,config:Config,bytes:number) {
  const usage=await c.query("SELECT bytes::text FROM orderflow.demo_transfer_usage WHERE month=date_trunc('month',now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date FOR UPDATE");
  if(BigInt(usage.rows[0]?.bytes??0)+BigInt(bytes)>BigInt(demoLimits(config).transferBytes))throw new AppError(429,'DEMO_TRANSFER_LIMIT','The demo file-transfer budget has been reached. You can still browse existing data.');
  await c.query(`INSERT INTO orderflow.demo_transfer_usage(month,bytes) VALUES(date_trunc('month',now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,$1)
    ON CONFLICT(month) DO UPDATE SET bytes=orderflow.demo_transfer_usage.bytes+excluded.bytes`,[bytes]);
}
export async function reserveDemoPublish(pool:pg.Pool|undefined,config:Config,key:string,bytes:number) {
  if(!config.DEMO_MODE)return;
  await locked(pool,async c=>{
    const existing=await c.query('SELECT bytes::text,state FROM orderflow.demo_storage_objects WHERE storage_key=$1',[key]);
    if(existing.rowCount && (Number(existing.rows[0].bytes)!==bytes || !['RESERVED','STORED'].includes(existing.rows[0].state)))throw new AppError(409,'DEMO_FILE_STATE','This file cannot be replaced.');
    if(!existing.rowCount){
      const total=(await c.query("SELECT coalesce(sum(bytes),0)::text AS bytes FROM orderflow.demo_storage_objects WHERE state IN ('RESERVED','STORED','DELETING')")).rows[0].bytes;
      if(BigInt(total)+BigInt(bytes)>BigInt(demoLimits(config).storageBytes))throw new AppError(429,'DEMO_STORAGE_LIMIT','The demo file storage is full. You can still browse existing data.');
      await c.query("INSERT INTO orderflow.demo_storage_objects(storage_key,bytes,state) VALUES($1,$2,'RESERVED')",[key,bytes]);
    }
    await transfer(c,config,bytes);
  });
}
export async function reserveDemoRead(pool:pg.Pool|undefined,config:Config,key:string) {
  if(!config.DEMO_MODE)return;
  await locked(pool,async c=>{
    const object=await c.query("SELECT bytes::text FROM orderflow.demo_storage_objects WHERE storage_key=$1 AND state='STORED'",[key]);
    if(!object.rowCount)throw new AppError(410,'FILE_MISSING','This demo file is no longer available.');
    await transfer(c,config,Number(object.rows[0].bytes));
  });
}
export async function markDemoStored(pool:pg.Pool|undefined,config:Config,key:string) {
  if(config.DEMO_MODE)await accountingPool(pool).query("UPDATE orderflow.demo_storage_objects SET state='STORED',updated_at=now() WHERE storage_key=$1 AND state='RESERVED'",[key]);
}
export async function beginDemoDelete(pool:pg.Pool|undefined,config:Config,key:string) {
  if(!config.DEMO_MODE)return true;
  return locked(pool,async c=>{
    const row=await c.query("UPDATE orderflow.demo_storage_objects SET state='DELETING',updated_at=now() WHERE storage_key=$1 AND state IN ('RESERVED','STORED','DELETING') RETURNING storage_key",[key]);
    return !!row.rowCount;
  });
}
export async function finishDemoDelete(pool:pg.Pool|undefined,config:Config,key:string) {
  if(config.DEMO_MODE)await accountingPool(pool).query("UPDATE orderflow.demo_storage_objects SET state='DELETED',updated_at=now() WHERE storage_key=$1",[key]);
}
