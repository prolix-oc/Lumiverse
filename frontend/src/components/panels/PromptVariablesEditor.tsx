import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Plus,
  Trash2,
} from 'lucide-react'
import clsx from 'clsx'
import NumberStepper from '@/components/shared/NumberStepper'
import { Toggle } from '@/components/shared/Toggle'
import { generateUUID } from '@/lib/uuid'
import type {
  PromptVariableDef,
  PromptVariableOption,
  PromptVariableType,
} from '@/lib/loom/types'
import css from './PromptVariablesEditor.module.css'

// ============================================================================
// Public API — the shape BlockEditor already consumes.
// ============================================================================

export interface VariablesEditorProps {
  variables: PromptVariableDef[]
  onChange: (vars: PromptVariableDef[]) => void
}

const TYPE_ACCENT_CLASS: Record<PromptVariableType, string> = {
  text: css.typeText,
  textarea: css.typeTextarea,
  number: css.typeNumber,
  slider: css.typeSlider,
  select: css.typeSelect,
  switch: css.typeSwitch,
  multiselect: css.typeMultiselect,
}

function makeNewVariable(): PromptVariableDef {
  return {
    id: generateUUID(),
    name: '',
    label: '',
    type: 'text',
    defaultValue: '',
  }
}

function makeNewOption(index: number): PromptVariableOption {
  return { id: generateUUID(), label: `Option ${index + 1}`, value: '' }
}

// Type-preserving migration. Swapping types shouldn't nuke the user's work —
// we coerce where possible and fall back to safe defaults when not.
function coerceVariableType(
  current: PromptVariableDef,
  nextType: PromptVariableType,
): PromptVariableDef {
  const base = {
    id: current.id,
    name: current.name,
    label: current.label,
    description: current.description,
  }
  switch (nextType) {
    case 'text':
      return {
        ...base,
        type: 'text',
        defaultValue:
          typeof current.defaultValue === 'string'
            ? current.defaultValue
            : String(current.defaultValue ?? ''),
      }
    case 'textarea':
      return {
        ...base,
        type: 'textarea',
        defaultValue:
          typeof current.defaultValue === 'string'
            ? current.defaultValue
            : String(current.defaultValue ?? ''),
        rows: (current as { rows?: number }).rows ?? 4,
      }
    case 'number': {
      const num =
        typeof current.defaultValue === 'number'
          ? current.defaultValue
          : Number(current.defaultValue) || 0
      return {
        ...base,
        type: 'number',
        defaultValue: num,
        min: (current as { min?: number }).min,
        max: (current as { max?: number }).max,
        step: (current as { step?: number }).step ?? 1,
      }
    }
    case 'slider': {
      const num =
        typeof current.defaultValue === 'number'
          ? current.defaultValue
          : Number(current.defaultValue) || 0
      const min =
        typeof (current as { min?: number }).min === 'number'
          ? (current as { min: number }).min
          : 0
      const max =
        typeof (current as { max?: number }).max === 'number'
          ? (current as { max: number }).max
          : 100
      return {
        ...base,
        type: 'slider',
        defaultValue: Math.min(Math.max(num, min), max),
        min,
        max,
        step: (current as { step?: number }).step ?? 1,
      }
    }
    case 'select': {
      const existing = (current as { options?: PromptVariableOption[] }).options ?? []
      const options = existing.length ? existing : [makeNewOption(0)]
      const validIds = new Set(options.map((o) => o.id))
      const candidate =
        typeof current.defaultValue === 'string' && validIds.has(current.defaultValue)
          ? current.defaultValue
          : options[0].id
      return {
        ...base,
        type: 'select',
        defaultValue: candidate,
        options,
      }
    }
    case 'switch': {
      // Accept anything truthy from prior types as a hint, but bias to 0.
      const dv = current.defaultValue as unknown
      const on =
        dv === 1 ||
        dv === '1' ||
        dv === true ||
        (typeof dv === 'string' && ['true', 'on', 'yes'].includes(dv.toLowerCase()))
      return {
        ...base,
        type: 'switch',
        defaultValue: on ? 1 : 0,
      }
    }
    case 'multiselect': {
      const existing = (current as { options?: PromptVariableOption[] }).options ?? []
      const options = existing.length ? existing : [makeNewOption(0)]
      const validIds = new Set(options.map((o) => o.id))
      const prior = current.defaultValue
      const def = Array.isArray(prior)
        ? prior.filter((id): id is string => typeof id === 'string' && validIds.has(id))
        : typeof prior === 'string' && validIds.has(prior)
        ? [prior]
        : []
      return {
        ...base,
        type: 'multiselect',
        defaultValue: def,
        options,
        separator: (current as { separator?: string }).separator ?? '\n\n',
      }
    }
  }
}

