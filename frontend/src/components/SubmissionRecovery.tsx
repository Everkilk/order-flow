import { useState } from 'react'
import { api, forgetRecovery, pendingRecoveries } from '../lib/api'
import { ActionButton, Notice, RecordLink } from './ui'
import { t } from '../app/locale'

export function SubmissionRecovery() {
  const [rows] = useState(pendingRecoveries)
  const [states, setStates] = useState<Record<string, 'COMMITTED' | 'UNCONFIRMED'>>({})
  const [links, setLinks] = useState<Record<string, string>>({})
  const [error, setError] = useState<unknown>()
  if (!rows.length) return null
  async function check(row: typeof rows[number]) {
    setError(undefined)
    try {
      const outcome = await api<{ state: 'COMMITTED' | 'UNCONFIRMED'; result: { id?: string } | null }>(`/submissions/${row.key}`)
      if (outcome.state === 'COMMITTED') {
        forgetRecovery(row.key)
        const path = row.operation.slice(row.operation.indexOf(' ') + 1)
        const section = path.split('/')[1]
        const supported = ['products','receipts','orders','returns','transfers','stock-requests','exports','imports']
        if (outcome.result?.id && supported.includes(section)) setLinks(old => ({ ...old, [row.key]: section === 'exports' || section === 'imports' ? `/jobs?${section === 'imports' ? 'import' : 'export'}=${outcome.result!.id}` : `/${section}/${outcome.result!.id}` }))
      }
      setStates(old => ({ ...old, [row.key]: outcome.state }))
    } catch (error) { setError(error) }
  }
  return <section className="notice"><p>{t('An earlier submission has an unconfirmed result. Check it before submitting again.')}</p><Notice error={error} />{rows.map(row => <div className="button-row" key={row.key}>{states[row.key] === 'COMMITTED' ? <><span role="status">{t('Previous submission completed. Review it before making another change.')}</span>{links[row.key] && <RecordLink to={links[row.key]}>{t('Open record →')}</RecordLink>}</> : <><ActionButton className="button subtle" onClick={() => check(row)}>{t('Check previous submission')}</ActionButton>{states[row.key] === 'UNCONFIRMED' && <span role="status">{t('The result is still unconfirmed. Return to the form and retry the same values within 24 hours.')}</span>}</>}</div>)}</section>
}
