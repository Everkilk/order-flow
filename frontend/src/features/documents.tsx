import { dateText } from '../app/locale'
import { ProductReference } from '../components/ProductReference'
import { OrderPicker } from '../components/OrderPicker'
import { MutationForm } from '../components/MutationForm'
import { useViewState } from '../lib/view-state'
import { t } from '../app/locale'
import { useRef, useState, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useSession } from '../app/session-context'
import { Badge, Card, Confirm, DataTable, Drawer, Field, Loading, Notice, PageHeading, Pager, RecordLink } from '../components/ui'
import { ProductPicker } from '../components/ProductPicker'
import { api, commandKey, json } from '../lib/api'
import { useOptions, usePage } from '../lib/queries'
import { useUnsavedDraft } from '../lib/unsaved'

export type DocumentKind = 'receipts' | 'orders' | 'returns' | 'transfers'
type Warehouse = { id: string; code: string; name: string }
type Supplier = { id: string; name: string }
type DocRow = { id: string; receiptNumber?: string; orderNumber?: string; returnNumber?: string; transferNumber?: string; status: string; warehouseId?: string; sourceWarehouseId?: string; destinationWarehouseId?: string; createdAt?: string; orderId?: string }
type Line = { id?: string; productId?: string; sku?: string; name?: string; warehouseId?: string; orderItemId?: string; quantity?: string; requestedQty?: string; unitCost?: string | null; unitPrice?: string | null; currency?: string | null; sentQty?: string; receivedQty?: string; inTransitQty?: string; quarantinedQty?: string; returnableQty?: string }
type Document = DocRow & { revision: number; kind?: string; note?: string; reason?: string; items: Line[]; createdBy?: string; receivedBy?: string }
type Discrepancy = { id: string; transferItemId: string; productId?: string; sku?: string; name?: string; kind: 'SHORTAGE' | 'EXCESS'; reportedQty: string; outstandingQty: string; status: string; reason: string }

const titles: Record<DocumentKind, string> = { receipts: 'Receipts', orders: 'Orders', returns: 'Returns', transfers: 'Transfers' }
const numberKeys: Record<DocumentKind, keyof DocRow> = { receipts: 'receiptNumber', orders: 'orderNumber', returns: 'returnNumber', transfers: 'transferNumber' }

export function DocumentList({ kind }: { kind: DocumentKind }) {
  const [status, setStatus] = useViewState('status', '')
  const [creating, setCreating] = useState(() => kind === 'returns' && new URLSearchParams(window.location.search).has('orderId'))
  const query = usePage<DocRow>(`/${kind}`, { status })
  const warehouses = useOptions<Warehouse>('/warehouses')
  const warehouseName = (id?: string) => warehouses.data?.items.find(row => row.id === id)?.code ?? id ?? '—'
  return <><PageHeading title={titles[kind]} description={kind === 'returns' ? 'Returned goods from fulfilled orders.' : `Create and track warehouse ${kind}.`} action={<button className="button primary" onClick={() => setCreating(true)}>{t(`New ${kind.slice(0, -1)}`)}</button>} /><Card><Field label="Status"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">{t("All statuses")}</option>{(kind === 'orders' ? ['DRAFT', 'CONFIRMED', 'FULFILLED', 'CANCELLED'] : kind === 'transfers' ? ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'DISPUTED', 'RECEIVED', 'RESOLVED', 'CANCELLED'] : ['DRAFT', 'POSTED']).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></Field>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={[...(kind === 'orders' ? ['Order ID'] : []), 'Document', 'Status', 'Warehouse', 'Created']} rows={query.data.items.map(row => [...(kind === 'orders' ? [row.id] : []), <RecordLink to={`/${kind}/${row.id}`}>{row[numberKeys[kind]] ?? `#${row.id}`}</RecordLink>, <Badge value={row.status} />, row.warehouseId ? warehouseName(row.warehouseId) : row.sourceWarehouseId && row.destinationWarehouseId ? `${warehouseName(row.sourceWarehouseId)} → ${warehouseName(row.destinationWarehouseId)}` : '—', row.createdAt ? dateText(row.createdAt) : '—'])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card>{creating && <Drawer title={`New ${kind.slice(0, -1)}`}><CreateDocument kind={kind} onClose={() => setCreating(false)} /></Drawer>}</>
}

