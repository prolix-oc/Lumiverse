import { useCallback, useEffect, useRef, useState } from 'react'
import type { ComfyUIFieldMapping, ComfyUIMappedFieldSemantic } from '../../../../api/dream-weaver'
import styles from './MappedFieldsForm.module.css'

export interface MappedFieldValues {
  positive_prompt?: string
  negative_prompt?: string
  seed?: number
  steps?: number
  cfg?: number
  sampler_name?: string
  scheduler?: string
  width?: number
  height?: number
  checkpoint?: string
  custom?: Record<string, unknown>
}

export interface MappedFieldsFormProps {
  mappings: ComfyUIFieldMapping[]
  values: MappedFieldValues
  onChange: (next: MappedFieldValues) => void
  onGenerate: () => void
  generating: boolean
}

interface NumericInputProps {
  value: number | undefined
  onChange: (next: number | undefined) => void
  step?: number
  className?: string
}

function NumericInput({ value, onChange, step, className }: NumericInputProps) {
  const [text, setText] = useState(() => (value != null ? String(value) : ''))
  const lastCommittedRef = useRef(value)

  useEffect(() => {
    if (value !== lastCommittedRef.current) {
      lastCommittedRef.current = value
      setText(value != null ? String(value) : '')
    }
  }, [value])

  const commit = useCallback(() => {
    const trimmed = text.trim()
    if (trimmed === '') {
      lastCommittedRef.current = undefined
      onChange(undefined)
      return
    }
    const n = Number(trimmed)
    if (!Number.isNaN(n)) {
      lastCommittedRef.current = n
      onChange(n)
    } else {
      setText(lastCommittedRef.current != null ? String(lastCommittedRef.current) : '')
    }
  }, [text, onChange])

  return (
    <input
      type="text"
      inputMode="decimal"
      className={className}
      value={text}
      step={step}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
    />
  )
}

export function MappedFieldsForm(props: MappedFieldsFormProps) {
  const [collapsed, setCollapsed] = useState(false)

  const uniqueSemantics = new Set<ComfyUIMappedFieldSemantic>()
  for (const mapping of props.mappings) uniqueSemantics.add(mapping.mappedAs)

  function updateField<K extends keyof MappedFieldValues>(key: K, value: MappedFieldValues[K]) {
    props.onChange({ ...props.values, [key]: value })
  }

  if (collapsed) {
    return (
      <div className={styles.collapsedBar}>
        <button
          type="button"
          className={styles.toggleButton}
          onClick={() => setCollapsed(false)}
        >
          Show Mapped Fields ({props.mappings.length})
        </button>
        <button
          type="button"
          className={styles.generateButton}
          onClick={props.onGenerate}
          disabled={props.generating}
        >
          {props.generating ? 'Generating...' : 'Generate'}
        </button>
      </div>
    )
  }

  return (
    <div className={styles.bar}>
      <div className={styles.barHeader}>
        <button
          type="button"
          className={styles.toggleButton}
          onClick={() => setCollapsed(true)}
        >
          Hide Mapped Fields
        </button>
        <span className={styles.fieldCount}>{props.mappings.length} fields mapped</span>
      </div>
      <div className={styles.fieldGrid}>
        {uniqueSemantics.has('positive_prompt') && (
          <div className={`${styles.fieldBlock} ${styles.fieldBlockWide}`}>
            <label className={styles.label}>Positive Prompt</label>
            <textarea
              className={styles.textarea}
              rows={2}
              value={props.values.positive_prompt ?? ''}
              onChange={(e) => updateField('positive_prompt', e.target.value)}
            />
          </div>
        )}
        {uniqueSemantics.has('negative_prompt') && (
          <div className={`${styles.fieldBlock} ${styles.fieldBlockWide}`}>
            <label className={styles.label}>Negative Prompt</label>
            <textarea
              className={styles.textarea}
              rows={2}
              value={props.values.negative_prompt ?? ''}
              onChange={(e) => updateField('negative_prompt', e.target.value)}
            />
          </div>
        )}
        {uniqueSemantics.has('seed') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>Seed</label>
            <NumericInput
              className={styles.input}
              value={props.values.seed}
              onChange={(v) => updateField('seed', v)}
            />
          </div>
        )}
        {uniqueSemantics.has('steps') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>Steps</label>
            <NumericInput
              className={styles.input}
              value={props.values.steps}
              onChange={(v) => updateField('steps', v)}
            />
          </div>
        )}
        {uniqueSemantics.has('cfg') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>CFG</label>
            <NumericInput
              className={styles.input}
              value={props.values.cfg}
              onChange={(v) => updateField('cfg', v)}
              step={0.1}
            />
          </div>
        )}
        {uniqueSemantics.has('width') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>Width</label>
            <NumericInput
              className={styles.input}
              value={props.values.width}
              onChange={(v) => updateField('width', v)}
            />
          </div>
        )}
        {uniqueSemantics.has('height') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>Height</label>
            <NumericInput
              className={styles.input}
              value={props.values.height}
              onChange={(v) => updateField('height', v)}
            />
          </div>
        )}
        {uniqueSemantics.has('sampler_name') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>Sampler</label>
            <input
              className={styles.input}
              value={props.values.sampler_name ?? ''}
              onChange={(e) => updateField('sampler_name', e.target.value || undefined)}
            />
          </div>
        )}
        {uniqueSemantics.has('scheduler') && (
          <div className={styles.fieldBlock}>
            <label className={styles.label}>Scheduler</label>
            <input
              className={styles.input}
              value={props.values.scheduler ?? ''}
              onChange={(e) => updateField('scheduler', e.target.value || undefined)}
            />
          </div>
        )}
        <div className={styles.generateBlock}>
          <button
            type="button"
            className={styles.generateButton}
            onClick={props.onGenerate}
            disabled={props.generating}
          >
            {props.generating ? 'Generating...' : 'Generate'}
          </button>
        </div>
      </div>
    </div>
  )
}