// ============================================================================
// VariablesEditor — accordion + list
// ============================================================================

export function VariablesEditor({ variables, onChange }: VariablesEditorProps) {
  const { t } = useTranslation('panels')
  const [expanded, setExpanded] = useState(variables.length > 0)

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const v of variables) {
      const name = v.name?.trim()
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, n]) => n > 1)
        .map(([name]) => name),
    )
  }, [variables])

  const updateVar = (id: string, patch: Partial<PromptVariableDef>) => {
    onChange(
      variables.map((v) => (v.id === id ? ({ ...v, ...patch } as PromptVariableDef) : v)),
    )
  }

  const changeType = (id: string, nextType: PromptVariableType) => {
    onChange(variables.map((v) => (v.id === id ? coerceVariableType(v, nextType) : v)))
  }

  const removeVar = (id: string) => {
    onChange(variables.filter((v) => v.id !== id))
  }

  const addVar = () => {
    onChange([...variables, makeNewVariable()])
    setExpanded(true)
  }

  return (
    <div className={css.root}>
      <div className={css.header}>
        <button
          type="button"
          className={css.headerToggle}
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {t('promptVariablesEditor.title')}
          {variables.length > 0 && (
            <span className={css.headerCount}>({variables.length})</span>
          )}
        </button>
        <button type="button" className={css.addBtn} onClick={addVar}>
          <Plus size={12} /> {t('promptVariablesEditor.addVariable')}
        </button>
      </div>

      <p className={css.hint}>
        {t('promptVariablesEditor.hint', { varName: '{{var::name}}', multiselectName: '{{var::name::ison::keyA,keyB}}' })}
      </p>

      {expanded && (
        variables.length === 0 ? (
          <div className={css.empty}>{t('promptVariablesEditor.empty')}</div>
        ) : (
          <div className={css.list}>
            {variables.map((v) => (
              <VariableRow
                key={v.id}
                variable={v}
                isDuplicate={Boolean(v.name?.trim()) && duplicateNames.has(v.name.trim())}
                onUpdate={(patch) => updateVar(v.id, patch)}
                onChangeType={(type) => changeType(v.id, type)}
                onRemove={() => removeVar(v.id)}
              />
            ))}
          </div>
        )
      )}
    </div>
  )
}

// ============================================================================
// VariableRow — single card
// ============================================================================

interface VariableRowProps {
  variable: PromptVariableDef
  isDuplicate: boolean
  onUpdate: (patch: Partial<PromptVariableDef>) => void
  onChangeType: (type: PromptVariableType) => void
  onRemove: () => void
}

