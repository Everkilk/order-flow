import {t} from '../app/locale'
import type {DemoAccount} from '../app/demo'

const labels={MANAGER:'Manager',STAFF:'Staff',VIEWER:'Viewer'}
const descriptions={MANAGER:'Explore inventory, orders, approvals and reports.',STAFF:'Try warehouse operations and file jobs.',VIEWER:'Browse inventory and reports.'}
export function DemoAccounts({accounts,onChoose,disabled}:{accounts:DemoAccount[];onChoose:(account:DemoAccount)=>void;disabled:boolean}) {
  return <section className="card demo-accounts" aria-labelledby="demo-accounts-title">
    <span className="demo-eyebrow">{t('PUBLIC DEMO')}</span>
    <h2 id="demo-accounts-title">{t('Try OrderFlow')}</h2>
    <p>{t('Choose a role to explore the warehouse workspace.')}</p>
    <table aria-label={t('Demo accounts')}><thead><tr><th scope="col">{t('Role')}</th><th scope="col">{t('Email')}</th><th scope="col">{t('Password')}</th><th scope="col"><span className="sr-only">{t('Sign in')}</span></th></tr></thead>
      <tbody>{accounts.map(account=><tr key={account.role}>
        <th scope="row"><strong>{t(labels[account.role])}</strong><small>{t(descriptions[account.role])}</small></th>
        <td data-label={t('Email')}><code>{account.email}</code></td>
        <td data-label={t('Password')}><code>{account.password}</code></td>
        <td><button type="button" className="button subtle" disabled={disabled} aria-label={t('Use {role} account',{role:t(labels[account.role])})} onClick={()=>onChoose(account)}>{t('Use account')}</button></td>
      </tr>)}</tbody>
    </table>
    <p className="demo-shared-note">{t('Shared sample data. Your changes are visible to other visitors. Account settings are read-only.')}</p>
  </section>
}
