import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { SessionContext, type User } from './session-context'
import { clearNavigation } from '../lib/view-state'

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const client = useQueryClient()
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ user: User }>('/auth/me')
      setUser(result.user)
    } catch {
      setUser(null)
      client.clear()
      clearNavigation()
    } finally { setLoading(false) }
  }, [client])
  useEffect(() => {
    void api<{ user: User }>('/auth/me').then(result => setUser(result.user)).catch(() => {
      setUser(null)
      client.clear()
      clearNavigation()
    }).finally(() => setLoading(false))
  }, [client])
  useEffect(() => {
    const expired = () => { setUser(null); client.clear(); clearNavigation() }
    const changed = () => { void refresh() }
    window.addEventListener('orderflow:unauthenticated', expired)
    window.addEventListener('orderflow:password-change-required', changed)
    return () => {
      window.removeEventListener('orderflow:unauthenticated', expired)
      window.removeEventListener('orderflow:password-change-required', changed)
    }
  }, [client, refresh])
  async function login(email: string, password: string) {
    const result = await api<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }), headers: { 'Content-Type': 'application/json' } })
    client.clear()
    clearNavigation()
    setUser(result.user)
  }
  async function logout() {
    try { await api<void>('/auth/logout', { method: 'POST' }) }
    finally { client.clear(); clearNavigation(); setUser(null) }
  }
  return <SessionContext.Provider value={{ user, loading, refresh, login, logout }}>{children}</SessionContext.Provider>
}
