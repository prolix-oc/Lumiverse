import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, RotateCcw, Sliders } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import NumberStepper from '@/components/shared/NumberStepper'
import SearchableSelect, { type SearchableSelectOption } from '@/components/shared/SearchableSelect'
import { Toggle } from '@/components/shared/Toggle'
import type { PromptBlock, PromptVariableDef, PromptVariableValue, PromptVariableValues } from '@/lib/loom/types'
import css from './PromptVariablesModal.module.css'

interface PromptVariablesModalProps {
  isOpen: boolean
  blocks: PromptBlock[]
  values: PromptVariableValues
  onSave: (values: PromptVariableValues) => void | Promise<void>
  onClose: () => void
}

interface EligibleBlock {
  block: PromptBlock
  variables: PromptVariableDef[]
}

function collectEligibleBlocks(blocks: PromptBlock[]): EligibleBlock[] {
  const out: EligibleBlock[] = []
  for (const block of blocks) {
    if (!block.enabled) continue
    const vars = block.variables?.filter((v) => v && v.name) ?? []
    if (vars.length) out.push({ block, variables: vars })
  }
  return out
}

function resolveInitialValue(def: PromptVariableDef, stored: PromptVariableValue | undefined): PromptVariableValue {
  if (stored === undefined || stored === null) {
    // Clone arrays so a defaultValue-derived selection isn't shared across blocks.
    if (def.type === 'multiselect') return Array.isArray(def.defaultValue) ? def.defaultValue.slice() : []
    return def.defaultValue
  }
  if (def.type === 'number' || def.type === 'slider') {
    const n = Number(stored)
    return Number.isFinite(n) ? n : (def.defaultValue as number)
  }
  if (def.type === 'switch') {
    if (typeof stored === 'number') return stored === 1 ? 1 : 0
    if (typeof stored === 'boolean') return stored ? 1 : 0
    const s = String(stored).trim().toLowerCase()
    return s === '1' || s === 'true' || s === 'on' || s === 'yes' ? 1 : 0
  }
  if (def.type === 'select') {
    const validIds = new Set(def.options.map((o) => o.id))
    const candidate = String(stored)
    return validIds.has(candidate) ? candidate : def.defaultValue
  }
  if (def.type === 'multiselect') {
    const validIds = new Set(def.options.map((o) => o.id))
    const list = Array.isArray(stored)
      ? stored.map(String)
      : typeof stored === 'string' && stored.length
      ? stored.split(',').map((s) => s.trim()).filter(Boolean)
      : []
    return list.filter((id) => validIds.has(id))
  }
  return String(stored)
}

function clampNumeric(def: PromptVariableDef, value: number): number {
  if (def.type !== 'number' && def.type !== 'slider') return value
  let v = value
  if (typeof def.min === 'number' && v < def.min) v = def.min
  if (typeof def.max === 'number' && v > def.max) v = def.max
  return v
}

