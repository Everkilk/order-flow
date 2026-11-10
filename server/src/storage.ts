import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, rm, stat, readdir,readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from './config.js';
import type pg from 'pg';
import {beginDemoDelete,finishDemoDelete,markDemoStored,reserveDemoPublish,reserveDemoRead,demoLimits} from './demo-limits.js';
import {AppError} from './errors.js';

const keyPattern=/^(?:imports|exports)\/[0-9a-f-]{36}\.csv$|^evidence\/[0-9a-f-]{36}\.bin$/;
const clients=new Map<string,S3Client>();

function validKey(key:string) {
  if(!keyPattern.test(key)) throw new Error('Invalid storage key.');
  return key;
}

function s3(config:Config) {
  const region=config.AWS_REGION!;
  const endpoint=process.env.AWS_ENDPOINT_URL_S3;
  const clientKey=`${region}|${endpoint ?? ''}|${Boolean(config.DEMO_MODE)}`;
  let client=clients.get(clientKey);
  if(!client) {client=new S3Client({region,forcePathStyle:Boolean(endpoint),...(config.DEMO_MODE?{maxAttempts:1}:{})});clients.set(clientKey,client);}
  return client;
}

function bucket(config:Config) {return config.S3_BUCKET!;}

export function storagePath(config:Config,key:string) {
  return join(resolve(config.DATA_DIR),...validKey(key).split('/'));
}

export async function prepareWrite(config:Config,key:string) {
  const path=storagePath(config,key);
  await mkdir(join(resolve(config.DATA_DIR),key.split('/')[0]!),{recursive:true});
  return path;
}

export async function publishFile(config:Config,key:string,pool?:pg.Pool) {
  const path=storagePath(config,key);
  const bytes=(await stat(path)).size;
  if(config.DEMO_MODE){const limits=demoLimits(config);const maximum=key.startsWith('imports/')?limits.csvBytes:key.startsWith('exports/')?limits.exportBytes:limits.evidenceBytes;
    if(bytes>maximum)throw new AppError(413,'DEMO_FILE_TOO_LARGE','This file exceeds the demo size limit.');}
  await reserveDemoPublish(pool,config,key,bytes);
  if(config.STORAGE_DRIVER==='s3') {
    if(config.DEMO_MODE)await s3(config).send(new PutObjectCommand({Bucket:bucket(config),Key:validKey(key),Body:await readFile(path)}));
    else await new Upload({client:s3(config),params:{Bucket:bucket(config),Key:validKey(key),Body:createReadStream(path)},queueSize:2,partSize:8*1024*1024}).done();
    await rm(path,{force:true});
  }
  await markDemoStored(pool,config,key);
}

export async function withLocalFile<T>(config:Config,key:string,operation:(path:string)=>Promise<T>,pool?:pg.Pool):Promise<T> {
  const path=storagePath(config,key);
  await reserveDemoRead(pool,config,key);
  if(config.STORAGE_DRIVER!=='s3') return operation(path);
  await mkdir(join(resolve(config.DATA_DIR),key.split('/')[0]!),{recursive:true});
  const temporary=`${path}.${randomUUID()}.tmp`;
  try {
    let body: unknown;
    try {body=(await s3(config).send(new GetObjectCommand({Bucket:bucket(config),Key:validKey(key)}))).Body;}
    catch(error) {
      if(error instanceof Error && error.name==='NoSuchKey')
        throw Object.assign(new Error('Stored file is missing.'),{code:'ENOENT'});
      throw error;
    }
    if(!(body instanceof Readable)) throw new Error('Stored object is unavailable.');
    await pipeline(body,createWriteStream(temporary,{flags:'wx'}));
    return await operation(temporary);
  } finally {await rm(temporary,{force:true}).catch(()=>{});}
}

export async function storedFileExists(config:Config,key:string,pool?:pg.Pool) {
  if(config.DEMO_MODE) {
    if(!pool)return false;
    const row=await pool.query("SELECT 1 FROM orderflow.demo_storage_objects WHERE storage_key=$1 AND state='STORED'",[key]);
    if(!row.rowCount)return false;
  }
  if(config.STORAGE_DRIVER!=='s3') {
    try {await stat(storagePath(config,key));return true;} catch {return false;}
  }
  try {await s3(config).send(new HeadObjectCommand({Bucket:bucket(config),Key:validKey(key)}));return true;}
  catch(error) {
    if(error && typeof error==='object' && '$metadata' in error &&
      (error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404) return false;
    throw error;
  }
}

export async function removeStoredFile(config:Config,key:string,pool?:pg.Pool) {
  await rm(storagePath(config,key),{force:true}).catch(error=>{
    // S3 is authoritative there; an unavailable local cache must not block its deletion.
    if(config.STORAGE_DRIVER!=='s3') throw error;
  });
  if(!await beginDemoDelete(pool,config,key))return;
  if(config.STORAGE_DRIVER==='s3') await s3(config).send(new DeleteObjectCommand({Bucket:bucket(config),Key:validKey(key)}));
  await finishDemoDelete(pool,config,key);
}

export async function openStoredStream(config:Config,key:string,pool?:pg.Pool):Promise<Readable|ReadStream> {
  await reserveDemoRead(pool,config,key);
  if(config.STORAGE_DRIVER!=='s3') return createReadStream(storagePath(config,key));
  const body=(await s3(config).send(new GetObjectCommand({Bucket:bucket(config),Key:validKey(key)}))).Body;
  if(!(body instanceof Readable)) throw new Error('Stored object is unavailable.');
  return body;
}

export async function listStoredObjects(config:Config) {
  const files:{key:string;bytes:number;createdAt:Date}[]=[];
  for(const prefix of ['imports','exports','evidence']) {
    if(config.STORAGE_DRIVER!=='s3') {
      for(const entry of await readdir(join(resolve(config.DATA_DIR),prefix),{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;})) {
        const key=prefix+'/'+entry.name;if(!entry.isFile() || !keyPattern.test(key))continue;
        const info=await stat(storagePath(config,key));files.push({key,bytes:info.size,createdAt:info.mtime});
      }
    } else {
      let token:string|undefined;
      for(let page=0;page<100;page++) {
        const result=await s3(config).send(new ListObjectsV2Command({Bucket:bucket(config),Prefix:prefix+'/',ContinuationToken:token}));
        for(const item of result.Contents??[])if(item.Key && keyPattern.test(item.Key))files.push({key:item.Key,bytes:item.Size??0,createdAt:item.LastModified??new Date()});
        token=result.NextContinuationToken;if(!result.IsTruncated)break;
        if(page===99)throw new Error('Demo storage inventory is too large to initialize safely.');
      }
    }
  }
  return files;
}
