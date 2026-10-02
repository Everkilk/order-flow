import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter, createRoutesFromElements, Navigate, NavLink, Outlet, Route, RouterProvider, useNavigate, useParams } from 'react-router-dom'
import { useState, type FormEvent, type ReactNode } from 'react'
import { SessionProvider } from './app/session'
import { useSession } from './app/session-context'
import { Card, Loading, Notice } from './components/ui'
import { Dashboard } from './features/dashboard'
import { Products, ProductDetail } from './features/products'
import { Stock, Movements } from './features/stock'
import { DocumentList, DocumentDetail } from './features/documents'
import { StockRequests, StockRequestDetail } from './features/approvals'
import { References } from './features/references'
import { Reports } from './features/reports'
import { Jobs } from './features/jobs'
import { Notifications, NotificationCount } from './features/notifications'
import { Users } from './features/users'
import { api, json } from './lib/api'
import { getLocale, setLocale, t } from './app/locale'
import { NavigationTrail } from './components/NavigationTrail'
import { confirmDiscard, useUnsavedNavigation } from './lib/unsaved'
import './App.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 15_000, refetchOnWindowFocus: false } } })

function Login() {
  const { login } = useSession()
  const [passwordChanged] = useState(() => {
    const changed = window.sessionStorage.getItem('orderflow.passwordChanged') === '1'
    window.sessionStorage.removeItem('orderflow.passwordChanged')
    return changed
  })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(undefined)
    try { await login(email, password) } catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <div className="auth-page"><Card className="auth-card"><div className="auth-locale"><LocaleSelect /></div><div className="brand auth-brand"><img className="brand-logo" src="/logo.png" alt="" /><span>OrderFlow</span></div><h1>{t('Welcome back')}</h1><p>{t('Sign in to manage your warehouse.')}</p><form onSubmit={submit}><label className="field"><span>{t('Email')}</span><input type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label><label className="field"><span>{t('Password')}</span><input type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label><Notice error={error} success={passwordChanged ? 'Password changed. Please sign in again.' : undefined} /><button className="button primary full" disabled={busy}>{t(busy ? 'Signing in…' : 'Sign in')}</button></form></Card></div>
}

function ChangePassword() {
  const { user, refresh } = useSession()
  const [currentPassword, setCurrent] = useState('')
  const [newPassword, setNext] = useState('')
  const [error, setError] = useState<unknown>()
  if (!user) return <Login />
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(undefined)
    try {
      await api<void>('/auth/change-password', json('POST', { currentPassword, newPassword }))
      window.sessionStorage.setItem('orderflow.passwordChanged', '1')
      await refresh()
    } catch (e) { setError(e) }
  }
  return <div className="auth-page"><Card className="auth-card"><div className="auth-locale"><LocaleSelect /></div><h1>{t('Change password')}</h1><p>{t('Your new password must have at least 12 characters.')}</p><form onSubmit={submit}><label className="field"><span>{t('Current password')}</span><input type="password" required value={currentPassword} onChange={event => setCurrent(event.target.value)} /></label><label className="field"><span>{t('New password')}</span><input type="password" minLength={12} required value={newPassword} onChange={event => setNext(event.target.value)} /></label><Notice error={error} /><button className="button primary full">{t('Change password')}</button></form></Card></div>
}

function LocaleSelect() {
  return <select className="locale-select" aria-label="Language" value={getLocale()} onChange={event => setLocale(event.target.value as 'en' | 'vi')}>
    <option value="en">English</option><option value="vi">Tiếng Việt</option>
  </select>
}

type NavItem = { to: string; label: string; roles?: string[] }
const nav: NavItem[] = [
  { to: '/', label: 'Overview' }, { to: '/products', label: 'Products' }, { to: '/stock', label: 'Stock' },
  { to: '/receipts', label: 'Receipts', roles: ['MANAGER', 'STAFF'] },
  { to: '/orders', label: 'Orders', roles: ['MANAGER', 'STAFF'] },
  { to: '/returns', label: 'Returns', roles: ['MANAGER', 'STAFF'] },
  { to: '/transfers', label: 'Transfers', roles: ['MANAGER', 'STAFF'] },
  { to: '/stock-requests', label: 'Approvals', roles: ['MANAGER', 'STAFF'] },
  { to: '/movements', label: 'Movements', roles: ['MANAGER', 'STAFF'] },
  { to: '/reports', label: 'Reports' },
  { to: '/jobs', label: 'Imports & exports', roles: ['MANAGER', 'STAFF'] },
  { to: '/references', label: 'Reference data', roles: ['MANAGER'] },
  { to: '/users', label: 'Users', roles: ['MANAGER'] },
]

