import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useSession } from '../app/session-context'
import { Card, Loading, Notice, PageHeading } from '../components/ui'
import { api } from '../lib/api'
import { t } from '../app/locale'

type DashboardData = {
  generatedAt: string
  stock: { stockRows: string; outOfStock: string; lowStock: string }
  unreadNotifications: string
  work?: {
    orders: { drafts: string; awaitingFulfillment: string }
    transfers: { awaitingReceipt: string; disputed: string }
    pendingApprovals?: string
    myOpenRequests?: string
  }
  valuation?: { currencyTotals: { currency: string; amount: string }[]; unvaluedStockRows: string }
}

export function Dashboard() {
  const { user } = useSession()
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api<DashboardData>('/dashboard') })
  if (query.isPending) return <Loading />
  if (query.error) return <Notice error={query.error} />
  const data = query.data
  const metrics = [
    ['Stock rows', data.stock.stockRows, '/stock'],
    ['Out of stock', data.stock.outOfStock, '/stock?availability=OUT_OF_STOCK'],
    ['Low stock', data.stock.lowStock, '/reports'],
    ['Unread alerts', data.unreadNotifications, '/notifications'],
  ]
  return <><PageHeading title={`${t('Good day')}, ${user?.displayName.split(' ')[0] ?? t('team')}`} description="Here is what is happening across your warehouse." /><div className="metric-grid">{metrics.map(([label, value, path]) => <Link className="metric" key={label} to={path}><span>{t(label)}</span><strong>{value}</strong><small>{t('View details →')}</small></Link>)}</div>{data.work && <div className="grid-two"><Card><h2>{t('Orders')}</h2><div className="summary-row"><span>{t('Drafts')}</span><strong>{data.work.orders.drafts}</strong></div><div className="summary-row"><span>{t('Awaiting fulfillment')}</span><strong>{data.work.orders.awaitingFulfillment}</strong></div><Link to="/orders">{t('Open orders →')}</Link></Card><Card><h2>{t('Transfers & review')}</h2><div className="summary-row"><span>{t('Awaiting receipt')}</span><strong>{data.work.transfers.awaitingReceipt}</strong></div><div className="summary-row"><span>{t('Disputed')}</span><strong>{data.work.transfers.disputed}</strong></div><div className="summary-row"><span>{t(user?.role === 'MANAGER' ? 'Pending approvals' : 'My open requests')}</span><strong>{data.work.pendingApprovals ?? data.work.myOpenRequests}</strong></div><Link to="/transfers">{t('Open transfers →')}</Link></Card></div>}{data.valuation && <Card><h2>{t('Stock valuation')}</h2><p className="muted">{t('Current on-hand stock at primary supplier cost, shown by currency.')}</p>{data.valuation.currencyTotals.map(row => <div className="summary-row" key={row.currency}><span>{row.currency}</span><strong>{row.amount}</strong></div>)}<div className="summary-row"><span>{t('Stock rows without a cost')}</span><strong>{data.valuation.unvaluedStockRows}</strong></div></Card>}</>
}
