import { test, expect, type Page } from '@playwright/test'
import { readFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

async function signIn(page: Page) {
  await page.getByLabel('Email', { exact: true }).fill('manager@example.com')
  await page.getByLabel('Password', { exact: true }).fill('example-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

for (const locale of ['en', 'vi']) {
  test(`fulfilled-order selector explains loading and empty results in ${locale}`, async ({ page }) => {
    await page.addInitScript(locale => localStorage.setItem('orderflow.locale', locale), locale)
    await mockSession(page)
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    await page.route('**/api/orders?**', async route => {
      await pending
      await route.fulfill({ json: { items: [], nextCursor: null } })
    })
    await page.goto('/returns')
    await page.getByLabel('Email', { exact: true }).fill('manager@example.com')
    await page.getByLabel(locale === 'en' ? 'Password' : 'Mật khẩu', { exact: true }).fill('example-password')
    await page.getByRole('button', { name: locale === 'en' ? 'Sign in' : 'Đăng nhập', exact: true }).click()
    await page.getByRole('button', { name: locale === 'en' ? 'New return' : 'Tạo phiếu trả', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer.getByRole('status')).toHaveText(locale === 'en' ? 'Searching…' : 'Đang tìm…')
    release()
    await expect(drawer.getByRole('status')).toHaveText(locale === 'en' ? 'No fulfilled orders match this search.' : 'Không có đơn hàng đã hoàn tất phù hợp với tìm kiếm này.')
    await expect(drawer.getByLabel(locale === 'en' ? 'Fulfilled order' : 'Đơn hàng đã hoàn tất', { exact: true }).locator('option')).toHaveCount(1)
  })
}

for (const width of [1440, 1024, 390, 320]) for (const locale of ['en','vi']) {
  test(`all document field grids align at ${width}px in ${locale}`, async({page})=>{
    test.setTimeout(60_000)
    await page.setViewportSize({width,height:1000})
    page.on('dialog',dialog=>dialog.accept())
    await page.addInitScript(locale=>localStorage.setItem('orderflow.locale',locale),locale)
    await mockSession(page,'MANAGER','Demo Staff / Nhân viên mẫu có tên dài để kiểm tra bố cục')
    const line={id:'22',productId:'9',sku:'HAMMER-001',name:'Hammer with a long descriptive product name for layout testing',warehouseId:'1',orderItemId:'22',quantity:'1',unitCost:'2',unitPrice:'3',currency:'USD',requestedQty:'1',returnableQty:'1',inTransitQty:'1',receivedQty:'0',quarantinedQty:'0'}
    await page.route(/\/api\/(receipts|orders|returns|transfers)\//,route=>{
      const path=new URL(route.request().url()).pathname
      if(path.endsWith('/discrepancies'))return route.fulfill({json:{items:[{id:'51',transferItemId:'22',productId:'9',sku:line.sku,name:line.name,kind:'EXCESS',reportedQty:'1',outstandingQty:'1',status:'OPEN',reason:'Layout fixture'}]}})
      const kind=path.split('/')[2],numberKey={receipts:'receiptNumber',orders:'orderNumber',returns:'returnNumber',transfers:'transferNumber'}[kind]!
      return route.fulfill({json:{id:path.endsWith('/21')?'21':path.endsWith('/2')?'2':'1',[numberKey]:'LAYOUT-'+kind,status:path.endsWith('/21')?'FULFILLED':path.endsWith('/2')?'SENT':'DRAFT',revision:0,...(kind==='receipts'||kind==='returns'?{warehouseId:'1'}:{}),...(kind==='returns'?{orderId:'21'}:{}),...(kind==='transfers'?{sourceWarehouseId:'1',destinationWarehouseId:'1'}:{}),items:[line]}})
    })
    await page.goto('/')
    await page.getByLabel(locale==='en'?'Email':'Email',{exact:true}).fill('manager@example.com')
    await page.getByLabel(locale==='en'?'Password':'Mật khẩu',{exact:true}).fill('example-password')
    await page.getByRole('button',{name:locale==='en'?'Sign in':'Đăng nhập',exact:true}).click()
    const output=join('..','docs','qa-2026-10-04','layouts');await mkdir(output,{recursive:true})
    for(const kind of ['receipts','orders','returns','transfers']) {
      await page.goto('/'+kind+'/1');await page.locator('.line-editor').waitFor()
      const controls=page.locator('.line-editor > .field input, .line-editor > .field select')
      const boxes=await controls.evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {y:box.y,height:box.height}}))
      if(width>740&&boxes.length>=2){expect(Math.abs(boxes[0].y-boxes[1].y)).toBeLessThan(1);expect(Math.abs(boxes[0].height-boxes[1].height)).toBeLessThan(1)}
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1)
      await page.screenshot({path:join(output,`${kind}-${width}-${locale}.png`),fullPage:true})
      if(width===1440||width===320) {
        await page.getByRole('button',{name:locale==='en'?'Add line':'Thêm dòng'}).click()
        await expect(page.locator('.line-editor')).toHaveCount(2)
        expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1)
      }
    }
    await page.goto('/transfers/2');await page.locator('.line-editor').waitFor()
    const receiving=page.locator('.line-editor input');const boxes=await receiving.evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().y))
    if(width>740)expect(Math.abs(boxes[0]-boxes[1])).toBeLessThan(1)
    expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1)
    await page.screenshot({path:join(output,`receiving-discrepancy-${width}-${locale}.png`),fullPage:true})
    if(width<741) {
      await page.getByRole('button',{name:locale==='en'?'Toggle menu':'Mở hoặc đóng menu'}).click()
      await expect(page.locator('.sidebar')).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)')
    }
    const account=await page.locator('.account-row').boundingBox(),signout=await page.getByRole('button',{name:locale==='en'?'Sign out':'Đăng xuất',exact:true}).boundingBox()
    expect(account!.x).toBeGreaterThanOrEqual(0);expect(account!.x+account!.width).toBeLessThanOrEqual(width)
    expect(signout!.x).toBeGreaterThanOrEqual(0);expect(signout!.y+signout!.height).toBeLessThanOrEqual(1000)
    expect(signout!.y).toBeGreaterThanOrEqual(account!.y+account!.height)
    expect(signout!.width).toBeGreaterThanOrEqual(44);expect(signout!.height).toBeGreaterThanOrEqual(44)
    expect(await page.getByRole('button',{name:locale==='en'?'Sign out':'Đăng xuất',exact:true}).evaluate(element=>getComputedStyle(element).backgroundColor)).toBe('rgb(180, 35, 50)')
    await page.screenshot({path:join(output,`account-${width}-${locale}.png`)})
  })
}

for (const width of [1440,1024,390,320]) for(const locale of ['en','vi']) {
  test(`remaining forms stay within ${width}px in ${locale}`,async({page})=>{
    test.setTimeout(60_000)
    await page.setViewportSize({width,height:1000});await page.addInitScript(locale=>localStorage.setItem('orderflow.locale',locale),locale);await mockSession(page)
    await page.goto('/');await page.getByLabel('Email',{exact:true}).fill('manager@example.com');await page.getByLabel(locale==='en'?'Password':'Mật khẩu',{exact:true}).fill('example-password');await page.getByRole('button',{name:locale==='en'?'Sign in':'Đăng nhập',exact:true}).click()
    const output=join('..','docs','qa-2026-10-04','layouts');await mkdir(output,{recursive:true})
    for(const section of ['stock-requests','references','users','jobs','reports']) {
      await page.goto('/'+section);await page.locator('main h1').waitFor()
      if(section==='references')await page.getByRole('button',{name:locale==='en'?'Warehouses':'Kho',exact:true}).click()
      await page.locator('main select').first().waitFor()
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width+1)
      const controls=await page.locator('main .field input, main .field select, main .field textarea').evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {left:box.left,right:box.right}}))
      expect(controls.length).toBeGreaterThan(0)
      for(const box of controls){expect(box.left).toBeGreaterThanOrEqual(0);expect(box.right).toBeLessThanOrEqual(width+1)}
      await page.screenshot({path:join(output,`${section}-${width}-${locale}.png`),fullPage:true})
    }
  })
}

test('return selector keeps internal ID distinct from reference and limits warehouses',async({page})=>{
  await mockSession(page)
  const seen:string[]=[];let submitted: { orderId?: string } | undefined
  const order={id:'29',orderNumber:'DEMO-V2-ORD-25',status:'FULFILLED',revision:1,items:[{id:'81',productId:'9',sku:'HAMMER-001',name:'Hammer',warehouseId:'1',quantity:'2',returnableQty:'2'}]}
  await page.route('**/api/orders**',route=>{
    const url=new URL(route.request().url());seen.push(url.search)
    return route.fulfill({json:url.pathname==='/api/orders/29'?order:{items:[order],nextCursor:null}})
  })
  await page.route('**/api/warehouses',route=>route.fulfill({json:{items:[{id:'1',code:'MAIN',name:'Main'},{id:'2',code:'OTHER',name:'Other'}]}}))
  await page.route('**/api/returns**',route=>{
    if(route.request().method()==='POST'){submitted=route.request().postDataJSON();return route.fulfill({status:201,json:{id:'7'}})}
    return route.fulfill({json:new URL(route.request().url()).pathname==='/api/returns/7'?{id:'7',returnNumber:'QA-RETURN',orderId:'29',orderNumber:order.orderNumber,warehouseId:'1',status:'DRAFT',revision:0,items:[]}:{items:[],nextCursor:null}})
  })
  await page.goto('/orders/29');await signIn(page)
  await expect(page.locator('.summary-row').filter({hasText:'Order ID'})).toContainText('29')
  await page.getByRole('link',{name:'Create a return →'}).click()
  const drawer=page.locator('.drawer')
  await expect(drawer.getByLabel('Fulfilled order',{exact:true})).toHaveValue('29')
  await expect(drawer.getByLabel('Warehouse',{exact:true}).locator('option[value="2"]')).toHaveCount(0)
  await drawer.getByLabel('Search fulfilled orders').fill('29')
  await expect.poll(()=>seen.some(query=>query.includes('q=29')&&query.includes('status=FULFILLED'))).toBe(true)
  await drawer.getByLabel('Fulfilled order',{exact:true}).selectOption('29')
  await expect(drawer.getByLabel('Fulfilled order',{exact:true}).locator('option:checked')).toHaveText('DEMO-V2-ORD-25 · Order ID: 29 · FULFILLED')
  await drawer.getByLabel('Document number').fill('QA-RETURN')
  await drawer.getByLabel('Warehouse',{exact:true}).selectOption('1')
  await drawer.getByLabel('Reason').fill('Identity regression')
  await drawer.getByRole('button',{name:'Create draft'}).click()
  await expect(page).toHaveURL(/\/returns\/7$/)
  expect(submitted?.orderId).toBe('29')
  await expect(page.getByRole('link',{name:'DEMO-V2-ORD-25 · Order ID: 29'})).toHaveAttribute('href','/orders/29')
})

