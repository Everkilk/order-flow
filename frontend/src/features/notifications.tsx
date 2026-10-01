import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Card, DataTable, Loading, Notice, PageHeading, Pager } from '../components/ui'
import { api, json } from '../lib/api'
import { usePage } from '../lib/queries'
import { useSession } from '../app/session-context'
import { t } from '../app/locale'

type Notification = { id: string; title: string; body: string; targetPath: string; createdAt: string; readAt: string | null }

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
  async function markRead(id: string) {
    await api<void>(`/notifications/${id}/read`, json('POST', {}))
    await client.invalidateQueries({ queryKey: ['page', '/notifications'] })
    await client.invalidateQueries({ queryKey: ['unread-count'] })
  }
  return <><PageHeading title="Notifications" description="Recent updates and tasks assigned to you." /><Card>{query.isPending ? <Loading /> : query.error ? <Notice error={query.error} /> : <DataTable headers={['Update', 'When', 'Status']} rows={query.data.items.map(row => [<div><strong>{row.title}</strong><p>{row.body}</p>{row.targetPath.startsWith('/') && !row.targetPath.startsWith('//') && <Link to={row.targetPath} onClick={() => { if (!row.readAt) void markRead(row.id) }}>{t('Open record →')}</Link>}</div>, new Date(row.createdAt).toLocaleString(), row.readAt ? t('Read') : <button className="button subtle" onClick={() => void markRead(row.id)}>{t('Mark read')}</button>])} />}<Pager next={query.next} previous={query.previous} onNext={query.forward} onPrevious={query.back} /></Card></>
}
