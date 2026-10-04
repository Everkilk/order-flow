import { presentNumbers } from './numbers'

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

export type SubmissionContext = { pending?: { signature: string; key: string; uncertain: boolean } }
let currentSubmission: SubmissionContext | undefined
let submissionActor = ''
const recoveryStorage = 'orderflow.submission-recovery'
const recoveryLifetime = 24 * 60 * 60 * 1000
type Recovery = { actor: string; fingerprint: string; key: string; operation: string; createdAt: number }
function recoveries(): Recovery[] {
  try {
    const rows: unknown = JSON.parse(sessionStorage.getItem(recoveryStorage) ?? '[]')
    return Array.isArray(rows) ? rows.filter((row): row is Recovery => row && typeof row.actor === 'string' && typeof row.operation === 'string' && /^[a-f0-9]{64}$/.test(row.fingerprint) && /^[a-f0-9-]{36}$/.test(row.key) && Number.isFinite(row.createdAt) && Date.now() - row.createdAt < recoveryLifetime) : []
  } catch { return [] }
}
function saveRecoveries(rows: Recovery[]) {
  try { sessionStorage.setItem(recoveryStorage, JSON.stringify(rows)) } catch { /* In-memory retries still work when storage is unavailable. */ }
}
export function setSubmissionActor(id: string) { submissionActor = id }
export function pendingRecoveries() { return recoveries().filter(row => row.actor === submissionActor) }
export function forgetRecovery(key: string) { saveRecoveries(recoveries().filter(row => row.key !== key)) }
export function clearSubmissionRecovery() {
  submissionActor = ''
  try { sessionStorage.removeItem(recoveryStorage) } catch { /* Storage can be disabled. */ }
}
async function signatureHash(signature: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
export function withSubmissionContext<T>(context: SubmissionContext, work: () => T): T {
  const previous = currentSubmission; currentSubmission = context
  try { return work() } finally { currentSubmission = previous }
}
const activeMutations = new Map<string, Promise<unknown>>()
async function bodySignature(body: BodyInit | null | undefined) {
  if (!(body instanceof FormData)) return String(body ?? '')
  const values: unknown[] = []
  for (const [name, value] of body.entries()) {
    if (value instanceof File) {
      const hash = await crypto.subtle.digest('SHA-256', await value.arrayBuffer())
      values.push([name, value.name, value.type, [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')])
    } else values.push([name, value])
  }
  return JSON.stringify(values)
}

export function pathWithQuery(path: string, params: Record<string, string | undefined | null>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value)
  return path + (query.size ? `?${query}` : '')
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (options.method && !['GET','HEAD','OPTIONS'].includes(options.method)) {
    const context = currentSubmission
    const signature = options.method + ' ' + path + ' ' + await bodySignature(options.body)
    if (context?.pending?.uncertain && context.pending.signature !== signature)
      throw new ApiError(409, 'SUBMISSION_UNCERTAIN', 'The previous submission may have succeeded. Retry it before changing the form.')
    const headers = new Headers(options.headers)
    const existing = context?.pending
    // Recovery stores no submitted data or credential-derived fingerprint.
    const recoverable = !!submissionActor && !path.startsWith('/auth/')
    const actor = submissionActor
    const operation = options.method + ' ' + path
    let safeBody = await bodySignature(options.body)
    if (typeof options.body === 'string') {
      try { safeBody = JSON.stringify(JSON.parse(options.body), (key, value) => /password/i.test(key) ? '[credential]' : value) } catch { /* Non-JSON bodies have no credential fields. */ }
    }
    const fingerprint = recoverable ? await signatureHash(operation + ' ' + safeBody) : ''
    const prior = recoverable ? recoveries().find(row => row.actor === actor && row.operation === operation) : undefined
    if (prior && prior.fingerprint !== fingerprint) throw new ApiError(409, 'SUBMISSION_UNCERTAIN', 'The previous submission may have succeeded. Retry it before changing the form.')
    const recovery = prior
    const key = existing?.signature === signature ? existing.key : recovery?.key ?? headers.get('Idempotency-Key') ?? commandKey()
    if (!path.startsWith('/auth/')) headers.set('Idempotency-Key', key)
    const pending = { signature, key, uncertain: false }
    if (context) context.pending = pending
    const flight = key + ':' + signature
    if (activeMutations.has(flight)) return activeMutations.get(flight) as Promise<T>
    if (recoverable) saveRecoveries([...recoveries().filter(row => !(row.actor === actor && row.fingerprint === fingerprint)), { actor, fingerprint, key, operation, createdAt: recovery?.createdAt ?? Date.now() }])
    const request = requestApi<T>(path, { ...options, headers })
    activeMutations.set(flight, request)
    try {
      const result = await request
      if (context) context.pending = undefined
      if (recoverable) saveRecoveries(recoveries().filter(row => row.key !== key))
      return result
    } catch (error) {
      pending.uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500
      if (context && !pending.uncertain) context.pending = undefined
      if (recoverable && !pending.uncertain) saveRecoveries(recoveries().filter(row => row.key !== key))
      throw error
    } finally { activeMutations.delete(flight) }
  }
  return requestApi<T>(path, options)
}

async function requestApi<T>(path: string, options: RequestInit): Promise<T> {
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
  return presentNumbers(body) as T
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