test('stock-request form locks immediately and reuses its key after a lost response',async({page})=>{
  await mockSession(page)
  const keys:string[]=[];let attempts=0
  await page.route('**/api/stock-requests**',route=>{
    if(route.request().method()==='POST'){
      attempts++;keys.push(route.request().headers()['idempotency-key'])
      return attempts===1?route.abort('failed'):route.fulfill({status:201,json:{id:'77'}})
    }
    return route.fulfill({json:new URL(route.request().url()).pathname==='/api/stock-requests/77'?{id:'77',requestType:'DAMAGE',warehouseId:'1',productId:'9',sku:'HAMMER-001',productName:'Hammer',reason:'Retry fixture',requestedDelta:'-1',decision:null}:{items:[],nextCursor:null}})
  })
  await page.goto('/stock-requests');await signIn(page)
  await page.getByLabel('Warehouse',{exact:true}).selectOption('1')
  await page.getByLabel('Product',{exact:true}).selectOption('9')
  await page.getByLabel('Quantity to remove').fill('1');await page.getByLabel('Reason',{exact:true}).fill('Retry fixture')
  await page.locator('form').evaluate((form:HTMLFormElement)=>{form.requestSubmit();form.requestSubmit()})
  await expect(page.getByRole('alert')).toContainText('Connection failed')
  expect(attempts).toBe(1)
  const recovery = await page.evaluate(() => sessionStorage.getItem('orderflow.submission-recovery'))
  expect(recovery).not.toContain('Retry fixture')
  expect(recovery).not.toContain('example-password')
  await page.getByLabel('Quantity to remove').fill('2')
  await page.getByRole('button',{name:'Submit request'}).click()
  await expect(page.getByRole('alert')).toContainText('previous submission may have succeeded')
  expect(attempts).toBe(1)
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Check previous submission' })).toBeVisible()
  await page.route('**/api/submissions/**',route=>route.fulfill({json:{state:'UNCONFIRMED',result:null}}))
  await page.getByRole('button',{name:'Check previous submission'}).click()
  await expect(page.getByText('The result is still unconfirmed. Return to the form and retry the same values within 24 hours.')).toBeVisible()
  expect(attempts).toBe(1)
  await page.getByLabel('Warehouse',{exact:true}).selectOption('1')
  await page.getByLabel('Product',{exact:true}).selectOption('9')
  await page.getByLabel('Reason',{exact:true}).fill('Retry fixture')
  await page.getByLabel('Quantity to remove').fill('1')
  await page.getByRole('button',{name:'Submit request'}).click()
  await expect(page).toHaveURL(/\/stock-requests\/77$/)
  expect(keys).toHaveLength(2);expect(keys[0]).toMatch(/^[a-f0-9-]{36}$/);expect(keys[1]).toBe(keys[0])
})

test('a committed submission can be recovered after reload without another write',async({page})=>{
  await mockSession(page)
  const key='11111111-2222-4333-8444-555555555555'
  await page.route('**/api/submissions/**',route=>route.fulfill({json:{state:'COMMITTED',result:{id:'77'}}}))
  await page.goto('/');await signIn(page)
  await page.evaluate(key=>sessionStorage.setItem('orderflow.submission-recovery',JSON.stringify([{actor:'1',fingerprint:'a'.repeat(64),key,operation:'POST /stock-requests',createdAt:Date.now()}])),key)
  await page.reload()
  await page.getByRole('button',{name:'Check previous submission'}).click()
  await expect(page.getByText('Previous submission completed. Review it before making another change.')).toBeVisible()
  await expect(page.getByRole('link',{name:'Open record →'})).toHaveAttribute('href','/stock-requests/77')
  expect(await page.evaluate(()=>sessionStorage.getItem('orderflow.submission-recovery'))).not.toContain(key)
})

test('evidence deletion confirmation updates history and locks decided evidence',async({page})=>{
  await mockSession(page);let removed=false,deletes=0
  await page.route('**/api/stock-requests/77',route=>route.fulfill({json:{id:'77',requestType:'LOSS',warehouseId:'1',productId:'9',productName:'Hammer',sku:'HAMMER-001',decision:removed?'REJECTED':null}}))
  await page.route('**/api/evidence/stock-requests/77**',route=>{
    if(route.request().method()==='DELETE'){removed=true;deletes++;return route.fulfill({status:204})}
    return route.fulfill({json:{items:removed?[]:[{id:'8',filename:'wrong.png'}],canUpload:!removed,canDelete:!removed,removed:removed?[{id:'8',filename:'wrong.png',removedBy:'Warehouse Manager',removedAt:'2026-10-04T00:00:00Z',cleanupStatus:'DONE'}]:[]}})
  })
  await page.goto('/stock-requests/77');await signIn(page)
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'Delete',exact:true}).click()
  expect(deletes).toBe(0);await expect(page.getByRole('link',{name:'wrong.png'})).toBeVisible()
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Deletion history'})).toBeVisible()
  await expect(page.getByRole('link',{name:'wrong.png'})).toHaveCount(0)
  await expect(page.getByText('Evidence is locked after a decision.')).toBeVisible()
  await expect(page.getByRole('button',{name:'Upload evidence'})).toHaveCount(0)
  expect(deletes).toBe(1)
})

test('a saved evidence deletion reports refresh failure without offering another delete',async({page})=>{
  await mockSession(page)
  let deleted=false,deletes=0
  await page.route('**/api/stock-requests/77',route=>route.fulfill({json:{id:'77',requestType:'LOSS',warehouseId:'1',productId:'9',decision:null}}))
  await page.route('**/api/evidence/stock-requests/77**',route=>{
    if(route.request().method()==='DELETE'){deleted=true;deletes++;return route.fulfill({status:204})}
    if(deleted)return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Temporary refresh failure.'}}})
    return route.fulfill({json:{items:[{id:'8',filename:'wrong.png'}],canUpload:true,canDelete:true,removed:[]}})
  })
  await page.goto('/stock-requests/77');await signIn(page)
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete',exact:true}).click()
  await expect(page.getByRole('status')).toContainText('Evidence deleted.')
  await expect(page.getByRole('alert')).toContainText('The change was saved, but the page could not refresh.')
  await expect(page.getByRole('button',{name:'Delete',exact:true})).toHaveCount(0)
  expect(deletes).toBe(1)
})

test('a completed order action reports refresh failure as saved',async({page})=>{
  await mockSession(page)
  let fulfilled=false,writes=0
  await page.route('**/api/orders/29**',route=>{
    if(route.request().method()==='POST'){fulfilled=true;writes++;return route.fulfill({json:{id:'29',status:'FULFILLED'}})}
    if(fulfilled)return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Temporary refresh failure.'}}})
    return route.fulfill({json:{id:'29',orderNumber:'QA-ORDER-29',status:'CONFIRMED',revision:1,items:[{id:'81',productId:'9',sku:'HAMMER-001',name:'Hammer',warehouseId:'1',quantity:'1'}]}})
  })
  await page.goto('/orders/29');await signIn(page)
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Fulfill',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('The change was saved, but the page could not refresh.')
  expect(writes).toBe(1)
})

test('a completed stock decision reports refresh failure as saved',async({page})=>{
  await mockSession(page)
  let decided=false,writes=0
  await page.route('**/api/stock-requests/77**',route=>{
    if(route.request().method()==='POST'){decided=true;writes++;return route.fulfill({json:{id:'77',decision:'REJECTED'}})}
    if(decided)return route.fulfill({status:503,json:{error:{code:'UNAVAILABLE',message:'Temporary refresh failure.'}}})
    return route.fulfill({json:{id:'77',requestType:'LOSS',warehouseId:'1',productId:'9',decision:null}})
  })
  await page.goto('/stock-requests/77');await signIn(page)
  await page.getByLabel('Decision').selectOption('REJECTED')
  await page.getByLabel('Reason',{exact:true}).fill('Reviewed')
  await page.getByRole('button',{name:'Submit decision'}).click()
  await expect(page.getByRole('alert')).toContainText('The change was saved, but the page could not refresh.')
  expect(writes).toBe(1)
})

test('Vietnamese keeps product data unchanged while translating notification templates',async({page})=>{
  await mockSession(page)
  await page.route('**/api/products/9',route=>route.fulfill({json:{id:'9',sku:'Pending',name:'Order',category:'Stock',unit:'EA',attributes:{},active:true,stock:[],suppliers:[{name:'Pending',primarySupplier:true,cost:'1',currency:'USD'}]}}))
  await page.route('**/api/notifications?**',route=>route.fulfill({json:{items:[{id:'1',title:'Order assigned',titleKey:'Order assigned',titleValues:{},body:'Order Pending is assigned to you.',messageKey:'Order {document} is assigned to you.',messageValues:{document:'Pending'},targetPath:'/orders/29',createdAt:'2026-10-04T00:00:00Z',readAt:'2026-10-04T00:01:00Z'}],nextCursor:null}}))
  await page.goto('/products/9');await signIn(page)
  await page.getByLabel('Language').selectOption('vi')
  await expect(page.getByRole('heading',{name:'Order',exact:true})).toBeVisible()
  await expect(page.getByRole('cell',{name:'Pending',exact:true})).toBeVisible()
  await expect(page.getByRole('cell',{name:'Có',exact:true})).toBeVisible()
  await page.goto('/notifications')
  await expect(page.getByText('Đơn hàng được giao', {exact:true})).toBeVisible()
  await expect(page.getByText('Đơn hàng Pending được giao cho bạn.',{exact:true})).toBeVisible()
})

