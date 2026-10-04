import { RecordLink } from './ui'
import { t } from '../app/locale'

export function ProductReference({ id, sku, name }: { id?: string | null; sku?: string | null; name?: string | null }) {
  if (!id) return <span>—</span>
  return <RecordLink to={`/products/${id}`}><span className="product-reference"><span>{name || sku || `${t('Product')} #${id}`}</span>{name && sku && <small>{sku}</small>}</span></RecordLink>
}
