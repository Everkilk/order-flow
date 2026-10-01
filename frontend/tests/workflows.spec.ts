import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

async function mockSession(page: Page, role: 'MANAGER' | 'VIEWER' = 'MANAGER') {
  await page.addInitScript(() => { Object.defineProperty(window, 'EventSource', { value: undefined }) })
  let signedIn = false
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    const method = route.request().method()
    const send = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
    if (path === '/api/auth/me') return signedIn ? send({ user: { id: '1', email: 'manager@example.com', displayName: 'Warehouse Manager', role, warehouses: ['1'], mustChangePassword: false } }) : send({ error: { code: 'UNAUTHENTICATED', message: 'Sign in first.' } }, 401)
    if (path === '/api/auth/login') { signedIn = true; return send({ user: { id: '1', email: 'manager@example.com', displayName: 'Warehouse Manager', role, warehouses: ['1'], mustChangePassword: false } }) }
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
  await expect(page.getByText('8.000000')).toBeVisible()
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
  await expect(page.getByText('8.000000')).toBeVisible()
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
  await expect(page.getByText('8.000000')).toBeVisible()
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
    if (kind === 'returns') await page.route('**/api/orders/21', route => route.fulfill({ json: { id: '21', orderNumber: 'QA-ORDER', status: 'FULFILLED', revision: 1, items: [{ id: '22', productId: '9', sku: 'HAMMER-001', warehouseId: '1', quantity: '5', returnableQty: '3' }] } }))
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
      await drawer.getByLabel('Fulfilled order ID').fill('21')
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
      await page.getByRole('button', { name: 'Record receipt', exact: true }).click()
      expect(requests.find(request => request.path.endsWith('/receive'))?.body).toMatchObject({ items: [{ transferItemId: '31', acceptedQty: '2', quarantinedQty: '0' }] })
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

test('excess discrepancy defaults to a valid resolution and clears after resolving', async ({ page }) => {
  await mockSession(page)
  let resolved = false
  await page.route('**/api/transfers/50', route => route.fulfill({ json: { id: '50', transferNumber: 'QA-EXCESS', status: 'DISPUTED', revision: 1, sourceWarehouseId: '1', destinationWarehouseId: '2', items: [] } }))
  await page.route('**/api/transfers/50/discrepancies', route => route.fulfill({ json: { items: [{ id: '51', transferItemId: '52', kind: 'EXCESS', reportedQty: '1', outstandingQty: resolved ? '0' : '1', status: resolved ? 'RESOLVED' : 'OPEN', reason: 'Extra delivery' }] } }))
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
