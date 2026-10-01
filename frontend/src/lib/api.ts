export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export type Page<T> = { items: T[]; nextCursor: string | null }

export function pathWithQuery(path: string, params: Record<string, string | undefined | null>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  return path + (query.size ? `?${query}` : '')
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers)
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Connection failed. Check your network and try again.')
  }
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new ApiError(response.status, 'INVALID_RESPONSE', 'The server returned an unexpected response.')
  }
  const body: unknown = await response.json()
  if (!response.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      window.dispatchEvent(new Event('orderflow:unauthenticated'))
    }
    if (error?.code === 'PASSWORD_CHANGE_REQUIRED') {
      window.dispatchEvent(new Event('orderflow:password-change-required'))
    }
    throw new ApiError(response.status, error?.code ?? 'REQUEST_FAILED', error?.message ?? 'Request failed.')
  }
  return body as T
}

export function json(method: 'POST' | 'PUT' | 'PATCH', body: unknown, key?: string): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    headers: key ? { 'Idempotency-Key': key } : undefined,
  }
}

export function messageOf(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'STALE_REVISION' || error.code === 'STALE_BALANCE') return 'This record changed. Refresh and review it before retrying.'
    return error.message
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export function commandKey() { return crypto.randomUUID() }
