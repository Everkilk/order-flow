/** Decimal display only; storage precision and inventory arithmetic are unchanged. */
export function decimalText(value: string): string {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) return value;
  const trimmed=value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;
  return /^-0+$/.test(trimmed) ? '0' : trimmed;
}
