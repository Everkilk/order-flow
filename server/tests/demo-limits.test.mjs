import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import pg from 'pg';
import {localDatabaseUrl,migrate,quoteIdentifier} from '../scripts/db-lib.mjs';
import {createExample} from '../scripts/example-data.mjs';
import {readConfig} from '../dist/config.js';
import {createApp} from '../dist/app.js';
import {passwordHash} from '../dist/auth.js';
import {initializeDemoStorage,demoMaintenance} from '../dist/demo-maintenance.js';
import {prepareWrite,publishFile,removeStoredFile,openStoredStream} from '../dist/storage.js';
import {runOneJob} from '../dist/job-worker.js';
import {logger} from '../dist/errors.js';
import {closeDemoAccounting} from '../dist/demo-limits.js';
logger.level='silent';
const testRoot=resolve('../../.orderflow-qa');

let admin,pool,app,s3,base,config,directory,name,example,manager,requestId;
const servers=[],objects=new Map(),calls=[];
let failDeletes=false;
const passwords={MANAGER:'Demo-manager-test-2026',STAFF:'Demo-staff-test-2026',VIEWER:'Demo-viewer-test-2026'};
const emails={MANAGER:'admin@example.com',STAFF:'staff@example.com',VIEWER:'viewer@example.com'};
const existingKey=`evidence/${randomUUID()}.bin`;
const oldEnv={endpoint:process.env.AWS_ENDPOINT_URL_S3,access:process.env.AWS_ACCESS_KEY_ID,secret:process.env.AWS_SECRET_ACCESS_KEY};
const start=async server=>{server.listen(0,'127.0.0.1');await once(server,'listening');servers.push(server);return 'http://127.0.0.1:'+server.address().port;};
async function request(path,method='GET',body,cookie=manager,key){const r=await fetch(base+path,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(key?{'Idempotency-Key':key}:{}),...(body && !(body instanceof FormData)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});return {status:r.status,data:r.status===204?null:await r.json(),headers:r.headers};}
async function login(role='MANAGER'){const r=await request('/api/auth/login','POST',{email:emails[role],password:passwords[role]},'');assert.equal(r.status,200);assert.equal(r.data.user.role,role);return r.headers.get('set-cookie').split(';')[0];}
async function settle(){await pool.query("UPDATE orderflow.background_jobs SET status='DONE',lease_until=NULL WHERE status IN ('PENDING','PROCESSING')");await pool.query("UPDATE orderflow.demo_job_admissions SET last_started_at=now()-interval '1 minute'");}
const csv=(count=1)=>'sku,name,category_id,unit_id,barcode,description,selling_price,selling_currency,attributes_json\n'+Array.from({length:count},(_,i)=>`D-${randomUUID()}-${i},Demo,${example.category},${example.unit},,,,,"{""screen_size_inches"":6.1}"`).join('\n')+'\n';
function upload(text,filename='demo.csv'){const form=new FormData();form.set('file',new Blob([text]),filename);return form;}
before(async()=>{
 const u=localDatabaseUrl(),a=new URL(u);a.pathname='/postgres';admin=new pg.Client({connectionString:a.toString()});await admin.connect();name='orderflow_demo_limits_'+randomUUID().replaceAll('-','').slice(0,12);await admin.query('CREATE DATABASE '+quoteIdentifier(name));u.pathname='/'+name;pool=new pg.Pool({connectionString:u.toString(),max:10});const c=await pool.connect();try{await migrate(c,()=>{});example=await createExample(c,undefined,false);}finally{c.release();}
 for(const role of Object.keys(passwords))await pool.query('INSERT INTO orderflow.users(email,display_name,password_hash,role,must_change_password) VALUES($1,$2,$3,$2,false)',[emails[role],role,await passwordHash(passwords[role])]);
 const id=(await pool.query("SELECT id FROM orderflow.users WHERE email='admin@example.com'")).rows[0].id;
 requestId=(await pool.query("INSERT INTO orderflow.stock_change_requests(request_type,warehouse_id,product_id,requested_by,requested_delta,reason) VALUES('DAMAGE',$1,$2,$3,-1,'Demo test') RETURNING id",[example.warehouse,example.product,id])).rows[0].id;
 objects.set(existingKey,Buffer.from('stored'));
 s3=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');const key=decodeURIComponent(url.pathname).replace(/^\/demo\.test\//,'');calls.push({method:req.method,key});
  if(url.searchParams.has('list-type')){const prefix=url.searchParams.get('prefix');res.writeHead(200,{'Content-Type':'application/xml'}).end('<ListBucketResult><IsTruncated>false</IsTruncated>'+[...objects].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>`<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>${new Date().toISOString()}</LastModified></Contents>`).join('')+'</ListBucketResult>');return;}
  if(req.method==='PUT'){const chunks=[];for await(const b of req)chunks.push(b);objects.set(key,Buffer.concat(chunks));res.writeHead(200,{ETag:'"test"'}).end();return;}
  if(req.method==='DELETE'){if(failDeletes){res.writeHead(503,{'Content-Type':'application/xml'}).end('<Error><Code>ServiceUnavailable</Code></Error>');return;}objects.delete(key);res.writeHead(204).end();return;}
  const bytes=objects.get(key);if(!bytes){res.writeHead(404,{'Content-Type':'application/xml'}).end('<Error><Code>NoSuchKey</Code></Error>');return;}res.writeHead(200,{'Content-Length':bytes.length});res.end(req.method==='HEAD'?undefined:bytes);
 });
 process.env.AWS_ENDPOINT_URL_S3=await start(s3);process.env.AWS_ACCESS_KEY_ID='test';process.env.AWS_SECRET_ACCESS_KEY='test';
 await mkdir(testRoot,{recursive:true});directory=await mkdtemp(join(testRoot,'demo-limits-'));
 config=readConfig({DATABASE_URL:u.toString(),DATA_DIR:directory,NODE_ENV:'test',STORAGE_DRIVER:'s3',S3_BUCKET:'demo.test',AWS_REGION:'us-east-1',DEMO_MODE:'true',DEMO_MANAGER_PASSWORD:passwords.MANAGER,DEMO_STAFF_PASSWORD:passwords.STAFF,DEMO_VIEWER_PASSWORD:passwords.VIEWER,DEMO_REQUESTS_PER_MINUTE:'10000',DEMO_ACCOUNT_REQUESTS_PER_MINUTE:'10000',DEMO_LOGINS_PER_MINUTE:'1000'});
 await initializeDemoStorage(pool,config);app=createApp(pool,config);base=await start(createServer(app));manager=await login();
});
after(async()=>{
 for(const server of servers.reverse())await new Promise(r=>server.close(r));
 if(pool){await closeDemoAccounting(pool);await pool.end();}if(admin){if(name)await admin.query('DROP DATABASE '+quoteIdentifier(name));await admin.end();}
 for(const [key,value]of Object.entries({AWS_ENDPOINT_URL_S3:oldEnv.endpoint,AWS_ACCESS_KEY_ID:oldEnv.access,AWS_SECRET_ACCESS_KEY:oldEnv.secret})){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 if(directory && resolve(directory).startsWith(testRoot+sep))await rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:100});
});

