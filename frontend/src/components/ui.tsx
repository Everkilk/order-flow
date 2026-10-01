import { Link } from 'react-router-dom'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { messageOf } from '../lib/api'
import { t } from '../app/locale'

export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><h1>{t(title)}</h1>{description && <p>{t(description)}</p>}</div>{action}</div>
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
  if (error) return <div className="notice error" role="alert">{t(messageOf(error))}</div>
  if (success) return <div className="notice success" role="status">{t(success)}</div>
  return null
}

export function Loading() { return <div className="state">{t('Loading…')}</div> }
export function Empty({ text = 'No records found.' }: { text?: string }) { return <div className="state">{t(text)}</div> }
export function Badge({ value }: { value?: string | null }) { return <span className={`badge badge-${(value ?? '').toLowerCase()}`}>{value ? t(value) : '—'}</span> }

export function DataTable({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  if (!rows.length) return <Empty />
  return <div className="table-scroll"><table><thead><tr>{headers.map(header => <th key={header}>{t(header)}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i}>{typeof cell === 'string' ? t(cell) : cell}</td>)}</tr>)}</tbody></table></div>
}

export function Pager({ next, previous, onNext, onPrevious }: { next: string | null; previous: boolean; onNext: () => void; onPrevious: () => void }) {
  return <div className="pager"><button type="button" className="button subtle" disabled={!previous} onClick={onPrevious}>{t('Previous')}</button><button type="button" className="button subtle" disabled={!next} onClick={onNext}>{t('Next')}</button></div>
}

export function RecordLink({ to, children }: { to: string; children: ReactNode }) { return <Link className="record-link" to={to}>{children}</Link> }

export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="field"><span>{t(label)}</span>{children}</label> }

export function Confirm({ message, onConfirm, disabled, children }: { message: string; onConfirm: () => void; disabled?: boolean; children: ReactNode }) {
  return <button type="button" className="button" disabled={disabled} onClick={() => { if (window.confirm(t(message))) onConfirm() }}>{typeof children === 'string' ? t(children) : children}</button>
}
