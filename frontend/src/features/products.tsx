import { t } from '../app/locale'
import { useEffect, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useSession } from '../app/session-context'
import { Card, DataTable, Field, Loading, Notice, PageHeading, Pager, RecordLink } from '../components/ui'
import { api, json, type Page } from '../lib/api'
import { useOptions, usePage } from '../lib/queries'
import { useUnsavedDraft } from '../lib/unsaved'

type Category = { id: string; name: string }
type Unit = { id: string; code: string; name: string }
type Attribute = { key: string; label: string; dataType: 'string' | 'number' | 'boolean'; required: boolean; allowedValues: (string | number | boolean)[] | null; minValue: string | null; maxValue: string | null }
type Product = { id: string; sku: string; barcode: string | null; name: string; categoryId: string; unitId: string; description: string | null; imageUrl: string | null; attributes: Record<string, unknown>; sellingPrice: string | null; sellingCurrency: 'VND' | 'USD' | null; active: boolean; revision: string; category?: string; unit?: string; stock?: { warehouse: string; onHand: string; reserved: string; available: string }[]; suppliers?: { id: string; name: string; supplierSku?: string | null; primarySupplier: boolean; cost?: string | null; currency?: string | null }[] }
type ProductRow = Pick<Product, 'id' | 'sku' | 'name' | 'categoryId' | 'imageUrl'> & { category: string }

