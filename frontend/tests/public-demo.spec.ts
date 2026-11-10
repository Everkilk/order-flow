import {test,expect,type Page} from '@playwright/test'
import {mkdir} from 'node:fs/promises'
import {resolve} from 'node:path'

const accounts=[{role:'MANAGER',email:'admin@example.com',password:'demo-manager-2026'},{role:'STAFF',email:'staff@example.com',password:'demo-staff-2026'},{role:'VIEWER',email:'viewer@example.com',password:'demo-viewer-2026'}]
const demo={enabled:true,accountChangesAllowed:false,notifications:'poll',accounts,limits:{csvRows:200,csvBytes:262144,evidenceBytes:2097152,exportBytes:2097152,storageBytes:52428800,transferBytes:1073741824,databaseBytes:209715200,cooldownSeconds:10}}
async function setup(page:Page,{enabled=true,authenticated=false,locale='en'}={}) {
  let user=authenticated?{id:'1',email:accounts[0].email,displayName:'Demo Manager',role:'MANAGER',warehouses:['1'],mustChangePassword:false}:null
  const calls:{path:string;method:string;body:unknown}[]=[]
  await page.addInitScript(locale=>localStorage.setItem('orderflow.locale',locale),locale)
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();calls.push({path,method,body:request.postData()})
    const send=(json:unknown,status=200)=>route.fulfill({status,json})
    if(path==='/api/demo-info')return send(enabled?demo:{enabled:false})
    if(path==='/api/auth/me')return user?send({user}):send({error:{code:'UNAUTHENTICATED',message:'Sign in first.'}},401)
    if(path==='/api/auth/login'){const body=request.postDataJSON();const account=accounts.find(a=>a.email===body.email&&a.password===body.password)!;user={id:'1',email:account.email,displayName:'Demo '+account.role,role:account.role,warehouses:['1'],mustChangePassword:false};return send({user})}
    if(path==='/api/dashboard')return send({stock:{stockRows:'1',outOfStock:'0',lowStock:'0'},unreadNotifications:'0',work:{orders:{drafts:'0',awaitingFulfillment:'0'},transfers:{awaitingReceipt:'0',disputed:'0'},pendingApprovals:'0'},valuation:{currencyTotals:[],unvaluedStockRows:'0'}})
    if(path==='/api/notifications/unread-count')return send({count:0})
    if(path==='/api/users')return send({items:[{id:'1',email:accounts[0].email,displayName:'Demo Manager',role:'MANAGER',active:true}],nextCursor:null})
    if(path==='/api/users/1')return send({id:'1',email:accounts[0].email,displayName:'Demo Manager',role:'MANAGER',active:true,warehouseIds:['1']})
    if(path==='/api/warehouses')return send({items:[{id:'1',code:'DEMO-MAIN',name:'Demo warehouse'}],nextCursor:null})
    return send({items:[],nextCursor:null})
  })
  return calls
}

for(const [label,width,height]of [['desktop',1440,1000],['mobile',360,900]] as const)for(const locale of ['en','vi']) {
  test(`public accounts are accessible and autofill without signing in: ${label} ${locale}`,async({page})=>{
    await page.setViewportSize({width,height});const calls=await setup(page,{locale});await page.goto('/')
    const table=page.getByRole('table',{name:locale==='en'?'Demo accounts':'Tài khoản dùng thử'});await expect(table).toBeVisible();await expect(table.getByRole('row')).toHaveCount(4)
    for(const account of accounts){await expect(table.getByText(account.email,{exact:true})).toBeVisible();await expect(table.getByText(account.password,{exact:true})).toBeVisible()}
    const useStaff=page.getByRole('button',{name:locale==='en'?'Use Staff account':'Dùng tài khoản Nhân viên',exact:true});await useStaff.focus();await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox',{name:'Email',exact:true})).toHaveValue(accounts[1].email)
    await expect(page.getByLabel(locale==='en'?'Password':'Mật khẩu',{exact:true})).toHaveValue(accounts[1].password)
    await expect(page.getByRole('button',{name:locale==='en'?'Sign in':'Đăng nhập',exact:true})).toBeFocused()
    expect(calls.filter(c=>c.path==='/api/auth/login')).toHaveLength(0)
    const bounds=await page.locator('.auth-card').boundingBox(),demoBounds=await table.boundingBox();expect(bounds).not.toBeNull();expect(demoBounds).not.toBeNull()
    if(label==='desktop')expect(demoBounds!.x).toBeGreaterThan(bounds!.x+bounds!.width)
    else expect(demoBounds!.y).toBeGreaterThan(bounds!.y+bounds!.height)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    const folder=resolve('../../.orderflow-qa/cv-demo');await mkdir(folder,{recursive:true});await page.screenshot({path:resolve(folder,`login-${label}-${locale}.png`),fullPage:true})
  })
}
test('ordinary deployments do not publish demo credentials',async({page})=>{await setup(page,{enabled:false});await page.goto('/');await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible();await expect(page.getByRole('table')).toHaveCount(0);await expect(page.getByText(accounts[0].password)).toHaveCount(0)})
test('demo account administration exposes details without mutation controls',async({page})=>{
 await setup(page,{authenticated:true});await page.goto('/users');await expect(page.getByText('Account settings are read-only in this shared demo.').first()).toBeVisible()
 await page.getByRole('button',{name:'Demo Manager',exact:true}).click();await expect(page.getByText('DEMO-MAIN',{exact:false})).toBeVisible()
 for(const name of ['Create user','Reset password','Save warehouses','Save changes'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0)
 await expect(page.locator('input[type="password"]')).toHaveCount(0)
})
test('demo notifications pause when hidden or idle and resume on activity',async({page})=>{
 await page.clock.install();const calls=await setup(page,{authenticated:true});await page.goto('/');await expect(page.getByRole('heading',{name:'Good day, Demo',exact:true})).toBeVisible()
 const count=()=>calls.filter(c=>c.path==='/api/notifications/unread-count').length
 await page.clock.runFor(30000);await expect.poll(count).toBeGreaterThan(1);expect(calls.some(c=>c.path==='/api/notifications/stream')).toBe(false)
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'))})
 const hidden=count();await page.clock.runFor(60000);expect(count()).toBe(hidden)
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'))})
 await expect.poll(count).toBeGreaterThan(hidden);await page.clock.fastForward(5*60000);const idle=count();await page.clock.runFor(60000);expect(count()).toBe(idle)
 await page.getByRole('heading',{name:'Good day, Demo',exact:true}).click();await page.clock.runFor(30000);await expect.poll(count).toBeGreaterThan(idle)
})