function VariableRow({
  variable,
  isDuplicate,
  onUpdate,
  onChangeType,
  onRemove,
}: VariableRowProps) {
  const { t } = useTranslation('panels')
  const typeOptions = useMemo(
    () =>
      (['text', 'textarea', 'number', 'slider', 'select', 'switch', 'multiselect'] as const).map((value) => ({
        value,
        label: t(`promptVariablesEditor.types.${value}`),
      })),
    [t],
  )
  const isNumeric = variable.type === 'number' || variable.type === 'slider'
  const isSlider = variable.type === 'slider'
  const isSelect = variable.type === 'select'
  const isMultiselect = variable.type === 'multiselect'
  const isSwitch = variable.type === 'switch'

  const sliderMin = isSlider ? (variable as { min: number }).min : 0
  const sliderMax = isSlider ? (variable as { max: number }).max : 100
  const sliderStep = isSlider ? (variable as { step?: number }).step ?? 1 : 1

  return (
    <div className={clsx(css.card, TYPE_ACCENT_CLASS[variable.type])}>
      {/* Row 1: handle · type · name · delete */}
      <div className={css.headerRow}>
        <span className={css.handle} aria-hidden="true" title={t('promptVariablesEditor.dragComingSoon')}>
          <GripVertical size={14} />
        </span>

        <div className={clsx(css.field, css.typeField)}>
          <label className={css.fieldLabel}>{t('promptVariablesEditor.type')}</label>
          <select
            className={css.select}
            value={variable.type}
            onChange={(e) => onChangeType(e.target.value as PromptVariableType)}
          >
            {typeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={css.nameField}>
          <label className={css.fieldLabel}>{t('promptVariablesEditor.name')}</label>
          <div className={css.nameRow}>
            <input
              className={clsx(css.input, css.inputMono)}
              value={variable.name}
              placeholder={t('promptVariablesEditor.namePlaceholder')}
              spellCheck={false}
              onChange={(e) => onUpdate({ name: e.target.value })}
            />
            {isDuplicate && (
              <span
                className={css.dupChip}
                title={t('promptVariablesEditor.duplicateTitle')}
              >
                <AlertTriangle size={10} />
                {t('promptVariablesEditor.shadowed')}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          className={css.deleteBtn}
          onClick={onRemove}
          aria-label={t('promptVariablesEditor.removeVariable')}
          title={t('promptVariablesEditor.removeVariable')}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Row 2: label */}
      <div className={clsx(css.field, css.colFull)}>
        <label className={css.fieldLabel}>{t('promptVariablesEditor.label')}</label>
        <input
          className={css.input}
          value={variable.label}
          placeholder={t('promptVariablesEditor.labelPlaceholder')}
          onChange={(e) => onUpdate({ label: e.target.value })}
        />
      </div>

      {/* Row 3: default value — type-specific control.
          For select/multiselect the default is set via the options list below. */}
      {!isSelect && !isMultiselect && (
        <div className={clsx(css.field, isSlider ? css.colHalf : css.colFull)}>
          <label className={css.fieldLabel}>{t('promptVariablesEditor.default')}</label>
          {variable.type === 'textarea' ? (
            <textarea
              className={css.textarea}
              value={String(variable.defaultValue ?? '')}
              rows={3}
              placeholder={t('promptVariablesEditor.defaultTextareaPlaceholder')}
              onChange={(e) =>
                onUpdate({ defaultValue: e.target.value } as Partial<PromptVariableDef>)
              }
            />
          ) : variable.type === 'text' ? (
            <input
              className={css.input}
              value={String(variable.defaultValue ?? '')}
              placeholder={t('promptVariablesEditor.defaultTextPlaceholder')}
              onChange={(e) =>
                onUpdate({ defaultValue: e.target.value } as Partial<PromptVariableDef>)
              }
            />
          ) : isSwitch ? (
            <div className={css.switchToggleRow}>
              <Toggle.Switch
                checked={(variable as { defaultValue: 0 | 1 }).defaultValue === 1}
                onChange={(next) =>
                  onUpdate({ defaultValue: next ? 1 : 0 } as Partial<PromptVariableDef>)
                }
              />
              <span className={css.switchToggleLabel}>
                {(variable as { defaultValue: 0 | 1 }).defaultValue === 1 ? t('promptVariablesEditor.switchOn') : t('promptVariablesEditor.switchOff')}
              </span>
              <span className={css.switchToggleHint}>
                {t('promptVariablesEditor.switchHint')}
              </span>
            </div>
          ) : (
            <NumberStepper
              value={
                Number((variable as { defaultValue?: unknown }).defaultValue) || 0
              }
              onChange={(n) =>
                onUpdate({ defaultValue: n ?? 0 } as Partial<PromptVariableDef>)
              }
              min={(variable as { min?: number }).min}
              max={(variable as { max?: number }).max}
              step={(variable as { step?: number }).step ?? 1}
            />
          )}
        </div>
      )}

      {/* Slider-only preview: what end-users will see. Lives beside the
          stepper so the creator can cross-check. */}
      {isSlider && (
        <div className={clsx(css.sliderPreview, css.colHalf)}>
          <input
            type="range"
            className={css.sliderPreviewTrack}
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            value={
              typeof variable.defaultValue === 'number'
                ? variable.defaultValue
                : sliderMin
            }
            onChange={(e) =>
              onUpdate({ defaultValue: Number(e.target.value) } as Partial<PromptVariableDef>)
            }
            aria-label={t('promptVariablesEditor.defaultPreviewAria')}
          />
          <div className={css.sliderPreviewScale}>
            <span>{sliderMin}</span>
            <span>{sliderMax}</span>
          </div>
        </div>
      )}

      {/* Options list — select & multiselect */}
      {(isSelect || isMultiselect) && (
        <OptionsListEditor
          variable={variable as Extract<PromptVariableDef, { type: 'select' | 'multiselect' }>}
          mode={isMultiselect ? 'multiple' : 'single'}
          onUpdate={onUpdate}
        />
      )}

      {/* Multiselect: separator */}
      {isMultiselect && (
        <div className={clsx(css.field, css.colFull)}>
          <label className={css.fieldLabel}>Separator (inserted between selected values)</label>
          <textarea
            className={css.textarea}
            rows={2}
            value={(variable as { separator?: string }).separator ?? '\n\n'}
            placeholder={'Two newlines by default'}
            onChange={(e) =>
              onUpdate({ separator: e.target.value } as Partial<PromptVariableDef>)
            }
          />
        </div>
      )}

      {/* Row 4 (numeric only): min / max / step as equal thirds */}
      {isNumeric && (
        <>
          <div className={clsx(css.field, css.colThird)}>
            <label className={css.fieldLabel}>{t('promptVariablesEditor.min')}</label>
            <NumberStepper
              value={
                typeof (variable as { min?: number }).min === 'number'
                  ? (variable as { min: number }).min
                  : null
              }
              onChange={(n) =>
                onUpdate({ min: n ?? undefined } as Partial<PromptVariableDef>)
              }
              allowEmpty={variable.type === 'number'}
            />
          </div>
          <div className={clsx(css.field, css.colThird)}>
            <label className={css.fieldLabel}>{t('promptVariablesEditor.max')}</label>
            <NumberStepper
              value={
                typeof (variable as { max?: number }).max === 'number'
                  ? (variable as { max: number }).max
                  : null
              }
              onChange={(n) =>
                onUpdate({ max: n ?? undefined } as Partial<PromptVariableDef>)
              }
              allowEmpty={variable.type === 'number'}
            />
          </div>
          <div className={clsx(css.field, css.colThird)}>
            <label className={css.fieldLabel}>{t('promptVariablesEditor.step')}</label>
            <NumberStepper
              value={
                typeof (variable as { step?: number }).step === 'number'
                  ? (variable as { step: number }).step
                  : 1
              }
              onChange={(n) =>
                onUpdate({ step: n ?? 1 } as Partial<PromptVariableDef>)
              }
              min={0}
            />
          </div>
        </>
      )}

      {/* Row 5: description — always last, soft hint copy */}
      <div className={clsx(css.field, css.colFull)}>
        <label className={css.fieldLabel}>{t('promptVariablesEditor.descriptionOptional')}</label>
        <input
          className={css.input}
          value={variable.description ?? ''}
          placeholder={t('promptVariablesEditor.descriptionPlaceholder')}
          onChange={(e) => onUpdate({ description: e.target.value || undefined })}
        />
      </div>
    </div>
  )
}

// ============================================================================
// OptionsListEditor — used by select + multiselect
// ============================================================================

interface OptionsListEditorProps {
  variable: Extract<PromptVariableDef, { type: 'select' | 'multiselect' }>
  mode: 'single' | 'multiple'
  onUpdate: (patch: Partial<PromptVariableDef>) => void
}

function OptionsListEditor({ variable, mode, onUpdate }: OptionsListEditorProps) {
  const options = variable.options ?? []
  const selectedIds = useMemo(() => {
    if (variable.type === 'multiselect') {
      return new Set(Array.isArray(variable.defaultValue) ? variable.defaultValue : [])
    }
    return new Set(typeof variable.defaultValue === 'string' ? [variable.defaultValue] : [])
  }, [variable])

  const patchOptions = (next: PromptVariableOption[]) => {
    if (variable.type === 'multiselect') {
      const validIds = new Set(next.map((o) => o.id))
      const filtered = (Array.isArray(variable.defaultValue) ? variable.defaultValue : []).filter(
        (id) => validIds.has(id),
      )
      onUpdate({ options: next, defaultValue: filtered } as Partial<PromptVariableDef>)
      return
    }
    // single-select: keep the previous default if still present; otherwise first option
    const validIds = new Set(next.map((o) => o.id))
    const currentDefault =
      typeof variable.defaultValue === 'string' && validIds.has(variable.defaultValue)
        ? variable.defaultValue
        : next[0]?.id ?? ''
    onUpdate({ options: next, defaultValue: currentDefault } as Partial<PromptVariableDef>)
  }

  const updateOption = (id: string, patch: Partial<PromptVariableOption>) => {
    patchOptions(options.map((o) => (o.id === id ? { ...o, ...patch } : o)))
  }

  const removeOption = (id: string) => {
    patchOptions(options.filter((o) => o.id !== id))
  }

  const addOption = () => {
    patchOptions([...options, makeNewOption(options.length)])
  }

  const setDefault = (id: string, checked: boolean) => {
    if (mode === 'single') {
      onUpdate({ defaultValue: id } as Partial<PromptVariableDef>)
      return
    }
    const prior = new Set(Array.isArray(variable.defaultValue) ? variable.defaultValue : [])
    if (checked) prior.add(id)
    else prior.delete(id)
    // Preserve declaration order so the persisted default matches option order.
    const ordered = options.filter((o) => prior.has(o.id)).map((o) => o.id)
    onUpdate({ defaultValue: ordered } as Partial<PromptVariableDef>)
  }

  return (
    <div className={css.optionsList}>
      <div className={css.optionsListHeader}>
        <span>
          Options{' '}
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>
            ({mode === 'single' ? 'pick one default' : 'pick the default selection'})
          </span>
        </span>
        <button type="button" className={css.optionAddBtn} onClick={addOption}>
          <Plus size={11} /> Add option
        </button>
      </div>

      {options.length === 0 ? (
        <div className={css.optionsEmpty}>No options yet — add one to give end users a choice.</div>
      ) : (
        options.map((opt) => (
          <div key={opt.id} className={css.optionRow}>
            <div className={css.optionDefaultCell}>
              <input
                type={mode === 'single' ? 'radio' : 'checkbox'}
                className={css.optionDefaultInput}
                name={mode === 'single' ? `default-${variable.id}` : undefined}
                checked={selectedIds.has(opt.id)}
                onChange={(e) => setDefault(opt.id, e.target.checked)}
                aria-label="Use as default"
                title="Use as default"
              />
            </div>
            <input
              className={css.optionLabelInput}
              value={opt.label}
              placeholder="Label shown to user"
              onChange={(e) => updateOption(opt.id, { label: e.target.value })}
            />
            <textarea
              className={css.optionValueInput}
              value={opt.value}
              rows={1}
              placeholder="Value substituted into the prompt"
              onChange={(e) => updateOption(opt.id, { value: e.target.value })}
            />
            <button
              type="button"
              className={css.optionDelete}
              onClick={() => removeOption(opt.id)}
              aria-label="Remove option"
              title="Remove option"
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))
      )}
    </div>
  )
}
