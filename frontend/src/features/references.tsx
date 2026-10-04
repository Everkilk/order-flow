import { MutationForm } from '../components/MutationForm'
import { confirmDiscard, useUnsavedDraft } from '../lib/unsaved'
import { useViewState } from '../lib/view-state'
import { t } from '../app/locale'
import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, DataTable, Field, Loading, Notice, PageHeading } from '../components/ui'
import { ProductPicker } from '../components/ProductPicker'
import { api, json } from '../lib/api'
import { useOptions } from '../lib/queries'

type RefRow = { id: string; name: string; code?: string; email?: string | null; phone?: string | null; decimalPlaces?: number }
type Kind = 'categories' | 'units' | 'suppliers' | 'warehouses'
const kinds: { id: Kind; label: string }[] = [
  { id: 'categories', label: 'Categories' }, { id: 'units', label: 'Units' },
  { id: 'suppliers', label: 'Suppliers' }, { id: 'warehouses', label: 'Warehouses' },
]

export function References() {
  const { markDirty, markClean } = useUnsavedDraft()
  const [kind, setKind] = useViewState<Kind>('kind', 'categories')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [decimalPlaces, setDecimalPlaces] = useState('0')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useViewState('selectedCategoryId', '')
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  const query = useOptions<RefRow>(`/${kind}`)
  const client = useQueryClient()
  function discardChanges() {
    if (!confirmDiscard()) return false
    markClean(); setName(''); setCode(''); setDecimalPlaces('0'); setEmail(''); setPhone(''); setAddress('')
    return true
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setSuccess('')
    const body = kind === 'categories' ? { name } : kind === 'units' ? { name, code, decimalPlaces: Number(decimalPlaces) } : kind === 'suppliers' ? { name, email: email || null, phone: phone || null } : { name, code, address: address || null }
    try {
      await api(`/${kind}`, json('POST', body))
      await client.invalidateQueries({ queryKey: ['options', `/${kind}`] })
      markClean(); setName(''); setCode(''); setEmail(''); setPhone(''); setAddress(''); setSuccess('Created successfully.')
    } catch (e) { setError(e) }
  }
  return <><PageHeading title="Reference data" description="Define the names and choices used in products and documents." /><div className="tabs">{kinds.map(item => <button type="button" key={item.id} className={kind === item.id ? 'tab active' : 'tab'} onClick={() => { if (item.id !== kind && discardChanges()) { setKind(item.id); setSelectedCategoryId(''); setError(undefined); setSuccess('') } }}>{t(item.label)}</button>)}</div><div className="grid-two"><Card><h2>{t(kinds.find(item => item.id === kind)?.label ?? '')}</h2>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={kind === 'units' ? ['Code', 'Name', 'Decimals'] : kind === 'suppliers' ? ['Name', 'Email', 'Phone'] : kind === 'warehouses' ? ['Code', 'Name'] : ['Name']} rows={query.data.items.map(row => kind === 'units' ? [row.code, row.name, row.decimalPlaces] : kind === 'suppliers' ? [row.name, row.email ?? '—', row.phone ?? '—'] : kind === 'warehouses' ? [row.code, row.name] : [<button className="link-button" onClick={() => { if (row.id !== selectedCategoryId && discardChanges()) setSelectedCategoryId(row.id) }}>{row.name}</button>])} />}</Card><Card><h2>{t(`Add ${kind === 'categories' ? 'category' : kind.slice(0,-1)}`)}</h2><MutationForm onChange={markDirty} onSubmit={submit} className="stack"><Field label="Name"><input required value={name} onChange={event => setName(event.target.value)} /></Field>{(kind === 'units' || kind === 'warehouses') && <Field label="Code"><input required value={code} onChange={event => setCode(event.target.value)} /></Field>}{kind === 'units' && <Field label="Decimal places"><input type="number" min="0" max="6" required value={decimalPlaces} onChange={event => setDecimalPlaces(event.target.value)} /></Field>}{kind === 'suppliers' && <><Field label="Email"><input type="email" value={email} onChange={event => setEmail(event.target.value)} /></Field><Field label="Phone"><input value={phone} onChange={event => setPhone(event.target.value)} /></Field></>}{kind === 'warehouses' && <Field label="Address"><textarea value={address} onChange={event => setAddress(event.target.value)} /></Field>}<Notice error={error} success={success} /><button className="button primary">{t("Create")}</button></MutationForm></Card></div>{kind === 'categories' && selectedCategoryId && <CategoryAttributes key={selectedCategoryId} categoryId={selectedCategoryId} />}{kind === 'warehouses' && <Thresholds />}</>
}

type Attribute = { id: string; key: string; label: string; dataType: 'string' | 'number' | 'boolean'; required: boolean; unitLabel: string | null; minValue: string | null; maxValue: string | null; allowedValues: (string | number | boolean)[] | null }

