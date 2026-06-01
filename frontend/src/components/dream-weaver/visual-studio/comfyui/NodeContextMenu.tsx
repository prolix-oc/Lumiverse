import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import type {
  ComfyUIFieldMapping,
  ComfyUIMappedFieldSemantic,
} from '../../../../api/dream-weaver'
import styles from './NodeContextMenu.module.css'

export interface NodeContextMenuProps {
  nodeId: string
  classType: string
  availableFields: Array<{ fieldName: string; currentValue: unknown }>
  nodeMappings: ComfyUIFieldMapping[]
  anchor: { x: number; y: number }
  onToggleField: (fieldName: string, mappedAs: ComfyUIMappedFieldSemantic | null) => void
  onClose: () => void
}

const SEMANTIC_VALUES: ComfyUIMappedFieldSemantic[] = [
  'positive_prompt',
  'negative_prompt',
  'seed',
  'steps',
  'cfg',
  'sampler_name',
  'scheduler',
  'width',
  'height',
  'checkpoint',
  'init_image',
  'denoise',
  'custom',
]

export function NodeContextMenu(props: NodeContextMenuProps) {
  const { t } = useTranslation('dreamWeaver')
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState(props.anchor)

  useEffect(() => {
    setPosition(props.anchor)
  }, [props.anchor])

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return

    const margin = 12
    const rect = element.getBoundingClientRect()
    const maxLeft = window.innerWidth - rect.width - margin
    const maxTop = window.innerHeight - rect.height - margin

    setPosition({
      x: Math.max(margin, Math.min(props.anchor.x, maxLeft)),
      y: Math.max(margin, Math.min(props.anchor.y, maxTop)),
    })
  }, [props.anchor])

  useEffect(() => {
    function handleClickOutside(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        props.onClose()
      }
    }
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') props.onClose()
    }
    document.addEventListener('pointerdown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [props])

  function getCurrentMapping(fieldName: string): ComfyUIFieldMapping | undefined {
    return props.nodeMappings.find((m) => m.fieldName === fieldName)
  }

  return createPortal(
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: position.x, top: position.y }}
      role="menu"
    >
      <div className={styles.header}>
        <div className={styles.classType}>{props.classType}</div>
        <div className={styles.nodeId}>{t('comfyui.nodeMenu.nodeId', { id: props.nodeId })}</div>
      </div>
      <div className={styles.fields}>
        {props.availableFields.map((field) => {
          const mapping = getCurrentMapping(field.fieldName)
          return (
            <div key={field.fieldName} className={styles.field}>
              <div className={styles.fieldRow}>
                <span className={styles.fieldName}>{field.fieldName}</span>
                <span className={styles.fieldValue}>{String(field.currentValue).slice(0, 40)}</span>
              </div>
              <select
                className={styles.select}
                value={mapping?.mappedAs ?? ''}
                onChange={(e) => {
                  const value = e.target.value as ComfyUIMappedFieldSemantic | ''
                  props.onToggleField(field.fieldName, value === '' ? null : value)
                }}
              >
                <option value="">{t('comfyui.nodeMenu.notMapped')}</option>
                {SEMANTIC_VALUES.map((semantic) => (
                  <option key={semantic} value={semantic}>
                    {t(`comfyui.nodeMenu.semantics.${semantic}`)}
                  </option>
                ))}
              </select>
              {mapping?.autoDetected && (
                <div className={styles.autoDetectedHint}>{t('comfyui.nodeMenu.autoDetected')}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