export function PromptVariablesModal({
  isOpen,
  blocks,
  values,
  onSave,
  onClose,
}: PromptVariablesModalProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'promptVariables' })
  const { t: tc } = useTranslation('common')
  const eligible = useMemo(() => collectEligibleBlocks(blocks), [blocks])

  // Local draft keyed by blockId → varName. Seeded from stored values on open.
  const [draft, setDraft] = useState<PromptVariableValues>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isOpen) return
    const seeded: PromptVariableValues = {}
    for (const { block, variables } of eligible) {
      const bucket: Record<string, PromptVariableValue> = {}
      const stored = values[block.id] ?? {}
      for (const def of variables) {
        bucket[def.name] = resolveInitialValue(def, stored[def.name])
      }
      seeded[block.id] = bucket
    }
    setDraft(seeded)
    setCollapsed(Object.fromEntries(eligible.map(({ block }) => [block.id, true])))
  }, [isOpen, eligible, values])

  const setVar = (blockId: string, varName: string, value: PromptVariableValue) => {
    setDraft((prev) => ({
      ...prev,
      [blockId]: { ...(prev[blockId] ?? {}), [varName]: value },
    }))
  }

  const resetVar = (blockId: string, def: PromptVariableDef) => {
    setVar(blockId, def.name, def.defaultValue)
  }

  const resetAll = () => {
    const fresh: PromptVariableValues = {}
    for (const { block, variables } of eligible) {
      fresh[block.id] = Object.fromEntries(
        variables.map((def) => [def.name, def.defaultValue]),
      )
    }
    setDraft(fresh)
  }

  const buildSavePayload = (): PromptVariableValues => {
    const out: PromptVariableValues = {}
    for (const { block, variables } of eligible) {
      const bucket: Record<string, PromptVariableValue> = {}
      const current = draft[block.id] ?? {}
      for (const def of variables) {
        const raw = current[def.name]
        if (raw === undefined) continue
        if (def.type === 'number' || def.type === 'slider') {
          const n = Number(raw)
          bucket[def.name] = clampNumeric(def, Number.isFinite(n) ? n : (def.defaultValue as number))
        } else if (def.type === 'switch') {
          const n = typeof raw === 'number' ? raw : Number(raw)
          bucket[def.name] = n === 1 ? 1 : 0
        } else if (def.type === 'multiselect') {
          const validIds = new Set(def.options.map((o) => o.id))
          const list = Array.isArray(raw) ? raw : [raw]
          bucket[def.name] = list.map(String).filter((id) => validIds.has(id))
        } else if (def.type === 'select') {
          const validIds = new Set(def.options.map((o) => o.id))
          const candidate = String(raw)
          bucket[def.name] = validIds.has(candidate) ? candidate : def.defaultValue
        } else {
          bucket[def.name] = String(raw)
        }
      }
      if (Object.keys(bucket).length) out[block.id] = bucket
    }
    return out
  }

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSave(buildSavePayload())
      onClose()
    } catch {
      // error surfaced via hook's console.warn + toast upstream
    } finally {
      setSaving(false)
    }
  }

  const toggleBlockCollapsed = (blockId: string) => {
    setCollapsed((prev) => ({ ...prev, [blockId]: !prev[blockId] }))
  }

  return (
    <ModalShell
      isOpen={isOpen}
      onClose={onClose}
      maxWidth="clamp(320px, 90vw, min(640px, var(--lumiverse-content-max-width, 640px)))"
      maxHeight="85vh"
      className={css.modal}
    >
      <div className={css.header}>
        <Sliders size={18} />
        <div>
          <h3 className={css.title}>{t('title')}</h3>
          <p className={css.subtitle}>
            {t('subtitle', { token: t('tokenExample') })}
          </p>
        </div>
      </div>

      <div className={css.body}>
        {eligible.length === 0 ? (
          <div className={css.empty}>
            {t('empty')}
          </div>
        ) : (
          eligible.map(({ block, variables }) => {
            const isCollapsed = !!collapsed[block.id]
            return (
              <div key={block.id} className={css.blockSection}>
                <div className={css.blockHeader} onClick={() => toggleBlockCollapsed(block.id)}>
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className={css.blockHeaderLabel}>{block.name || t('untitledBlock')}</span>
                  <span className={css.blockHeaderCount}>
                    {t('variableCount', { count: variables.length })}
                  </span>
                </div>
                {!isCollapsed && (
                  <div className={css.blockBody}>
                    {variables.map((def) => (
                      <VariableControl
                        key={def.id}
                        def={def}
                        value={draft[block.id]?.[def.name] ?? def.defaultValue}
                        onChange={(v) => setVar(block.id, def.name, v)}
                        onReset={() => resetVar(block.id, def)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className={css.footer}>
        {eligible.length > 0 && (
          <button
            type="button"
            className={`${css.btn} ${css.btnGhost} ${css.footerLeft}`}
            onClick={resetAll}
          >
            {t('resetAll')}
          </button>
        )}
        <button
          type="button"
          className={`${css.btn} ${css.btnCancel}`}
          onClick={onClose}
        >
          {tc('actions.cancel')}
        </button>
        <button
          type="button"
          className={`${css.btn} ${css.btnSubmit}`}
          onClick={handleSave}
          disabled={saving || eligible.length === 0}
        >
          {saving ? t('saving') : tc('actions.save')}
        </button>
      </div>
    </ModalShell>
  )
}

interface VariableControlProps {
  def: PromptVariableDef
  value: PromptVariableValue
  onChange: (v: PromptVariableValue) => void
  onReset: () => void
}

function VariableControl({ def, value, onChange, onReset }: VariableControlProps) {
  const { t } = useTranslation('shared', { keyPrefix: 'promptVariables' })
  return (
    <div className={css.variableRow}>
      <div className={css.variableLabel}>
        <span>{def.label || def.name}</span>
        <span className={css.variableName}>{'{{'}var::{def.name}{'}}'}</span>
        <button
          type="button"
          className={css.resetBtn}
          onClick={onReset}
          title={t('resetToDefault')}
          aria-label={t('resetToDefault')}
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {def.description && <div className={css.variableDescription}>{def.description}</div>}
      {renderControl(def, value, onChange)}
    </div>
  )
}

function renderControl(
  def: PromptVariableDef,
  value: PromptVariableValue,
  onChange: (v: PromptVariableValue) => void,
) {
  switch (def.type) {
    case 'text':
      return (
        <input
          type="text"
          className={css.textInput}
          value={typeof value === 'string' ? value : String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'textarea':
      return (
        <textarea
          className={css.textArea}
          rows={def.rows ?? 4}
          value={typeof value === 'string' ? value : String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'number':
      return (
        <NumberStepper
          value={typeof value === 'number' ? value : Number(value) || (typeof def.defaultValue === 'number' ? def.defaultValue : 0)}
          onChange={(v) => onChange(v ?? (typeof def.defaultValue === 'number' ? def.defaultValue : 0))}
          min={def.min}
          max={def.max}
          step={def.step ?? 1}
        />
      )
    case 'slider': {
      const numeric = typeof value === 'number' ? value : Number(value) || def.defaultValue
      return (
        <>
          <div className={css.sliderRow}>
            <input
              type="range"
              className={css.slider}
              min={def.min}
              max={def.max}
              step={def.step ?? 1}
              value={numeric}
              onChange={(e) => onChange(Number(e.target.value))}
            />
            <span className={css.sliderValue}>{numeric}</span>
          </div>
          <div className={css.sliderRange}>
            <span>{def.min}</span>
            <span>{def.max}</span>
          </div>
        </>
      )
    }
    case 'select': {
      if (def.options.length === 0) {
        return <div className={css.multiselectEmpty}>No options defined for this variable.</div>
      }
      const validIds = new Set(def.options.map((o) => o.id))
      const current = typeof value === 'string' && validIds.has(value) ? value : def.defaultValue
      const opts: SearchableSelectOption[] = def.options.map((opt) => ({
        value: opt.id,
        label: opt.label || opt.id,
        sublabel: opt.value ? truncateForSublabel(opt.value) : undefined,
      }))
      return (
        <SearchableSelect
          options={opts}
          value={current}
          onChange={(v) => onChange(v)}
          ariaLabel={def.label || def.name}
          portal
        />
      )
    }
    case 'switch': {
      const on = typeof value === 'number' ? value === 1 : value === '1' || value === 'true'
      return (
        <div className={css.switchRow}>
          <Toggle.Switch checked={on} onChange={(next) => onChange(next ? 1 : 0)} />
          <span className={css.switchStateLabel}>{on ? 'On' : 'Off'}</span>
        </div>
      )
    }
    case 'multiselect': {
      if (def.options.length === 0) {
        return <div className={css.multiselectEmpty}>No options defined for this variable.</div>
      }
      const validIds = new Set(def.options.map((o) => o.id))
      const selectedIds = Array.isArray(value)
        ? value.filter((id): id is string => typeof id === 'string' && validIds.has(id))
        : []
      const opts: SearchableSelectOption[] = def.options.map((opt) => ({
        value: opt.id,
        label: opt.label || opt.id,
        sublabel: opt.value ? truncateForSublabel(opt.value) : undefined,
      }))
      return (
        <SearchableSelect
          multi
          options={opts}
          value={selectedIds}
          // Re-sort to option-declaration order so the persisted/joined output is stable.
          onChange={(next) =>
            onChange(def.options.filter((o) => next.includes(o.id)).map((o) => o.id))
          }
          ariaLabel={def.label || def.name}
          placeholder="None selected"
          portal
        />
      )
    }
  }
}

function truncateForSublabel(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()
  return collapsed.length > 60 ? `${collapsed.slice(0, 57)}…` : collapsed
}
