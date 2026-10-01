import { createContext, useContext } from 'react'

export type User = {
  id: string
  email: string
  displayName: string
  role: 'MANAGER' | 'STAFF' | 'VIEWER'
  warehouses?: string[]
  mustChangePassword: boolean
}

export type Session = {
  user: User | null
  loading: boolean
  refresh: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

export const SessionContext = createContext<Session | null>(null)

export function useSession() {
  const session = useContext(SessionContext)
  if (!session) throw new Error('SessionProvider is missing')
  return session
}