test('demo is opt-in, publishes only intended accounts, preserves logins and accounts for pre-existing storage',async()=>{
 const ordinary=readConfig({DATABASE_URL:config.DATABASE_URL});assert.equal(ordinary.DEMO_MODE,false);
 const info=await request('/api/demo-info');assert.equal(info.status,200);assert.equal(info.data.accounts.length,3);assert.equal(info.data.accounts[0].password,passwords.MANAGER);assert(!JSON.stringify(info.data).includes('AWS_ACCESS'));
 for(const role of ['STAFF','VIEWER']){const cookie=await login(role);assert.equal((await request('/api/auth/me','GET',undefined,cookie)).data.user.role,role);await request('/api/auth/logout','POST',undefined,cookie);}
 assert.equal((await pool.query('SELECT bytes::int FROM orderflow.demo_storage_objects WHERE storage_key=$1',[existingKey])).rows[0].bytes,6);
});
test('account mutations and notification streams are blocked before work is performed',async()=>{
 const before=(await pool.query('SELECT email,password_hash,role,active FROM orderflow.users ORDER BY id')).rows;
 for(const [method,path,body]of [['POST','/api/users',{email:'new@example.com',password:'anything'}],['PATCH','/api/users/1',{active:false}],['PUT','/api/users/1/warehouses',{warehouseIds:[]}],['POST','/api/users/1/reset-password',{temporaryPassword:'Changed-test-password'}],['POST','/api/auth/change-password',{currentPassword:passwords.MANAGER,newPassword:'Changed-test-password'}]])assert.equal((await request(path,method,body)).data.error.code,'DEMO_ACCOUNT_PROTECTED');
 assert.deepEqual((await pool.query('SELECT email,password_hash,role,active FROM orderflow.users ORDER BY id')).rows,before);
 assert.equal((await request('/api/notifications/stream')).data.error.code,'DEMO_POLL_NOTIFICATIONS');
});
test('CSV boundaries and replays are enforced before S3, including simultaneous retries',async()=>{
 await settle();let puts=calls.filter(x=>x.method==='PUT').length;
 assert.equal((await request('/api/imports/products','POST',upload(csv(201)),manager,randomUUID())).status,413);
 assert.equal((await request('/api/imports/products','POST',upload('x'.repeat(256*1024+1)),manager,randomUUID())).status,413);
 assert.equal(calls.filter(x=>x.method==='PUT').length,puts);
 const key=randomUUID(),text=csv(200);
 const pair=await Promise.all([request('/api/imports/products','POST',upload(text),manager,key),request('/api/imports/products','POST',upload(text),manager,key)]);
 assert(pair.every(x=>x.status===202));assert.equal(pair[0].data.id,pair[1].data.id);assert.equal(calls.filter(x=>x.method==='PUT').length,puts+1);
 assert.equal((await request('/api/exports','POST',{kind:'PRODUCTS'},manager,randomUUID())).data.error.code,'DEMO_JOB_BUSY');
 await runOneJob(pool,config);assert.equal((await request('/api/imports/'+pair[0].data.id)).data.status,'READY');assert.equal((await request('/api/exports','POST',{kind:'PRODUCTS'},manager,randomUUID())).data.error.code,'DEMO_JOB_COOLDOWN');
 await pool.query("UPDATE orderflow.demo_job_admissions SET last_started_at=now()-interval '1 minute'");
 assert.equal((await request('/api/imports/'+pair[0].data.id+'/commit','POST',{},manager,pair[0].data.commitKey)).status,202);await runOneJob(pool,config);assert.equal((await request('/api/imports/'+pair[0].data.id)).data.status,'COMMITTED');
 await settle();
 const header='sku,name\n',exact=header+'x'.repeat(256*1024-header.length-1)+'\n';
 assert.equal((await request('/api/imports/products','POST',upload(exact),manager,randomUUID())).status,202);await settle();
});
test('evidence accepts exactly 2 MB and rejects the next byte without a storage request',async()=>{
 const valid=Buffer.alloc(2*1024*1024);Buffer.from([137,80,78,71,13,10,26,10]).copy(valid);
 const before=calls.length;const tooLarge=Buffer.concat([valid,Buffer.from([0])]);
 assert.equal((await request('/api/evidence/stock-requests/'+requestId,'POST',upload(tooLarge,'large.png'),manager,randomUUID())).status,413);assert.equal(calls.length,before);
 const good=await request('/api/evidence/stock-requests/'+requestId,'POST',upload(valid,'valid.png'),manager,randomUUID());assert.equal(good.status,201);
});
test('storage and transfer reservations survive new pools and serialize concurrent writes',async()=>{
 const used=Number((await pool.query("SELECT sum(bytes)::text AS bytes FROM orderflow.demo_storage_objects WHERE state IN ('RESERVED','STORED','DELETING')")).rows[0].bytes);
 const limited={...config,DEMO_STORAGE_BYTES:used+5};const keys=[`exports/${randomUUID()}.csv`,`exports/${randomUUID()}.csv`];
 for(const key of keys)await writeFile(await prepareWrite(limited,key),'12345');
 const before=calls.filter(x=>x.method==='PUT').length;const race=await Promise.allSettled(keys.map(k=>publishFile(limited,k,pool)));assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(calls.filter(x=>x.method==='PUT').length,before+1);
 const second=new pg.Pool({connectionString:config.DATABASE_URL});try{const key=`exports/${randomUUID()}.csv`;await writeFile(await prepareWrite(limited,key),'12345');await assert.rejects(publishFile(limited,key,second),e=>e.code==='DEMO_STORAGE_LIMIT');}finally{await closeDemoAccounting(second);await second.end();}
 const gets=calls.filter(x=>x.method==='GET').length;await assert.rejects(openStoredStream({...config,DEMO_TRANSFER_BYTES:1},existingKey,pool),e=>e.code==='DEMO_TRANSFER_LIMIT');assert.equal(calls.filter(x=>x.method==='GET').length,gets);
 assert.equal((await request('/api/products')).status,200);
});
test('file accounting completes even when every business connection is occupied',async()=>{
 const held=await Promise.all(Array.from({length:10},()=>pool.connect()));let timer;
 try{const key=`exports/${randomUUID()}.csv`;await writeFile(await prepareWrite(config,key),'ok');await Promise.race([publishFile(config,key,pool),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('File accounting waited on the business pool')),1500)})]);assert(objects.has(key));}
 finally{clearTimeout(timer);for(const client of held)client.release();}
});
test('database limits retain browsing/login, sessions stay bounded, and throttles are enforced',async()=>{
 const limit=config.DEMO_DATABASE_BYTES;config.DEMO_DATABASE_BYTES=1;
 try{assert.equal((await request('/api/categories','POST',{name:'Blocked'})).data.error.code,'DEMO_DATABASE_LIMIT');assert.equal((await request('/api/products')).status,200);manager=await login();}finally{config.DEMO_DATABASE_BYTES=limit;}
 for(let i=0;i<8;i++)manager=await login();
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM orderflow.sessions s JOIN orderflow.users u ON u.id=s.user_id WHERE u.email='admin@example.com'")).rows[0].n,6);
 const saved=base;base=await start(createServer(createApp(pool,{...config,DEMO_REQUESTS_PER_MINUTE:2})));
 try{assert.equal((await request('/api/demo-info')).status,200);assert.equal((await request('/api/demo-info')).status,200);assert.equal((await request('/api/demo-info')).status,429);}finally{base=saved;}
});
test('exports enforce output limits and expiry; cleanup retries retain storage charges and preserve active evidence',async()=>{
 await settle();const original=config.DEMO_EXPORT_BYTES;config.DEMO_EXPORT_BYTES=1;const puts=calls.filter(x=>x.method==='PUT').length;
 const big=await request('/api/exports','POST',{kind:'PRODUCTS'},manager,randomUUID());assert.equal(big.status,202);await runOneJob(pool,config);config.DEMO_EXPORT_BYTES=original;
 const error=(await request('/api/exports/'+big.data.id)).data;assert.equal(error.status,'DEAD');assert.equal(error.lastErrorCode,'DEMO_EXPORT_TOO_LARGE');assert.equal(calls.filter(x=>x.method==='PUT').length,puts);
 await settle();const out=await request('/api/exports','POST',{kind:'PRODUCTS'},manager,randomUUID());await runOneJob(pool,config);
 await pool.query("UPDATE orderflow.export_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",[out.data.id]);const key=(await pool.query('SELECT storage_key FROM orderflow.export_jobs WHERE id=$1',[out.data.id])).rows[0].storage_key;
 const gets=calls.filter(x=>x.method==='GET').length;assert.equal((await request('/api/exports/'+out.data.id+'/file')).status,410);assert.equal(calls.filter(x=>x.method==='GET').length,gets);
 await pool.query('UPDATE orderflow.demo_state SET maintenance_at=NULL');await demoMaintenance(pool,config);failDeletes=true;await runOneJob(pool,config);
 assert.equal((await pool.query('SELECT state FROM orderflow.demo_storage_objects WHERE storage_key=$1',[key])).rows[0].state,'DELETING');assert(objects.has(key));
 failDeletes=false;await pool.query("UPDATE orderflow.background_jobs SET available_at=now() WHERE status='PENDING'");await runOneJob(pool,config);assert(!objects.has(key));assert.equal((await pool.query('SELECT state FROM orderflow.demo_storage_objects WHERE storage_key=$1',[key])).rows[0].state,'DELETED');
 assert.equal((await pool.query("SELECT count(*)::int AS n FROM orderflow.demo_storage_objects o JOIN orderflow.evidence_files f ON f.storage_key=o.storage_key WHERE o.state='STORED'")).rows[0].n,1);
});
test('more than thirty successful file jobs in a day are allowed',async()=>{
 for(let i=0;i<35;i++){await settle();const row=await request('/api/exports','POST',{kind:'PRODUCTS'},manager,randomUUID());assert.equal(row.status,202);await runOneJob(pool,config);assert.equal((await request('/api/exports/'+row.data.id)).data.status,'DONE');}
});
