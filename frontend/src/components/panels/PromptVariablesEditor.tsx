import { useMemo, useState } from 'react'
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
import { generateUUID } from '@/lib/uuid'
import type { PromptVariableDef, PromptVariableType } from '@/lib/loom/types'
import css from './PromptVariablesEditor.module.css'

// ============================================================================
// Public API — the shape BlockEditor already consumes.
// ============================================================================

export interface VariablesEditorProps {
  variables: PromptVariableDef[]
  onChange: (vars: PromptVariableDef[]) => void
}

const VARIABLE_TYPE_OPTIONS: { value: PromptVariableType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Text Area' },
  { value: 'number', label: 'Number' },
  { value: 'slider', label: 'Slider' },
]

const TYPE_ACCENT_CLASS: Record<PromptVariableType, string> = {
  text: css.typeText,
  textarea: css.typeTextarea,
  number: css.typeNumber,
  slider: css.typeSlider,
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
  }
}

// ============================================================================
// VariablesEditor — accordion + list
// ============================================================================

export function VariablesEditor({ variables, onChange }: VariablesEditorProps) {
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
          Prompt Variables
          {variables.length > 0 && (
            <span className={css.headerCount}>({variables.length})</span>
          )}
        </button>
        <button type="button" className={css.addBtn} onClick={addVar}>
          <Plus size={12} /> Add Variable
        </button>
      </div>

      <p className={css.hint}>
        Declare typed inputs that end users can configure via the &ldquo;Configure Prompt
        Variables&rdquo; modal. Reference them inside this block&apos;s content with{' '}
        <code>{'{{var::name}}'}</code>.
      </p>

      {expanded && (
        variables.length === 0 ? (
          <div className={css.empty}>
            No variables declared yet. Add one to expose a user-configurable input on this
            block.
          </div>
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
  const isNumeric = variable.type === 'number' || variable.type === 'slider'
  const isSlider = variable.type === 'slider'

  const sliderMin = isSlider ? (variable as { min: number }).min : 0
  const sliderMax = isSlider ? (variable as { max: number }).max : 100
  const sliderStep = isSlider ? (variable as { step?: number }).step ?? 1 : 1

  return (
    <div className={clsx(css.card, TYPE_ACCENT_CLASS[variable.type])}>
      {/* Row 1: handle · type · name · delete */}
      <div className={css.headerRow}>
        <span className={css.handle} aria-hidden="true" title="Drag (coming soon)">
          <GripVertical size={14} />
        </span>

        <div className={clsx(css.field, css.typeField)}>
          <label className={css.fieldLabel}>Type</label>
          <select
            className={css.select}
            value={variable.type}
            onChange={(e) => onChangeType(e.target.value as PromptVariableType)}
          >
            {VARIABLE_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className={css.nameField}>
          <label className={css.fieldLabel}>Name</label>
          <div className={css.nameRow}>
            <input
              className={clsx(css.input, css.inputMono)}
              value={variable.name}
              placeholder="tone"
              spellCheck={false}
              onChange={(e) => onUpdate({ name: e.target.value })}
            />
            {isDuplicate && (
              <span
                className={css.dupChip}
                title="This name is used by more than one variable — the last enabled block wins at assembly time."
              >
                <AlertTriangle size={10} />
                shadowed
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          className={css.deleteBtn}
          onClick={onRemove}
          aria-label="Remove variable"
          title="Remove variable"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* Row 2: label */}
      <div className={clsx(css.field, css.colFull)}>
        <label className={css.fieldLabel}>Label</label>
        <input
          className={css.input}
          value={variable.label}
          placeholder="Response tone"
          onChange={(e) => onUpdate({ label: e.target.value })}
        />
      </div>

      {/* Row 3: default value — type-specific control */}
      <div className={clsx(css.field, variable.type === 'slider' ? css.colHalf : css.colFull)}>
        <label className={css.fieldLabel}>Default</label>
        {variable.type === 'textarea' ? (
          <textarea
            className={css.textarea}
            value={String(variable.defaultValue ?? '')}
            rows={3}
            placeholder="Default body text…"
            onChange={(e) =>
              onUpdate({ defaultValue: e.target.value } as Partial<PromptVariableDef>)
            }
          />
        ) : variable.type === 'text' ? (
          <input
            className={css.input}
            value={String(variable.defaultValue ?? '')}
            placeholder="Neutral, warm, clinical…"
            onChange={(e) =>
              onUpdate({ defaultValue: e.target.value } as Partial<PromptVariableDef>)
            }
          />
        ) : (
          <NumberStepper
            value={
              typeof variable.defaultValue === 'number'
                ? variable.defaultValue
                : Number(variable.defaultValue) || 0
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
            aria-label="Default value preview"
          />
          <div className={css.sliderPreviewScale}>
            <span>{sliderMin}</span>
            <span>{sliderMax}</span>
          </div>
        </div>
      )}

      {/* Row 4 (numeric only): min / max / step as equal thirds */}
      {isNumeric && (
        <>
          <div className={clsx(css.field, css.colThird)}>
            <label className={css.fieldLabel}>Min</label>
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
            <label className={css.fieldLabel}>Max</label>
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
            <label className={css.fieldLabel}>Step</label>
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
        <label className={css.fieldLabel}>Description (optional)</label>
        <input
          className={css.input}
          value={variable.description ?? ''}
          placeholder="Hint shown to end users configuring this variable"
          onChange={(e) => onUpdate({ description: e.target.value || undefined })}
        />
      </div>
    </div>
  )
}
