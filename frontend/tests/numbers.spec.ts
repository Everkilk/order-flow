import { test, expect } from '@playwright/test'
import { decimalText, presentNumbers, notificationBody } from '../src/lib/numbers'

test('decimal display preserves meaningful digits and very large values', () => {
  for (const [source, expected] of [
    ['9.000000', '9'], ['0.000000', '0'], ['2.125000', '2.125'],
    ['170.0000000000', '170'], ['-0.0000', '0'], ['-2.125000', '-2.125'],
    ['9999999999999999.123400', '9999999999999999.1234'], ['1.', '1.'], ['invalid', 'invalid'],
  ]) expect(decimalText(source)).toBe(expected)
})

test('only declared decimal fields change; identifiers and uploaded previews stay exact', () => {
  const source = { id: '9.000', sku: '9.000000', barcode: '001000', name: '=SUM(1+1)', cost: null,
    amount: '9999999999999999.123400', items: [{ quantity: '2.125000', unitPrice: '25.0000', currency: 'USD' }],
    attributes: { quantity: '9.000000' }, rows: [{ values: ['9.000000', '001'] }],
  }
  expect(presentNumbers(source)).toEqual({ ...source, amount: '9999999999999999.1234', items: [{ quantity: '2.125', unitPrice: '25', currency: 'USD' }] })
  expect(source.items[0].quantity).toBe('2.125000')
  expect(notificationBody('LOW_STOCK', '15.000000 available in DEMO.')).toBe('15 available in DEMO.')
  expect(notificationBody('TEST', '15.000000 available in DEMO.')).toBe('15.000000 available in DEMO.')
})