export function Products() {
  const { user } = useSession()
  const [params, setParams] = useSearchParams()
  const [searchDraft, setSearchDraft] = useState({ source: params.get('q') ?? '', value: params.get('q') ?? '' })
  const [showCreate, setShowCreate] = useState(false)
  const q = params.get('q') ?? ''
  const categoryId = params.get('categoryId') ?? ''
  const draft = searchDraft.source === q ? searchDraft.value : q
  useEffect(() => {
    if (draft === q) return
    const timer = setTimeout(() => setParams(old => { const next = new URLSearchParams(old); if (draft) next.set('q', draft); else next.delete('q'); return next }, { replace: true }), 300)
    return () => clearTimeout(timer)
  }, [draft, q, setParams])
  const query = usePage<ProductRow>('/products', { q, categoryId })
  const categories = useOptions<Category>('/categories')
  return <><PageHeading title="Products" description="Find items by SKU, barcode, or name." action={user?.role === 'MANAGER' ? <button className="button primary" onClick={() => setShowCreate(true)}>{t("New product")}</button> : undefined} /><Card><div className="filters"><Field label="Search"><input value={draft} onChange={event => setSearchDraft({ source: q, value: event.target.value })} placeholder="Search products" /></Field><Field label="Category"><select value={categoryId} onChange={event => setParams(old => { const next = new URLSearchParams(old); if (event.target.value) next.set('categoryId', event.target.value); else next.delete('categoryId'); return next })}><option value="">All categories</option>{categories.data?.items.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></Field></div>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['SKU', 'Name', 'Category']} rows={query.data.items.map(row => [<RecordLink to={`/products/${row.id}`}>{row.sku}</RecordLink>, row.name, row.category])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card>{showCreate && <div className="modal-backdrop"><Card className="drawer"><div className="drawer-head"><h2>{t("New product")}</h2></div><ProductForm onSaved={() => setShowCreate(false)} onClose={() => setShowCreate(false)} /></Card></div>}</>
}

export function ProductDetail() {
  const { id } = useParams()
  const { user } = useSession()
  const [editing, setEditing] = useState(false)
  const query = useQuery({ queryKey: ['product', id], queryFn: () => api<Product>(`/products/${id}`), enabled: !!id })
  if (query.isPending) return <Loading />
  if (query.error) return <Notice error={query.error} />
  const product = query.data
  return <><PageHeading title={product.name} description={`SKU ${product.sku} · ${product.category}`} action={user?.role === 'MANAGER' && !editing ? <button className="button primary" onClick={() => setEditing(true)}>{t("Edit product")}</button> : undefined} />{editing ? <Card><ProductForm initial={product} onSaved={() => { setEditing(false); void query.refetch() }} onClose={() => setEditing(false)} /></Card> : <div className="grid-two"><Card><h2>{t("Details")}</h2><div className="summary-row"><span>{t("Barcode")}</span><strong>{product.barcode ?? '—'}</strong></div><div className="summary-row"><span>{t("Unit")}</span><strong>{product.unit}</strong></div><div className="summary-row"><span>{t("Price")}</span><strong>{product.sellingPrice ? `${product.sellingPrice} ${product.sellingCurrency}` : '—'}</strong></div><div className="summary-row"><span>{t("Status")}</span><strong>{product.active ? 'Active' : 'Inactive'}</strong></div><p>{product.description}</p>{product.imageUrl && <a href={product.imageUrl} target="_blank" rel="noreferrer">{t("View image")}</a>}<h3>{t("Category attributes")}</h3>{Object.entries(product.attributes).map(([key, value]) => <div className="summary-row" key={key}><span>{key}</span><strong>{String(value)}</strong></div>)}</Card><Card><h2>{t("Warehouse stock")}</h2><DataTable headers={['Warehouse', 'On hand', 'Reserved', 'Available']} rows={(product.stock ?? []).map(row => [row.warehouse, row.onHand, row.reserved, row.available])} /><h2>{t("Suppliers")}</h2><DataTable headers={['Supplier', 'Primary', 'Cost']} rows={(product.suppliers ?? []).map(row => [row.name, row.primarySupplier ? 'Yes' : 'No', row.cost ? `${row.cost} ${row.currency}` : '—'])} />{user?.role === 'MANAGER' && <SupplierEditor product={product} onSaved={() => void query.refetch()} />}</Card></div>}</>
}

function SupplierEditor({ product, onSaved }: { product: Product; onSaved: () => void }) {
  const suppliers = useOptions<{ id: string; name: string }>('/suppliers')
  const [supplierId, setSupplierId] = useState('')
  const [supplierSku, setSupplierSku] = useState('')
  const [primarySupplier, setPrimary] = useState(false)
  const [cost, setCost] = useState('')
  const [currency, setCurrency] = useState('')
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  const [busy, setBusy] = useState(false)
  function choose(id: string) {
    setSupplierId(id)
    const existing = product.suppliers?.find(row => row.id === id)
    setSupplierSku(existing?.supplierSku ?? '')
    setPrimary(existing?.primarySupplier ?? false)
    setCost(existing?.cost ?? '')
    setCurrency(existing?.currency ?? '')
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined); setSuccess('')
    try {
      await api<void>(`/products/${product.id}/suppliers/${supplierId}`, json('PUT', {
        supplierSku: supplierSku || null,
        primarySupplier,
        cost: cost || null,
        currency: cost ? currency : null,
      }))
      setSuccess('Supplier saved.')
      onSaved()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <><h3>{t("Add or edit supplier")}</h3><form className="stack" onSubmit={submit}>
    <Field label="Supplier"><select required value={supplierId} onChange={event => choose(event.target.value)}><option value="">Choose supplier</option>{suppliers.data?.items.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field>
    <Field label="Supplier SKU"><input value={supplierSku} onChange={event => setSupplierSku(event.target.value)} /></Field>
    <Field label="Primary supplier"><input type="checkbox" checked={primarySupplier} onChange={event => setPrimary(event.target.checked)} /></Field>
    <Field label="Cost"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,4})?" value={cost} onChange={event => setCost(event.target.value)} /></Field>
    <Field label="Currency"><select value={currency} required={!!cost} onChange={event => setCurrency(event.target.value)}><option value="">No cost</option><option>VND</option><option>USD</option></select></Field>
    <Notice error={error} success={success} /><button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save supplier'}</button>
  </form></>
}

function ProductForm({ initial, onSaved, onClose }: { initial?: Product; onSaved: () => void; onClose: () => void }) {
  const navigate = useNavigate()
  const { markDirty, markClean, confirmClose } = useUnsavedDraft()
  const client = useQueryClient()
  const categories = useOptions<Category>('/categories')
  const units = useOptions<Unit>('/units')
  const [sku, setSku] = useState(initial?.sku ?? '')
  const [name, setName] = useState(initial?.name ?? '')
  const [barcode, setBarcode] = useState(initial?.barcode ?? '')
  const [description, setDescription] = useState(initial?.description ?? '')
  const [imageUrl, setImageUrl] = useState(initial?.imageUrl ?? '')
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? '')
  const [unitId, setUnitId] = useState(initial?.unitId ?? '')
  const [sellingPrice, setPrice] = useState(initial?.sellingPrice ?? '')
  const [sellingCurrency, setCurrency] = useState(initial?.sellingCurrency ?? '')
  const [active, setActive] = useState(initial?.active ?? true)
  const [attributes, setAttributes] = useState<Record<string, unknown>>(initial?.attributes ?? {})
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const definitions = useQuery({ queryKey: ['category-attributes', categoryId], queryFn: () => api<Page<Attribute>>(`/categories/${categoryId}/attributes`), enabled: !!categoryId })
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined)
    const body = { sku, name, barcode: barcode || null, description: description || null, imageUrl: imageUrl || null, categoryId, unitId, attributes, sellingPrice: sellingPrice || null, sellingCurrency: sellingPrice ? sellingCurrency : null }
    try {
      const saved = initial ? await api<Product>(`/products/${initial.id}`, json('PUT', { ...body, active, expectedRevision: Number(initial.revision) })) : await api<Product>('/products', json('POST', body))
      await client.invalidateQueries({ queryKey: ['page', '/products'] })
      markClean()
      onSaved()
      if (!initial) navigate(`/products/${saved.id}`)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <form onSubmit={submit} onChange={markDirty} className="form-grid"><Field label="SKU"><input required maxLength={100} value={sku} onChange={event => setSku(event.target.value)} /></Field><Field label="Product name"><input required maxLength={240} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="Barcode"><input value={barcode} onChange={event => setBarcode(event.target.value)} /></Field><Field label="Category"><select required value={categoryId} onChange={event => { setCategoryId(event.target.value); setAttributes({}) }}><option value="">Choose category</option>{categories.data?.items.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></Field><Field label="Unit"><select required value={unitId} onChange={event => setUnitId(event.target.value)}><option value="">Choose unit</option>{units.data?.items.map(row => <option key={row.id} value={row.id}>{row.name} ({row.code})</option>)}</select></Field><Field label="Image URL"><input type="url" value={imageUrl} onChange={event => setImageUrl(event.target.value)} /></Field><Field label="Selling price"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,4})?" value={sellingPrice} onChange={event => setPrice(event.target.value)} /></Field><Field label="Currency"><select value={sellingCurrency} required={!!sellingPrice} onChange={event => setCurrency(event.target.value as 'VND' | 'USD' | '')}><option value="">No price</option><option>VND</option><option>USD</option></select></Field><Field label="Description"><textarea maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} /></Field>{definitions.data?.items.map(def => <Field key={def.key} label={`${def.label}${def.required ? ' *' : ''}`}><AttributeField definition={def} value={attributes[def.key]} onChange={value => setAttributes(old => { const next = { ...old }; if (value === undefined) delete next[def.key]; else next[def.key] = value; return next })} /></Field>)}{initial && <Field label="Active"><input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} /></Field>}<div className="form-actions"><Notice error={error} /><div className="button-row"><button type="button" className="button subtle" onClick={() => { if (confirmClose()) { markClean(); onClose() } }}>{t("Close")}</button><button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button></div></div></form>
}

function AttributeField({ definition, value, onChange }: { definition: Attribute; value: unknown; onChange: (value: unknown) => void }) {
  if (definition.dataType === 'boolean') return <select value={value === undefined ? '' : String(value)} required={definition.required} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select>
  if (definition.allowedValues?.length) return <select value={value === undefined ? '' : String(value)} required={definition.required} onChange={event => onChange(event.target.value === '' ? undefined : definition.dataType === 'number' ? Number(event.target.value) : event.target.value)}><option value="">Choose</option>{definition.allowedValues.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select>
  return <input type={definition.dataType === 'number' ? 'number' : 'text'} required={definition.required} min={definition.minValue ?? undefined} max={definition.maxValue ?? undefined} value={value === undefined ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? undefined : definition.dataType === 'number' ? Number(event.target.value) : event.target.value)} />
}
