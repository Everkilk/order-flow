import { Link } from 'react-router-dom'
import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import { withSubmissionContext, type SubmissionContext } from '../lib/api'
import { messageOf } from '../lib/api'
import { t, errorText } from '../app/locale'

export function PageHeading({ title, description, action, translateTitle = true }: { title: string; description?: string; action?: ReactNode; translateTitle?: boolean }) {
  return <div className="page-heading"><div><h1>{translateTitle ? t(title) : title}</h1>{description && <p>{t(description)}</p>}</div>{action}</div>
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

export function Drawer({ title, children }: { title: string; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const element = dialog.current
    if (!element) return
    const previous = document.activeElement
    element.showModal()
    return () => {
      element.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return <dialog ref={dialog} className="card drawer" aria-labelledby={titleId} aria-modal="true" onKeyDown={event => {
    if (event.key !== 'Tab') return
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }} onCancel={event => {
    event.preventDefault()
    // Use the form's close action so Escape respects its unsaved-change guard.
    dialog.current?.querySelector<HTMLButtonElement>('button[data-dialog-close]')?.click()
  }}><div className="drawer-head"><h2 id={titleId}>{t(title)}</h2></div>{children}</dialog>
}

export function Notice({ error, success }: { error?: unknown; success?: string }) {
  if (error) return <div className="notice error" role="alert">{errorText(messageOf(error))}</div>
  if (success) return <div className="notice success" role="status">{t(success)}</div>
  return null
}

export function Loading() { return <div className="state">{t('Loading…')}</div> }
export function Empty({ text = 'No records found.' }: { text?: string }) { return <div className="state">{t(text)}</div> }
export function Badge({ value }: { value?: string | null }) { return <span className={`badge badge-${(value ?? '').toLowerCase()}`}>{value ? t(value) : '—'}</span> }

export function DataTable({ headers, rows, translateHeaders = true }: { headers: string[]; rows: ReactNode[][]; translateHeaders?: boolean }) {
  if (!rows.length) return <Empty />
  return <div className="table-scroll"><table><thead><tr>{headers.map(header => <th key={header}>{translateHeaders ? t(header) : header}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>{cell}</td>)}</tr>)}</tbody></table></div>
}

export function Pager({ next, previous, onNext, onPrevious }: { next: string | null; previous: boolean; onNext: () => void; onPrevious: () => void }) {
  return <div className="pager"><button type="button" className="button subtle" disabled={!previous} onClick={onPrevious}>{t('Previous')}</button><button type="button" className="button subtle" disabled={!next} onClick={onNext}>{t('Next')}</button></div>
}

export function RecordLink({ to, children }: { to: string; children: ReactNode }) { return <Link className="record-link" to={to}>{children}</Link> }

export function ActionButton({ onClick, children, disabled, ...props }: Omit<ComponentProps<'button'>, 'onClick'> & { onClick: () => unknown }) {
  const locked = useRef(false)
  const context = useRef<SubmissionContext>({})
  const [busy, setBusy] = useState(false)
  return <button {...props} type="button" aria-busy={busy} disabled={disabled || busy} onClick={async () => {
    if (locked.current) return
    locked.current = true; setBusy(true)
    try { await withSubmissionContext(context.current, onClick) } finally { locked.current = false; setBusy(false) }
  }}>{busy && !props.className?.includes('icon-button') ? t('Processing…') : children}</button>
}

export function Field({ label, children, translateLabel = true }: { label: string; children: ReactNode; translateLabel?: boolean }) {
  const labelId = useId()
  return <label className="field"><span id={labelId}>{translateLabel ? t(label) : label}</span>{Children.map(children, child => {
    if (!isValidElement<{ 'aria-labelledby'?: string }>(child) || (typeof child.type !== 'function' && !['input', 'select', 'textarea'].includes(String(child.type)))) return child
    return cloneElement(child, { 'aria-labelledby': child.props['aria-labelledby'] ?? labelId })
  })}</label>
}

export function Confirm({ message, onConfirm, disabled, children }: { message: string; onConfirm: () => unknown; disabled?: boolean; children: ReactNode }) {
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)
  const context = useRef<SubmissionContext>({})
  return <button type="button" className="button" disabled={disabled || busy} onClick={async () => {
    if (locked.current || !window.confirm(t(message))) return
    locked.current = true; setBusy(true)
    try { await withSubmissionContext(context.current, onConfirm) } finally { locked.current = false; setBusy(false) }
  }}>{busy ? t('Processing…') : typeof children === 'string' ? t(children) : children}</button>
}
