import { test, expect, type Page } from '@playwright/test'

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
