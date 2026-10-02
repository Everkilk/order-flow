import { useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'
import { useLocation } from 'react-router-dom'

const values = new Map<string, unknown>()
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const notify = () => listeners.forEach(listener => listener())
export function clearViewState() { values.clear(); notify() }

/** Memory only; a history entry owns its filters and pagers, never passwords or dirty inputs. */
export function useViewState<T>(name: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const location = useLocation()
  const [fallback] = useState(initial)
  const entryKey = typeof location.state?.viewKey === 'string' ? location.state.viewKey : location.key
  const key = `${entryKey}:${location.pathname}:${name}`
  const value = useSyncExternalStore(subscribe, () => values.has(key) ? values.get(key) as T : fallback)
  const set: Dispatch<SetStateAction<T>> = next => {
    const old = values.has(key) ? values.get(key) as T : fallback
    values.set(key, typeof next === 'function' ? (next as (previous: T) => T)(old) : next)
    notify()
  }
  return [value, set]
}

export const navigationEntries = new Map<number, { key: string; pathname: string; search: string; scroll: number }>()
export function clearNavigation() { navigationEntries.clear(); clearViewState() }
