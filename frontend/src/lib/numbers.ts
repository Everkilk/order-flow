/** Display decimal text without rounding or converting it to a floating point number. */
export function decimalText(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value
  const trimmed = value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
  return /^-0+$/.test(trimmed) ? '0' : trimmed
}

// These are decimal fields in the application API, never identifiers or free text.
const decimalFields = new Set([
  'quantity', 'requestedQty', 'sentQty', 'receivedQty', 'inTransitQty', 'quarantinedQty',
  'returnableQty', 'returnedQty', 'outstandingQty', 'reportedQty', 'resolvedQty', 'acceptedQty', 'shortageQty', 'excessQty',
  'onHand', 'reserved', 'available', 'onHandDelta', 'reservedDelta', 'requestedDelta',
  'countedQty', 'observedOnHand', 'approvedDelta', 'unitCost', 'unitPrice', 'sellingPrice', 'cost', 'amount',
  'threshold', 'criticalThreshold', 'minValue', 'maxValue',
])
const opaqueFields = new Set(['attributes', 'attributes_json', 'preview', 'rows', 'filters', 'errors'])

/** Presentation copy: original API types and uploaded/validated file contents stay intact. */
export function presentNumbers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentNumbers)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    decimalFields.has(key) && typeof item === 'string' ? decimalText(item)
      : opaqueFields.has(key) ? item : presentNumbers(item),
  ]))
}

export function notificationBody(eventClass: string | undefined, body: string): string {
  if (eventClass !== 'LOW_STOCK') return body
  return body.replace(/^(-?\d+(?:\.\d+)?) available in /, (_, amount: string) => `${decimalText(amount)} available in `)
}