test('sign-out failure retains the authenticated account and permits retry',async({page})=>{
  await mockSession(page);let attempts=0
  await page.route('**/api/auth/logout',async route=>{
    if(++attempts===1)return route.abort('failed')
    return route.fallback()
  })
  await page.goto('/');await signIn(page)
  await page.getByRole('button',{name:'Sign out',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Connection failed')
  await expect(page.locator('.account-name')).toContainText('Warehouse Manager')
  await page.getByRole('button',{name:'Sign out',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Welcome back'})).toBeVisible()
  expect(attempts).toBe(2)
})

test('Back restores a filtered later product page and breadcrumbs link to the section', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/products**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/products/9') return route.fulfill({ json: { id: '9', sku: 'PAGE2', name: 'Page two drill', categoryId: '1', unitId: '1', category: 'Tools', unit: 'EA', attributes: {}, active: true, revision: '0', stock: [], suppliers: [] } })
    return route.fulfill({ json: { items: [{ id: '9', sku: url.searchParams.has('cursor') ? 'PAGE2' : 'PAGE1', name: 'Drill', category: 'Tools' }], nextCursor: url.searchParams.has('cursor') ? null : 'later-page' } })
  })
  await page.goto('/products')
  await signIn(page)
  await page.getByLabel('Search', { exact: true }).fill('drill')
  await expect(page).toHaveURL(/q=drill/)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('link', { name: 'PAGE2', exact: true }).click()
  const trail = page.getByRole('navigation', { name: 'Breadcrumb' })
  await expect(trail.getByText('Product details')).toBeVisible()
  await expect(trail.getByRole('link', { name: 'Products' })).toHaveAttribute('href', '/products')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('drill')
  await expect(page.getByRole('link', { name: 'PAGE2', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Previous', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Previous', exact: true }).click()
  await expect(page.getByRole('link', { name: 'PAGE1', exact: true })).toBeVisible()
})

test('a direct product detail uses its parent fallback; Back from Stock returns to Stock', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/products/9', route => route.fulfill({ json: { id: '9', sku: 'HAMMER-001', name: 'Hammer', attributes: {}, active: true, stock: [], suppliers: [] } }))
  await page.goto('/products/9')
  await signIn(page)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/products$/)
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await page.getByRole('link', { name: /HAMMER-001/ }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/stock$/)
  await page.getByRole('link', { name: 'Overview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
})

test('bulk notification read reports errors, retries and refreshes list, badge and dashboard', async ({ page }) => {
  await mockSession(page)
  let count = 30, attempts = 0
  await page.route('**/api/notifications/unread-count', route => route.fulfill({ json: { count } }))
  await page.route('**/api/dashboard', route => route.fulfill({ json: { stock: { stockRows: '1', outOfStock: '0', lowStock: '0' }, unreadNotifications: String(count) } }))
  await page.route('**/api/notifications?**', route => route.fulfill({ json: { items: [{ id: '1', eventClass: 'LOW_STOCK', title: 'Low stock', body: '15.000000 available in MAIN.', targetPath: '/stock', createdAt: '2026-10-02T00:00:00Z', readAt: count ? null : '2026-10-02T01:00:00Z' }], nextCursor: null } }))
  await page.route('**/api/notifications/read-all', route => {
    attempts++
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: { message: 'Try again.' } } })
    count = 0
    return route.fulfill({ status: 204 })
  })
  await page.goto('/notifications')
  await signIn(page)
  await expect(page.getByText('15 available in MAIN.')).toBeVisible()
  await page.getByRole('button', { name: 'Mark all as read', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Try again.')
  await page.getByRole('button', { name: 'Mark all as read', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('All notifications marked as read.')
  await expect(page.getByRole('button', { name: 'Mark all as read', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Mark read', exact: true })).toHaveCount(0)
  await expect(page.locator('.notification-link strong')).toHaveCount(0)
  await page.getByRole('link', { name: 'Overview', exact: true }).click()
  await expect(page.locator('.metric').filter({ hasText: 'Unread alerts' }).locator('strong')).toHaveText('0')
  expect(attempts).toBe(2)
})

test('logo, icon sign-out and navigation remain usable on mobile in both languages', async ({ page }) => {
  await mockSession(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('.auth-brand img')).toHaveAttribute('src', '/logo.png')
  await signIn(page)
  await expect(page.locator('.topbar').getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Toggle menu' }).click()
  const logout = page.locator('.sidebar-footer').getByRole('button', { name: 'Sign out', exact: true })
  await expect(logout).toBeInViewport()
  await expect(logout).toHaveText('')
  await expect(page.locator('.sidebar img')).toBeVisible()
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await page.getByLabel('Language').selectOption('vi')
  await expect(page.getByRole('button', { name: 'Quay lại', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Mở hoặc đóng menu' }).click()
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Chào mừng trở lại' })).toBeVisible()
})

test('unsaved supplier changes protect Back and sign-out; cancellation keeps input', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/products/9', route => route.fulfill({ json: { id: '9', sku: 'HAMMER-001', name: 'Hammer', attributes: {}, active: true, stock: [], suppliers: [] } }))
  await page.goto('/products/9')
  await signIn(page)
  await page.getByLabel('Supplier SKU', { exact: true }).fill('unsaved-qa')
  let prompts = 0
  const cancel = async (dialog: import('@playwright/test').Dialog) => { prompts++; await dialog.dismiss() }
  page.on('dialog', cancel)
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByLabel('Supplier SKU', { exact: true })).toHaveValue('unsaved-qa')
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByLabel('Supplier SKU', { exact: true })).toHaveValue('unsaved-qa')
  expect(prompts).toBe(2)
  page.off('dialog', cancel)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
})

test('Back restores scroll after returning to a long Stock list', async ({ page }) => {
  await mockSession(page)
  await page.setViewportSize({ width: 1280, height: 500 })
  await page.route('**/api/stock**', route => route.fulfill({ json: { items: Array.from({ length: 25 }, (_, i) => ({ warehouseId: '1', warehouse: 'MAIN', productId: '9', sku: `ROW-${i}`, name: 'Hammer', onHand: '9.000000', reserved: '0.000000', available: '9.000000' })), nextCursor: null } }))
  await page.route('**/api/products/9', route => route.fulfill({ json: { id: '9', name: 'Hammer', attributes: {}, active: true, stock: [], suppliers: [] } }))
  await page.goto('/stock')
  await signIn(page)
  const link = page.getByRole('link', { name: 'ROW-20 · Hammer', exact: true })
  await link.scrollIntoViewIfNeeded()
  const scroll = await page.evaluate(() => window.scrollY)
  expect(scroll).toBeGreaterThan(500)
  await link.click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Stock', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scroll)
})

test('document status filter and pagination return with their original history entry', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/orders**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/orders/12') return route.fulfill({ json: { id: '12', orderNumber: 'ORDER-SECOND', status: 'FULFILLED', revision: '1', items: [] } })
    return route.fulfill({ json: { items: [{ id: '12', orderNumber: url.searchParams.has('cursor') ? 'ORDER-SECOND' : 'ORDER-FIRST', status: url.searchParams.get('status') || 'DRAFT', createdAt: '2026-10-02T00:00:00Z' }], nextCursor: url.searchParams.has('cursor') ? null : '12' } })
  })
  await page.goto('/orders')
  await signIn(page)
  await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('FULFILLED')
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('link', { name: 'ORDER-SECOND', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('FULFILLED')
  await expect(page.getByRole('link', { name: 'ORDER-SECOND', exact: true })).toBeVisible()
})

for (const [path, label] of [['/', 'Overview'], ['/products', 'Products'], ['/stock', 'Stock'], ['/receipts', 'Receipts'], ['/orders', 'Orders'], ['/returns', 'Returns'], ['/transfers', 'Transfers'], ['/stock-requests', 'Approvals'], ['/movements', 'Movements'], ['/reports', 'Reports'], ['/jobs', 'Imports & exports'], ['/references', 'Reference data'], ['/users', 'Users'], ['/notifications', 'Notifications'], ['/unknown-page', 'Page not found']]) {
  test(`navigation trail names ${path} correctly`, async ({ page }) => {
    await mockSession(page)
    // Reports has a different response shape from ordinary lists.
    await page.route('**/api/reports/valuation', route => route.fulfill({ json: { currencyTotals: [], unvaluedStockRows: '0' } }))
    await page.goto(path)
    await signIn(page)
    await expect(page.locator('.breadcrumbs [aria-current="page"]')).toHaveText(label)
    if (path !== '/') {
      await expect(page.getByRole('button', { name: 'Back', exact: true })).toHaveText('←')
      await page.getByRole('button', { name: 'Back', exact: true }).click()
      await expect(page).toHaveURL(/\/$/)
    }
  })
}

test('job selection and browser Back keep independent pagers and uploaded unsaved files', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/imports**', route => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/preview')) return route.fulfill({ json: { columns: ['sku', 'quantity', 'unit_price'], rows: [{ rowNumber: 2, values: ['000123', '2.125000', '25.0000'] }, { rowNumber: 3, values: ['000124', '9.000000', '25.0000'] }], hasMore: false, errors: [{ rowNumber: 3, field: 'unit_price', message: 'Invalid price fixture' }] } })
    if (/\/imports\/\d+$/.test(url.pathname)) return route.fulfill({ json: { id: '32', kind: 'ORDERS', status: 'INVALID', jobStatus: 'DONE', errors: [], validatedRows: 2 } })
    return route.fulfill({ json: { items: [{ id: url.searchParams.has('cursor') ? '32' : '31', kind: 'ORDERS', status: 'INVALID' }], nextCursor: url.searchParams.has('cursor') ? null : '31' } })
  })
  await page.route('**/api/exports**', route => {
    const url = new URL(route.request().url())
    if (/\/exports\/\d+$/.test(url.pathname)) return route.fulfill({ json: { id: '42', kind: 'PRODUCTS', ready: true, status: 'DONE' } })
    return route.fulfill({ json: { items: [{ id: url.searchParams.has('cursor') ? '42' : '41', kind: 'PRODUCTS', ready: true, status: 'DONE' }], nextCursor: url.searchParams.has('cursor') ? null : '41' } })
  })
  await page.goto('/jobs'); await signIn(page)
  const imports = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'New import', exact: true }) })
  const exports = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'New export', exact: true }) })
  await imports.getByRole('button', { name: 'Next', exact: true }).click()
  await exports.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByLabel('CSV file').setInputFiles({ name: 'unsaved.csv', mimeType: 'text/csv', buffer: Buffer.from('sku,quantity\n000123,2.125000\n') })
  await imports.getByRole('button', { name: '#32', exact: true }).click()
  await expect(page.locator('.breadcrumbs [aria-current]')).toHaveText('Import review')
  const preview = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Import review', exact: true }) })
  await expect(preview.getByRole('cell', { name: '000123', exact: true })).toBeVisible()
  await expect(preview.getByRole('cell', { name: '2.125', exact: true })).toBeVisible()
  await expect(preview.getByRole('cell', { name: '25.0000', exact: true })).toBeVisible()
  await expect(preview.getByRole('cell', { name: '25', exact: true })).toBeVisible()
  await exports.getByRole('button', { name: '#42', exact: true }).click()
  await expect(page.locator('.breadcrumbs [aria-current]')).toHaveText('Export download')
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('.breadcrumbs [aria-current]')).toHaveText('Import review')
  await expect(imports.getByRole('button', { name: '#32', exact: true })).toBeVisible()
  await expect(exports.getByRole('button', { name: '#42', exact: true })).toBeVisible()
  expect(await page.getByLabel('CSV file').evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('unsaved.csv')
  expect(await page.getByLabel('CSV file').evaluate((input: HTMLInputElement) => input.files?.[0]?.text())).toBe('sku,quantity\n000123,2.125000\n')
  const dismissed = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve() }))
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await dismissed
  await expect(page).toHaveURL(/\/jobs\?import=32$/)
  const accepted = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.accept(); resolve() }))
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await accepted
  await expect(page).toHaveURL(/\/stock$/)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await signIn(page)
  await page.getByRole('link', { name: 'Imports & exports', exact: true }).click()
  await expect(imports.getByRole('button', { name: '#31', exact: true })).toBeVisible()
  await expect(exports.getByRole('button', { name: '#41', exact: true })).toBeVisible()
  await expect(imports.getByRole('button', { name: 'Previous', exact: true })).toBeDisabled()
})

