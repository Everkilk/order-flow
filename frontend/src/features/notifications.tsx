import { dateText } from '../app/locale'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ActionButton, Card, DataTable, Loading, Notice, PageHeading, Pager } from '../components/ui'
import { api, json } from '../lib/api'
import { usePage } from '../lib/queries'
import { useSession } from '../app/session-context'
import { t } from '../app/locale'
import { decimalText, notificationBody } from '../lib/numbers'

type Notification = { id: string; eventClass?: string; title: string; body: string; targetPath: string; createdAt: string; readAt: string | null; titleKey?: string; titleValues?: Record<string,string>; messageKey?: string; messageValues?: Record<string,string> }

function translatedBody(row:Notification) {
  const values={...row.messageValues}
  if(values.amount) values.amount=decimalText(values.amount)
  for(const key of ['status','type']) if(values[key]) values[key]=t(values[key].toUpperCase())
  return row.messageKey ? t(row.messageKey,values) : t(notificationBody(row.eventClass,row.body))
}

function useLiveNotifications() {
  const { user } = useSession()
  const client = useQueryClient()
  useEffect(() => {
    if (!user) return
    let stream: EventSource | undefined
    let polling: ReturnType<typeof setInterval> | undefined
    let failures = 0
    const update = () => { void client.invalidateQueries({ queryKey: ['page', '/notifications'] }); void client.invalidateQueries({ queryKey: ['unread-count'] }); void client.invalidateQueries({ queryKey: ['dashboard'] }) }
    if (typeof EventSource !== 'undefined') {
      stream = new EventSource('/api/notifications/stream', { withCredentials: true })
      stream.addEventListener('notification', update)
      stream.onopen = () => { failures = 0; if (polling) { clearInterval(polling); polling = undefined } }
      stream.onerror = () => { failures++; if (failures >= 3 && !polling) polling = setInterval(update, 30_000) }
    } else polling = setInterval(update, 30_000)
    return () => { stream?.close(); if (polling) clearInterval(polling) }
  }, [user, client])
}

export function NotificationCount() {
  useLiveNotifications()
  const query = useQuery({ queryKey: ['unread-count'], queryFn: () => api<{ count: number }>('/notifications/unread-count') })
  return <Link className="notification-link" to="/notifications" aria-label={t('Notifications')}>{t('Alerts')} {query.data?.count ? <strong>{query.data.count}</strong> : null}</Link>
}

export function Notifications() {
  const query = usePage<Notification>('/notifications')
  const client = useQueryClient()
  const unread = useQuery({ queryKey: ['unread-count'], queryFn: () => api<{ count: number }>('/notifications/unread-count') })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<unknown>()
  const [success, setSuccess] = useState('')
  async function markRead(id: string) {
    if (busy) return
    setBusy(id); setError(undefined); setSuccess('')
    try {
      await api<void>(id === 'all' ? '/notifications/read-all' : `/notifications/${id}/read`, json('POST', {}))
      await Promise.all([
        client.invalidateQueries({ queryKey: ['page', '/notifications'] }),
        client.invalidateQueries({ queryKey: ['unread-count'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ])
      if (id === 'all') setSuccess('All notifications marked as read.')
    } catch (e) { setError(e) } finally { setBusy(null) }
  }
  return <><PageHeading title="Notifications" description="Recent updates and tasks assigned to you." action={<ActionButton className="button subtle" disabled={busy !== null || !unread.data?.count} onClick={() => markRead('all')}>{t(busy === 'all' ? 'Marking as read…' : 'Mark all as read')}</ActionButton>} /><Notice error={error} success={success} /><Card>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['Update', 'When', 'Status']} rows={query.data.items.map(row => [<div><strong>{t(row.titleKey ?? row.title,row.titleValues)}</strong><p>{translatedBody(row)}</p>{row.targetPath.startsWith('/') && !row.targetPath.startsWith('//') && <Link to={row.targetPath} onClick={() => { if (!row.readAt) void markRead(row.id) }}>{t('Open record →')}</Link>}</div>, dateText(row.createdAt), row.readAt ? t('Read') : <ActionButton className="button subtle" disabled={busy !== null} onClick={() => markRead(row.id)}>{t('Mark read')}</ActionButton>])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card></>
}
