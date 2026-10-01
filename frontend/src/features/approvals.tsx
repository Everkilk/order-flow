import { t } from '../app/locale'
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { useSession } from '../app/session-context'
import { Badge, Card, DataTable, Field, Loading, Notice, PageHeading, Pager, RecordLink } from '../components/ui'
import { ProductPicker } from '../components/ProductPicker'
import { api, commandKey, json } from '../lib/api'
import { useOptions, usePage } from '../lib/queries'
import { Evidence } from './documents'

type RequestRow = { id: string; requestType: string; warehouseId: string | null; productId: string | null; reason: string; decision: string | null; createdAt: string }
type RequestDetail = RequestRow & { requestedDelta: string | null; countedQty: string | null; observedOnHand: string | null; observedVersion: string | null; originalEventId: string | null; decisionId: string | null; approvedDelta: string | null; decisionReason?: string | null; decidedAt?: string | null }
type Warehouse = { id: string; code: string }

export function StockRequests() {
  const [pending, setPending] = useState('true')
  const query = usePage<RequestRow>('/stock-requests', { pending })
  const [type, setType] = useState<'DAMAGE' | 'LOSS' | 'COUNT' | 'REVERSAL'>('DAMAGE')
  const [warehouseId, setWarehouse] = useState('')
  const [productId, setProduct] = useState('')
  const [quantity, setQuantity] = useState('')
  const [originalEventId, setEvent] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<unknown>()
  const client = useQueryClient()
  const navigate = useNavigate()
  const warehouses = useOptions<Warehouse>('/warehouses')
  async function create(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    const body = type === 'REVERSAL' ? { requestType: type, originalEventId, reason } : type === 'COUNT' ? { requestType: type, warehouseId, productId, countedQty: quantity, reason } : { requestType: type, warehouseId, productId, quantity, reason }
    try { const row = await api<{ id: string }>('/stock-requests', json('POST', body)); await client.invalidateQueries({ queryKey: ['page', '/stock-requests'] }); navigate(`/stock-requests/${row.id}`) } catch (e) { setError(e) }
  }
  return <><PageHeading title="Stock requests" description="Request and review corrections to stock records." /><div className="grid-two"><Card><h2>{t("Requests")}</h2><Field label="Show"><select value={pending} onChange={event => setPending(event.target.value)}><option value="true">Pending</option><option value="false">Decided</option><option value="">All</option></select></Field>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['ID', 'Type', 'Created', 'Decision']} rows={query.data.items.map(row => [<RecordLink to={`/stock-requests/${row.id}`}>#{row.id}</RecordLink>, row.requestType, new Date(row.createdAt).toLocaleDateString(), <Badge value={row.decision ?? 'PENDING'} />])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card><Card><h2>{t("New request")}</h2><form className="stack" onSubmit={create}><Field label="Type"><select value={type} onChange={event => setType(event.target.value as typeof type)}><option>DAMAGE</option><option>LOSS</option><option>COUNT</option><option>REVERSAL</option></select></Field>{type === 'REVERSAL' ? <Field label="Original event ID"><input required pattern="[1-9][0-9]*" value={originalEventId} onChange={event => setEvent(event.target.value)} /></Field> : <><Field label="Warehouse"><select required value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">Choose warehouse</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></Field><ProductPicker value={productId} onChange={setProduct} /><Field label={type === 'COUNT' ? 'Counted on hand' : 'Quantity to remove'}><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={quantity} onChange={event => setQuantity(event.target.value)} /></Field></>}<Field label="Reason"><textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></Field><Notice error={error} /><button className="button primary">{t("Submit request")}</button></form></Card></div></>
}

export function StockRequestDetail() {
  const { id } = useParams()
  const { user } = useSession()
  const query = useQuery({ queryKey: ['stock-request', id], queryFn: () => api<RequestDetail>(`/stock-requests/${id}`), enabled: !!id })
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED')
  const [reason, setReason] = useState('')
  const [version, setVersion] = useState('')
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [key, setKey] = useState(commandKey)
  const stock = useQuery({ queryKey: ['approval-stock', query.data?.warehouseId, query.data?.productId], queryFn: () => api<{ items: { version: string; onHand: string; available: string }[] }>(`/stock?warehouseId=${query.data!.warehouseId}&productId=${query.data!.productId}`), enabled: !!query.data?.warehouseId && !!query.data?.productId && user?.role === 'MANAGER' })
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setBusy(true)
    try {
      await api(`/stock-requests/${id}/decision`, json('POST', { decision, reason, ...(decision === 'APPROVED' && query.data?.requestType !== 'REVERSAL' ? { reviewedBalanceVersion: version } : {}) }, key))
      setKey(commandKey()); await query.refetch()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  if (query.isPending) return <Loading />
  if (query.error) return <Notice error={query.error} />
  const row = query.data
  return <><PageHeading title={`Stock request #${row.id}`} description={row.requestType} /><div className="grid-two"><Card><h2>{t("Request")}</h2>{[['Status', row.decision ?? 'Pending'], ['Warehouse', row.warehouseId], ['Product', row.productId], ['Requested change', row.requestedDelta], ['Counted quantity', row.countedQty], ['Observed on hand', row.observedOnHand], ['Original event', row.originalEventId], ['Reason', row.reason], ['Decision reason', row.decisionReason], ['Decided at', row.decidedAt]].filter(([, value]) => value != null).map(([label, value]) => <div className="summary-row" key={label}><span>{label}</span><strong>{value}</strong></div>)}</Card>{user?.role === 'MANAGER' && !row.decision && <Card><h2>{t("Decide request")}</h2><p className="muted">{t("Review the current balance before approving. If a count is stale, ask for a new count.")}</p>{stock.data?.items[0] && <p>Current on hand: <strong>{stock.data.items[0].onHand}</strong> · Version: <strong>{stock.data.items[0].version}</strong></p>}<form className="stack" onSubmit={submit}><Field label="Decision"><select value={decision} onChange={event => setDecision(event.target.value as typeof decision)}><option>APPROVED</option><option>REJECTED</option></select></Field>{decision === 'APPROVED' && row.requestType !== 'REVERSAL' && <Field label="Reviewed balance version"><input required pattern="[1-9][0-9]*" value={version} onChange={event => setVersion(event.target.value)} placeholder={stock.data?.items[0]?.version} /></Field>}<Field label="Reason"><textarea required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></Field><Notice error={error} /><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Submit decision'}</button></form></Card>}</div><Card><Evidence target="stock-requests" id={row.id} /></Card></>
}
