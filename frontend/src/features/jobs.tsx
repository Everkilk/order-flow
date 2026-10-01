import { t } from '../app/locale'
import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useSession } from '../app/session-context'
import { Badge, Card, DataTable, Field, Loading, Notice, PageHeading, Pager } from '../components/ui'
import { api, json } from '../lib/api'
import { useOptions, usePage } from '../lib/queries'

type ImportRow = { id: string; kind: string; status: string; validatedRows: number | null; createdAt: string }
type ImportDetail = ImportRow & { commitKey: string; jobStatus: string; lastErrorCode: string | null; errors: { rowNumber: number; field: string | null; message: string }[] }
type Preview = { columns: string[]; rows: { rowNumber: number; values: string[] }[]; hasMore: boolean; errors: { rowNumber: number; field: string; message: string }[] }
type ExportRow = { id: string; kind: string; format: string; status: string; ready: boolean; createdAt: string; lastErrorCode?: string | null }
type Warehouse = { id: string; code: string }

export function Jobs() {
  const { user } = useSession()
  const client = useQueryClient()
  const [importKind, setImportKind] = useState('orders')
  const [file, setFile] = useState<File | null>(null)
  const [exportKind, setExportKind] = useState('STOCK')
  const [warehouseId, setWarehouse] = useState('')
  const [params, setParams] = useSearchParams()
  const selectedImport = params.get('import')
  const selectedExport = params.get('export')
  const setSelectedImport = (id: string) => setParams({ import: id })
  const setSelectedExport = (id: string) => setParams({ export: id })
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  const imports = usePage<ImportRow>('/imports')
  const exports = usePage<ExportRow>('/exports')
  const warehouses = useOptions<Warehouse>('/warehouses')
  const importDetail = useQuery({ queryKey: ['import', selectedImport], queryFn: () => api<ImportDetail>(`/imports/${selectedImport}`), enabled: !!selectedImport, refetchInterval: query => {
    const detail = query.state.data
    return detail && (['UPLOADED','VALIDATING'].includes(detail.status) || (detail.status === 'READY' && ['PENDING','PROCESSING'].includes(detail.jobStatus))) ? 3000 : false
  } })
  const preview = useQuery({ queryKey: ['preview', selectedImport], queryFn: () => api<Preview>(`/imports/${selectedImport}/preview`), enabled: !!selectedImport && ['READY','INVALID','COMMITTED','FAILED'].includes(importDetail.data?.status ?? '') })
  const exportDetail = useQuery({ queryKey: ['export', selectedExport], queryFn: () => api<ExportRow>(`/exports/${selectedExport}`), enabled: !!selectedExport, refetchInterval: query => !query.state.data?.ready && ['PENDING','PROCESSING'].includes(query.state.data?.status ?? '') ? 3000 : false })
  const importStatus = importDetail.data?.status
  const exportStatus = exportDetail.data?.status
  useEffect(() => {
    if (importStatus) void client.invalidateQueries({ queryKey: ['page', '/imports'] })
  }, [client, selectedImport, importStatus])
  useEffect(() => {
    if (exportStatus) void client.invalidateQueries({ queryKey: ['page', '/exports'] })
  }, [client, selectedExport, exportStatus])
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file) return
    setError(undefined); setSuccess('')
    if (file.size > 20 * 1024 * 1024) { setError(new Error('CSV must be at most 20 MB.')); return }
    const body = new FormData(); body.set('file', file)
    try { const row = await api<{ id: string }>(`/imports/${importKind}`, { method: 'POST', body }); setSelectedImport(row.id); setFile(null); await client.invalidateQueries({ queryKey: ['page', '/imports'] }); setSuccess('Upload received.') } catch (e) { setError(e) }
  }
  async function commit() {
    if (!selectedImport || !importDetail.data) return
    setError(undefined)
    try { await api(`/imports/${selectedImport}/commit`, json('POST', {}, importDetail.data.commitKey)); await importDetail.refetch(); setSuccess('Import queued for commit.') } catch (e) { setError(e) }
  }
  async function createExport(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    try { const row = await api<{ id: string }>('/exports', json('POST', { kind: exportKind, ...(exportKind === 'PRODUCTS' ? {} : { warehouseId }) })); setSelectedExport(row.id); await client.invalidateQueries({ queryKey: ['page', '/exports'] }); setSuccess('Export queued.') } catch (e) { setError(e) }
  }
  return <><PageHeading title="Imports & exports" description="Review CSV data before committing it, and download processed exports." /><Notice error={error} success={success} /><div className="grid-two"><Card><h2>{t("New import")}</h2><p className="muted">{t("CSV, up to 20 MB and 10,000 rows.")}</p><form className="stack" onSubmit={upload}><Field label="Data type"><select value={importKind} onChange={event => setImportKind(event.target.value)}>{user?.role === 'MANAGER' && <><option value="products">{t("Products")}</option><option value="opening-stock">{t("Opening stock")}</option></>}<option value="orders">{t("Draft orders")}</option></select></Field><Field label="CSV file"><input type="file" required accept=".csv,text/csv" onChange={event => setFile(event.target.files?.[0] ?? null)} /></Field><button className="button primary" disabled={!file}>{t("Upload & validate")}</button></form><h3>{t("Recent imports")}</h3>{imports.isPending ? <Loading /> : imports.error ? <Notice error={imports.error} /> : <DataTable headers={['ID', 'Type', 'Status']} rows={imports.data.items.map(row => [<button className="link-button" onClick={() => setSelectedImport(row.id)}>#{row.id}</button>, row.kind, <Badge value={row.status} />])} />}<Pager next={imports.next} previous={imports.previous} onNext={imports.forward} onPrevious={imports.back} /></Card><Card><h2>{t("Import review")}</h2>{!selectedImport ? <p className="muted">{t("Choose an import to review it.")}</p> : importDetail.isPending ? <Loading /> : importDetail.error ? <Notice error={importDetail.error} /> : <><div className="summary-row"><span>{t("Status")}</span><Badge value={importDetail.data.status} /></div><div className="summary-row"><span>{t("Validated rows")}</span><strong>{importDetail.data.validatedRows ?? '—'}</strong></div>{importDetail.data.lastErrorCode && <p>Job error: {importDetail.data.lastErrorCode}</p>}{importDetail.data.errors.length > 0 && <DataTable headers={['Row', 'Field', 'Problem']} rows={importDetail.data.errors.map(row => [row.rowNumber, row.field ?? '—', row.message])} />}{preview.data && <><h3>{t("CSV preview")}</h3><DataTable headers={preview.data.columns} rows={preview.data.rows.map(row => row.values)} />{preview.data.hasMore && <p className="muted">{t("Showing the first 20 rows.")}</p>}</>}{importDetail.data.status === 'READY' && <button className="button primary" onClick={() => { if (window.confirm('Commit all validated rows?')) void commit() }}>{t("Commit import")}</button>}</>}</Card></div><div className="grid-two"><Card><h2>{t("New export")}</h2><form className="stack" onSubmit={createExport}><Field label="Data"><select value={exportKind} onChange={event => setExportKind(event.target.value)}><option value="PRODUCTS">{t("Products")}</option><option value="STOCK">{t("Stock")}</option><option value="MOVEMENTS">{t("Movements")}</option><option value="REPORT">{t("Low stock report")}</option></select></Field>{exportKind !== 'PRODUCTS' && <Field label="Warehouse"><select required value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("Choose warehouse")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></Field>}<button className="button primary">{t("Request export")}</button></form><h3>{t("Recent exports")}</h3>{exports.isPending ? <Loading /> : exports.error ? <Notice error={exports.error} /> : <DataTable headers={['ID', 'Type', 'Status']} rows={exports.data.items.map(row => [<button className="link-button" onClick={() => setSelectedExport(row.id)}>#{row.id}</button>, row.kind, <Badge value={row.status} />])} />}<Pager next={exports.next} previous={exports.previous} onNext={exports.forward} onPrevious={exports.back} /></Card><Card><h2>{t("Export download")}</h2>{!selectedExport ? <p className="muted">{t("Choose an export.")}</p> : exportDetail.isPending ? <Loading /> : exportDetail.error ? <Notice error={exportDetail.error} /> : <><p>{exportDetail.data.kind} · {exportDetail.data.status}</p>{exportDetail.data.ready ? <a className="button primary" href={`/api/exports/${selectedExport}/file`}>{t("Download CSV")}</a> : <p>{exportDetail.data.status === 'FAILED' ? t("Export failed. Request a new export.") : t("Processing…")}</p>}</>}</Card></div></>
}
