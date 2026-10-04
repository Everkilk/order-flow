import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, pathWithQuery, type Page } from '../lib/api'
import { Field, Notice } from './ui'
import { t } from '../app/locale'

type Order = { id: string; orderNumber: string; status: string }
export function OrderPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [search, setSearch] = useState('')
  const [term, setTerm] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [history, setHistory] = useState<(string | null)[]>([])
  useEffect(() => { const timer = setTimeout(() => { setTerm(search.trim()); setCursor(null); setHistory([]) }, 250); return () => clearTimeout(timer) }, [search])
  const query = useQuery({ queryKey: ['order-picker', term, cursor], queryFn: ({ signal }) => api<Page<Order>>(pathWithQuery('/orders', { status: 'FULFILLED', limit: '25', cursor, q: term }), { signal }) })
  const selected = useQuery({ queryKey: ['selected-return-order', value], queryFn: () => api<Order>(`/orders/${value}`), enabled: !!value })
  const label = (row: Order) => `${row.orderNumber} · ${t('Order ID')}: ${row.id} · ${t(row.status)}`
  const invalid = !!value && !!selected.data && selected.data.status !== 'FULFILLED'
  return <div className="product-picker"><Field label="Search fulfilled orders"><input type="search" value={search} placeholder={t('Document number or Order ID')} onChange={event => { setSearch(event.target.value); onChange('') }} /></Field><Field label="Fulfilled order"><select required value={invalid ? '' : value} onChange={event => onChange(event.target.value)}><option value="">{t('Choose fulfilled order')}</option>{selected.data && !query.data?.items.some(row => row.id === value) && selected.data.status === 'FULFILLED' && <option value={value}>{label(selected.data)}</option>}{query.data?.items.map(row => <option key={row.id} value={row.id}>{label(row)}</option>)}</select></Field><Notice error={query.error || selected.error || (invalid ? new Error('The selected order is not fulfilled. Choose a fulfilled order.') : undefined)} />{value && selected.data && <p className="muted">{label(selected.data)}</p>}<div className="button-row"><button type="button" className="button subtle" disabled={!history.length} onClick={() => { setCursor(history.at(-1)!); setHistory(old => old.slice(0,-1)) }}>{t('Previous')}</button><button type="button" className="button subtle" disabled={!query.data?.nextCursor} onClick={() => { setHistory(old => [...old,cursor]); setCursor(query.data!.nextCursor) }}>{t('Next')}</button></div></div>
}
