import { t } from '../app/locale'
import { useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Card, DataTable, Field, Loading, Notice, PageHeading, Pager } from '../components/ui'
import { api, json } from '../lib/api'
import { useOptions, usePage } from '../lib/queries'

type UserRow = { id: string; email: string; displayName: string; role: 'MANAGER' | 'STAFF' | 'VIEWER'; active: boolean }
type Warehouse = { id: string; code: string; name: string }

export function Users() {
  const query = usePage<UserRow>('/users')
  const client = useQueryClient()
  const warehouses = useOptions<Warehouse>('/warehouses')
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<UserRow['role']>('STAFF')
  const [password, setPassword] = useState('')
  const [selected, setSelected] = useState<UserRow | null>(null)
  const [selectedWarehouses, setSelectedWarehouses] = useState<string[]>([])
  const [temporaryPassword, setTemporaryPassword] = useState('')
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  async function create(event: FormEvent) {
    event.preventDefault(); setError(undefined); setSuccess('')
    try {
      await api('/users', json('POST', { email, displayName, role, password }))
      setEmail(''); setDisplayName(''); setPassword(''); setSuccess('User created. Assign warehouses before they start work.')
      await client.invalidateQueries({ queryKey: ['page', '/users'] })
    } catch (e) { setError(e) }
  }
  async function open(row: UserRow) {
    setSelected(row); setError(undefined); setSuccess(''); setTemporaryPassword('')
    try {
      const detail = await api<UserRow & { warehouseIds: string[] }>(`/users/${row.id}`)
      setSelectedWarehouses(detail.warehouseIds)
    } catch (e) { setError(e) }
  }
  async function update(body: Partial<UserRow>) {
    if (!selected) return
    try {
      await api<void>(`/users/${selected.id}`, json('PATCH', body))
      setSelected(old => old ? { ...old, ...body } : old)
      setSuccess('User updated.')
      await client.invalidateQueries({ queryKey: ['page', '/users'] })
    } catch (e) { setError(e) }
  }
  async function saveWarehouses() {
    if (!selected) return
    try { await api<void>(`/users/${selected.id}/warehouses`, json('PUT', { warehouseIds: selectedWarehouses })); setSuccess('Warehouse access updated.') } catch (e) { setError(e) }
  }
  async function resetPassword() {
    if (!selected) return
    try { await api<void>(`/users/${selected.id}/reset-password`, json('POST', { temporaryPassword })); setTemporaryPassword(''); setSuccess('Temporary password set. Share it privately with the user.') } catch (e) { setError(e) }
  }
  return <><PageHeading title="Users" description="Manage access and warehouse assignments." /><div className="grid-two"><Card><h2>{t("Accounts")}</h2>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['Name', 'Email', 'Role', 'Status']} rows={query.data.items.map(row => [<button className="link-button" onClick={() => void open(row)}>{row.displayName}</button>, row.email, row.role, row.active ? 'Active' : 'Inactive'])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card><Card><h2>{selected ? `Manage ${selected.displayName}` : 'New user'}</h2><Notice error={error} success={success} />{selected ? <div className="stack"><Field label="Display name"><input value={selected.displayName} onChange={event => setSelected(old => old ? { ...old, displayName: event.target.value } : old)} /></Field><Field label="Role"><select value={selected.role} onChange={event => setSelected(old => old ? { ...old, role: event.target.value as UserRow['role'] } : old)}><option value={"MANAGER"}>{t("MANAGER")}</option><option value={"STAFF"}>{t("STAFF")}</option><option value={"VIEWER"}>{t("VIEWER")}</option></select></Field><button className="button primary" onClick={() => void update({ displayName: selected.displayName, role: selected.role })}>{t("Save user")}</button><div className="button-row"><button className="button" onClick={() => void update({ active: !selected.active })}>{selected.active ? 'Deactivate' : 'Activate'}</button><button className="button subtle" onClick={() => setSelected(null)}>{t("Close")}</button></div><h3>{t("Warehouse access")}</h3>{warehouses.data?.items.map(row => <label className="check-row" key={row.id}><input type="checkbox" checked={selectedWarehouses.includes(row.id)} onChange={event => setSelectedWarehouses(old => event.target.checked ? [...old, row.id] : old.filter(id => id !== row.id))} />{row.code} — {row.name}</label>)}<button className="button primary" onClick={() => void saveWarehouses()}>{t("Save warehouses")}</button><h3>{t("Reset password")}</h3><Field label="Temporary password"><input type="password" minLength={12} value={temporaryPassword} onChange={event => setTemporaryPassword(event.target.value)} /></Field><button className="button" disabled={temporaryPassword.length < 12} onClick={() => void resetPassword()}>{t("Reset password")}</button></div> : <form className="stack" onSubmit={create}><Field label="Name"><input required value={displayName} onChange={event => setDisplayName(event.target.value)} /></Field><Field label="Email"><input type="email" required value={email} onChange={event => setEmail(event.target.value)} /></Field><Field label="Role"><select value={role} onChange={event => setRole(event.target.value as UserRow['role'])}><option value={"STAFF"}>{t("STAFF")}</option><option value={"VIEWER"}>{t("VIEWER")}</option><option value={"MANAGER"}>{t("MANAGER")}</option></select></Field><Field label="Initial password"><input type="password" required minLength={12} value={password} onChange={event => setPassword(event.target.value)} /></Field><button className="button primary">{t("Create user")}</button></form>}</Card></div></>
}