function Shell() {
  useUnsavedNavigation()
  const [signingOut, setSigningOut] = useState(false)
  const { user, logout } = useSession()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  if (!user) return null
  return <div className="shell"><aside className={`sidebar ${menuOpen ? 'open' : ''}`}><button type="button" className="button icon-button menu-close" aria-label={t('Close menu')} onClick={() => setMenuOpen(false)}>×</button><div className="brand"><img className="brand-logo" src="/logo.png" alt="" /><span>OrderFlow</span></div><div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{nav.filter(item => !item.roles || item.roles.includes(user.role)).map(item => <NavLink key={item.to} end={item.to === '/'} to={item.to} onClick={() => setMenuOpen(false)} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>{t(item.label)}</NavLink>)}</nav><div className="sidebar-footer"><span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span><div className="account-name"><strong>{user.displayName}</strong><small>{user.role.toLowerCase()}</small></div><button type="button" className="button icon-button sign-out-button" aria-label={t('Sign out')} title={t('Sign out')} disabled={signingOut} onClick={async () => { if (signingOut || !confirmDiscard()) return; setSigningOut(true); try { await logout() } finally { navigate('/'); setSigningOut(false) } }}><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M9 5H4v14h5M14 8l4 4-4 4M8 12h10" /></svg></button></div></aside><div className="main-area"><header className="topbar"><button type="button" className="menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">☰</button><span className="topbar-title">{t('Warehouse management')}</span><div className="top-actions"><LocaleSelect /><NotificationCount /></div></header><NavigationTrail /><main><Outlet /></main></div></div>
}

function AuthGate({ children, roles }: { children: ReactNode; roles?: string[] }) {
  const { user, loading } = useSession()
  if (loading) return <Loading />
  if (!user) return <Login />
  if (user.mustChangePassword) return <ChangePassword />
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />
  return children
}

function ProtectedShell() { return <AuthGate><Shell /></AuthGate> }
function Restricted({ roles, children }: { roles: string[]; children: ReactNode }) { return <AuthGate roles={roles}>{children}</AuthGate> }
const staff = ['MANAGER', 'STAFF']

function JobDeepLink({ kind }: { kind: 'import' | 'export' }) {
  const { id } = useParams()
  return <Navigate to={`/jobs?${kind}=${encodeURIComponent(id ?? '')}`} replace />
}

const router = createBrowserRouter(createRoutesFromElements(
  <Route element={<ProtectedShell />}>
    <Route index element={<Dashboard />} />
    <Route path="products" element={<Products />} />
    <Route path="products/:id" element={<ProductDetail />} />
    <Route path="stock" element={<Stock />} />
    <Route path="receipts" element={<Restricted roles={staff}><DocumentList kind="receipts" /></Restricted>} />
    <Route path="receipts/:id" element={<Restricted roles={staff}><DocumentDetail kind="receipts" /></Restricted>} />
    <Route path="orders" element={<Restricted roles={staff}><DocumentList kind="orders" /></Restricted>} />
    <Route path="orders/:id" element={<Restricted roles={staff}><DocumentDetail kind="orders" /></Restricted>} />
    <Route path="returns" element={<Restricted roles={staff}><DocumentList kind="returns" /></Restricted>} />
    <Route path="returns/:id" element={<Restricted roles={staff}><DocumentDetail kind="returns" /></Restricted>} />
    <Route path="transfers" element={<Restricted roles={staff}><DocumentList kind="transfers" /></Restricted>} />
    <Route path="transfers/:id" element={<Restricted roles={staff}><DocumentDetail kind="transfers" /></Restricted>} />
    <Route path="stock-requests" element={<Restricted roles={staff}><StockRequests /></Restricted>} />
    <Route path="stock-requests/:id" element={<Restricted roles={staff}><StockRequestDetail /></Restricted>} />
    <Route path="movements" element={<Restricted roles={staff}><Movements /></Restricted>} />
    <Route path="reports" element={<Reports />} />
    <Route path="jobs" element={<Restricted roles={staff}><Jobs /></Restricted>} />
    <Route path="imports/:id" element={<Restricted roles={staff}><JobDeepLink kind="import" /></Restricted>} />
    <Route path="exports/:id" element={<Restricted roles={staff}><JobDeepLink kind="export" /></Restricted>} />
    <Route path="references" element={<Restricted roles={['MANAGER']}><References /></Restricted>} />
    <Route path="users" element={<Restricted roles={['MANAGER']}><Users /></Restricted>} />
    <Route path="notifications" element={<Notifications />} />
    <Route path="*" element={<Card><h1>{t('Page not found')}</h1><p>{t('Check the address or choose a page from the menu.')}</p></Card>} />
  </Route>,
))

export default function App() {
  return <QueryClientProvider client={queryClient}><SessionProvider><RouterProvider router={router} /></SessionProvider></QueryClientProvider>
}
