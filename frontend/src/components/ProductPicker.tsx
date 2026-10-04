import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, pathWithQuery, type Page } from '../lib/api'
import { Field, Notice } from './ui'
import { t } from '../app/locale'

type ProductOption = { id: string; sku: string; name: string; active?: boolean }

export function ProductPicker({ value, onChange, label = 'Product', selectedLabel }: {
  value: string
  onChange: (id: string, product?: ProductOption) => void
  label?: string
  selectedLabel?: string
}) {
  const [search, setSearch] = useState('')
  const [queryText, setQueryText] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setQueryText(search.trim()), 250)
    return () => clearTimeout(timer)
  }, [search])
  const query = useQuery({
    queryKey: ['product-picker', queryText],
    queryFn: ({ signal }) => api<Page<ProductOption>>(pathWithQuery('/products', { q: queryText, limit: '25' }), { signal }),
  })
  const options = query.data?.items.filter(row => row.active !== false) ?? []
  const selected = options.find(row => row.id === value)
  return <div className="product-picker">
    <Field label={label === 'Product' ? 'Search product' : `Search ${label.toLowerCase()}`}>
      <input type="search" value={search} placeholder={t('SKU or product name')} onChange={event => { setSearch(event.target.value); onChange('') }} />
    </Field>
    <Field label={label}>
      <select required value={value} onChange={event => onChange(event.target.value, options.find(row => row.id === event.target.value))}>
        <option value="">{t(query.isFetching ? 'Searching…' : 'Choose product')}</option>
        {value && !selected && <option value={value}>{selectedLabel ?? t('Product #{id}', { id: value })}</option>}
        {options.map(row => <option key={row.id} value={row.id}>{row.sku} — {row.name}</option>)}
      </select>
    </Field>
    {query.error && <Notice error={query.error} />}
    {query.data?.nextCursor && <small className="muted">{t('Showing the first 25 matches. Search to narrow the list.')}</small>}
  </div>
}