function CategoryAttributes({ categoryId }: { categoryId: string }) {
  const { markDirty, markClean } = useUnsavedDraft()
  const client = useQueryClient()
  const query = useQuery({ queryKey: ['category-attributes', categoryId], queryFn: () => api<{ items: Attribute[] }>(`/categories/${categoryId}/attributes`) })
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [dataType, setDataType] = useState<Attribute['dataType']>('string')
  const [required, setRequired] = useState(false)
  const [unitLabel, setUnitLabel] = useState('')
  const [minValue, setMinValue] = useState('')
  const [maxValue, setMaxValue] = useState('')
  const [allowed, setAllowed] = useState('')
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setSuccess('')
    const allowedValues = allowed.trim() ? allowed.split(',').map(value => dataType === 'number' ? Number(value.trim()) : value.trim()) : null
    try {
      await api(`/categories/${categoryId}/attributes`, json('POST', {
        key, label, dataType, required, unitLabel: unitLabel || null,
        minValue: dataType === 'number' && minValue ? Number(minValue) : null,
        maxValue: dataType === 'number' && maxValue ? Number(maxValue) : null,
        allowedValues,
      }))
      await client.invalidateQueries({ queryKey: ['category-attributes', categoryId] })
      markClean(); setKey(''); setLabel(''); setUnitLabel(''); setMinValue(''); setMaxValue(''); setAllowed('')
      setSuccess('Attribute added.')
    } catch (e) { setError(e) }
  }
  return <Card><h2>{t("Category attributes")}</h2><p className="muted">{t("Fields appear on products in this category. Use lowercase keys such as material or size.")}</p>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['Key', 'Label', 'Type', 'Required']} rows={query.data.items.map(row => [row.key, row.label, t(row.dataType), t(row.required ? 'Yes' : 'No')])} />}<h3>{t("Add attribute")}</h3><MutationForm onChange={markDirty} className="form-grid" onSubmit={submit}><Field label="Key"><input required pattern="[a-z][a-z0-9_]*" value={key} onChange={event => setKey(event.target.value)} /></Field><Field label="Label"><input required value={label} onChange={event => setLabel(event.target.value)} /></Field><Field label="Type"><select value={dataType} onChange={event => { setDataType(event.target.value as Attribute['dataType']); setAllowed('') }}><option value="string">{t("Text")}</option><option value="number">{t("Number")}</option><option value="boolean">{t("Yes / no")}</option></select></Field><Field label="Required"><input type="checkbox" checked={required} onChange={event => setRequired(event.target.checked)} /></Field><Field label="Unit label (optional)"><input value={unitLabel} onChange={event => setUnitLabel(event.target.value)} /></Field>{dataType === 'number' && <><Field label="Minimum"><input type="number" value={minValue} onChange={event => setMinValue(event.target.value)} /></Field><Field label="Maximum"><input type="number" value={maxValue} onChange={event => setMaxValue(event.target.value)} /></Field></>}{dataType !== 'boolean' && <Field label="Allowed values, comma separated (optional)"><input value={allowed} onChange={event => setAllowed(event.target.value)} /></Field>}<div className="form-actions"><Notice error={error} success={success} /><button className="button primary">{t("Add attribute")}</button></div></MutationForm></Card>
}

function Thresholds() {
  const { markDirty, markClean } = useUnsavedDraft()
  const warehouses = useOptions<RefRow>('/warehouses')
  const [warehouseId, setWarehouse] = useState('')
  const [productId, setProduct] = useState('')
  const [threshold, setThreshold] = useState('')
  const [criticalThreshold, setCritical] = useState('')
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined); setSuccess('')
    try {
      await api<void>(`/warehouses/${warehouseId}/thresholds/${productId}`, json('PUT', { threshold, criticalThreshold: criticalThreshold || null }))
      markClean(); setSuccess('Low-stock threshold saved.')
    } catch (e) { setError(e) }
  }
  return <Card><h2>{t("Low-stock thresholds")}</h2><p className="muted">{t("Set a threshold for a product in one warehouse. Search by SKU or name to choose it.")}</p><MutationForm onChange={markDirty} className="form-grid" onSubmit={submit}><Field label="Warehouse"><select required value={warehouseId} onChange={event => setWarehouse(event.target.value)}><option value="">{t("Choose warehouse")}</option>{warehouses.data?.items.map(row => <option key={row.id} value={row.id}>{row.code} — {row.name}</option>)}</select></Field><ProductPicker value={productId} onChange={setProduct} /><Field label="Low-stock threshold"><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={threshold} onChange={event => setThreshold(event.target.value)} /></Field><Field label="Critical threshold (optional)"><input inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,6})?" value={criticalThreshold} onChange={event => setCritical(event.target.value)} /></Field><div className="form-actions"><Notice error={error} success={success} /><button className="button primary">{t("Save threshold")}</button></div></MutationForm></Card>
}
