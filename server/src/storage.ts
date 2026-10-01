import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Config } from './config.js';

const keyPattern=/^(?:imports|exports)\/[0-9a-f-]{36}\.csv$|^evidence\/[0-9a-f-]{36}\.bin$/;
const clients=new Map<string,S3Client>();

function validKey(key:string) {
  if(!keyPattern.test(key)) throw new Error('Invalid storage key.');
  return key;
}

function s3(config:Config) {
  const region=config.AWS_REGION!;
  const endpoint=process.env.AWS_ENDPOINT_URL_S3;
  const clientKey=`${region}|${endpoint ?? ''}`;
  let client=clients.get(clientKey);
  if(!client) {client=new S3Client({region,forcePathStyle:Boolean(endpoint)});clients.set(clientKey,client);}
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

export async function publishFile(config:Config,key:string) {
  if(config.STORAGE_DRIVER!=='s3') return;
  const path=storagePath(config,key);
  await new Upload({client:s3(config),params:{Bucket:bucket(config),Key:validKey(key),Body:createReadStream(path)},queueSize:2,partSize:8*1024*1024}).done();
  await rm(path,{force:true});
}

export async function withLocalFile<T>(config:Config,key:string,operation:(path:string)=>Promise<T>):Promise<T> {
  const path=storagePath(config,key);
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

export async function storedFileExists(config:Config,key:string) {
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

export async function removeStoredFile(config:Config,key:string) {
  await rm(storagePath(config,key),{force:true}).catch(()=>{});
  if(config.STORAGE_DRIVER==='s3') await s3(config).send(new DeleteObjectCommand({Bucket:bucket(config),Key:validKey(key)}));
}

export async function openStoredStream(config:Config,key:string):Promise<Readable|ReadStream> {
  if(config.STORAGE_DRIVER!=='s3') return createReadStream(storagePath(config,key));
  const body=(await s3(config).send(new GetObjectCommand({Bucket:bucket(config),Key:validKey(key)}))).Body;
  if(!(body instanceof Readable)) throw new Error('Stored object is unavailable.');
  return body;
}
