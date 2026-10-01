import { t } from '../app/locale'
import { useState, type FormEvent } from 'react'
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
type Discrepancy = { id: string; transferItemId: string; kind: 'SHORTAGE' | 'EXCESS'; reportedQty: string; outstandingQty: string; status: string; reason: string }

const titles: Record<DocumentKind, string> = { receipts: 'Receipts', orders: 'Orders', returns: 'Returns', transfers: 'Transfers' }
const numberKeys: Record<DocumentKind, keyof DocRow> = { receipts: 'receiptNumber', orders: 'orderNumber', returns: 'returnNumber', transfers: 'transferNumber' }

export function DocumentList({ kind }: { kind: DocumentKind }) {
  const [status, setStatus] = useState('')
  const [creating, setCreating] = useState(false)
  const query = usePage<DocRow>(`/${kind}`, { status })
  const warehouses = useOptions<Warehouse>('/warehouses')
  const warehouseName = (id?: string) => warehouses.data?.items.find(row => row.id === id)?.code ?? id ?? '—'
  return <><PageHeading title={titles[kind]} description={kind === 'returns' ? 'Returned goods from fulfilled orders.' : `Create and track warehouse ${kind}.`} action={<button className="button primary" onClick={() => setCreating(true)}>New {kind.slice(0, -1)}</button>} /><Card><Field label="Status"><select value={status} onChange={event => setStatus(event.target.value)}><option value="">{t("All statuses")}</option>{(kind === 'orders' ? ['DRAFT', 'CONFIRMED', 'FULFILLED', 'CANCELLED'] : kind === 'transfers' ? ['DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'DISPUTED', 'RECEIVED', 'RESOLVED', 'CANCELLED'] : ['DRAFT', 'POSTED']).map(value => <option key={value}>{value}</option>)}</select></Field>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['Document', 'Status', 'Warehouse', 'Created']} rows={query.data.items.map(row => [<RecordLink to={`/${kind}/${row.id}`}>{row[numberKeys[kind]] ?? `#${row.id}`}</RecordLink>, <Badge value={row.status} />, row.warehouseId ? warehouseName(row.warehouseId) : row.sourceWarehouseId && row.destinationWarehouseId ? `${warehouseName(row.sourceWarehouseId)} → ${warehouseName(row.destinationWarehouseId)}` : '—', row.createdAt ? new Date(row.createdAt).toLocaleString() : '—'])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card>{creating && <Drawer title={`New ${kind.slice(0, -1)}`}><CreateDocument kind={kind} onClose={() => setCreating(false)} /></Drawer>}</>
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
  const [orderId, setOrder] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const warehouses = useOptions<Warehouse>('/warehouses')
  const suppliers = useOptions<Supplier>('/suppliers')
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setBusy(true)
    const body = kind === 'receipts' ? { receiptNumber: number, kind: receiptKind, warehouseId, supplierId: supplierId || null, note: note || null } : kind === 'orders' ? { orderNumber: number, note: note || null } : kind === 'returns' ? { returnNumber: number, orderId, warehouseId, reason: note } : { transferNumber: number, sourceWarehouseId: warehouseId, destinationWarehouseId, note: note || null }
    try { const row = await api<{ id: string }>(`/${kind}`, json('POST', body)); markClean(); navigate(`/${kind}/${row.id}`) } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <form className="stack" onSubmit={submit} onChange={markDirty}><Field label="Document number"><input required maxLength={80} value={number} onChange={event => setNumber(event.target.value)} /></Field>{kind === 'receipts' && <Field label="Receipt type"><select value={receiptKind} onChange={event => setReceiptKind(event.target.value as typeof receiptKind)}><option value="INBOUND">{t("Inbound")}</option>{user?.role === 'MANAGER' && <option value="OPENING">{t("Opening stock")}</option>}</select></Field>}{kind === 'returns' && <Field label="Fulfilled order ID"><input required pattern="[1-9][0-9]*" value={orderId} onChange={event => setOrder(event.target.value)} /></Field>}{kind !== 'orders' && <Field label={kind === 'transfers' ? 'Source warehouse' : 'Warehouse'}><select required value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("Choose")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field>}{kind === 'transfers' && <Field label="Destination warehouse"><select required value={destinationWarehouseId} onChange={event => setDestination(event.target.value)}><option value="">{t("Choose")}</option>{warehouses.data?.items.filter(row => row.id !== warehouseId).map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field>}{kind === 'receipts' && <Field label="Supplier (optional)"><select value={supplierId} onChange={event => setSupplier(event.target.value)}><option value="">{t("No supplier")}</option>{suppliers.data?.items.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>}<Field label={kind === 'returns' ? 'Reason' : 'Note'}><textarea required={kind === 'returns'} maxLength={1000} value={note} onChange={event => setNote(event.target.value)} /></Field><Notice error={error} /><div className="button-row"><button type="button" data-dialog-close className="button subtle" onClick={() => { if (confirmClose()) { markClean(); onClose() } }}>{t("Close")}</button><button className="button primary" disabled={busy}>{busy ? 'Creating…' : 'Create draft'}</button></div></form>
}

export function DocumentDetail({ kind }: { kind: DocumentKind }) {
  const { id } = useParams()
  const query = useQuery({ queryKey: ['document', kind, id], queryFn: () => api<Document>(`/${kind}/${id}`), enabled: !!id })
  const warehouses = useOptions<Warehouse>('/warehouses')
  const warehouseName = (warehouseId?: string) => warehouses.data?.items.find(row => row.id === warehouseId)?.code ?? warehouseId
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [actionKeys, setActionKeys] = useState<Record<string, string>>({})
  async function action(name: string, body: unknown = {}) {
    if (!id) return
    setError(undefined); setBusy(true)
    const key = actionKeys[name] ?? commandKey()
    setActionKeys(old => ({ ...old, [name]: key }))
    try { await api(`/${kind}/${id}/${name}`, json('POST', body, key)); setActionKeys(old => { const next = { ...old }; delete next[name]; return next }); await query.refetch() } catch (e) { setError(e) } finally { setBusy(false) }
  }
  if (query.isPending) return <Loading />
  if (query.error) return <Notice error={query.error} />
  const doc = query.data
  const number = doc[numberKeys[kind]] ?? `#${doc.id}`
  return <><PageHeading title={String(number)} description={`${titles[kind].slice(0, -1)} · ${doc.status}`} /><Notice error={error} /><div className="grid-two"><Card><h2>{t("Document")}</h2><div className="summary-row"><span>{t("Status")}</span><Badge value={doc.status} /></div>{doc.orderId && <div className="summary-row"><span>{t("Order")}</span><RecordLink to={`/orders/${doc.orderId}`}>#{doc.orderId}</RecordLink></div>}{[['Warehouse', warehouseName(doc.warehouseId)], ['Source', warehouseName(doc.sourceWarehouseId)], ['Destination', warehouseName(doc.destinationWarehouseId)], ['Kind', doc.kind], ['Note / reason', doc.note ?? doc.reason]].filter(([, value]) => value != null).map(([label, value]) => <div className="summary-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}{doc.status === 'DRAFT' && doc.items.length > 0 && <div className="button-row">{kind === 'orders' ? <><Confirm disabled={busy} message="Confirm this order and reserve stock?" onConfirm={() => void action('confirm')}>Confirm order</Confirm><Confirm disabled={busy} message="Cancel this order?" onConfirm={() => void action('cancel')}>Cancel</Confirm></> : kind === 'transfers' ? <Confirm disabled={busy} message="Dispatch this transfer and remove stock from the source?" onConfirm={() => void action('send')}>Dispatch</Confirm> : <Confirm disabled={busy} message="Post this document to inventory?" onConfirm={() => void action('post')}>Post {kind.slice(0, -1)}</Confirm>}</div>}{kind === 'orders' && doc.status === 'CONFIRMED' && <div className="button-row"><Confirm disabled={busy} message="Fulfill this order and deduct inventory?" onConfirm={() => void action('fulfill')}>Fulfill</Confirm><Confirm disabled={busy} message="Cancel this order and release reserved stock?" onConfirm={() => void action('cancel')}>Cancel</Confirm></div>}</Card><Card><h2>{t("Items")}</h2>{doc.status === 'DRAFT' ? <LineEditor key={`${kind}:${doc.id}:${doc.revision}`} kind={kind} doc={doc} onSaved={() => void query.refetch()} /> : <DataTable headers={kind === 'transfers' ? ['Product', 'Requested', 'Received', 'In transit', 'Quarantined'] : ['Product / item', 'Quantity', 'Cost / price']} rows={doc.items.map(line => kind === 'transfers' ? [line.sku ?? line.productId, line.requestedQty, line.receivedQty, line.inTransitQty, line.quarantinedQty] : [line.sku ?? line.productId ?? line.orderItemId, line.quantity, line.unitCost ?? line.unitPrice ?? '—'])} />}</Card></div>{kind === 'transfers' && doc.status !== 'DRAFT' && <TransferProgress doc={doc} onChanged={() => void query.refetch()} />}{kind === 'orders' && doc.status === 'FULFILLED' && <Card><p>{t("Need to receive returned goods?")}</p><Link to="/returns">Create a return →</Link></Card>}</>
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
  return <form className="stack" onSubmit={submit} onChange={markDirty}><p className="muted">{t("Search by SKU or name, choose a product, then save the lines before posting or confirming.")}</p>{lines.map((line, index) => <div className="line-editor" key={index}>{kind === 'returns' ? <Field label="Order item"><select required value={line.orderItemId ?? ''} onChange={event => setLine(index, { orderItemId: event.target.value })}><option value="">{t("Choose order item")}</option>{order.data?.items.filter(item => item.warehouseId === doc.warehouseId && Number(item.returnableQty ?? '0') > 0).map(item => <option key={item.id} value={item.id}>{item.sku ?? `Product #${item.productId}`} · Returnable {item.returnableQty}</option>)}</select></Field> : <ProductPicker value={line.productId ?? ''} selectedLabel={line.sku ? `${line.sku} — ${line.name ?? ''}` : undefined} onChange={productId => setLine(index, { productId })} />}{kind === 'orders' && <Field label="Warehouse"><select required value={line.warehouseId ?? ''} onChange={event => setLine(index, { warehouseId: event.target.value })}><option value="">{t("Choose")}</option>{warehouses.data?.items.map(row => <option value={row.id} key={row.id}>{row.code}</option>)}</select></Field>}<Field label="Quantity"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={(kind === 'transfers' ? line.requestedQty : line.quantity) ?? ''} onChange={event => setLine(index, kind === 'transfers' ? { requestedQty: event.target.value } : { quantity: event.target.value })} /></Field>{(kind === 'receipts' || kind === 'orders') && <><Field label={kind === 'receipts' ? 'Unit cost' : 'Unit price'}><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,4})?" value={(kind === 'receipts' ? line.unitCost : line.unitPrice) ?? ''} onChange={event => setLine(index, kind === 'receipts' ? { unitCost: event.target.value } : { unitPrice: event.target.value })} /></Field><Field label="Currency"><select value={line.currency ?? ''} onChange={event => setLine(index, { currency: event.target.value })}><option value="">—</option><option>VND</option><option>USD</option></select></Field></>}<button type="button" className="button subtle" disabled={lines.length === 1} onClick={() => { markDirty(); setLines(old => old.filter((_, i) => i !== index)) }}>{t("Remove")}</button></div>)}<div className="button-row"><button type="button" className="button subtle" disabled={lines.length >= 200} onClick={() => { markDirty(); setLines(old => [...old, {}]) }}>{t("Add line")}</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save lines'}</button></div><Notice error={error} /></form>
}

function TransferProgress({ doc, onChanged }: { doc: Document; onChanged: () => void }) {
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
    const items = doc.items.filter(line => accepted[line.id ?? ''] || quarantined[line.id ?? '']).map(line => ({ transferItemId: line.id, acceptedQty: accepted[line.id ?? ''] || '0', quarantinedQty: quarantined[line.id ?? ''] || '0', ...(quarantined[line.id ?? ''] && quarantined[line.id ?? ''] !== '0' ? { excessReason: excessReason[line.id ?? ''] } : {}) }))
    try { await api(`/transfers/${doc.id}/receive`, json('POST', { note: note || null, items }, key)); setKey(commandKey()); onChanged(); await discrepancies.refetch() } catch (e) { setError(e) }
  }
  return <><div className="grid-two">{canReceive && ['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(doc.status) && <Card><h2>{t("Receive transfer")}</h2><form className="stack" onSubmit={receive}>{doc.items.map(line => <div className="line-editor" key={line.id}><strong>Product #{line.productId}</strong><span>In transit: {line.inTransitQty}</span><Field label="Accept"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={accepted[line.id ?? ''] ?? ''} onChange={event => setAccepted(old => ({ ...old, [line.id ?? '']: event.target.value }))} /></Field><Field label="Quarantine excess"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quarantined[line.id ?? ''] ?? ''} onChange={event => setQuarantined(old => ({ ...old, [line.id ?? '']: event.target.value }))} /></Field>{quarantined[line.id ?? ''] && quarantined[line.id ?? ''] !== '0' && <Field label="Excess reason"><input required value={excessReason[line.id ?? ''] ?? ''} onChange={event => setExcessReason(old => ({ ...old, [line.id ?? '']: event.target.value }))} /></Field>}</div>)}<Field label="Note"><textarea value={note} onChange={event => setNote(event.target.value)} /></Field><Notice error={error} /><button className="button primary">{t("Record receipt")}</button></form></Card>}<Card><h2>{t("Discrepancies")}</h2>{discrepancies.isPending ? <Loading /> : discrepancies.error ? <Notice error={discrepancies.error} /> : discrepancies.data.items.length ? discrepancies.data.items.map(row => <DiscrepancyCard key={row.id} row={row} transferId={doc.id} onChanged={() => { void discrepancies.refetch(); onChanged() }} />) : <p>{t("No discrepancies reported.")}</p>}</Card></div>{canReceive && ['SENT','PARTIALLY_RECEIVED','DISPUTED'].includes(doc.status) && <Card><h2>{t("Report shortage")}</h2>{doc.items.filter(line => Number(line.inTransitQty ?? '0') > 0).map(line => <div className="summary-row" key={line.id}><span>{line.sku ?? line.productId} · In transit {line.inTransitQty}</span><ShortageForm transferId={doc.id} itemId={line.id!} onChanged={() => { void discrepancies.refetch(); onChanged() }} /></div>)}</Card>}</>
}

function DiscrepancyCard({ row, transferId, onChanged }: { row: Discrepancy; transferId: string; onChanged: () => void }) {
  const { user } = useSession()
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [resolutionType, setResolution] = useState(row.kind === 'EXCESS' ? 'ACCEPT_EXCESS' : 'LOSS')
  const [laterReceiptItemId, setLaterReceipt] = useState('')
  const [error, setError] = useState<unknown>()
  const [key, setKey] = useState(commandKey)
  async function resolve(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    try { await api(`/discrepancies/${row.id}/resolve`, json('POST', { resolutionType, quantity, reason, ...(resolutionType === 'LATER_RECEIPT' ? { laterReceiptItemId } : {}) }, key)); setKey(commandKey()); onChanged() } catch (e) { setError(e) }
  }
  return <div className="discrepancy"><strong>{row.kind} #{row.id}</strong><p>Outstanding: {row.outstandingQty} · {row.reason}</p>{row.kind === 'SHORTAGE' && row.outstandingQty !== '0' && <ShortageForm transferId={transferId} itemId={row.transferItemId} onChanged={onChanged} />}{user?.role === 'MANAGER' && row.outstandingQty !== '0' && <form className="stack" onSubmit={resolve}><Field label="Resolution"><select value={resolutionType} onChange={event => setResolution(event.target.value)}>{(row.kind === 'SHORTAGE' ? ['LOSS','DISPATCH_CORRECTION','LATER_RECEIPT'] : ['ACCEPT_EXCESS','RETURN_EXCESS']).map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Quantity"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quantity} onChange={event => setQuantity(event.target.value)} /></Field>{resolutionType === 'LATER_RECEIPT' && <Field label="Later receipt item ID"><input required pattern="[1-9][0-9]*" value={laterReceiptItemId} onChange={event => setLaterReceipt(event.target.value)} /></Field>}<Field label="Reason"><textarea required value={reason} onChange={event => setReason(event.target.value)} /></Field><Notice error={error} /><button className="button">{t("Resolve")}</button></form>}<Evidence target="discrepancies" id={row.id} /></div>
}

function ShortageForm({ transferId, itemId, onChanged }: { transferId: string; itemId: string; onChanged?: () => void }) {
  const [show, setShow] = useState(false)
  const [quantity, setQuantity] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>()
  const [key, setKey] = useState(commandKey)
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    try { await api(`/transfers/${transferId}/shortages`, json('POST', { transferItemId: itemId, quantity, reason }, key)); setKey(commandKey()); setShow(false); onChanged?.() } catch (e) { setError(e) }
  }
  return <>{!show ? <button className="button subtle" onClick={() => setShow(true)}>{t("Report shortage")}</button> : <form className="stack" onSubmit={submit}><Field label="Quantity"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quantity} onChange={event => setQuantity(event.target.value)} /></Field><Field label="Reason"><input required value={reason} onChange={event => setReason(event.target.value)} /></Field><Notice error={error} /><button className="button">{t("Report shortage")}</button></form>}</>
}

export function Evidence({ target, id }: { target: 'discrepancies' | 'stock-requests'; id: string }) {
  const query = useQuery({ queryKey: ['evidence', target, id], queryFn: () => api<{ items: { id: string; filename: string }[] }>(`/evidence/${target}/${id}`) })
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<unknown>()
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file) return
    if (file.size > 5 * 1024 * 1024) { setError(new Error('Evidence must be 5 MB or smaller.')); return }
    const body = new FormData(); body.set('file', file)
    try { await api(`/evidence/${target}/${id}`, { method: 'POST', body }); setFile(null); await query.refetch() } catch (e) { setError(e) }
  }
  return <div className="evidence"><h3>{t("Evidence")}</h3>{query.data?.items.map(row => <a key={row.id} href={`/api/evidence/${row.id}/file`} target="_blank" rel="noreferrer">{row.filename}</a>)}<form onSubmit={upload} className="stack"><input type="file" accept="image/png,image/jpeg,application/pdf" onChange={event => setFile(event.target.files?.[0] ?? null)} /><Notice error={error} /><button className="button subtle" disabled={!file}>{t("Upload evidence")}</button></form></div>
}
