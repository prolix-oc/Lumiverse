import type { ImageGenParameterSchema } from '@/types/api'
import styles from './PortraitPane.module.css'

export function ParamField({ paramKey, schema, value, disabled, onChange }: {
  paramKey: string
  schema: ImageGenParameterSchema
  value: any
  disabled?: boolean
  onChange: (v: any) => void
}) {
  const label = paramKey.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
  if (schema.type === 'select') {
    return (
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{label}</span>
        <select className={styles.input} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {(schema.options ?? []).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
    )
  }
  if (schema.type === 'boolean') {
    return (
      <label className={styles.fieldInline}>
        <input type="checkbox" checked={Boolean(value)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className={styles.fieldLabel}>{label}</span>
      </label>
    )
  }
  const isNum = schema.type === 'number' || schema.type === 'integer'
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <input
        className={styles.input}
        type={isNum ? 'number' : 'text'}
        value={value ?? ''}
        min={schema.min}
        max={schema.max}
        step={schema.step}
        disabled={disabled}
        onChange={(e) => onChange(isNum ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
      />
    </label>
  )
}
