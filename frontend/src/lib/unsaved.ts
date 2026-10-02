import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { useBlocker } from 'react-router-dom'
import { t } from '../app/locale'

const drafts = new Set<object>()
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export function confirmDiscard() { return drafts.size === 0 || window.confirm(t('Discard unsaved changes?')) }

export function useUnsavedNavigation() {
  const dirty = useSyncExternalStore(subscribe, () => drafts.size > 0)
  const prompted = useRef<string | null>(null)
  // Filters and selected jobs update the URL without unmounting their forms.
  // Guard leaving the page; same-page browsing keeps the actual dirty fields intact.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname)
  useEffect(() => {
    if (blocker.state !== 'blocked') { prompted.current = null; return }
    if (prompted.current === blocker.location.key) return
    prompted.current = blocker.location.key
    if (confirmDiscard()) blocker.proceed()
    else blocker.reset()
  }, [blocker])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!drafts.size) return
      event.preventDefault(); event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])
}

export function useUnsavedDraft() {
  const token = useRef<object>({})
  useEffect(() => { const id = token.current; return () => { drafts.delete(id); notify() } }, [])
  const markDirty = useCallback(() => { drafts.add(token.current); notify() }, [])
  const markClean = useCallback(() => { drafts.delete(token.current); notify() }, [])
  const confirmClose = useCallback(() => !drafts.has(token.current) || window.confirm(t('Discard unsaved changes?')), [])
  return { markDirty, markClean, confirmClose }
}
