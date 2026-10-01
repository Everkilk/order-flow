import { useCallback, useEffect, useRef, useState } from 'react'
import { useBlocker } from 'react-router-dom'
import { t } from '../app/locale'

export function useUnsavedDraft() {
  const dirty = useRef(false)
  const promptedLocationKey = useRef<string | null>(null)
  const [, setVersion] = useState(0)
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty.current && (
      currentLocation.pathname !== nextLocation.pathname ||
      currentLocation.search !== nextLocation.search ||
      currentLocation.hash !== nextLocation.hash
    ))

  useEffect(() => {
    if (blocker.state !== 'blocked') { promptedLocationKey.current = null; return }
    if (promptedLocationKey.current === blocker.location.key) return
    promptedLocationKey.current = blocker.location.key
    if (window.confirm(t('Discard unsaved changes?'))) blocker.proceed()
    else blocker.reset()
  }, [blocker])

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty.current) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const markDirty = useCallback(() => { dirty.current = true; setVersion(value => value + 1) }, [])
  const markClean = useCallback(() => { dirty.current = false; setVersion(value => value + 1) }, [])
  const confirmClose = useCallback(() => !dirty.current || window.confirm(t('Discard unsaved changes?')), [])
  return { markDirty, markClean, confirmClose }
}