function CreateDocument({ kind, onClose }: { kind: DocumentKind; onClose: () => void }) {
  const navigate = useNavigate()
  const { markDirty, markClean, confirmClose } = useUnsavedDraft()
  const { user } = useSession()
  const [number, setNumber] = useState('')
  const [warehouseId, setWarehouse] = useState('')
  const [destinationWarehouseId, setDestination] = useState('')
  const [supplierId, setSupplier] = useState('')
  const [receiptKind, setReceiptKind] = useState<'INBOUND' | 'OPENING'>('INBOUND')
  const [orderId, setOrder] = useState(() => kind === 'returns' ? new URLSearchParams(window.location.search).get('orderId') ?? '' : '')
  const [note, setNote] = useState('')
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const warehouses = useOptions<Warehouse>('/warehouses')
  const suppliers = useOptions<Supplier>('/suppliers')
  const selectedOrder = useQuery({ queryKey: ['selected-return-order', orderId], queryFn: () => api<Document>(`/orders/${orderId}`), enabled: kind === 'returns' && !!orderId })
  const availableWarehouses = warehouses.data?.items.filter(row => kind !== 'returns' || selectedOrder.data?.items.some(item => item.warehouseId === row.id))
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setBusy(true)
    const body = kind === 'receipts' ? { receiptNumber: number, kind: receiptKind, warehouseId, supplierId: supplierId || null, note: note || null } : kind === 'orders' ? { orderNumber: number, note: note || null } : kind === 'returns' ? { returnNumber: number, orderId, warehouseId, reason: note } : { transferNumber: number, sourceWarehouseId: warehouseId, destinationWarehouseId, note: note || null }
    try { const row = await api<{ id: string }>(`/${kind}`, json('POST', body)); markClean(); navigate(`/${kind}/${row.id}`) } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <MutationForm className="stack" onSubmit={submit} onChange={markDirty}><Field label="Document number"><input required maxLength={80} value={number} onChange={event => setNumber(event.target.value)} /></Field>{kind === 'receipts' && <Field label="Receipt type"><select value={receiptKind} onChange={event => setReceiptKind(event.target.value as typeof receiptKind)}><option value="INBOUND">{t("Inbound")}</option>{user?.role === 'MANAGER' && <option value="OPENING">{t("Opening stock")}</option>}</select></Field>}{kind === 'returns' && <OrderPicker value={orderId} onChange={value => { setOrder(value); setWarehouse('') }} />}{kind !== 'orders' && <Field label={kind === 'transfers' ? 'Source warehouse' : 'Warehouse'}><select required value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("Choose")}</option>{availableWarehouses?.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field>}{kind === 'transfers' && <Field label="Destination warehouse"><select required value={destinationWarehouseId} onChange={event => setDestination(event.target.value)}><option value="">{t("Choose")}</option>{warehouses.data?.items.filter(row => row.id !== warehouseId).map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field>}{kind === 'receipts' && <Field label="Supplier (optional)"><select value={supplierId} onChange={event => setSupplier(event.target.value)}><option value="">{t("No supplier")}</option>{suppliers.data?.items.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>}<Field label={kind === 'returns' ? 'Reason' : 'Note'}><textarea required={kind === 'returns'} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></Field><Notice error={error} /><div className="button-row"><button type="button" data-dialog-close className="button subtle" onClick={() => { if (confirmClose()) { markClean(); onClose() } }}>{t("Close")}</button><button className="button primary" disabled={busy}>{t(busy ? 'Creating…' : 'Create draft')}</button></div></MutationForm>
}

export function DocumentDetail({ kind }: { kind: DocumentKind }) {
  const { id } = useParams()
  const query = useQuery({ queryKey: ['document', kind, id], queryFn: () => api<Document>(`/${kind}/${id}`), enabled: !!id })
  const warehouses = useOptions<Warehouse>('/warehouses')
  const warehouseName = (warehouseId?: string) => warehouses.data?.items.find(row => row.id === warehouseId)?.code ?? warehouseId
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [actionKeys, setActionKeys] = useState<Record<string, string>>({})
  const [savedButStale, setSavedButStale] = useState(false)
  async function action(name: string, body: unknown = {}) {
    if (!id) return
    setError(undefined); setSavedButStale(false); setBusy(true)
    const key = actionKeys[name] ?? commandKey()
    setActionKeys(old => ({ ...old, [name]: key }))
    try { await api(`/${kind}/${id}/${name}`, json('POST', body, key)) } catch (e) { setError(e); setBusy(false); return }
    setActionKeys(old => { const next = { ...old }; delete next[name]; return next })
    try { if ((await query.refetch()).isError) setSavedButStale(true) } catch { setSavedButStale(true) }
    finally { setBusy(false) }
  }
  if (query.isPending) return <Loading />
  if (query.error) return <Notice error={savedButStale ? new Error('The change was saved, but the page could not refresh. Reload to see the latest data.') : query.error} />
  const doc = query.data
  const number = doc[numberKeys[kind]] ?? `#${doc.id}`
  return <><PageHeading translateTitle={false} title={String(number)} description={`${t(titles[kind].slice(0, -1))} · ${t(doc.status)}`} /><Notice error={error} /><div className="grid-two"><Card><h2>{t("Document")}</h2><div className="summary-row"><span>{t("Status")}</span><Badge value={doc.status} /></div>{kind === 'orders' && <div className="summary-row"><span>{t("Order ID")}</span><strong>{doc.id}</strong></div>}{doc.orderId && <div className="summary-row"><span>{t("Order")}</span><RecordLink to={`/orders/${doc.orderId}`}>{doc.orderNumber ?? t("Order")} · {t("Order ID")}: {doc.orderId}</RecordLink></div>}{[['Warehouse', warehouseName(doc.warehouseId)], ['Source', warehouseName(doc.sourceWarehouseId)], ['Destination', warehouseName(doc.destinationWarehouseId)], ['Kind', doc.kind], ['Note / reason', doc.note ?? doc.reason]].filter(([, value]) => value != null).map(([label, value]) => <div className="summary-row" key={label}><span>{t(String(label))}</span><strong>{label === 'Kind' ? t(String(value)) : value}</strong></div>)}{doc.status === 'DRAFT' && doc.items.length > 0 && <div className="button-row">{kind === 'orders' ? <><Confirm disabled={busy} message="Confirm this order and reserve stock?" onConfirm={() => action('confirm')}>Confirm order</Confirm><Confirm disabled={busy} message="Cancel this order?" onConfirm={() => action('cancel')}>Cancel</Confirm></> : kind === 'transfers' ? <Confirm disabled={busy} message="Dispatch this transfer and remove stock from the source?" onConfirm={() => action('send')}>Dispatch</Confirm> : <Confirm disabled={busy} message="Post this document to inventory?" onConfirm={() => action('post')}>{t(`Post ${kind.slice(0, -1)}`)}</Confirm>}</div>}{kind === 'orders' && doc.status === 'CONFIRMED' && <div className="button-row"><Confirm disabled={busy} message="Fulfill this order and deduct inventory?" onConfirm={() => action('fulfill')}>Fulfill</Confirm><Confirm disabled={busy} message="Cancel this order and release reserved stock?" onConfirm={() => action('cancel')}>Cancel</Confirm></div>}</Card><Card><h2>{t("Items")}</h2>{doc.status === 'DRAFT' ? <LineEditor key={`${kind}:${doc.id}:${doc.revision}`} kind={kind} doc={doc} onSaved={() => void query.refetch()} /> : <DataTable headers={kind === 'transfers' ? ['Product', 'Requested', 'Received', 'In transit', 'Quarantined'] : ['Product / item', 'Quantity', 'Cost / price']} rows={doc.items.map(line => kind === 'transfers' ? [<ProductReference id={line.productId} sku={line.sku} name={line.name} />, line.requestedQty, line.receivedQty, line.inTransitQty, line.quarantinedQty] : [<ProductReference id={line.productId} sku={line.sku} name={line.name} />, line.quantity, line.unitCost ?? line.unitPrice ?? '—'])} />}</Card></div>{kind === 'transfers' && doc.status !== 'DRAFT' && <TransferProgress doc={doc} onChanged={() => void query.refetch()} />}{kind === 'orders' && doc.status === 'FULFILLED' && <Card><p>{t("Need to receive returned goods?")}</p><Link to={`/returns?orderId=${doc.id}`}>{t("Create a return →")}</Link></Card>}</>
}

function LineEditor({ kind, doc, onSaved }: { kind: DocumentKind; doc: Document; onSaved: () => void }) {
  const { markDirty, markClean } = useUnsavedDraft()
  const [lines, setLines] = useState<Line[]>(doc.items.length ? doc.items : [{}])
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const warehouses = useOptions<Warehouse>('/warehouses')
  const order = useQuery({ queryKey: ['return-order', doc.orderId], queryFn: () => api<Document>(`/orders/${doc.orderId}`), enabled: kind === 'returns' && !!doc.orderId })
  function setLine(index: number, changes: Partial<Line>) { setLines(old => old.map((line, i) => i === index ? { ...line, ...changes } : line)) }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setBusy(true)
    const items = lines.map(line => kind === 'receipts' ? { productId: line.productId, quantity: line.quantity, unitCost: line.unitCost || null, currency: line.unitCost ? line.currency : null } : kind === 'orders' ? { productId: line.productId, warehouseId: line.warehouseId, quantity: line.quantity, unitPrice: line.unitPrice || null, currency: line.unitPrice ? line.currency : null } : kind === 'returns' ? { orderItemId: line.orderItemId, quantity: line.quantity } : { productId: line.productId, requestedQty: line.requestedQty })
    try { await api(`/${kind}/${doc.id}/items`, json('PUT', { expectedRevision: Number(doc.revision), items })); markClean(); onSaved() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <MutationForm className="stack" onSubmit={submit} onChange={markDirty}><p className="muted">{t("Search by SKU or name, choose a product, then save the lines before posting or confirming.")}</p>{lines.map((line, index) => <div className="line-editor" key={index}>{kind === 'returns' ? <div className="product-picker"><Field label="Order item"><select required value={line.orderItemId ?? ''} onChange={event => setLine(index, { orderItemId: event.target.value, ...(() => { const item = order.data?.items.find(row => row.id === event.target.value); return { productId: item?.productId, sku: item?.sku, name: item?.name } })() })}><option value="">{t("Choose order item")}</option>{order.data?.items.filter(item => item.warehouseId === doc.warehouseId && Number(item.returnableQty ?? '0') > 0).map(item => <option key={item.id} value={item.id}>{item.name ? `${item.name} · ${item.sku ?? ''}` : item.sku ?? t('Product #{id}', { id: item.productId ?? '' })} · {t("Returnable")} {item.returnableQty}</option>)}</select></Field>{kind === 'returns' && line.orderItemId && (() => { const item = order.data?.items.find(item => item.id === line.orderItemId); return <ProductReference id={item?.productId} sku={item?.sku} name={item?.name} /> })()}</div> : <> <ProductPicker value={line.productId ?? ''} selectedLabel={line.sku ? `${line.sku} — ${line.name ?? ''}` : undefined} onChange={(productId, product) => setLine(index, { productId, sku: product?.sku, name: product?.name })} />{line.productId && <ProductReference id={line.productId} sku={line.sku} name={line.name} />}</>}{kind === 'orders' && <Field label="Warehouse"><select required value={line.warehouseId ?? ''} onChange={event => setLine(index, { warehouseId: event.target.value })}><option value="">{t("Choose")}</option>{warehouses.data?.items.map(row => <option value={row.id} key={row.id}>{row.code}</option>)}</select></Field>}<Field label="Quantity"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={(kind === 'transfers' ? line.requestedQty : line.quantity) ?? ''} onChange={event => setLine(index, kind === 'transfers' ? { requestedQty: event.target.value } : { quantity: event.target.value })} /></Field>{(kind === 'receipts' || kind === 'orders') && <><Field label={kind === 'receipts' ? 'Unit cost' : 'Unit price'}><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,4})?" value={(kind === 'receipts' ? line.unitCost : line.unitPrice) ?? ''} onChange={event => setLine(index, kind === 'receipts' ? { unitCost: event.target.value } : { unitPrice: event.target.value })} /></Field><Field label="Currency"><select value={line.currency ?? ''} onChange={event => setLine(index, { currency: event.target.value })}><option value="">—</option><option>VND</option><option>USD</option></select></Field></>}<button type="button" className="button subtle" disabled={lines.length === 1} onClick={() => { markDirty(); setLines(old => old.filter((_, i) => i !== index)) }}>{t("Remove")}</button></div>)}<div className="button-row"><button type="button" className="button subtle" disabled={lines.length >= 200} onClick={() => { markDirty(); setLines(old => [...old, {}]) }}>{t("Add line")}</button><button className="button primary" disabled={busy}>{t(busy ? 'Saving…' : 'Save lines')}</button></div><Notice error={error} /></MutationForm>
}

function TransferProgress({ doc, onChanged }: { doc: Document; onChanged: () => void }) {
  const { markDirty, markClean } = useUnsavedDraft()
  const { user } = useSession()
  const [accepted, setAccepted] = useState<Record<string, string>>({})
  const [quarantined, setQuarantined] = useState<Record<string, string>>({})
  const [excessReason, setExcessReason] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [error, setError] = useState<unknown>()
  const [key, setKey] = useState(commandKey)
  const discrepancies = useQuery({ queryKey: ['transfer-discrepancies', doc.id], queryFn: () => api<{ items: Discrepancy[] }>(`/transfers/${doc.id}/discrepancies`) })
  const canReceive = user?.role === 'MANAGER' || user?.warehouses?.includes(doc.destinationWarehouseId ?? '')
  async function receive(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    const items = doc.items.filter(line => accepted[line.id ?? ''] || quarantined[line.id ?? '']).map(line => ({ transferItemId: line.id, acceptedQty: accepted[line.id ?? ''] || '0', quarantinedQty: quarantined[line.id ?? ''] || '0', ...(Number(quarantined[line.id ?? ''] ?? '0') > 0 ? { excessReason: excessReason[line.id ?? ''] } : {}) }))
    try { await api(`/transfers/${doc.id}/receive`, json('POST', { note: note || null, items }, key)); markClean(); setAccepted({}); setQuarantined({}); setExcessReason({}); setNote(''); setKey(commandKey()); onChanged(); await discrepancies.refetch() } catch (e) { setError(e) }
  }
  return <><div className="grid-two">{canReceive && ['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(doc.status) && <Card><h2>{t("Receive transfer")}</h2><MutationForm onChange={markDirty} className="stack" onSubmit={receive}>{doc.items.map(line => <div className="line-editor" key={line.id}><ProductReference id={line.productId} sku={line.sku} name={line.name} /><span className="line-context">{t("In transit")}: {line.inTransitQty}</span><Field label="Accept"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={accepted[line.id ?? ''] ?? ''} onChange={event => setAccepted(old => ({ ...old, [line.id ?? '']: event.target.value }))} /></Field><Field label="Quarantine excess"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quarantined[line.id ?? ''] ?? ''} onChange={event => setQuarantined(old => ({ ...old, [line.id ?? '']: event.target.value }))} /></Field>{Number(quarantined[line.id ?? ''] ?? '0') > 0 && <Field label="Excess reason"><input required value={excessReason[line.id ?? ''] ?? ''} onChange={event => setExcessReason(old => ({ ...old, [line.id ?? '']: event.target.value }))} /></Field>}</div>)}<Field label="Note"><textarea value={note} onChange={event => setNote(event.target.value)} /></Field><Notice error={error} /><button className="button primary">{t("Record receipt")}</button></MutationForm></Card>}<Card><h2>{t("Discrepancies")}</h2>{discrepancies.isPending ? <Loading /> : discrepancies.error ? <Notice error={discrepancies.error} /> : discrepancies.data.items.length ? discrepancies.data.items.map(row => <DiscrepancyCard key={row.id} row={row} transferId={doc.id} onChanged={() => { void discrepancies.refetch(); onChanged() }} />) : <p>{t("No discrepancies reported.")}</p>}</Card></div>{canReceive && ['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(doc.status) && <Card><h2>{t("Report shortage")}</h2>{doc.items.filter(line => Number(line.inTransitQty ?? '0') > 0).map(line => <div className="summary-row" key={line.id}><span><ProductReference id={line.productId} sku={line.sku} name={line.name} /> · {t("In transit")} {line.inTransitQty}</span><ShortageForm transferId={doc.id} itemId={line.id!} onChanged={() => { void discrepancies.refetch(); onChanged() }} /></div>)}</Card>}</>
}

function DiscrepancyCard({ row, transferId, onChanged }: { row: Discrepancy; transferId: string; onChanged: () => void }) {
  const { markDirty, markClean } = useUnsavedDraft()
  const { user } = useSession()
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [resolutionType, setResolution] = useState(row.kind === 'EXCESS' ? 'ACCEPT_EXCESS' : 'LOSS')
  const [laterReceiptItemId, setLaterReceipt] = useState('')
  const [error, setError] = useState<unknown>()
  const [key, setKey] = useState(commandKey)
  async function resolve(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    try { await api(`/discrepancies/${row.id}/resolve`, json('POST', { resolutionType, quantity, reason, ...(resolutionType === 'LATER_RECEIPT' ? { laterReceiptItemId } : {}) }, key)); markClean(); setKey(commandKey()); onChanged() } catch (e) { setError(e) }
  }
  return <div className="discrepancy"><strong>{t(row.kind)} #{row.id}</strong><p><ProductReference id={row.productId} sku={row.sku} name={row.name} /></p><p>{t("Outstanding")}: {row.outstandingQty} · {row.reason}</p>{row.kind === 'SHORTAGE' && Number(row.outstandingQty) > 0 && <ShortageForm transferId={transferId} itemId={row.transferItemId} onChanged={onChanged} />}{user?.role === 'MANAGER' && Number(row.outstandingQty) > 0 && <MutationForm onChange={markDirty} className="stack" onSubmit={resolve}><Field label="Resolution"><select value={resolutionType} onChange={event => setResolution(event.target.value)}>{(row.kind === 'SHORTAGE' ? ['LOSS','DISPATCH_CORRECTION','LATER_RECEIPT'] : ['ACCEPT_EXCESS','RETURN_EXCESS']).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></Field><Field label="Quantity"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quantity} onChange={event => setQuantity(event.target.value)} /></Field>{resolutionType === 'LATER_RECEIPT' && <Field label="Later receipt item ID"><input required pattern="[1-9][0-9]*" value={laterReceiptItemId} onChange={event => setLaterReceipt(event.target.value)} /></Field>}<Field label="Reason"><textarea required value={reason} onChange={event => setReason(event.target.value)} /></Field><Notice error={error} /><button className="button">{t("Resolve")}</button></MutationForm>}<Evidence target="discrepancies" id={row.id} /></div>
}

function ShortageForm({ transferId, itemId, onChanged }: { transferId: string; itemId: string; onChanged?: () => void }) {
  const { markDirty, markClean } = useUnsavedDraft()
  const [show, setShow] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>()
  const [key, setKey] = useState(commandKey)
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    try { await api(`/transfers/${transferId}/shortages`, json('POST', { transferItemId: itemId, quantity, reason }, key)); markClean(); setKey(commandKey()); setShow(false); onChanged?.() } catch (e) { setError(e) }
  }
  return <>{!show ? <button className="button subtle" onClick={() => setShow(true)}>{t("Report shortage")}</button> : <MutationForm onChange={markDirty} className="stack" onSubmit={submit}><Field label="Quantity"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quantity} onChange={event => setQuantity(event.target.value)} /></Field><Field label="Reason"><input required value={reason} onChange={event => setReason(event.target.value)} /></Field><Notice error={error} /><button className="button">{t("Report shortage")}</button></MutationForm>}</>
}

export function Evidence({ target, id }: { target: 'discrepancies' | 'stock-requests'; id: string }) {
  const { markDirty, markClean } = useUnsavedDraft()
  const query = useQuery({ queryKey: ['evidence', target, id], queryFn: () => api<{ items: { id: string; filename: string }[]; removed?: { id: string; filename: string; removedAt: string; removedBy: string; cleanupStatus: string }[]; canUpload?: boolean; canDelete?: boolean }>(`/evidence/${target}/${id}`) })
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  const [savedButStale, setSavedButStale] = useState(false)
  async function refreshAfterSave() {
    try { if ((await query.refetch()).isError) setSavedButStale(true) } catch { setSavedButStale(true) }
  }
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file) return
    setError(undefined); setSuccess(''); setSavedButStale(false)
    if (file.size > 5 * 1024 * 1024) { setError(new Error('Evidence must be 5 MB or smaller.')); return }
    const body = new FormData(); body.set('file', file)
    try { await api(`/evidence/${target}/${id}`, { method: 'POST', body }) } catch (e) { setError(e); return }
    markClean(); setFile(null); if(input.current) input.current.value=''; setSuccess('Upload received.'); await refreshAfterSave()
  }
  async function remove(fileId: string) {
    setError(undefined); setSuccess(''); setSavedButStale(false)
    try { await api(`/evidence/stock-requests/${id}/${fileId}`, { method: 'DELETE' }) } catch (e) { setError(e); return }
    setSuccess('Evidence deleted.'); await refreshAfterSave()
  }
  return <div className="evidence"><h3>{t('Evidence')}</h3>{query.isPending ? <Loading /> : query.error ? <Notice error={savedButStale ? new Error('The change was saved, but the page could not refresh. Reload to see the latest data.') : query.error} /> : query.data.items.map(row => <div className="evidence-row" key={row.id}><a href={`/api/evidence/${row.id}/file`} target="_blank" rel="noreferrer">{row.filename}</a>{target === 'stock-requests' && query.data.canDelete && <Confirm message={t('Delete evidence {filename}?', { filename: row.filename })} onConfirm={() => remove(row.id)}>{t('Delete')}</Confirm>}</div>)}<Notice error={error} /><Notice success={success} />{!query.error && query.data?.canUpload !== false && <MutationForm onChange={markDirty} onSubmit={upload} className="stack"><Field label="Evidence file"><input ref={input} type="file" accept="image/png,image/jpeg,application/pdf" onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field><button className="button subtle" disabled={!file}>{t('Upload evidence')}</button></MutationForm>}{query.data?.canUpload === false && <p className="muted">{t('Evidence is locked after a decision.')}</p>}{!query.error && !!query.data?.removed?.length && <section><h3>{t('Deletion history')}</h3><DataTable headers={['File','Deleted by','Deleted at','Storage cleanup']} rows={query.data.removed.map(row => [row.filename,row.removedBy,dateText(row.removedAt),row.cleanupStatus === 'DEAD' ? t('Cleanup failed; an administrator must review it.') : t(row.cleanupStatus)])} /></section>}</div>
}