for (const kind of ['import', 'export'] as const) {
  test(`direct ${kind} alias opens the selected job and returns to its parent`, async ({ page }) => {
    await mockSession(page)
    await page.route(`**/api/${kind}s/17`, route => route.fulfill({ json: kind === 'import'
      ? { id: '17', kind: 'PRODUCTS', status: 'COMMITTED', jobStatus: 'DONE', errors: [], validatedRows: 1 }
      : { id: '17', kind: 'PRODUCTS', status: 'DONE', ready: true } }))
    await page.route('**/api/imports/17/preview', route => route.fulfill({ json: { columns: ['sku'], rows: [], errors: [], hasMore: false } }))
    await page.goto(`/${kind}s/17`); await signIn(page)
    await expect(page).toHaveURL(new RegExp(`/jobs\\?${kind}=17$`))
    await expect(page.locator('.breadcrumbs [aria-current]')).toHaveText(kind === 'import' ? 'Import review' : 'Export download')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(/\/jobs$/)
  })
}

test('attribute and threshold forms protect changes when switching reference sections', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/categories', route => route.fulfill({ json: { items: [{ id: '1', name: 'Tools' }, { id: '2', name: 'Clothes' }] } }))
  await page.route('**/api/categories/2/attributes', route => route.fulfill({ json: { items: [] } }))
  await page.goto('/references'); await signIn(page)
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.getByLabel('Key', { exact: true }).fill('unsaved_attribute')
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Clothes', exact: true }).click()
  await expect(page.getByLabel('Key', { exact: true })).toHaveValue('unsaved_attribute')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Clothes', exact: true }).click()
  await expect(page.getByLabel('Key', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Warehouses', exact: true }).click()
  await page.getByLabel('Low-stock threshold', { exact: true }).fill('2.125')
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Categories', exact: true }).click()
  await expect(page.getByLabel('Low-stock threshold', { exact: true })).toHaveValue('2.125')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Categories', exact: true }).click()
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await expect(page).toHaveURL(/\/stock$/)
})

for (const [kind, status] of [['receipts', 'POSTED'], ['orders', 'FULFILLED'], ['returns', 'POSTED'], ['transfers', 'PARTIALLY_RECEIVED']]) {
  test(`decimal presentation covers ${kind} lines and transfer balances`, async ({ page }) => {
    await mockSession(page)
    await page.route(`**/api/${kind}/12`, route => route.fulfill({ json: { id: '12', status, revision: 1, items: [{ id: '101', sku: '000123', productId: '9', quantity: '2.125000', unitCost: '25.0000', unitPrice: '25.0000', requestedQty: '9.000000', receivedQty: '7.000000', sentQty: '9.000000', inTransitQty: '2.000000', quarantinedQty: '0.000000' }] } }))
    await page.goto(`/${kind}/12`); await signIn(page)
    const items = page.locator('.card').filter({ has: page.getByRole('heading', { name: 'Items', exact: true }) })
    await expect(items.getByRole('cell', { name: '000123', exact: true })).toBeVisible()
    for (const value of kind === 'transfers' ? ['9', '7', '2', '0'] : ['2.125', '25']) await expect(items.getByRole('cell', { name: value, exact: true })).toBeVisible()
    await expect(page.locator('.breadcrumbs [aria-current]')).toHaveText(kind === 'receipts' ? 'Receipt details' : kind === 'orders' ? 'Order details' : kind === 'returns' ? 'Return details' : 'Transfer details')
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/${kind}$`))
  })
}

test('decimal prices, edit inputs and arbitrary product text keep their intended precision', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/products/9', route => route.fulfill({ json: { id: '9', sku: '000123', barcode: '000456', name: 'Text 9.000000', description: 'Original free text 2.125000', categoryId: '1', unitId: '1', unit: 'EA', attributes: { material: 'Text 9.000000' }, sellingPrice: '9999999999999999.123400', sellingCurrency: 'USD', active: true, revision: '1', stock: [{ warehouse: 'MAIN', onHand: '2.125000', reserved: '0.000000', available: '2.125000' }], suppliers: [{ id: '2', name: 'Acme', primarySupplier: true, cost: '10.0000', currency: 'USD' }] } }))
  await page.goto('/products/9'); await signIn(page)
  await expect(page.getByText('9999999999999999.1234 USD', { exact: true })).toBeVisible()
  await expect(page.getByText('Original free text 2.125000', { exact: true })).toBeVisible()
  await expect(page.getByText('000456', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Supplier', exact: true }).selectOption('2')
  await expect(page.getByLabel('Cost', { exact: true })).toHaveValue('10')
  await page.getByLabel('Supplier SKU', { exact: true }).fill('unsaved supplier')
  const cancelled = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve() }))
  await page.getByRole('button', { name: 'Edit product', exact: true }).click(); await cancelled
  await expect(page.getByLabel('Supplier SKU', { exact: true })).toHaveValue('unsaved supplier')
  await expect(page.getByLabel('Selling price', { exact: true })).toHaveCount(0)
  // Discard the supplier form before replacing it with product editing.
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Edit product', exact: true }).click()
  await expect(page.getByLabel('Selling price', { exact: true })).toHaveValue('9999999999999999.1234')
  await page.getByLabel('Selling price', { exact: true }).fill('2.')
  await expect(page.getByLabel('Selling price', { exact: true })).toHaveValue('2.')
})

test('reports, dashboard, approvals and movements trim quantities while retaining IDs', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/dashboard', route => route.fulfill({ json: { stock: { stockRows: '1', outOfStock: '0', lowStock: '0' }, unreadNotifications: '0', valuation: { currencyTotals: [{ currency: 'USD', amount: '170.0000000000' }], unvaluedStockRows: '2' } } }))
  await page.route('**/api/reports/valuation**', route => route.fulfill({ json: { currencyTotals: [{ currency: 'USD', amount: '170.0000000000', stockRows: '1' }], unvaluedStockRows: '2' } }))
  await page.route('**/api/reports/low-stock**', route => route.fulfill({ json: { items: [{ productId: '9', sku: '000123', warehouse: 'MAIN', available: '2.125000', threshold: '5.000000', criticalThreshold: null }], nextCursor: null } }))
  await page.route('**/api/reports/movements**', route => route.fulfill({ json: { items: [{ day: '2026-10-02', eventType: 'ADJUSTMENT', movements: 1, onHandDelta: '-2.125000', reservedDelta: '0.000000' }] } }))
  await page.route('**/api/movements**', route => route.fulfill({ json: { items: [{ id: '1', productId: '9', warehouseId: '001', eventType: 'ADJUSTMENT', onHandDelta: '-2.125000', reservedDelta: '0.000000', occurredAt: '2026-10-02T00:00:00Z' }], nextCursor: null } }))
  await page.route('**/api/stock-requests/12', route => route.fulfill({ json: { id: '12', requestType: 'DAMAGE', decision: 'APPROVED', warehouseId: '001', productId: '9', requestedDelta: '-2.125000', observedOnHand: '9.000000', approvedDelta: '-2.125000', reason: 'Text 9.000000' } }))
  await page.goto('/'); await signIn(page)
  await expect(page.getByText('170', { exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Reports', exact: true }).click()
  for (const value of ['2.125', '5', '170']) await expect(page.getByRole('cell', { name: value, exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Warehouse', exact: true }).first().selectOption('1')
  await page.getByLabel('From', { exact: true }).fill('2026-10-01')
  await page.getByLabel('To (exclusive)', { exact: true }).fill('2026-10-03')
  await page.getByRole('button', { name: 'Run report', exact: true }).click()
  await expect(page.getByRole('cell', { name: '-2.125', exact: true })).toBeVisible()
  await page.getByRole('link', { name: 'Movements', exact: true }).click()
  for (const value of ['-2.125', '0', '001']) await expect(page.getByRole('cell', { name: value, exact: true })).toBeVisible()
  await page.goto('/stock-requests/12')
  await expect(page.getByText('-2.125', { exact: true })).toBeVisible()
  await expect(page.getByText('Text 9.000000', { exact: true })).toBeVisible()
  await expect(page.locator('.summary-row').filter({ hasText: 'Observed on hand' }).locator('strong')).toHaveText('9')
})

test('reference tabs guard discarded input and account forms retain independently dirty changes', async ({ page }) => {
  await mockSession(page)
  const user = { id: '2', displayName: 'Demo Staff', email: 'demo@example.invalid', role: 'STAFF', active: true }
  await page.route('**/api/users?**', route => route.fulfill({ json: { items: [user], nextCursor: null } }))
  await page.route('**/api/users/2', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 204 }) : route.fulfill({ json: { ...user, warehouseIds: ['1'] } }))
  await page.goto('/references'); await signIn(page)
  await page.getByLabel('Name', { exact: true }).fill('Unsaved category')
  const cancelledTab = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve() }))
  await page.getByRole('button', { name: 'Units', exact: true }).click(); await cancelledTab
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved category')
  const acceptedTab = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.accept(); resolve() }))
  await page.getByRole('button', { name: 'Units', exact: true }).click(); await acceptedTab
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('')
  await page.getByRole('link', { name: 'Users', exact: true }).click()
  await page.getByRole('button', { name: 'Demo Staff', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: 'MAIN — Main' })).toBeChecked()
  await page.getByLabel('Display name', { exact: true }).fill('Saved profile')
  await page.getByLabel('Temporary password', { exact: true }).fill('Unsaved-local-only')
  await page.getByRole('button', { name: 'Save user', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('User updated.')
  const cancelledClose = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.dismiss(); resolve() }))
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await cancelledClose
  await expect(page.getByLabel('Temporary password', { exact: true })).toHaveValue('Unsaved-local-only')
  const acceptedClose = new Promise<void>(resolve => page.once('dialog', async dialog => { await dialog.accept(); resolve() }))
  await page.getByRole('button', { name: 'Close', exact: true }).click(); await acceptedClose
  await expect(page.getByLabel('Initial password', { exact: true })).toHaveValue('')
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await expect(page).toHaveURL(/\/stock$/)
})

test('layout review captures logo, long account footer and breadcrumbs at four widths in both languages', async ({ page }, info) => {
  test.setTimeout(60_000)
  await mockSession(page, 'MANAGER', 'Demo Staff / Nhân viên miền Bắc rất dài')
  await page.route('**/api/products/9', route => route.fulfill({ json: { id: '9', sku: 'DEMO-V2-P001', name: 'Smartphone / Điện thoại thông minh', categoryId: '1', unitId: '1', category: 'Electronics / Điện tử', unit: 'EA', attributes: { material: 'Demo / Mẫu' }, sellingPrice: '25.0000', sellingCurrency: 'USD', active: true, stock: [{ warehouse: 'MAIN', onHand: '9.000000', reserved: '0.000000', available: '9.000000' }], suppliers: [] } }))
  const directory = process.env.QA_SCREENSHOT_DIR || info.outputPath('visuals')
  await mkdir(directory, { recursive: true })
  await page.goto('/products/9')
  for (const width of [1440, 768, 390, 320]) for (const language of ['en', 'vi']) {
    await page.setViewportSize({ width, height: 900 })
    await page.getByLabel(/^(Language|Ngôn ngữ)$/).selectOption(language)
    const logo = page.locator('.auth-brand img')
    await expect(logo).toBeVisible()
    expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(258)
    await page.screenshot({ path: join(directory, `signin-${width}-${language}.png`), fullPage: true })
  }
  await page.getByLabel(/^(Language|Ngôn ngữ)$/).selectOption('en'); await signIn(page)
  for (const width of [1440, 768, 390, 320]) for (const language of ['en', 'vi']) {
    await page.setViewportSize({ width, height: 900 }); await page.getByLabel(/^(Language|Ngôn ngữ)$/).selectOption(language)
    await expect(page.getByRole('heading', { name: 'Smartphone / Điện thoại thông minh', exact: true })).toBeVisible()
    await page.screenshot({ path: join(directory, `product-${width}-${language}.png`), fullPage: true })
    if (width < 740) {
      await page.getByRole('button', { name: language === 'en' ? 'Toggle menu' : 'Mở hoặc đóng menu' }).click()
      await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
    } else await expect(page.getByRole('button', { name: language === 'en' ? 'Close menu' : 'Đóng trình đơn', exact: true })).toBeHidden()
    const signout = page.locator('.sidebar-footer button')
    await expect(signout).toBeInViewport()
    const bounds = await signout.boundingBox(), svg = await signout.locator('svg').boundingBox()
    expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44)
    expect(svg!.width).toBe(22)
    await page.screenshot({ path: join(directory, `sidebar-${width}-${language}.png`), fullPage: true })
    if (width < 740) {
      await page.getByRole('button', { name: language === 'en' ? 'Close menu' : 'Đóng trình đơn', exact: true }).click()
      await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -232, 0)')
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  }
})

async function mockSession(page: Page, role: 'MANAGER' | 'STAFF' | 'VIEWER' = 'MANAGER', displayName = 'Warehouse Manager') {
  await page.addInitScript(() => { Object.defineProperty(window, 'EventSource', { value: undefined }) })
  let signedIn = false
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/auth/me') return signedIn ? send({ user: { id: '1', email: 'manager@example.com', displayName, role, warehouses: ['1'], mustChangePassword: false } }) : send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' } }, 401)
    if (path === '/api/auth/login') { signedIn = true; return send({ user: { id: '1', email: 'manager@example.com', displayName, role, warehouses: ['1'], mustChangePassword: false } }) }
    if (path === '/api/auth/logout') { signedIn = false; return route.fulfill({ status: 204 }) }
    if (path === '/api/notifications/unread-count') return send({ count: 0 })
    if (path === '/api/dashboard') return send({ generatedAt: new Date().toISOString(), role, stock: { stockRows: '1', outOfStock: '0', lowStock: '0' }, unreadNotifications: '0' })
    if (path === '/api/categories') return send({ items: [{ id: '1', name: 'Tools' }] })
    if (path === '/api/units') return send({ items: [{ id: '1', name: 'Each', code: 'EA' }] })
    if (path === '/api/suppliers') return send({ items: [{ id: '2', name: 'Acme' }] })
    if (path === '/api/warehouses') return send({ items: [{ id: '1', name: 'Main', code: 'MAIN' }] })
    if (path === '/api/categories/1/attributes') return send({ items: [{ key: 'material', label: 'Material', dataType: 'string', required: true, allowedValues: null, minValue: null, maxValue: null }] })
    if (path === '/api/products' && method === 'GET') return send({ items: [{ id: '9', sku: 'HAMMER-001', name: 'Hammer', categoryId: '1', category: 'Tools', imageUrl: null }], nextCursor: null })
    if (path === '/api/products' && method === 'POST') return send({ id: '10' }, 201)
    if (path === '/api/products/10') return send({ id: '10', sku: 'NEW-001', name: 'New hammer', categoryId: '1', category: 'Tools', unitId: '1', unit: 'EA', attributes: { material: 'steel' }, active: true, revision: '0', stock: [], suppliers: [] })
    if (path === '/api/stock') return send({ items: [{ warehouseId: '1', warehouse: 'MAIN', productId: '9', sku: 'HAMMER-001', name: 'Hammer', onHand: '10.000000', reserved: '2.000000', available: '8.000000', version: '1' }], nextCursor: null })
    if (path === '/api/reports/valuation') return send({ currencyTotals: [], unvaluedStockRows: '0' })
    if (path === '/api/notifications/stream') return route.abort()
    return send({ items: [], nextCursor: null })
  })
}

test('manager signs in, searches products, and opens stock', async ({ page }) => {
  await mockSession(page)
  await page.goto('/')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible()
  await page.getByRole('link', { name: 'Products', exact: true }).click()
  await page.getByLabel('Search').fill('HAMMER')
  await expect(page.getByRole('link', { name: 'HAMMER-001' })).toBeVisible()
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await expect(page.getByText('8', { exact: true })).toBeVisible()
})

for (const count of ['0', '3']) {
  test(`dashboard shows waiting counts of ${count} instead of blank values`, async ({ page }) => {
    await mockSession(page)
    await page.route('**/api/dashboard', route => route.fulfill({ json: {
      generatedAt: new Date().toISOString(),
      stock: { stockRows: '1', outOfStock: '0', lowStock: '0' }, unreadNotifications: '0',
      work: { orders: { drafts: '0', awaitingFulfillment: count }, transfers: { awaitingReceipt: count, disputed: '0' }, pendingApprovals: '0' },
    } }))
    await page.goto('/')
    await page.getByLabel('Email').fill('manager@example.com')
    await page.getByLabel('Password').fill('example-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    for (const label of ['Awaiting fulfillment', 'Awaiting receipt']) {
      await expect(page.locator('.summary-row').filter({ has: page.getByText(label, { exact: true }) }).locator('strong')).toHaveText(count)
    }
  })
}

test('sign-in, navigation, search and sign-out work using only the keyboard', async ({ page }) => {
  await mockSession(page)
  await page.goto('/')
  async function tabTo(target: ReturnType<Page['getByRole']>) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await target.evaluate(element => element === document.activeElement)) return
      await page.keyboard.press('Tab')
    }
    await expect(target).toBeFocused()
  }
  await tabTo(page.getByLabel('Email'))
  await page.keyboard.type('manager@example.com')
  await tabTo(page.getByLabel('Password'))
  await page.keyboard.type('example-password')
  await tabTo(page.getByRole('button', { name: 'Sign in', exact: true }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: /Good day/ })).toBeVisible()
  await tabTo(page.getByRole('link', { name: 'Products', exact: true }))
  await page.keyboard.press('Enter')
  await tabTo(page.getByLabel('Search'))
  await page.keyboard.type('HAMMER')
  await expect(page.getByRole('link', { name: 'HAMMER-001' })).toBeVisible()
  await tabTo(page.getByRole('link', { name: 'Stock', exact: true }))
  await page.keyboard.press('Enter')
  await expect(page.getByText('8', { exact: true })).toBeVisible()
  await tabTo(page.getByRole('button', { name: 'Sign out', exact: true }))
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
})

test('CSV file picker submits file bytes and displays validation before commit', async ({ page }) => {
  await mockSession(page)
  const csv = 'sku,name,category_id,unit_id\r\nQA-001,Keyboard fixture,1,1\r\n'
  let multipart = '', status = 'READY'
  await page.route('**/api/imports**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/imports/products' && route.request().method() === 'POST') {
      multipart = route.request().postDataBuffer()?.toString() ?? ''
      return route.fulfill({ status: 202, json: { id: '12' } })
    }
    if (path === '/api/imports/12/commit') { status = 'COMMITTED'; return route.fulfill({ status: 202, json: { status: 'QUEUED' } }) }
    if (path === '/api/imports/12/preview') return route.fulfill({ json: { columns: ['sku', 'name'], rows: [{ rowNumber: 2, values: ['QA-001', 'Keyboard fixture'] }], hasMore: false, errors: [] } })
    const row = { id: '12', kind: 'PRODUCTS', status, validatedRows: 1, jobStatus: 'DONE', commitKey: crypto.randomUUID(), errors: [] }
    return route.fulfill({ json: path === '/api/imports/12' ? row : { items: multipart ? [row] : [], nextCursor: null } })
  })
  await page.goto('/jobs')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Upload & validate' })).toBeDisabled()
  await page.getByLabel('Data type').selectOption('products')
  await page.getByLabel('CSV file').setInputFiles({ name: 'qa-products.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
  await page.getByRole('button', { name: 'Upload & validate' }).click()
  await expect(page.getByRole('heading', { name: 'CSV preview' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('Upload received.')
  await expect(page.getByText('Keyboard fixture', { exact: true })).toBeVisible()
  expect(multipart).toContain('filename="qa-products.csv"')
  expect(multipart).toContain(csv)
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Commit import' }).click()
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: '#12', exact: true }) })).toContainText('COMMITTED')
})

test('Download CSV saves the expected file and exact contents', async ({ page }) => {
  await mockSession(page)
  const csv = 'sku,name\r\nQA-001,Download fixture\r\n'
  await page.route('**/api/exports/8', route => route.fulfill({ json: { id: '8', kind: 'PRODUCTS', format: 'CSV', status: 'DONE', ready: true } }))
  await page.route('**/api/exports/8/file', route => route.fulfill({ contentType: 'text/csv', headers: { 'Content-Disposition': 'attachment; filename="orderflow-8.csv"' }, body: csv }))
  await page.goto('/jobs?export=8')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  const pending = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download CSV' }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe('orderflow-8.csv')
  expect(await download.failure()).toBeNull()
  const path = await download.path()
  expect(path).not.toBeNull()
  expect(await readFile(path!, 'utf8')).toBe(csv)
})

test('manager product form sends category attributes as JSON values', async ({ page }) => {
  await mockSession(page)
  await page.goto('/products')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'New product' }).click()
  const editor = page.locator('.drawer')
  await page.getByLabel('SKU').fill('NEW-001')
  await page.getByLabel('Product name').fill('New hammer')
  await editor.getByLabel('Category').selectOption('1')
  await editor.getByLabel('Unit').selectOption('1')
  await editor.getByLabel('Material').fill('steel')
  const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/products') && request.method() === 'POST')
  await page.getByRole('button', { name: 'Save product' }).click()
  const request = await requestPromise
  expect(request.postDataJSON()).toMatchObject({ sku: 'NEW-001', categoryId: '1', unitId: '1', attributes: { material: 'steel' } })
  await expect(page).toHaveURL(/\/products\/10$/)
  await expect(page.getByRole('heading', { name: 'New hammer' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Supplier', exact: true }).selectOption('2')
  await page.getByRole('textbox', { name: 'Cost', exact: true }).fill('12.50')
  await page.getByRole('combobox', { name: 'Currency' }).selectOption('USD')
  const supplierRequest = page.waitForRequest(request => request.url().endsWith('/api/products/10/suppliers/2') && request.method() === 'PUT')
  await page.getByRole('button', { name: 'Save supplier' }).click()
  expect((await supplierRequest).postDataJSON()).toMatchObject({ cost: '12.50', currency: 'USD' })
})

test('viewer sees stock without manager controls on a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockSession(page, 'VIEWER')
  await page.goto('/')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Toggle menu' }).click()
  await expect(page.getByRole('link', { name: 'Users' })).toHaveCount(0)
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await expect(page.getByText('8', { exact: true })).toBeVisible()
})

test('manager creates a receipt and selects a product by SKU before saving lines', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/receipts**', async route => {
    const pathname = new URL(route.request().url()).pathname
    const method = route.request().method()
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === '/api/receipts' && method === 'GET') return send({ items: [], nextCursor: null })
    if (pathname === '/api/receipts' && method === 'POST') return send({ id: '4' }, 201)
    if (pathname === '/api/receipts/4' && method === 'GET') return send({ id: '4', receiptNumber: 'RC-001', status: 'DRAFT', kind: 'INBOUND', warehouseId: '1', revision: 0, items: [] })
    if (pathname === '/api/receipts/4/items' && method === 'PUT') return send({ revision: 1 })
    return route.continue()
  })
  await page.goto('/receipts')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'New receipt' }).click()
  await page.getByLabel('Document number').fill('RC-001')
  await page.locator('.drawer').getByRole('combobox', { name: 'Warehouse' }).selectOption('1')
  await page.getByRole('button', { name: 'Create draft' }).click()
  await expect(page).toHaveURL(/\/receipts\/4$/)
  await page.getByLabel('Search product').fill('HAMMER')
  await page.getByRole('combobox', { name: 'Product' }).selectOption('9')
  await page.getByLabel('Quantity').fill('2')
  const requestPromise = page.waitForRequest(request => request.url().endsWith('/api/receipts/4/items') && request.method() === 'PUT')
  await page.getByRole('button', { name: 'Save lines' }).click()
  const request = await requestPromise
  expect(request.postDataJSON()).toMatchObject({ expectedRevision: 0, items: [{ productId: '9', quantity: '2' }] })
})

test('unsaved product edit asks before leaving the page', async ({ page }) => {
  await mockSession(page)
  await page.goto('/products/10')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('button', { name: 'Edit product' }).click()
  await page.getByLabel('Product name').fill('Changed hammer')
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await expect(page).toHaveURL(/\/products\/10$/)
  await expect(page.getByLabel('Product name')).toHaveValue('Changed hammer')
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('link', { name: 'Stock', exact: true }).click()
  await expect(page).toHaveURL(/\/stock$/)
})

test('job notification link opens the matching import review', async ({ page }) => {
  await mockSession(page)
  await page.route('**/api/imports/7', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '7', kind: 'PRODUCTS', status: 'INVALID', validatedRows: 1, commitKey: crypto.randomUUID(), jobStatus: 'DONE', lastErrorCode: null, errors: [{ rowNumber: 2, field: 'sku', message: 'Duplicate SKU.' }] }) }))
  await page.route('**/api/imports/7/preview', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ columns: ['sku'], rows: [{ rowNumber: 2, values: ['DUPLICATE'] }], hasMore: false, errors: [] }) }))
  await page.goto('/imports/7')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/jobs\?import=7$/)
  await expect(page.getByText('Duplicate SKU.')).toBeVisible()
})

test('Vietnamese can be selected before sign-in', async ({ page }) => {
  await mockSession(page)
  await page.goto('/')
  await page.getByRole('combobox', { name: 'Language' }).selectOption('vi')
  await expect(page.getByRole('heading', { name: 'Chào mừng trở lại' })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Mật khẩu').fill('example-password')
  await page.getByRole('button', { name: 'Đăng nhập' }).click()
  await expect(page.getByRole('link', { name: 'Sản phẩm' })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Xin chào/ })).toBeVisible()
  await page.getByRole('link', { name: 'Tồn kho', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Kho', exact: true })).toContainText('Tất cả kho được phép')
  await expect(page.getByRole('combobox', { name: 'Khả dụng', exact: true })).toContainText('Tất cả tồn kho')
  await page.getByRole('combobox', { name: 'Khả dụng', exact: true }).selectOption({ label: 'Hết hàng' })
  await expect(page).toHaveURL(/availability=OUT_OF_STOCK/)
})

test('completed export refreshes the recent list without reload and stops polling', async ({ page }) => {
  await mockSession(page)
  let status = 'PENDING', detailReads = 0, queued = false
  await page.route('**/api/exports**', route => {
    const path = new URL(route.request().url()).pathname
    const row = { id: '8', kind: 'PRODUCTS', format: 'CSV', status, ready: status === 'DONE' }
    if (route.request().method() === 'POST') { queued = true; return route.fulfill({ status: 202, json: { id: '8' } }) }
    if (path === '/api/exports/8') {
      detailReads++
      if (detailReads > 1) status = 'DONE'
      return route.fulfill({ json: { ...row, status, ready: status === 'DONE' } })
    }
    return route.fulfill({ json: { items: queued ? [row] : [], nextCursor: null } })
  })
  await page.goto('/jobs')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('combobox', { name: 'Data', exact: true }).selectOption('PRODUCTS')
  await page.getByRole('button', { name: 'Request export' }).click()
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: '#8', exact: true }) })).toContainText('DONE', { timeout: 10000 })
  await expect(page.getByRole('link', { name: 'Download CSV' })).toBeVisible()
  const readsAtCompletion = detailReads
  await page.waitForTimeout(3500)
  expect(detailReads).toBe(readsAtCompletion)
})

test('validated imports awaiting review and failed exports do not poll forever', async ({ page }) => {
  await mockSession(page)
  let importReads = 0, exportReads = 0
  await page.route('**/api/imports/7', route => {
    importReads++
    return route.fulfill({ json: { id: '7', kind: 'PRODUCTS', status: 'READY', jobStatus: 'DONE', validatedRows: 1, commitKey: crypto.randomUUID(), lastErrorCode: null, errors: [] } })
  })
  await page.route('**/api/imports/7/preview', route => route.fulfill({ json: { columns: ['sku'], rows: [], hasMore: false, errors: [] } }))
  await page.route('**/api/exports/8', route => {
    exportReads++
    return route.fulfill({ json: { id: '8', kind: 'PRODUCTS', format: 'CSV', status: 'FAILED', ready: false, lastErrorCode: 'TEST_FAILURE' } })
  })
  await page.goto('/jobs?import=7&export=8')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('button', { name: 'Commit import' })).toBeVisible()
  await expect(page.getByText('PRODUCTS · FAILED')).toBeVisible()
  await expect(page.getByText('Export failed. Request a new export.')).toBeVisible()
  await expect(page.getByText('Processing…')).toHaveCount(0)
  await page.waitForTimeout(3500)
  expect(importReads).toBe(1)
  expect(exportReads).toBe(1)
})

test('committing a reviewed import resumes polling and refreshes the committed list', async ({ page }) => {
  await mockSession(page)
  let status = 'READY', jobStatus = 'DONE', commitReads = 0
  const commitKey = crypto.randomUUID()
  await page.route('**/api/imports**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/imports/7/commit') { jobStatus = 'PENDING'; return route.fulfill({ status: 202, json: { status: 'QUEUED' } }) }
    if (path === '/api/imports/7/preview') return route.fulfill({ json: { columns: ['sku'], rows: [], hasMore: false, errors: [] } })
    if (path === '/api/imports/7') {
      if (jobStatus === 'PENDING' && ++commitReads > 1) { status = 'COMMITTED'; jobStatus = 'DONE' }
      return route.fulfill({ json: { id: '7', kind: 'PRODUCTS', status, jobStatus, validatedRows: 1, commitKey, lastErrorCode: null, errors: [] } })
    }
    return route.fulfill({ json: { items: [{ id: '7', kind: 'PRODUCTS', status, validatedRows: 1 }], nextCursor: null } })
  })
  await page.goto('/jobs?import=7')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Commit import' }).click()
  await expect(page.getByRole('row').filter({ has: page.getByRole('button', { name: '#7', exact: true }) })).toContainText('COMMITTED', { timeout: 10000 })
  await expect(page.getByRole('button', { name: 'Commit import' })).toHaveCount(0)
})

test('temporary password flow returns to sign-in with a clear message', async ({ page }) => {
  await mockSession(page)
  let signedIn = false
  await page.route('**/api/auth/**', route => {
    const pathname = new URL(route.request().url()).pathname
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (pathname === '/api/auth/me') return signedIn
      ? send({ user: { id: '1', displayName: 'Manager', role: 'MANAGER', warehouses: ['1'], mustChangePassword: true } })
      : send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' } }, 401)
    if (pathname === '/api/auth/login') { signedIn = true; return send({ user: { id: '1', displayName: 'Manager', role: 'MANAGER', warehouses: ['1'], mustChangePassword: true } }) }
    if (pathname === '/api/auth/change-password') { signedIn = false; return route.fulfill({ status: 204 }) }
    return route.continue()
  })
  await page.goto('/')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('temporary-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible()
  await page.getByLabel('Current password').fill('temporary-password')
  await page.getByLabel('New password').fill('new-secure-password')
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByRole('status')).toHaveText('Password changed. Please sign in again.')
})

for (const kind of ['orders', 'returns', 'transfers'] as const) {
  test(`${kind} form creates a draft, saves lines and completes its main workflow`, async ({ page }) => {
    await mockSession(page)
    await page.route('**/api/warehouses', route => route.fulfill({ json: { items: [{ id: '1', code: 'MAIN', name: 'Main' }, { id: '2', code: 'OTHER', name: 'Other' }] } }))
    if (kind === 'returns') {
      await page.route('**/api/orders?**', route => route.fulfill({ json: { items: [{ id: '21', orderNumber: 'QA-ORDER', status: 'FULFILLED' }], nextCursor: null } }))
      await page.route('**/api/orders/21', route => route.fulfill({ json: { id: '21', orderNumber: 'QA-ORDER', status: 'FULFILLED', revision: 1, items: [{ id: '22', productId: '9', sku: 'HAMMER-001', warehouseId: '1', quantity: '5', returnableQty: '3' }] } }))
    }
    let status = 'DRAFT', revision = 0
    let items: Record<string, string | null>[] = []
    const requests: { path: string; body: unknown; key?: string }[] = []
    const numberKey = { orders: 'orderNumber', returns: 'returnNumber', transfers: 'transferNumber' }[kind]
    const document = () => ({ id: '30', [numberKey]: 'QA-DOCUMENT', status, revision, items, ...(kind === 'returns' ? { orderId: '21', warehouseId: '1', reason: 'QA return' } : kind === 'transfers' ? { sourceWarehouseId: '1', destinationWarehouseId: '2' } : {}) })
    await page.route(`**/api/${kind}**`, route => {
      const path = new URL(route.request().url()).pathname
      const method = route.request().method()
      if (method !== 'GET') requests.push({ path, body: route.request().postDataJSON(), key: route.request().headers()['idempotency-key'] })
      if (path === `/api/${kind}` && method === 'POST') return route.fulfill({ status: 201, json: { id: '30' } })
      if (path === `/api/${kind}/30/items` && method === 'PUT') {
        items = route.request().postDataJSON().items.map((item: Record<string, string | null>) => ({ ...item, id: '31', sku: 'HAMMER-001', receivedQty: '0', inTransitQty: kind === 'transfers' ? '2' : '0', quarantinedQty: '0' }))
        revision++
        return route.fulfill({ json: { revision } })
      }
      if (method === 'POST') {
        status = path.endsWith('/confirm') ? 'CONFIRMED' : path.endsWith('/fulfill') ? 'FULFILLED' : path.endsWith('/send') ? 'SENT' : path.endsWith('/receive') ? 'RECEIVED' : 'POSTED'
        if (status === 'RECEIVED') items = items.map(item => ({ ...item, receivedQty: '2', inTransitQty: '0' }))
        return route.fulfill({ json: { status } })
      }
      if (path === `/api/${kind}/30`) return route.fulfill({ json: document() })
      return route.fulfill({ json: { items: [], nextCursor: null } })
    })
    await page.goto(`/${kind}`)
    await page.getByLabel('Email').fill('manager@example.com')
    await page.getByLabel('Password').fill('example-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.getByRole('button', { name: `New ${kind.slice(0, -1)}` }).click()
    const drawer = page.locator('.drawer')
    await drawer.getByLabel('Document number').fill('QA-DOCUMENT')
    if (kind === 'returns') {
      await drawer.getByLabel('Fulfilled order', { exact: true }).selectOption('21')
      await drawer.getByRole('combobox', { name: 'Warehouse' }).selectOption('1')
      await drawer.getByLabel('Reason').fill('QA return')
    }
    if (kind === 'transfers') {
      await drawer.getByLabel('Source warehouse').selectOption('1')
      await expect(drawer.getByLabel('Destination warehouse').locator('option[value="1"]')).toHaveCount(0)
      await drawer.getByLabel('Destination warehouse').selectOption('2')
    }
    await drawer.getByRole('button', { name: 'Create draft' }).click()
    await expect(page).toHaveURL(new RegExp(`/${kind}/30$`))
    expect(requests[0].body).toMatchObject({ [numberKey]: 'QA-DOCUMENT', ...(kind === 'returns' ? { orderId: '21', warehouseId: '1', reason: 'QA return' } : kind === 'transfers' ? { sourceWarehouseId: '1', destinationWarehouseId: '2' } : {}) })
    if (kind === 'returns') await page.getByLabel('Order item').selectOption('22')
    else {
      await page.getByLabel('Search product').fill('HAMMER')
      await page.getByRole('combobox', { name: 'Product', exact: true }).selectOption('9')
    }
    if (kind === 'orders') await page.getByRole('combobox', { name: 'Warehouse' }).selectOption('1')
    await page.getByLabel('Quantity', { exact: true }).fill('2')
    await page.getByRole('button', { name: 'Save lines' }).click()
    const action = kind === 'orders' ? 'Confirm order' : kind === 'returns' ? 'Post return' : 'Dispatch'
    await expect(page.getByRole('button', { name: action, exact: true })).toBeVisible()
    expect(requests.find(request => request.path.endsWith('/items'))?.body).toMatchObject({ expectedRevision: 0, items: [kind === 'returns' ? { orderItemId: '22', quantity: '2' } : kind === 'orders' ? { productId: '9', warehouseId: '1', quantity: '2' } : { productId: '9', requestedQty: '2' }] })
    page.once('dialog', dialog => dialog.accept())
    await page.getByRole('button', { name: action, exact: true }).click()
    if (kind === 'orders') {
      await expect(page.getByRole('button', { name: 'Fulfill', exact: true })).toBeVisible()
      page.once('dialog', dialog => dialog.accept())
      await page.getByRole('button', { name: 'Fulfill', exact: true }).click()
    }
    if (kind === 'transfers') {
      await page.getByLabel('Accept', { exact: true }).fill('2')
      await page.getByLabel('Quarantine excess', { exact: true }).fill('1')
      await expect(page.getByLabel('Excess reason', { exact: true })).toBeVisible()
      await expect(page.getByLabel('Excess reason', { exact: true })).toHaveAttribute('required', '')
      await page.getByLabel('Quarantine excess', { exact: true }).fill('0.000000')
      await expect(page.getByLabel('Excess reason', { exact: true })).toHaveCount(0)
      await page.getByRole('button', { name: 'Record receipt', exact: true }).click()
      expect(requests.find(request => request.path.endsWith('/receive'))?.body).toEqual({ note: null, items: [{ transferItemId: '31', acceptedQty: '2', quarantinedQty: '0.000000' }] })
    }
    await expect(page.locator('.summary-row').filter({ has: page.getByText('Status', { exact: true }) })).toContainText(kind === 'orders' ? 'FULFILLED' : kind === 'returns' ? 'POSTED' : 'RECEIVED')
    await expect(page.getByRole('button', { name: 'Save lines', exact: true })).toHaveCount(0)
    for (const request of requests.filter(request => !request.path.endsWith('/items') && request.path !== `/api/${kind}`)) expect(request.key).toMatch(/^[0-9a-f-]{36}$/)
  })
}

test('stock approval shows stale balance errors and requires a fresh review before retry', async ({ page }) => {
  await mockSession(page)
  let created = false, decision: string | null = null, version = '1', attempts = 0
  const decisions: Record<string, string>[] = []
  await page.route('**/api/stock?**', route => route.fulfill({ json: { items: [{ version, onHand: '10', available: '8' }] } }))
  await page.route('**/api/stock-requests**', route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/stock-requests' && route.request().method() === 'POST') {
      expect(route.request().postDataJSON()).toMatchObject({ requestType: 'DAMAGE', warehouseId: '1', productId: '9', quantity: '1', reason: 'QA damage' })
      created = true
      return route.fulfill({ status: 201, json: { id: '40' } })
    }
    if (path === '/api/stock-requests/40/decision') {
      decisions.push(route.request().postDataJSON())
      if (++attempts === 1) { version = '2'; return route.fulfill({ status: 409, json: { error: { code: 'STALE_BALANCE', message: 'Balance changed.' } } }) }
      decision = 'APPROVED'
      return route.fulfill({ json: { decision } })
    }
    const row = { id: '40', requestType: 'DAMAGE', warehouseId: '1', productId: '9', requestedDelta: '-1', reason: 'QA damage', decision }
    return route.fulfill({ json: path === '/api/stock-requests/40' ? row : { items: created ? [row] : [], nextCursor: null } })
  })
  await page.goto('/stock-requests')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('combobox', { name: 'Warehouse' }).selectOption('1')
  await page.getByLabel('Search product').fill('HAMMER')
  await page.getByRole('combobox', { name: 'Product', exact: true }).selectOption('9')
  await page.getByLabel('Quantity to remove').fill('1')
  await page.getByLabel('Reason', { exact: true }).fill('QA damage')
  await page.getByRole('button', { name: 'Submit request' }).click()
  await expect(page).toHaveURL(/\/stock-requests\/40$/)
  await page.getByLabel('Reviewed balance version').fill('1')
  await page.getByLabel('Reason', { exact: true }).fill('Reviewed damage')
  await page.getByRole('button', { name: 'Submit decision' }).click()
  await expect(page.getByRole('alert')).toHaveText('This record changed. Refresh and review it before retrying.')
  await expect(page.getByRole('heading', { name: 'Decide request' })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Reviewed balance version')).toHaveAttribute('placeholder', '2')
  await page.getByLabel('Reviewed balance version').fill('2')
  await page.getByLabel('Reason', { exact: true }).fill('Reviewed updated balance')
  await page.getByRole('button', { name: 'Submit decision' }).click()
  await expect(page.getByRole('heading', { name: 'Decide request' })).toHaveCount(0)
  expect(decisions.map(row => row.reviewedBalanceVersion)).toEqual(['1', '2'])
  await expect(page.locator('.summary-row').filter({ has: page.getByText('Status', { exact: true }) })).toContainText('APPROVED')
})

test('evidence picker is named, rejects oversized files and submits a small file', async ({ page }) => {
  await mockSession(page)
  let uploaded = false, uploadCount = 0
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=', 'base64')
  await page.route('**/api/stock-requests/40', route => route.fulfill({ json: { id: '40', requestType: 'DAMAGE', decision: 'APPROVED', reason: 'Fictional damage' } }))
  await page.route('**/api/evidence/stock-requests/40', route => {
    if (route.request().method() === 'POST') {
      uploadCount++
      expect(route.request().headers()['content-type']).toContain('multipart/form-data; boundary=')
      const body = route.request().postDataBuffer()!
      expect(body.includes(Buffer.from('filename="qa-evidence.png"'))).toBe(true)
      expect(body.includes(png)).toBe(true)
      uploaded = true
      return route.fulfill({ status: 201, json: { id: '60' } })
    }
    return route.fulfill({ json: { items: uploaded ? [{ id: '60', filename: 'qa-evidence.png' }] : [] } })
  })
  await page.goto('/stock-requests/40')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  const picker = page.getByLabel('Evidence file', { exact: true })
  await expect(picker).toBeVisible({ timeout: 3000 })
  await expect(page.getByRole('button', { name: 'Upload evidence' })).toBeDisabled()
  await picker.setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1) })
  await page.getByRole('button', { name: 'Upload evidence' }).click()
  await expect(page.getByRole('alert')).toHaveText('Evidence must be 5 MB or smaller.')
  expect(uploadCount).toBe(0)
  await picker.setInputFiles({ name: 'qa-evidence.png', mimeType: 'image/png', buffer: png })
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page).toHaveURL(/\/stock-requests\/40$/)
  expect(await picker.evaluate((input: HTMLInputElement) => input.files?.[0]?.name)).toBe('qa-evidence.png')
  await page.getByRole('button', { name: 'Upload evidence' }).click()
  await expect(page.getByRole('link', { name: 'qa-evidence.png' })).toHaveAttribute('href', '/api/evidence/60/file')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Upload evidence' })).toBeDisabled()
  expect(uploadCount).toBe(1)
  await page.getByRole('combobox', { name: 'Language' }).selectOption('vi')
  await expect(page.getByLabel('Tệp minh chứng', { exact: true })).toBeVisible()
})

test('excess discrepancy defaults to a valid resolution and clears after resolving', async ({ page }) => {
  await mockSession(page)
  let resolved = false
  await page.route('**/api/transfers/50', route => route.fulfill({ json: { id: '50', transferNumber: 'QA-EXCESS', status: 'DISPUTED', revision: 1, sourceWarehouseId: '1', destinationWarehouseId: '2', items: [] } }))
  await page.route('**/api/transfers/50/discrepancies', route => route.fulfill({ json: { items: [{ id: '51', transferItemId: '52', kind: 'EXCESS', reportedQty: '1.000000', outstandingQty: resolved ? '0.000000' : '1.000000', status: resolved ? 'RESOLVED' : 'OPEN', reason: 'Extra delivery' }] } }))
  await page.route('**/api/discrepancies/51/resolve', route => {
    const body = route.request().postDataJSON()
    if (body.resolutionType !== 'ACCEPT_EXCESS') return route.fulfill({ status: 400, json: { error: { code: 'INVALID_RESOLUTION', message: 'Invalid excess resolution.' } } })
    resolved = true
    return route.fulfill({ json: { status: 'RESOLVED' } })
  })
  await page.goto('/transfers/50')
  await page.getByLabel('Email').fill('manager@example.com')
  await page.getByLabel('Password').fill('example-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  const discrepancy = page.locator('.discrepancy')
  await expect(discrepancy.getByRole('combobox', { name: 'Resolution' })).toHaveValue('ACCEPT_EXCESS')
  await discrepancy.getByLabel('Quantity').fill('1')
  await discrepancy.getByLabel('Reason').fill('Verified excess')
  page.once('dialog', dialog => dialog.dismiss())
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(discrepancy.getByLabel('Reason')).toHaveValue('Verified excess')
  const pending = page.waitForRequest(request => request.url().endsWith('/api/discrepancies/51/resolve'))
  await discrepancy.getByRole('button', { name: 'Resolve', exact: true }).click()
  expect((await pending).postDataJSON()).toMatchObject({ resolutionType: 'ACCEPT_EXCESS', quantity: '1', reason: 'Verified excess' })
  await expect(discrepancy.getByRole('button', { name: 'Resolve', exact: true })).toHaveCount(0)
  await expect(discrepancy).toContainText('Outstanding: 0')
})

for (const entry of [{ path: '/products', title: 'New product', field: 'SKU' }, { path: '/orders', title: 'New order', field: 'Document number' }]) {
  test(`${entry.title} popup keeps keyboard focus inside and protects unsaved changes`, async ({ page }) => {
    await mockSession(page)
    if (entry.title === 'New order') await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(entry.path)
    await page.getByLabel('Email').fill('manager@example.com')
    await page.getByLabel('Password').fill('example-password')
    await page.getByRole('button', { name: 'Sign in' }).click()
    const trigger = page.getByRole('button', { name: entry.title, exact: true })
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: entry.title, exact: true })
    await expect(dialog).toBeVisible()
    const bounds = await dialog.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    expect(Math.abs(bounds!.x + bounds!.width - page.viewportSize()!.width)).toBeLessThan(1)
    await expect(dialog.getByLabel(entry.field, { exact: true })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(dialog.getByRole('button', { name: entry.title === 'New product' ? 'Save product' : 'Create draft' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog.getByLabel(entry.field, { exact: true })).toBeFocused()
    await page.keyboard.type('UNSAVED-QA')
    page.once('dialog', prompt => prompt.dismiss())
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel(entry.field, { exact: true })).toHaveValue('UNSAVED-QA')
    page.once('dialog', prompt => prompt.accept())
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })
}
