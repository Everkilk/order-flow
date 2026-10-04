import { useRef, useState, type ComponentProps, type FormEvent } from 'react'
import { withSubmissionContext, type SubmissionContext } from '../lib/api'
import { t } from '../app/locale'

type Props = Omit<ComponentProps<'form'>, 'onSubmit'> & { onSubmit?: (event: FormEvent<HTMLFormElement>) => unknown }

export function MutationForm({ onSubmit, children, ...props }: Props) {
  const locked = useRef(false)
  const context = useRef<SubmissionContext>({})
  const [busy, setBusy] = useState(false)
  return <form {...props} aria-busy={busy} onSubmit={async event => {
    if (locked.current) { event.preventDefault(); return }
    locked.current = true; setBusy(true)
    try { await withSubmissionContext(context.current, () => onSubmit?.(event)) }
    finally { locked.current = false; setBusy(false) }
  }}><fieldset className="submission-fields" disabled={busy}>{children}</fieldset>{busy && <span className="muted submission-progress" role="status">{t('Processing…')}</span>}</form>
}
