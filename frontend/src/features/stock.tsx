import { t } from '../app/locale'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, DataTable, Field, Loading, Notice, PageHeading, Pager, RecordLink } from '../components/ui'
import { useOptions, usePage } from '../lib/queries'

type Warehouse = { id: string; code: string; name: string }
type StockRow = { warehouseId: string; warehouse: string; productId: string; sku: string; name: string; onHand: string; reserved: string; available: string; version: string }
type Movement = { id: string; productId: string; warehouseId: string; eventType: string; onHandDelta: string; reservedDelta: string; occurredAt: string; reason: string; orderId?: string; receiptId?: string; returnId?: string; transferId?: string }

export function Stock() {
  const [params, setParams] = useSearchParams()
  const warehouseId = params.get('warehouseId') ?? ''
  const availability = params.get('availability') ?? ''
  const query = usePage<StockRow>('/stock', { warehouseId, availability })
  const warehouses = useOptions<Warehouse>('/warehouses')
  return <><PageHeading title="Stock" description="Current quantities by product and warehouse." /><Card><div className="filters"><Field label="Warehouse"><select value={warehouseId} onChange={event => setParams(old => { const next = new URLSearchParams(old); if (event.target.value) next.set('warehouseId', event.target.value); else next.delete('warehouseId'); return next })}><option value="">{t("All permitted warehouses")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field><Field label="Availability"><select value={availability} onChange={event => setParams(old => { const next = new URLSearchParams(old); if (event.target.value) next.set('availability', event.target.value); else next.delete('availability'); return next })}><option value="">{t("All stock")}</option><option value="AVAILABLE">{t("Available")}</option><option value="OUT_OF_STOCK">{t("Out of stock")}</option></select></Field></div>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['Product', 'Warehouse', 'On hand', 'Reserved', 'Available']} rows={query.data.items.map(row => [<RecordLink to={`/products/${row.productId}`}>{row.sku} · {row.name}</RecordLink>, row.warehouse, row.onHand, row.reserved, row.available])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card></>
}

export function Movements() {
  const [warehouseId, setWarehouse] = useState('')
  const [eventType, setEventType] = useState('')
  const [reference, setReference] = useState('')
  const [applied, setApplied] = useState({ warehouseId: '', eventType: '', reference: '' })
  const query = usePage<Movement>('/movements', applied)
  const warehouses = useOptions<Warehouse>('/warehouses')
  return <><PageHeading title="Movements" description="A record of inventory changes, newest first." /><Card><form className="filters" onSubmit={event => { event.preventDefault(); setApplied({ warehouseId, eventType, reference }) }}><Field label="Warehouse"><select value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("All permitted")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></Field><Field label="Event"><select value={eventType} onChange={event => setEventType(event.target.value)}><option value="">{t("All events")}</option>{['OPENING','RECEIPT','ORDER_CONFIRM','ORDER_CANCEL','ORDER_FULFILL','ORDER_RETURN','TRANSFER_SEND','TRANSFER_RECEIVE','TRANSFER_RESOLUTION','ADJUSTMENT','REVERSAL'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Document number"><input value={reference} onChange={event => setReference(event.target.value)} placeholder="Exact number" /></Field><button className="button primary">{t("Apply")}</button></form>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['When', 'Event', 'Product', 'Warehouse', 'On-hand change', 'Reserved change', 'Source']} rows={query.data.items.map(row => [new Date(row.occurredAt).toLocaleString(), row.eventType.replaceAll('_', ' '), <RecordLink to={`/products/${row.productId}`}>#{row.productId}</RecordLink>, row.warehouseId, row.onHandDelta, row.reservedDelta, row.orderId ? <RecordLink to={`/orders/${row.orderId}`}>Order</RecordLink> : row.receiptId ? <RecordLink to={`/receipts/${row.receiptId}`}>Receipt</RecordLink> : row.returnId ? <RecordLink to={`/returns/${row.returnId}`}>Return</RecordLink> : row.transferId ? <RecordLink to={`/transfers/${row.transferId}`}>Transfer</RecordLink> : '—'])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card></>
}
