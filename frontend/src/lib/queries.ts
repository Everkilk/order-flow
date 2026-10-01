import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, pathWithQuery, type Page } from './api'

export function usePage<T>(path: string, filters: Record<string, string | undefined | null> = {}) {
  const filterKey = JSON.stringify(filters)
  const [page, setPage] = useState<{ key: string; cursor: string | null; history: (string | null)[] }>({ key: filterKey, cursor: null, history: [] })
  const active = page.key === filterKey ? page : { key: filterKey, cursor: null, history: [] }
  const query = useQuery({
    queryKey: ['page', path, filterKey, active.cursor],
    queryFn: ({ signal }) => api<Page<T>>(pathWithQuery(path, { ...filters, cursor: active.cursor, limit: '25' }), { signal }),
  })
  return {
    ...query,
    previous: active.history.length > 0,
    next: query.data?.nextCursor ?? null,
    forward: () => { if (query.data?.nextCursor) setPage({ key: filterKey, cursor: query.data.nextCursor, history: [...active.history, active.cursor] }) },
    back: () => { if (active.history.length) setPage({ key: filterKey, cursor: active.history[active.history.length - 1], history: active.history.slice(0, -1) }) },
  }
}

export function useOptions<T>(path: string) {
  return useQuery({ queryKey: ['options', path], queryFn: () => api<{ items: T[] }>(path), staleTime: 60_000 })
}
