import { ProductReference } from '../components/ProductReference'
import { MutationForm } from '../components/MutationForm'
import { useViewState } from '../lib/view-state'
import { t } from '../app/locale'
import { type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSession } from '../app/session-context'
import { Card, DataTable, Field, Loading, Notice, PageHeading, Pager } from '../components/ui'
import { api, pathWithQuery } from '../lib/api'
import { useOptions, usePage } from '../lib/queries'

type Warehouse = { id: string; code: string; name: string }
type LowRow = { warehouseId: string; warehouse: string; productId: string; sku: string; name: string; available: string; threshold: string; criticalThreshold: string | null }
type SummaryRow = { day: string; eventType: string; movements: number; onHandDelta: string; reservedDelta: string }
type Valuation = { currencyTotals: { currency: string; amount: string; stockRows: string }[]; unvaluedStockRows: string }

export function Reports() {
  const { user } = useSession()
  const [warehouseId, setWarehouse] = useViewState('warehouseId', '')
  const [from, setFrom] = useViewState('from', '')
  const [to, setTo] = useViewState('to', '')
  const [range, setRange] = useViewState<{ warehouseId: string; from: string; to: string } | null>('range', null)
  const warehouses = useOptions<Warehouse>('/warehouses')
  const low = usePage<LowRow>('/reports/low-stock', { warehouseId })
  const valuation = useQuery({ queryKey: ['valuation', warehouseId], queryFn: () => api<Valuation>(pathWithQuery('/reports/valuation', { warehouseId })), enabled: user?.role === 'MANAGER' })
  const summary = useQuery({ queryKey: ['summary', range], queryFn: () => api<{ items: SummaryRow[] }>(pathWithQuery('/reports/movements', range!)), enabled: !!range })
  function submit(event: FormEvent) {
    event.preventDefault()
    if (!warehouseId || !from || !to) return
    setRange({ warehouseId, from: new Date(`${from}T00:00:00+07:00`).toISOString(), to: new Date(`${to}T00:00:00+07:00`).toISOString() })
  }
  return <><PageHeading title="Reports" description="Low stock and warehouse movement summaries." /><Card><h2>{t("Low stock")}</h2><Field label="Warehouse"><select value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("All permitted")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field>{low.isPending ? <Loading /> : low.error ? <Notice error={low.error} /> : <DataTable headers={['SKU', 'Product', 'Warehouse', 'Available', 'Threshold', 'Critical']} rows={low.data.items.map(row => [row.sku, <ProductReference id={row.productId} sku={row.sku} name={row.name} />, row.warehouse, row.available, row.threshold, row.criticalThreshold ?? '—'])} />}<Pager next={low.next} previous={low.previous} onNext={low.forward} onPrevious={low.back} /></Card>{user?.role === 'MANAGER' && <Card><h2>{t("Valuation")}</h2><p className="muted">{t("On-hand quantity × primary supplier cost. Totals stay separate by currency.")}</p>{valuation.isPending ? <Loading /> : valuation.error ? <Notice error={valuation.error} /> : <><DataTable headers={['Currency', 'Amount', 'Stock rows']} rows={valuation.data.currencyTotals.map(row => [row.currency, row.amount, row.stockRows])} /><p>{t("Rows without a primary supplier cost")}: {valuation.data.unvaluedStockRows}</p></>}</Card>}{user?.role !== 'VIEWER' && <Card><h2>{t("Movement summary")}</h2><p className="muted">{t("Choose one warehouse and at most 31 days. The end date is exclusive (Asia/Ho_Chi_Minh).")}</p><MutationForm className="filters" onSubmit={submit}><Field label="Warehouse"><select required value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("Choose")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></Field><Field label="From"><input type="date" required value={from} onChange={event => setFrom(event.target.value)} /></Field><Field label="To (exclusive)"><input type="date" required value={to} onChange={event => setTo(event.target.value)} /></Field><button className="button primary">{t("Run report")}</button></MutationForm>{summary.isFetching ? <Loading /> : summary.error ? <Notice error={summary.error} /> : summary.data ? <DataTable headers={['Day', 'Event', 'Movements', 'On-hand change', 'Reserved change']} rows={summary.data.items.map(row => [row.day, t(row.eventType), row.movements, row.onHandDelta, row.reservedDelta])} /> : null}</Card>}</>
}
