import { useLayoutEffect } from 'react'
import { Link, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { t } from '../app/locale'
import { navigationEntries } from '../lib/view-state'

const sections: Record<string, [string, string]> = {
  products: ['Products', 'Product details'], receipts: ['Receipts', 'Receipt details'],
  orders: ['Orders', 'Order details'], returns: ['Returns', 'Return details'],
  transfers: ['Transfers', 'Transfer details'], 'stock-requests': ['Approvals', 'Stock request details'],
  stock: ['Stock', ''], movements: ['Movements', ''], reports: ['Reports', ''],
  jobs: ['Imports & exports', ''], references: ['Reference data', ''], users: ['Users', ''],
  notifications: ['Notifications', ''],
}

export function NavigationTrail() {
  const location = useLocation()
  const navigate = useNavigate()
  const type = useNavigationType()
  const index = Number(window.history.state?.idx ?? 0)
  const [section, id] = location.pathname.split('/').filter(Boolean)
  const labels = sections[section]
  const params = new URLSearchParams(location.search)
  const selectedJob = section === 'jobs' && (params.has('import') || params.has('export'))
  const detail = labels && (id ? labels[1] : selectedJob ? params.has('import') ? 'Import review' : 'Export download' : '')
  const fallback = detail ? `/${section}` : '/'
  const previous = navigationEntries.get(index - 1)

  useLayoutEffect(() => {
    const entry = navigationEntries.get(index)
    const wanted = type === 'POP' && entry?.key === location.key ? entry.scroll : 0
    let restoring = wanted > 0
    navigationEntries.set(index, { key: location.key, pathname: location.pathname, search: location.search, scroll: wanted })
    const restore = () => {
      if (!restoring || (document.scrollingElement?.scrollHeight ?? 0) - window.innerHeight >= wanted) {
        window.scrollTo(0, wanted); restoring = false; observer.disconnect()
      }
    }
    // A returning list can mount its loading state before its cached rows appear.
    const observer = new ResizeObserver(restore)
    observer.observe(document.body)
    restore()
    const remember = () => {
      if (restoring) return
      const current = navigationEntries.get(index)
      if (current) current.scroll = window.scrollY
    }
    const stopRestoring = () => { restoring = false; observer.disconnect(); remember() }
    window.addEventListener('scroll', remember, { passive: true })
    window.addEventListener('click', remember, true)
    window.addEventListener('wheel', stopRestoring, { passive: true })
    window.addEventListener('touchmove', stopRestoring, { passive: true })
    return () => { observer.disconnect(); window.removeEventListener('scroll', remember); window.removeEventListener('click', remember, true); window.removeEventListener('wheel', stopRestoring); window.removeEventListener('touchmove', stopRestoring) }
  }, [index, location.key, location.pathname, location.search, type])

  return <div className="navigation-row">
    {location.pathname !== '/' && <button type="button" className="button icon-button back-button" aria-label={t('Back')} title={t('Back')} onClick={() => previous ? navigate(-1) : navigate(fallback)}>←</button>}
    <nav aria-label={t('Breadcrumb')} className="breadcrumbs">
      {detail && <><Link to={`/${section}`}>{t(labels[0])}</Link><span aria-hidden="true">›</span></>}
      <span aria-current="page">{t(detail || (location.pathname === '/' ? 'Overview' : labels?.[0] ?? 'Page not found'))}</span>
    </nav>
  </div>
}
