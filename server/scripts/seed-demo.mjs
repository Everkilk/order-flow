import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';
import { Decimal } from 'decimal.js';
import * as data from './demo-dataset.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const definition=hash([data.version,data.categories,data.units,data.warehouses,data.suppliers,data.accounts,data.products,data.opening,data.receipts,data.orders,data.returns,data.transfers,data.requests,data.thresholds,data.limits]);
const cleanRecord=value=>{
  if(Array.isArray(value)) return value.map(cleanRecord);
  if(!value || typeof value!=='object') return value;
  const omit=new Set(['createdAt','postedAt','decidedAt','generatedAt','stock','returnedQty','returnableQty']);
  return Object.fromEntries(Object.entries(value).filter(([key])=>!omit.has(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,cleanRecord(item)]));
};
export function validateTarget(target) {
  const url=new URL(target);
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.username || url.password || url.search || url.hash || url.pathname!=='/' || (!local && (url.protocol!=='https:' || url.hostname!=='order-flow-khaki-phi.vercel.app')))
    throw new Error('Unsupported demo target. Use the known demo origin or a local API origin.');
  if(local && !['http:','https:'].includes(url.protocol)) throw new Error('Unsupported protocol.');
  return {origin:url.origin,local};
}

export async function seedDemo(options) {
  if(!options.apply) return {dryRun:true,...data.datasetSummary(),balances:data.expectedBalances()};
  const target=validateTarget(options.target);
  if(options.dataset!==data.version) throw new Error('Explicit --dataset DEMO-V2 is required.');
  if(!target.local && !options.freeTierConfirmed) throw new Error('Verify current free-tier capacity before applying hosted demo data.');
  if(!options.checkpoint) throw new Error('A checkpoint path is required.');
  const passwords=options.passwords;
  if(!passwords?.admin || data.accounts.some(account=>typeof passwords[account.key]!=='string' || passwords[account.key].length<12))
    throw new Error('Supply the administrator password and all three demo passwords privately. Demo passwords need at least 12 characters.');
  const checkpointPath=resolve(options.checkpoint);
  let checkpoint;
  try { checkpoint=JSON.parse(await readFile(checkpointPath,'utf8')); }
  catch(error) { if(error.code!=='ENOENT') throw error; }
  checkpoint ??= {version:data.version,target:target.origin,definition,steps:{},records:{},commands:{},requests:0,jobs:0,uploadedBytes:0};
  if(checkpoint.version!==data.version || checkpoint.target!==target.origin || checkpoint.definition!==definition) throw new Error('Checkpoint target or dataset mismatch.');
  if(checkpoint.pending) throw new Error(`Ambiguous operation ${checkpoint.pending}. Inspect its original result before recovery; no operation was repeated.`);
  const sessions=new Map(),started=Date.now();
  let writes=0,completed=0,runRequests=0,warehouseIds=[],outcome;
  const save=async()=>{
    await mkdir(dirname(checkpointPath),{recursive:true});
    await writeFile(checkpointPath+'.tmp',JSON.stringify(checkpoint,null,2));
    await rename(checkpointPath+'.tmp',checkpointPath);
  };
  const budget=()=>{
    if(runRequests>=data.limits.requests || (!target.local && checkpoint.requests>=data.limits.requests) || Date.now()-started>=data.limits.durationMs) throw new Error('Demo request/time ceiling reached. Stop and reassess capacity.');
  };
  async function request(actor,path,method='GET',body,key,expected,format='json') {
    budget();checkpoint.requests++;runRequests++;
    const headers={Origin:options.origin ?? target.origin};
    if(sessions.get(actor)) headers.Cookie=sessions.get(actor);
    if(key) headers['Idempotency-Key']=key;
    if(body!==undefined && !(body instanceof FormData)) headers['Content-Type']='application/json';
    const response=await fetch(target.origin+'/api'+path,{method,headers,body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(target.local?15000:60000),redirect:'error'});
    const cookie=response.headers.get('set-cookie');
    if(cookie) sessions.set(actor,cookie.split(';')[0]);
    const result=response.status===204?null:format==='file' && response.ok?Buffer.from(await response.arrayBuffer()):await response.json();
    if(expected!==undefined) {
      if(response.status!==expected) throw new Error(`${method} ${path} expected ${expected}, received ${response.status}.`);
      return result;
    }
    if(!response.ok) throw new Error(`${method} ${path} failed (${response.status}, ${result?.error?.code ?? 'REQUEST_FAILED'}).`);
    if(method!=='GET') writes++;
    return result;
  }
  async function list(actor,path) {
    const items=[];let cursor;
    do {
      const query=new URLSearchParams({limit:'100',...(cursor?{cursor}:{})});
      const result=await request(actor,`${path}${path.includes('?')?'&':'?'}${query}`);
      items.push(...result.items);cursor=result.nextCursor;
    } while(cursor);
    return items;
  }
  async function step(name,operation) {
    if(Object.hasOwn(checkpoint.steps,name)) return checkpoint.steps[name];
    checkpoint.pending=name;await save();
    const result=await operation();
    checkpoint.steps[name]=result ?? null;delete checkpoint.pending;await save();
    completed++;
    if(options.stopAfter && completed>=options.stopAfter) throw new Error('Controlled stop between completed steps. Resume with the same checkpoint.');
    return result;
  }
  async function remember(path) {
    const record=await request('admin',path);
    checkpoint.records[path]=hash(cleanRecord(record));await save();
    return record;
  }
  const keyFor=name=>checkpoint.commands[name] ??= randomUUID();
  async function command(name,actor,path,body={}) {
    const [kind,indexText]=name.split(':'),index=Number(indexText);
    const touched=kind==='receipt'?[data.receipts[index].warehouse]:kind==='order'?data.orders[index].items.map(line=>line.warehouse)
      :kind==='return'?[data.returns[index].warehouse]:kind==='transfer'?[data.transfers[index].source,data.transfers[index].destination]
      :kind==='request'?[data.requests[index].warehouse]:[];
    return step(name,async()=>{
      const result=await request(actor,path,'POST',body,keyFor(name));
      const documentPath=kind==='transfer'?`/transfers/${checkpoint.steps[`transfers:${index}:create`].id}`:path.split('/').slice(0,-1).join('/');
      await remember(documentPath);
      for(const warehouse of new Set(touched)) await remember(`/stock?warehouseId=${warehouseIds[warehouse]}&limit=100`);
      return result;
    });
  }
  async function importCsv(name,actor,kind,csv) {
    const bytes=Buffer.byteLength(csv);
    if(bytes>data.limits.fileBytes) throw new Error('Demo CSV exceeds file ceiling.');
    const imported=await step(name+':upload',async()=>{
      if(checkpoint.jobs>=data.limits.jobs || checkpoint.uploadedBytes+bytes>data.limits.totalFileBytes) throw new Error('Demo file/job ceiling reached.');
      checkpoint.jobs++;checkpoint.uploadedBytes+=bytes;await save();
      const form=new FormData();form.set('file',new Blob([csv],{type:'text/csv'}),name+'.csv');
      return request(actor,`/imports/${kind}`,'POST',form);
    });
    async function wait(states) {
      for(let attempt=0;attempt<30;attempt++) {
        await options.tick?.();
        const result=await request(actor,`/imports/${imported.id}`);
        if(states.includes(result.status)) return result;
        if(['INVALID','FAILED'].includes(result.status) || result.jobStatus==='DEAD') throw new Error(`Demo import ${imported.id} ended in ${result.status}.`);
        await new Promise(resolve=>setTimeout(resolve,target.local?50:2000));
      }
      throw new Error(`Import ${imported.id} is still running; keep its original checkpoint and inspect that job.`);
    }
    const validated=await wait(['READY','COMMITTED']);
    if(validated.status!=='COMMITTED') await step(name+':commit',()=>request(actor,`/imports/${imported.id}/commit`,'POST',{},validated.commitKey));
    await wait(['COMMITTED']);
    return imported;
  }
  try {
    const admin=await request('admin','/auth/login','POST',{email:options.adminEmail ?? 'admin@example.com',password:passwords.admin});
    if(admin.user.role!=='MANAGER' || admin.user.mustChangePassword) throw new Error('An activated Manager account is required.');
    // Verify recorded documents before performing any new work. Never overwrite tester edits.
    for(const [path,fingerprint] of Object.entries(checkpoint.records)) {
      const record=await request('admin',path);
      if(hash(cleanRecord(record))!==fingerprint) throw new Error(`Demo record changed: ${path}. Inspect tester changes before continuing.`);
    }
    const known={};
    for(const path of ['/categories','/units','/warehouses','/suppliers']) known[path]=(await request('admin',path)).items;
    const existingUsers=await list('admin','/users');
    const existingProducts=await list('admin','/products?q='+encodeURIComponent(data.version+'-'));
    if(!Object.keys(checkpoint.steps).length && (existingProducts.length || Object.values(known).flat().some(row=>row.code?.startsWith(data.version) || row.name?.startsWith(data.version))))
      throw new Error('Dataset namespace already exists without this checkpoint. Inspect it before applying.');
    for(const account of data.accounts) {
      const collision=existingUsers.find(user=>user.email.toLowerCase()===account.email);
      const saved=checkpoint.steps['account:'+account.key];
      if(collision && (!saved || saved.id!==collision.id || collision.role!==account.role || collision.displayName!==account.displayName || !collision.active))
        throw new Error(`Account collision: ${account.email}. No account was reset or replaced.`);
    }
    const ids={categories:[],units:{},warehouses:[],suppliers:[],products:[],accounts:{},orders:[],receipts:[],returns:[],transfers:[],requests:[]};
    for(const [plural,definitions] of [['categories',data.categories],['units',data.units],['warehouses',data.warehouses],['suppliers',data.suppliers]]) {
      for(let i=0;i<definitions.length;i++) {
        const definition=definitions[i],{key,...input}=definition;
        const wasSaved=Object.hasOwn(checkpoint.steps,`reference:${plural}:${i}`);
        const result=await step(`reference:${plural}:${i}`,()=>request('admin','/'+plural,'POST',input));
        const existing=known['/'+plural].find(row=>row.id===result.id);
        if(existing && Object.entries(input).some(([field,value])=>existing[field]!==value)) throw new Error(`Demo reference changed: ${plural}/${result.id}.`);
        if(wasSaved && !existing) throw new Error('Saved demo reference is missing or inactive.');
        if(plural==='units') ids.units[key]=result.id;
        else ids[plural][i]=result.id;
      }
    }
    warehouseIds=ids.warehouses;
    for(let i=0;i<data.categories.length;i++) {
      for(const attribute of data.attributes) await step(`attribute:${i}:${attribute.key}`,()=>request('admin',`/categories/${ids.categories[i]}/attributes`,'POST',attribute));
      await remember(`/categories/${ids.categories[i]}/attributes`);
    }
    for(const account of data.accounts) {
      const temporary=passwords[account.key]+'-setup-'+hash([data.version,target.origin,account.email]).slice(0,8);
      const created=await step('account:'+account.key,()=>request('admin','/users','POST',{email:account.email,displayName:account.displayName,role:account.role,password:temporary}));
      ids.accounts[account.key]=created.id;
      await step('access:'+account.key,()=>request('admin',`/users/${created.id}/warehouses`,'PUT',{warehouseIds:account.warehouses.map(i=>ids.warehouses[i])}));
      // This activation follows the same password policy and session revocation as the UI.
      if(!checkpoint.steps['activated:'+account.key]) {
        const login=await request(account.key,'/auth/login','POST',{email:account.email,password:temporary});
        if(!login.user.mustChangePassword) throw new Error('Unexpected activation state; inspect this account.');
        await step('activated:'+account.key,async()=>{await request(account.key,'/auth/change-password','POST',{currentPassword:temporary,newPassword:passwords[account.key]});return {id:created.id};});
      }
      const ready=await request(account.key,'/auth/login','POST',{email:account.email,password:passwords[account.key]});
      if(ready.user.mustChangePassword || ready.user.role!==account.role) throw new Error(`Account ${account.email} is not ready to use.`);
    }
    const productCsv=stringify(data.products.map(p=>[p.sku,p.name,ids.categories[p.category],ids.units[p.unit],p.barcode,p.description,p.sellingPrice,p.sellingCurrency,JSON.stringify(p.attributes)]),
      {header:true,columns:['sku','name','category_id','unit_id','barcode','description','selling_price','selling_currency','attributes_json']});
    await importCsv('demo-products','admin','products',productCsv);
    const importedProducts=await list('admin','/products?q='+encodeURIComponent(data.version+'-'));
    if(importedProducts.length!==data.products.length) throw new Error('Demo product count does not match its manifest.');
    for(const p of data.products) {
      const found=importedProducts.find(row=>row.sku===p.sku);
      if(!found || found.name!==p.name) throw new Error('Demo product identity mismatch.');
      ids.products[p.index]=found.id;
      if(!p.unvalued) await step('supplier-link:'+p.index,()=>request('admin',`/products/${found.id}/suppliers/${ids.suppliers[p.supplier]}`,'PUT',{primarySupplier:true,cost:p.cost,currency:p.currency,supplierSku:p.sku}));
      await remember(`/products/${found.id}`);
    }
    for(const threshold of data.thresholds) await step(`threshold:${threshold.product}`,()=>request('admin',`/warehouses/${ids.warehouses[threshold.warehouse]}/thresholds/${ids.products[threshold.product]}`,'PUT',{threshold:threshold.threshold,criticalThreshold:threshold.criticalThreshold}));
    const openingCsv=stringify(data.opening.flatMap(doc=>doc.items.map(line=>[doc.number,ids.warehouses[doc.warehouse],data.products[line.product].sku,line.quantity,data.products[line.product].cost,data.products[line.product].currency])),
      {header:true,columns:['receipt_number','warehouse_id','sku','quantity','unit_cost','currency']});
    await importCsv('demo-opening','admin','opening-stock',openingCsv);
    for(const warehouseId of warehouseIds) await remember(`/stock?warehouseId=${warehouseId}&limit=100`);
    const receiptIndex=await list('admin','/receipts');
    for(const doc of data.opening) {
      const found=receiptIndex.find(row=>row.receiptNumber===doc.number);
      if(!found || found.status!=='POSTED') throw new Error('Opening receipt missing or incomplete.');
      ids.receipts.push(found.id);await remember(`/receipts/${found.id}`);
    }
    const priceLine=line=>({productId:ids.products[line.product],quantity:line.quantity,unitCost:data.products[line.product].cost,currency:data.products[line.product].currency});
    async function document(kind,doc,index,input,items,owner=doc.actor) {
      const record=await step(`${kind}:${index}:create`,async()=>{
        const result=await request(owner,'/'+kind,'POST',input);
        await remember(`/${kind}/${result.id}`);return result;
      });
      await step(`${kind}:${index}:items`,async()=>{
        const result=await request(owner,`/${kind}/${record.id}/items`,'PUT',{expectedRevision:0,items});
        await remember(`/${kind}/${record.id}`);return result;
      });
      return record.id;
    }
    for(let i=0;i<data.receipts.length;i++) {
      const doc=data.receipts[i];
      const id=await document('receipts',doc,i,{receiptNumber:doc.number,kind:'INBOUND',warehouseId:ids.warehouses[doc.warehouse],supplierId:ids.suppliers[doc.supplier],note:'Fictional shared demo receipt / Phiếu nhập mẫu.'},doc.items.map(priceLine));
      ids.receipts.push(id);
      if(doc.status==='POSTED') await command(`receipt:${i}:post`,doc.actor,`/receipts/${id}/post`);
      await remember(`/receipts/${id}`);
    }
    // A real Staff CSV import creates the six drafts; the remaining orders use the normal forms' APIs.
    const draftCsv=stringify(data.orders.slice(0,6).flatMap(doc=>doc.items.map(line=>[doc.number,ids.warehouses[line.warehouse],data.products[line.product].sku,line.quantity,data.products[line.product].sellingPrice,data.products[line.product].sellingCurrency])),
      {header:true,columns:['order_number','warehouse_id','sku','quantity','unit_price','currency']});
    await importCsv('demo-orders','staff','orders',draftCsv);
    const orderIndex=await list('admin','/orders');
    for(let i=0;i<data.orders.length;i++) {
      const doc=data.orders[i];let id;
      if(i<6) {
        id=orderIndex.find(row=>row.orderNumber===doc.number)?.id;
        if(!id) throw new Error('Imported draft order missing.');
      } else {
        id=await document('orders',doc,i,{orderNumber:doc.number,note:'Fictional shared demo order / Đơn hàng mẫu.'},doc.items.map(line=>({productId:ids.products[line.product],warehouseId:ids.warehouses[line.warehouse],quantity:line.quantity,unitPrice:data.products[line.product].sellingPrice,currency:data.products[line.product].sellingCurrency})));
        if(doc.status!=='CANCELLED') await command(`order:${i}:confirm`,doc.actor,`/orders/${id}/confirm`);
        if(doc.status==='FULFILLED') await command(`order:${i}:fulfill`,doc.actor,`/orders/${id}/fulfill`);
        if(doc.status==='CANCELLED') await command(`order:${i}:cancel`,doc.actor,`/orders/${id}/cancel`);
      }
      ids.orders[i]=id;await remember(`/orders/${id}`);
    }
    for(let i=0;i<data.returns.length;i++) {
      const doc=data.returns[i],order=await request(doc.actor,`/orders/${ids.orders[doc.order]}`);
      const id=await document('returns',doc,i,{returnNumber:doc.number,orderId:order.id,warehouseId:ids.warehouses[doc.warehouse],reason:'Fictional demo return / Hàng trả mẫu.'},[{orderItemId:order.items[0].id,quantity:doc.quantity}]);
      ids.returns[i]=id;
      if(doc.status==='POSTED') await command(`return:${i}:post`,doc.actor,`/returns/${id}/post`);
      await remember(`/returns/${id}`);
    }
    for(let i=0;i<data.transfers.length;i++) {
      const doc=data.transfers[i];
      const id=await document('transfers',doc,i,{transferNumber:doc.number,sourceWarehouseId:ids.warehouses[doc.source],destinationWarehouseId:ids.warehouses[doc.destination],note:'Fictional shared demo transfer / Chuyển kho mẫu.'},[{productId:ids.products[doc.product],requestedQty:doc.quantity}]);
      ids.transfers[i]=id;
      if(doc.scenario!=='DRAFT') await command(`transfer:${i}:send`,doc.actor,`/transfers/${id}/send`);
      const transfer=await request('admin',`/transfers/${id}`),item=transfer.items[0];
      if(!['DRAFT','SENT'].includes(doc.scenario)) {
        const accepted=['SHORTAGE','LOSS'].includes(doc.scenario)?'3':doc.scenario==='PARTIALLY_RECEIVED'?'2':'4';
        const quarantined=['EXCESS','ACCEPT_EXCESS'].includes(doc.scenario)?'1':'0';
        await command(`transfer:${i}:receive`,doc.receiver,`/transfers/${id}/receive`,{items:[{transferItemId:item.id,acceptedQty:accepted,quarantinedQty:quarantined,...(quarantined==='1'?{excessReason:'Fictional excess / Thừa hàng mẫu.'}:{})}]});
        if(['SHORTAGE','LOSS'].includes(doc.scenario)) await command(`transfer:${i}:shortage`,doc.receiver,`/transfers/${id}/shortages`,{transferItemId:item.id,quantity:'1',reason:'Fictional shortage / Thiếu hàng mẫu.'});
        if(['LOSS','ACCEPT_EXCESS'].includes(doc.scenario)) {
          const discrepancies=await request('admin',`/transfers/${id}/discrepancies`);
          const discrepancy=discrepancies.items.find(row=>row.kind===(doc.scenario==='LOSS'?'SHORTAGE':'EXCESS'));
          if(!discrepancy) throw new Error('Expected demo discrepancy missing.');
          await command(`transfer:${i}:resolve`,'admin',`/discrepancies/${discrepancy.id}/resolve`,{resolutionType:doc.scenario,quantity:'1',reason:'Fictional manager review / Rà soát mẫu.'});
          await remember(`/transfers/${id}/discrepancies`);
        }
      }
      await remember(`/transfers/${id}`);
    }
    for(let i=0;i<data.requests.length;i++) {
      const doc=data.requests[i];
      const created=await step(`request:${i}:create`,()=>request(doc.actor,'/stock-requests','POST',{requestType:doc.requestType,warehouseId:ids.warehouses[doc.warehouse],productId:ids.products[doc.product],reason:doc.key+' · Fictional inventory review / Rà soát tồn kho mẫu.',...(doc.requestType==='COUNT'?{countedQty:doc.quantity}:{quantity:doc.quantity})}));
      ids.requests[i]=created.id;
      if(doc.decision) {
        const stock=await request('admin',`/stock?warehouseId=${ids.warehouses[doc.warehouse]}&productId=${ids.products[doc.product]}`);
        await command(`request:${i}:decision`,'admin',`/stock-requests/${created.id}/decision`,{decision:doc.decision,reason:'Fictional demo decision / Quyết định mẫu.',...(doc.decision==='APPROVED'?{reviewedBalanceVersion:stock.items[0].version}:{})});
      }
      const reviewed=await remember(`/stock-requests/${created.id}`);
      if(reviewed.decision!==doc.decision) throw new Error('Demo stock request decision mismatch.');
    }
    // Clear only new Staff's earlier workflow alerts. Planned exports then prove later arrivals stay unread.
    await step('notifications:staff-read-baseline',async()=>{
      const before=await list('staff','/notifications');
      if(!before.some(row=>!row.readAt)) throw new Error('Expected demo workflow alerts are missing.');
      await request('staff','/notifications/read-all','POST',{});
      const after=await list('staff','/notifications');
      for(const original of before) {
        const changed=after.find(row=>row.id===original.id);
        if(!changed?.readAt || original.readAt && original.readAt!==changed.readAt) throw new Error('Bulk notification read did not preserve its rows/timestamps.');
      }
      return {ids:before.map(row=>row.id)};
    });
    for(const kind of ['PRODUCTS','STOCK','MOVEMENTS','REPORT']) {
      const exported=await step('export:'+kind,async()=>{
        if(checkpoint.jobs>=data.limits.jobs) throw new Error('Demo job ceiling reached.');
        checkpoint.jobs++;await save();
        return request('staff','/exports','POST',{kind,...(kind==='PRODUCTS'?{}:{warehouseId:ids.warehouses[0]})});
      });
      let ready;
      for(let attempt=0;attempt<30;attempt++) {
        await options.tick?.();ready=await request('staff',`/exports/${exported.id}`);
        if(ready.status==='DONE') break;
        if(ready.status==='FAILED') throw new Error(`Export ${exported.id} failed.`);
        await new Promise(resolve=>setTimeout(resolve,target.local?50:2000));
      }
      if(ready?.status!=='DONE') throw new Error(`Export ${exported.id} remains active. Keep this original job.`);
      const bytes=await request('staff',`/exports/${exported.id}/file`,'GET',undefined,undefined,undefined,'file');
      const rows=parse(bytes,{columns:true});
      if(!rows.length || !rows.some(row=>row.sku?.startsWith(data.version+'-') || ids.products.includes(row.product_id))) throw new Error('Demo export does not contain its planned records.');
      const numericColumns=['selling_price','on_hand','reserved','available','on_hand_delta','reserved_delta','threshold'];
      if(rows.some(row=>numericColumns.some(column=>typeof row[column]==='string' && /\.\d*0$/.test(row[column])))) throw new Error('Export numeric values still contain redundant zeros.');
      checkpoint.steps['download:'+kind]={id:exported.id,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};await save();
    }
    const stocks=[];
    for(const warehouseId of ids.warehouses) stocks.push(...await list('admin','/stock?warehouseId='+warehouseId));
    const expected=data.expectedBalances();
    for(const balance of expected) {
      const [warehouse,product]=balance.key.split(':').map(Number);
      const actual=stocks.find(row=>row.warehouseId===ids.warehouses[warehouse] && row.productId===ids.products[product]);
      if(!actual || ['onHand','reserved','available'].some(field=>!new Decimal(actual[field]).eq(balance[field]))) throw new Error(`Demo balance mismatch at ${balance.key}.`);
    }
    if(stocks.length!==expected.length) throw new Error('Unexpected stock rows in the new demo warehouses.');
    for(const [kind,docs,docIds] of [['receipts',[...data.opening.map(r=>({...r,status:'POSTED'})),...data.receipts],ids.receipts],['orders',data.orders,ids.orders],['returns',data.returns,ids.returns],['transfers',data.transfers,ids.transfers]])
      for(let i=0;i<docIds.length;i++) if((await request('admin',`/${kind}/${docIds[i]}`)).status!==docs[i].status) throw new Error(`Demo ${kind} status mismatch.`);
    for(let i=0;i<data.transfers.length;i++) {
      const doc=data.transfers[i],detail=await request('admin',`/transfers/${ids.transfers[i]}`),line=detail.items[0];
      const received=doc.scenario==='DRAFT'||doc.scenario==='SENT'?'0':doc.scenario==='PARTIALLY_RECEIVED'?'2':['SHORTAGE','LOSS'].includes(doc.scenario)?'3':'4';
      const transit=doc.scenario==='SENT'?'4':doc.scenario==='PARTIALLY_RECEIVED'?'2':doc.scenario==='SHORTAGE'?'1':'0';
      const quarantine=doc.scenario==='EXCESS'?'1':'0';
      for(const [field,expected] of Object.entries({requestedQty:doc.quantity,sentQty:doc.scenario==='DRAFT'?'0':'4',receivedQty:received,inTransitQty:transit,quarantinedQty:quarantine}))
        if(!new Decimal(line[field]).eq(expected)) throw new Error(`Demo transfer ${i} ${field} mismatch.`);
      const discrepancies=await request('admin',`/transfers/${ids.transfers[i]}/discrepancies`);
      const needsDiscrepancy=['SHORTAGE','EXCESS','LOSS','ACCEPT_EXCESS'].includes(doc.scenario);
      if(discrepancies.items.length!==(needsDiscrepancy?1:0)) throw new Error('Demo discrepancy count mismatch.');
      if(needsDiscrepancy && !new Decimal(discrepancies.items[0].outstandingQty).eq(['LOSS','ACCEPT_EXCESS'].includes(doc.scenario)?0:1)) throw new Error('Demo discrepancy outstanding mismatch.');
    }
    for(const account of data.accounts) {
      const actual=await remember(`/users/${ids.accounts[account.key]}`);
      if(actual.mustChangePassword || !actual.active || actual.role!==account.role || hash([...actual.warehouseIds].sort())!==hash(account.warehouses.map(i=>ids.warehouses[i]).sort())) throw new Error('Demo account permissions/activation mismatch.');
    }
    const earlier=new Set(checkpoint.steps['notifications:staff-read-baseline'].ids);
    const alerts=await list('staff','/notifications');
    if(!alerts.some(row=>!earlier.has(row.id) && !row.readAt && row.eventClass==='EXPORT_COMPLETE')) throw new Error('Expected later unread export notification missing.');
    // Permission probes are read-only or rejected writes and cannot change shared records.
    await request('north',`/stock?warehouseId=${ids.warehouses[0]}`,'GET',undefined,undefined,403);
    await request('viewer','/orders','GET',undefined,undefined,403);
    await request('viewer','/products','POST',{},undefined,403);
    const restricted=await list('north','/stock');
    if(restricted.some(row=>row.warehouseId!==ids.warehouses[1])) throw new Error('Restricted account sees an unassigned warehouse.');
    const ledger=[];
    for(const warehouseId of ids.warehouses) ledger.push(...await list('admin','/movements?warehouseId='+warehouseId));
    for(const stock of stocks) {
      const movements=ledger.filter(row=>row.warehouseId===stock.warehouseId && row.productId===stock.productId);
      for(const [field,delta] of [['onHand','onHandDelta'],['reserved','reservedDelta']]) if(!movements.reduce((sum,row)=>sum.plus(row[delta]),new Decimal(0)).eq(stock[field])) throw new Error('Inventory ledger does not reconcile.');
    }
    checkpoint.complete=true;checkpoint.ids=ids;checkpoint.expected=expected;await save();
    outcome={version:data.version,complete:true,requests:runRequests,totalRequests:checkpoint.requests,jobs:checkpoint.jobs,uploadedBytes:checkpoint.uploadedBytes,writes,summary:data.datasetSummary(),ids};
    return outcome;
  } finally {
    for(const actor of sessions.keys()) {
      try { await request(actor,'/auth/logout','POST'); } catch { /* Preserve the original failure and never log cookies. */ }
    }
    await save();
    if(outcome) {outcome.requests=runRequests;outcome.totalRequests=checkpoint.requests;}
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=new Map(process.argv.slice(2).map(arg=>{const [key,...value]=arg.replace(/^--/,'').split('=');return [key,value.length?value.join('='):true];}));
  try {
    const result=await seedDemo({apply:args.get('apply')===true,dataset:args.get('dataset'),target:args.get('target'),checkpoint:args.get('checkpoint'),
      freeTierConfirmed:args.get('free-tier-confirmed')===true,origin:process.env.DEMO_ORIGIN,
      passwords:{admin:process.env.DEMO_ADMIN_PASSWORD,...Object.fromEntries(data.accounts.map(account=>[account.key,process.env[account.passwordEnv]]))}});
    console.log(JSON.stringify(result,null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
