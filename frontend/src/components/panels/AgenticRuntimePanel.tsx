import type { AgenticRuntimeEditorProjection, SaveAgenticRuntimeEditorResult } from '@/api/agentic-runtime'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  ClipboardCheck,
  FileStack,
  Gauge,
  Link2,
  ListChecks,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react'
import clsx from 'clsx'
import type { ProviderInfo } from '@/types/api'
import ConnectionSelect from '@/components/shared/ConnectionSelect'
import { Toggle } from '@/components/shared/Toggle'
import { useStore } from '@/store'
import { agenticRuntimeApi } from '@/api/agentic-runtime'
import { ApiError } from '@/api/client'
import { unmarshalPreset } from '@/lib/loom/service'
import { toast } from '@/lib/toast'
import {
  AGENTIC_CUSTOM_PHASE_LIMIT,
  AGENTIC_DESCRIPTION_MAX_BYTES,
  AGENTIC_LABEL_MAX_LENGTH,
  AGENTIC_LOOM_POLICY_BUCKET_LIMIT,
  AGENTIC_LOOM_POLICY_LIMIT,
  AGENTIC_PREDICATE_MAX_DEPTH,
  AGENTIC_PREDICATE_MAX_ID_BYTES,
  AGENTIC_PREDICATE_MAX_LIST_BYTES,
  AGENTIC_PREDICATE_MAX_LIST_ITEMS,
  AGENTIC_PREDICATE_MAX_NODES,
  AGENTIC_PREDICATE_MAX_STRING_BYTES,
  AGENTIC_TASK_TEMPLATE_LIMIT,
  AGENT_INVOCATION_MIN,
  AGENT_MAX_OUTPUT_TOKENS_MAX,
  AGENT_MAX_OUTPUT_TOKENS_MIN,
  AGENT_PROFILE_LIMIT,
  AGENT_PROFILE_NAME_MAX_LENGTH,
  AGENT_SYSTEM_PROMPT_MAX_BYTES,
  AGENT_TIMEOUT_MS_MIN,
  AGENT_TOOL_CALL_MIN,
  CORE_AGENT_TOOL_IDS,
  agentTimeoutMsToSeconds,
  createAgentPromptBlock,
  createAgentProfileV2,
  createAgenticRuntimeDraft,
  createLoomPolicyEntryV1,
  parseAgentCustomPhasesV1,
  parseAgentRuntimePolicyV1,
  parseLoomPolicyBucketsV1,
  getAgenticRuntimeRepairItems,
  getAgentConfigQuarantine,
  getAgentRuntimeCustomPhases,
  getAgentRuntimePolicyBuckets,
  getAgentResultName,
  isAgentTaskTemplate,
  isCanonicalBlockRevision,
  normalizeAgentConfigForEditor,
  parseAgentMaxInvocationsInput,
  parseAgentMaxToolCallsInput,
  parseAgentTimeoutSecondsInput,
  removeAgentProfileMarkers,
  requiredReviewAcknowledgements,
  rewriteAgentProfileMarkers,
  rewriteTaskTransitionReferences,
  runtimeDraftFingerprint,
  setAgentRuntimeCustomPhases,
  setAgentRuntimePolicyBuckets,
  validateAgenticRuntimeDraft,
} from '@/lib/loom/agenticRuntime'
import type {
  AgentCapability,
  AgentConfigRepairItem,
  AgentConfigV2,
  AgentCustomPhaseCapability,
  AgentCustomPhaseV1,
  AgentMode,
  AgentProfileConfigV2,
  AgentTaskTemplate,
  AgenticRuntimeHostCeilings,
  AgenticRuntimeSaveDraft,
  CognitionPredicate,
  CognitionScalar,
  CognitionValue,
  CoreAgentToolId,
  LoomPreset,
  PromptBlock,
  WorkspaceCapability,
} from '@/lib/loom/types'
import type {
  LoomPolicyBucketsV1,
  LoomPolicyEntryV1,
  LoomPolicySourceV1,
} from '@/types/agent-runtime'
import { AGENT_CUSTOM_PHASE_CAPABILITIES, WORKSPACE_CAPABILITIES } from '@/lib/loom/types'
import styles from './AgenticRuntimePanel.module.css'

const SECTION_IDS = [
  'activation',
  'agents',
  'tools',
  'phases',
  'tasks',
  'workspace',
  'repair',
] as const

const ACTIVATION_REVIEW_REASON_ID = 'agentic-runtime-activation-review-reason'
const SAVE_VALIDATION_REASON_ID = 'agentic-runtime-save-validation-reason'

type SectionId = (typeof SECTION_IDS)[number]
type PolicyKey = 'workPolicy' | 'workspaceUsage' | 'completionCriteria' | 'renderPolicy'
const RUNTIME_POLICY_KEYS = new Set(['version', 'authority', 'scope', 'defaultMode', 'loomPolicy', 'phases'])

const POLICY_KEYS: readonly PolicyKey[] = [
  'workPolicy',
  'workspaceUsage',
  'completionCriteria',
  'renderPolicy',
]
const POLICY_DESTINATIONS = {
  workPolicy: 'root_work',
  workspaceUsage: 'root_work',
  completionCriteria: 'completion_handoff',
  renderPolicy: 'render',
} as const
const POLICY_CHECKPOINTS = {
  workPolicy: 'WORK',
  workspaceUsage: 'WORK',
  completionCriteria: 'PREPARE_COMMIT',
  renderPolicy: 'RENDER',
} as const

const WORKSPACE_TOOL_KEYS: Record<WorkspaceCapability, string> = {
  read_section: 'workspace_read_section',
  read_page: 'workspace_read_page',
  update_assigned_progress: 'workspace_update_progress',
  submit_child_result: 'workspace_submit_result',
}

const SECTION_ICONS: Record<SectionId, typeof Gauge> = {
  activation: Gauge,
  agents: Bot,
  tools: Wrench,
  phases: FileStack,
  tasks: ListChecks,
  workspace: ShieldCheck,
  repair: Link2,
}

const PREDICATE_KINDS: readonly CognitionPredicate['kind'][] = [
  'all',
  'any',
  'not',
  'generation_type',
  'phase',
  'preset_variable',
  'participant_fact',
  'tool_available',
  'task_transition',
]

const PREDICATE_ID_ENCODER = new TextEncoder()

function isEditablePredicateId(value: string): boolean {
  if (value.length === 0
    || value.includes('{{')
    || value.includes('}}')
    || PREDICATE_ID_ENCODER.encode(value).byteLength > AGENTIC_PREDICATE_MAX_ID_BYTES) {
    return false
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f) return false
  }
  return true
}

function isEditablePredicateText(value: string): boolean {
  if (value.includes('{{')
    || value.includes('}}')
    || PREDICATE_ID_ENCODER.encode(value).byteLength > AGENTIC_PREDICATE_MAX_STRING_BYTES) {
    return false
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0 || codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) {
      return false
    }
  }
  return true
}

function isEditablePredicateValue(value: CognitionValue): boolean {
  if (typeof value === 'string') return isEditablePredicateText(value)
  if (!Array.isArray(value)) return true
  if (value.length > AGENTIC_PREDICATE_MAX_LIST_ITEMS) return false
  let totalBytes = 0
  for (const entry of value) {
    if (!isEditablePredicateText(entry)) return false
    totalBytes += PREDICATE_ID_ENCODER.encode(entry).byteLength
  }
  return totalBytes <= AGENTIC_PREDICATE_MAX_LIST_BYTES
}


interface AgenticRuntimePanelProps {
  preset: LoomPreset
  onSave: (
    draft: AgenticRuntimeSaveDraft,
    promptOrder: PromptBlock[],
    expectedIdentity: { presetId: string; presetRevision: number; configRevision: number },
    acceptSnapshot: (result: SaveAgenticRuntimeEditorResult) => boolean,
  ) => Promise<SaveAgenticRuntimeEditorResult>
  onReload: () => Promise<SaveAgenticRuntimeEditorResult>
  onDirtyChange: (dirty: boolean) => void
}
type PanelRepairItem = Omit<AgentConfigRepairItem, 'kind' | 'action'> & {
  kind: AgentConfigRepairItem['kind'] | 'invalid_rule'
  action: AgentConfigRepairItem['action'] | {
    kind: 'select_revision' | 'discard'
    ref?: string
  }
}


function makePredicate(kind: CognitionPredicate['kind']): CognitionPredicate {
  switch (kind) {
    case 'all':
    case 'any':
      return { kind, children: [{ kind: 'phase', value: 'WORK' }] }
    case 'not':
      return { kind, child: { kind: 'phase', value: 'WORK' } }
    case 'generation_type':
      return { kind, value: 'normal' }
    case 'phase':
      return { kind, value: 'WORK' }
    case 'preset_variable':
    case 'participant_fact':
      return { kind, name: 'variable', operator: 'present' }
    case 'tool_available':
      return { kind, toolId: CORE_AGENT_TOOL_IDS[0], available: true }
    case 'task_transition':
      return { kind, taskId: 'task_1', transition: 'active' }
  }
}
function isCognitionScalar(value: CognitionValue): value is CognitionScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}
function removeTaskTransitionReference(
  value: CognitionPredicate | undefined,
  removedTaskId: string,
): CognitionPredicate | null {
  if (!value) return null
  if (value.kind === 'task_transition') {
    return value.taskId === removedTaskId ? null : value
  }
  if (value.kind === 'all' || value.kind === 'any') {
    const children = value.children
      .map((child) => removeTaskTransitionReference(child, removedTaskId))
      .filter((child): child is CognitionPredicate => child !== null)
    return { ...value, children }
  }
  if (value.kind === 'not') {
    const child = removeTaskTransitionReference(value.child, removedTaskId)
    return child ? { ...value, child } : null
  }
  return value
}
type RawTaskTransitionRepair = {
  value: unknown
  changed: boolean
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function removeRawTaskTransitionReference(
  value: unknown,
  removedTaskId: string,
): RawTaskTransitionRepair {
  if (!isObjectRecord(value)) return { value, changed: false }
  if (value.kind === 'task_transition') {
    return value.taskId === removedTaskId
      ? { value: null, changed: true }
      : { value, changed: false }
  }
  if (value.kind === 'all' || value.kind === 'any') {
    if (!Array.isArray(value.children)) return { value, changed: false }
    let changed = false
    const children: unknown[] = []
    for (const child of value.children) {
      const repaired = removeRawTaskTransitionReference(child, removedTaskId)
      changed ||= repaired.changed
      if (repaired.value !== null || !repaired.changed) children.push(repaired.value)
    }
    return changed
      ? { value: { ...value, children }, changed: true }
      : { value, changed: false }
  }
  if (value.kind === 'not') {
    const repaired = removeRawTaskTransitionReference(value.child, removedTaskId)
    if (!repaired.changed) return { value, changed: false }
    return repaired.value === null
      ? { value: null, changed: true }
      : { value: { ...value, child: repaired.value }, changed: true }
  }
  return { value, changed: false }
}

function repairMalformedRuntimePolicyTaskReferences(
  rawRuntimePolicy: NonNullable<AgentConfigV2['runtimePolicy']>,
  removedTaskId: string,
): NonNullable<AgentConfigV2['runtimePolicy']> {
  const repaired = structuredClone(rawRuntimePolicy)
  if (!isObjectRecord(repaired)) return repaired
  const repairedRecord = repaired
  const pruneRequired = (value: unknown): unknown => {
    const repairedPredicate = removeRawTaskTransitionReference(value, removedTaskId)
    return repairedPredicate.changed && repairedPredicate.value === null
      ? { kind: 'all', children: [] }
      : repairedPredicate.value
  }
  const phasesKey: string = 'phases'
  const rawPhases = repairedRecord[phasesKey]
  if (Array.isArray(rawPhases)) {
    repairedRecord[phasesKey] = rawPhases.map((phase) => {
      if (!isObjectRecord(phase)) return phase
      const nextPhase = { ...phase }
      if (Object.hasOwn(phase, 'enter')) nextPhase.enter = pruneRequired(phase.enter)
      if (Object.hasOwn(phase, 'exit')) nextPhase.exit = pruneRequired(phase.exit)
      if (Object.hasOwn(phase, 'skip')) {
        const skip = removeRawTaskTransitionReference(phase.skip, removedTaskId)
        if (skip.changed && skip.value === null) delete nextPhase.skip
        else nextPhase.skip = skip.value
      }
      return nextPhase
    })
  }
  const loomPolicyKey: string = 'loomPolicy'
  const rawLoomPolicy = repairedRecord[loomPolicyKey]
  if (isObjectRecord(rawLoomPolicy)) {
    const nextLoomPolicy = { ...rawLoomPolicy }
    for (const bucket of POLICY_KEYS) {
      if (!Object.hasOwn(rawLoomPolicy, bucket)) continue
      const rawBucket = rawLoomPolicy[bucket]
      if (!Array.isArray(rawBucket)) continue
      nextLoomPolicy[bucket] = rawBucket.map((entry) => {
        if (!isObjectRecord(entry) || !Object.hasOwn(entry, 'condition')) return entry
        const condition = removeRawTaskTransitionReference(entry.condition, removedTaskId)
        if (!condition.changed) return entry
        const nextEntry = { ...entry }
        if (condition.value === null) delete nextEntry.condition
        else nextEntry.condition = condition.value
        return nextEntry
      })
    }
    repairedRecord[loomPolicyKey] = nextLoomPolicy
  }
  return repaired
}


function repairTaskTransitionReferencesAfterRemoval<T extends { activation?: CognitionPredicate }>(
  value: T,
  removedTaskId: string,
): T {
  if (!value.activation) return value
  const activation = removeTaskTransitionReference(value.activation, removedTaskId)
  if (activation) return { ...value, activation }
  const repaired = { ...value }
  delete repaired.activation
  return repaired
}

function repairRuntimePolicyTaskReferencesAfterRemoval(
  config: AgentConfigV2,
  removedTaskId: string,
): AgentConfigV2 {
  const rawRuntimePolicy = config.runtimePolicy
  if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
    return config
  }
  try {
    const runtimePolicy = parseAgentRuntimePolicyV1(rawRuntimePolicy)
    const phases = runtimePolicy.phases.map((phase) => {
      const enter = removeTaskTransitionReference(phase.enter, removedTaskId)
        ?? ({ kind: 'all', children: [] } as CognitionPredicate)
      const exit = removeTaskTransitionReference(phase.exit, removedTaskId)
        ?? ({ kind: 'all', children: [] } as CognitionPredicate)
      const skip = phase.skip === undefined
        ? {}
        : (() => {
            const next = removeTaskTransitionReference(phase.skip, removedTaskId)
            return next ? { skip: next } : {}
          })()
      return { ...phase, enter, exit, ...skip }
    })
    const loomPolicy = runtimePolicy.loomPolicy === null
      ? null
      : {
          version: 1,
          ...runtimePolicy.loomPolicy,
          ...Object.fromEntries(POLICY_KEYS.map((bucket) => [
            bucket,
            runtimePolicy.loomPolicy?.[bucket].map((entry) => {
              if (entry.condition === undefined) return entry
              const condition = removeTaskTransitionReference(entry.condition, removedTaskId)
              if (condition) return { ...entry, condition }
              const { condition: _condition, ...withoutCondition } = entry
              return withoutCondition
            }),
          ])),
        } as LoomPolicyBucketsV1
    return {
      ...config,
      runtimePolicy: {
        ...runtimePolicy,
        phases,
        loomPolicy,
      },
    }
  } catch {
    return {
      ...config,
      runtimePolicy: repairMalformedRuntimePolicyTaskReferences(
        rawRuntimePolicy,
        removedTaskId,
      ),
    }
  }
}

function rewriteRuntimePolicyTaskReferences(
  config: AgentConfigV2,
  previousId: string,
  nextId: string,
): AgentConfigV2 {
  const rawRuntimePolicy = (config as unknown as Record<string, unknown>).runtimePolicy
  if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
    return config
  }
  const runtimePolicy = rawRuntimePolicy as Record<string, unknown>
  try {
    const phases = parseAgentCustomPhasesV1(runtimePolicy.phases).map((phase) => ({
      ...phase,
      enter: rewriteTaskTransitionReferences(phase.enter, previousId, nextId) as CognitionPredicate,
      exit: rewriteTaskTransitionReferences(phase.exit, previousId, nextId) as CognitionPredicate,
      ...(phase.skip === undefined
        ? {}
        : { skip: rewriteTaskTransitionReferences(phase.skip, previousId, nextId) as CognitionPredicate }),
    }))
    const loomPolicy = runtimePolicy.loomPolicy === null
      ? null
      : parseLoomPolicyBucketsV1(runtimePolicy.loomPolicy)
    const rewriteBucket = (bucket: PolicyKey): LoomPolicyEntryV1[] => (
      (loomPolicy?.[bucket] ?? []).map((entry) => entry.condition === undefined
        ? entry
        : {
            ...entry,
            condition: rewriteTaskTransitionReferences(
              entry.condition,
              previousId,
              nextId,
            ) as CognitionPredicate,
          })
    )
    return {
      ...config,
      runtimePolicy: {
        ...runtimePolicy,
        phases,
        loomPolicy: loomPolicy === null
          ? null
          : {
              version: 1,
              workPolicy: rewriteBucket('workPolicy'),
              workspaceUsage: rewriteBucket('workspaceUsage'),
              completionCriteria: rewriteBucket('completionCriteria'),
              renderPolicy: rewriteBucket('renderPolicy'),
            },
      },
    } as unknown as AgentConfigV2
  } catch {
    return config
  }
}
function updateRuntimePolicyChildProfileAssignments(
  config: AgentConfigV2,
  previousProfileId: string,
  nextProfileId: string | null,
): AgentConfigV2 {
  const rawRuntimePolicy = (config as unknown as Record<string, unknown>).runtimePolicy
  if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
    return config
  }
  try {
    const runtimePolicy = parseAgentRuntimePolicyV1(rawRuntimePolicy)
    const phases = runtimePolicy.phases.map((phase) => ({
      ...phase,
      childInstructionSubsets: nextProfileId === null
        ? phase.childInstructionSubsets.filter((subset) => subset.profileId !== previousProfileId)
        : phase.childInstructionSubsets.map((subset) => (
            subset.profileId === previousProfileId
              ? { ...subset, profileId: nextProfileId }
              : subset
          )),
    }))
    return {
      ...config,
      runtimePolicy: {
        ...runtimePolicy,
        phases,
      },
    }
  } catch {
    // Preserve malformed imported policy for the existing repair surface.
    return config
  }
}



type PredicateScalarType = 'string' | 'number' | 'boolean'
type PredicateValueType = PredicateScalarType | 'string_list'

function PredicateValueEditor({
  value,
  onChange,
  allowStringList = false,
  disabled = false,
}: {
  value: CognitionValue
  onChange: (value: CognitionValue) => void
  allowStringList?: boolean
  disabled?: boolean
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const valueType: PredicateValueType = Array.isArray(value)
    ? 'string_list'
    : typeof value as PredicateScalarType
  return (
    <div className={styles.predicateValueControls}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('predicate.valueType')}</span>
        <select
          className={styles.select}
          value={valueType}
          disabled={disabled}
          aria-label={t('predicate.valueType')}
          onChange={(event) => {
            const type = event.target.value as PredicateValueType
            onChange(type === 'number'
              ? 0
              : type === 'boolean'
                ? false
                : type === 'string_list'
                  ? ['']
                  : '')
          }}
        >
          <option value="string">{t('predicate.valueTypes.string')}</option>
          <option value="number">{t('predicate.valueTypes.number')}</option>
          <option value="boolean">{t('predicate.valueTypes.boolean')}</option>
          {allowStringList && <option value="string_list">{t('predicate.valueTypes.stringList')}</option>}
        </select>
      </label>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('predicate.value')}</span>
        {valueType === 'boolean' ? (
          <select
            className={styles.select}
            value={value === true ? 'true' : 'false'}
            disabled={disabled}
            aria-label={t('predicate.value')}
            onChange={(event) => onChange(event.target.value === 'true')}
          >
            <option value="true">{t('predicate.boolean.true')}</option>
            <option value="false">{t('predicate.boolean.false')}</option>
          </select>
        ) : valueType === 'number' ? (
          <input
            className={styles.input}
            type="number"
            step="any"
            value={value as number}
            disabled={disabled}
            aria-label={t('predicate.value')}
            onChange={(event) => {
              const next = event.target.valueAsNumber
              if (Number.isFinite(next)) onChange(next)
            }}
          />
        ) : (
          <input
            className={styles.input}
            value={Array.isArray(value) ? value.join(', ') : value as string}
            disabled={disabled}
            aria-label={t('predicate.value')}
            onChange={(event) => {
              const next = Array.isArray(value)
                ? event.target.value.split(',').map((entry) => entry.trim())
                : event.target.value
              if (isEditablePredicateValue(next)) onChange(next)
            }}
          />
        )}
      </label>
    </div>
  )
}

function PredicateScalarListEditor({
  values,
  onChange,
  disabled = false,
}: {
  values: CognitionScalar[]
  onChange: (values: CognitionScalar[]) => void
  disabled?: boolean
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  return (
    <fieldset className={styles.predicateValueList} disabled={disabled}>
      <legend className={styles.fieldLabel}>{t('predicate.values')}</legend>
      {values.map((entry, index) => (
        <div className={styles.predicateValueRow} key={index}>
          <PredicateValueEditor
            value={entry}
            disabled={disabled}
            onChange={(next) => {
              if (Array.isArray(next)
                || values.some((candidate, candidateIndex) => (
                  candidateIndex !== index
                  && typeof candidate === typeof next
                  && candidate === next
                ))) return
              onChange(values.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate))
            }}
          />
          <button
            type="button"
            className={styles.iconButton}
            disabled={disabled || values.length === 1}
            onClick={() => onChange(values.filter((_candidate, candidateIndex) => candidateIndex !== index))}
            aria-label={t('predicate.removeValue', { number: index + 1 })}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.button}
        disabled={disabled || values.length >= AGENTIC_PREDICATE_MAX_LIST_ITEMS}
        onClick={() => {
          let suffix = values.length + 1
          let candidate = `value_${suffix}`
          while (values.some((value) => value === candidate)) {
            suffix += 1
            candidate = `value_${suffix}`
          }
          onChange([...values, candidate])
        }}
      >
        <Plus size={16} aria-hidden="true" />
        {t('predicate.addValue')}
      </button>
    </fieldset>
  )
}


function FieldError({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null
  return <span className={styles.fieldError} id={id} role="alert">{children}</span>
}

function PredicateEditor({
  value,
  onChange,
  taskTemplateIds,
  depth = 0,
  disabled = false,
}: {
  value: CognitionPredicate
  onChange: (value: CognitionPredicate) => void
  taskTemplateIds: readonly string[]
  depth?: number
  disabled?: boolean
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const updateKind = (kind: CognitionPredicate['kind']) => {
    if (depth >= AGENTIC_PREDICATE_MAX_DEPTH - 1
      && (kind === 'all' || kind === 'any' || kind === 'not')) return
    onChange(makePredicate(kind))
  }
  return (
    <div className={clsx(styles.predicate, depth > 0 && styles.predicateNested)}>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{t('predicate.kind')}</span>
        <select
          className={styles.select}
          value={value.kind}
          disabled={disabled}
          onChange={(event) => updateKind(event.target.value as CognitionPredicate['kind'])}
        >
          {PREDICATE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{t(`predicate.kinds.${kind}`)}</option>
          ))}
        </select>
      </label>
      {(value.kind === 'all' || value.kind === 'any') && (
        <div className={styles.predicateChildren}>
          {value.children.map((predicate, index) => (
            <div className={styles.predicateChild} key={index}>
              <PredicateEditor
                value={predicate}
                taskTemplateIds={taskTemplateIds}
                depth={depth + 1}
                disabled={disabled}
                onChange={(next) => onChange({
                  ...value,
                  children: value.children.map((candidate, candidateIndex) => (
                    candidateIndex === index ? next : candidate
                  )),
                })}
              />
              <button
                type="button"
                className={styles.iconButton}
                disabled={disabled || value.children.length === 1}
                onClick={() => onChange({
                  ...value,
                  children: value.children.filter((_candidate, candidateIndex) => candidateIndex !== index),
                })}
                aria-label={t('predicate.remove')}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className={styles.button}
            disabled={disabled || value.children.length >= AGENTIC_PREDICATE_MAX_NODES - 1}
            onClick={() => onChange({
              ...value,
              children: [...value.children, { kind: 'phase', value: 'WORK' }],
            })}
          >
            <Plus size={16} aria-hidden="true" />
            {t('predicate.add')}
          </button>
        </div>
      )}
      {value.kind === 'not' && (
        <PredicateEditor
          value={value.child}
          taskTemplateIds={taskTemplateIds}
          depth={depth + 1}
          disabled={disabled}
          onChange={(child) => onChange({ ...value, child })}
        />
      )}
      {value.kind === 'generation_type' && (
        <select
          className={styles.select}
          value={value.value}
          disabled={disabled}
          aria-label={t('predicate.generationType')}
          onChange={(event) => onChange({ ...value, value: event.target.value as typeof value.value })}
        >
          {(['normal', 'continue', 'regenerate', 'swipe'] as const).map((generationType) => (
            <option key={generationType} value={generationType}>{t(`generationTypes.${generationType}`)}</option>
          ))}
        </select>
      )}
      {value.kind === 'phase' && (
        <select
          className={styles.select}
          value={value.value}
          disabled={disabled}
          aria-label={t('predicate.phase')}
          onChange={(event) => onChange({ ...value, value: event.target.value as typeof value.value })}
        >
          {(['ASSEMBLE', 'WORK', 'COMPLETE', 'RENDER', 'PREPARE_COMMIT', 'COMMITTING', 'COMMITTED',
            'COMMIT_FAILED', 'EXHAUSTED', 'FAILED', 'CANCELLED', 'TIMED_OUT'] as const).map((phase) => (
            <option key={phase} value={phase}>{t(`phases.names.${phase.toLowerCase()}`)}</option>
          ))}
        </select>
      )}
      {(value.kind === 'preset_variable' || value.kind === 'participant_fact') && (
        <div className={styles.inlineFields}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {value.kind === 'preset_variable' ? t('predicate.variableKey') : t('predicate.factKey')}
            </span>
            <input
              className={styles.input}
              value={value.name}
              maxLength={AGENTIC_PREDICATE_MAX_ID_BYTES}
              disabled={disabled}
              onChange={(event) => {
                if (isEditablePredicateId(event.target.value)) {
                  onChange({ ...value, name: event.target.value })
                }
              }}
              aria-label={value.kind === 'preset_variable' ? t('predicate.variableKey') : t('predicate.factKey')}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('predicate.operator')}</span>
            <select
              className={styles.select}
              value={value.operator}
              disabled={disabled}
              aria-label={t('predicate.operator')}
              onChange={(event) => {
                const operator = event.target.value as typeof value.operator
                if (operator === 'present') {
                  onChange({ kind: value.kind, name: value.name, operator })
                } else if (operator === 'in') {
                  const candidates: CognitionScalar[] = 'values' in value && value.values.length > 0
                    ? [...value.values]
                    : 'value' in value
                      ? isCognitionScalar(value.value) ? [value.value] : value.value
                      : ['']
                  const values = candidates.filter((candidate, candidateIndex) => (
                    candidates.findIndex((entry) => (
                      typeof entry === typeof candidate && entry === candidate
                    )) === candidateIndex
                  ))
                  onChange({ kind: value.kind, name: value.name, operator, values })
                } else {
                  const candidateValue: CognitionValue = 'value' in value
                    ? value.value
                    : 'values' in value
                      ? value.values[0] ?? ''
                      : ''
                  if (operator === 'includes') {
                    onChange({
                      kind: value.kind,
                      name: value.name,
                      operator,
                      value: isCognitionScalar(candidateValue)
                        ? candidateValue
                        : candidateValue[0] ?? '',
                    })
                  } else {
                    onChange({ kind: value.kind, name: value.name, operator, value: candidateValue })
                  }
                }
              }}
            >
              {(['equals', 'in', 'includes', 'present'] as const).map((operator) => (
                <option key={operator} value={operator}>{t(`predicate.operators.${operator}`)}</option>
              ))}
            </select>
          </label>
          {value.operator === 'in' ? (
            <PredicateScalarListEditor
              values={value.values}
              disabled={disabled}
              onChange={(values) => onChange({ ...value, values })}
            />
          ) : value.operator !== 'present' ? (
            <PredicateValueEditor
              value={value.value}
              allowStringList={value.operator === 'equals'}
              disabled={disabled}
              onChange={(next) => {
                if (value.operator === 'includes' && Array.isArray(next)) return
                onChange({ ...value, value: next } as CognitionPredicate)
              }}
            />
          ) : null}
        </div>
      )}
      {value.kind === 'tool_available' && (
        <div className={styles.inlineFields}>
          <select
            className={styles.select}
            value={value.toolId}
            disabled={disabled}
            aria-label={t('predicate.tool')}
            onChange={(event) => onChange({ ...value, toolId: event.target.value })}
          >
            {CORE_AGENT_TOOL_IDS.map((toolId) => <option key={toolId} value={toolId}>{toolId}</option>)}
          </select>
          <label className={styles.inlineCheckbox}>
            <input type="checkbox" checked={value.available} disabled={disabled} onChange={(event) => onChange({ ...value, available: event.target.checked })} />
            {t('predicate.available')}
          </label>
        </div>
      )}
      {value.kind === 'task_transition' && (
        <div className={styles.inlineFields}>
          <select
            className={styles.select}
            value={value.taskId}
            disabled={disabled}
            aria-label={t('predicate.task')}
            onChange={(event) => {
              if (event.target.value) onChange({ ...value, taskId: event.target.value })
            }}
          >
            <option value="">{t('predicate.chooseTask')}</option>
            {taskTemplateIds.map((templateId) => (
              <option key={templateId} value={templateId}>{templateId}</option>
            ))}
          </select>
          <select
            className={styles.select}
            value={value.transition}
            disabled={disabled}
            aria-label={t('predicate.transition')}
            onChange={(event) => onChange({ ...value, transition: event.target.value as typeof value.transition })}
          >
            {(['pending', 'active', 'blocked', 'completed', 'cancelled', 'failed'] as const).map((transition) => (
              <option key={transition} value={transition}>{t(`predicate.transitions.${transition}`)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

function ToolChecklist({
  selected,
  onChange,
  legend,
  disabled = false,
}: {
  selected: readonly CoreAgentToolId[]
  onChange: (toolIds: CoreAgentToolId[]) => void
  legend: string
  disabled?: boolean
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agentsTools' })
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <legend className={styles.fieldLabel}>{legend}</legend>
      <div className={styles.toolGrid}>
        {CORE_AGENT_TOOL_IDS.map((toolId) => {
          const checked = selected.includes(toolId)
          return (
            <label className={clsx(styles.choiceCard, checked && styles.choiceCardSelected)} key={toolId}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => onChange(checked
                  ? selected.filter((selectedId) => selectedId !== toolId)
                  : [...selected, toolId])}
              />
              <span>
                <strong>{t(`tools.${toolId}.label`)}</strong>
                <small>{t(`tools.${toolId}.description`)}</small>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function WorkspaceCapabilityChecklist({
  selected,
  onChange,
  legend,
  hint,
  disabled = false,
}: {
  selected: readonly WorkspaceCapability[]
  onChange: (capabilities: WorkspaceCapability[]) => void
  legend: string
  hint: string
  disabled?: boolean
}) {
  const { t: chatT } = useTranslation('chat')
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <legend className={styles.fieldLabel}>{legend}</legend>
      <p className={styles.muted}>{hint}</p>
      <div className={styles.toolGrid}>
        {WORKSPACE_CAPABILITIES.map((capability) => {
          const checked = selected.includes(capability)
          return (
            <label className={clsx(styles.choiceCard, checked && styles.choiceCardSelected)} key={capability}>
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  const next = new Set(selected)
                  if (checked) next.delete(capability)
                  else next.add(capability)
                  onChange(WORKSPACE_CAPABILITIES.filter((candidate) => next.has(candidate)))
                }}
              />
              <span><strong>{chatT(`agentRun.tools.${WORKSPACE_TOOL_KEYS[capability]}`)}</strong></span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <header className={styles.sectionHeader}>
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  )
}

function RepairRow({
  item,
  acknowledged,
  onAcknowledge,
  onRepair,
}: {
  item: PanelRepairItem
  acknowledged: boolean
  onAcknowledge: (checked: boolean) => void
  onRepair?: () => void
}) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const kindLabel = t(`repair.kinds.${item.kind}`, { defaultValue: t('repair.kinds.unknown') })
  const reasonLabel = t(`repair.reasons.${item.reasonCode}`, { defaultValue: t('repair.reasons.unknown') })
  const actionLabel = t(`repair.actions.${item.action.kind}`, { defaultValue: t('repair.actions.unknown') })
  const hasRepairAction = item.action.kind === 'select_revision' && onRepair !== undefined
  const repairActionLabel = item.id.startsWith('loom-policy:')
    && item.reasonCode !== 'stale_policy_source'
    ? t('repair.actions.discard')
    : actionLabel
  return (
    <li className={styles.repairItem}>
      <AlertTriangle size={18} aria-hidden="true" />
      <span className={styles.repairCopy}>
        <strong>{kindLabel}</strong>
        <small>{reasonLabel}</small>
        {item.label && <code className={styles.repairPath}>{item.label}</code>}
      </span>
      {hasRepairAction ? (
        <button type="button" className={styles.button} onClick={() => onRepair?.()}>{repairActionLabel}</button>
      ) : item.action.kind !== 'acknowledge' && item.kind !== 'disabled_import' ? (
        <span className={styles.actionBadge}>{actionLabel}</span>
      ) : null}
      <label className={styles.acknowledge}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => onAcknowledge(event.target.checked)}
        />
        {t('repair.acknowledge')}
      </label>
    </li>
  )
}

function providerSupportsAgentCapability(
  provider: ProviderInfo | undefined,
  capability: AgentCapability,
): boolean {
  if (!provider) return false
  const capabilities = provider.capabilities
  switch (capability) {
    case 'generation':
      return true
    case 'streaming':
      return capabilities?.supportsStreaming === true
    case 'tool_calling':
      return capabilities?.toolCalling === true
    case 'native_tool_continuation': {
      const mode = capabilities?.toolContinuationMode
      if (mode === 'native') {
        return capabilities.nativeToolContinuation === true && capabilities.toolCalling === true
      }
      return mode === 'legacy' && capabilities.toolCalling === true
    }
    case 'tools_disabled_finalization':
      return capabilities?.toolsDisabledFinalization === true
        || capabilities?.supportsToolFinalization === true
  }
}

function providerSupportsAgentCapabilities(
  providers: readonly ProviderInfo[],
  providerId: string,
  requiredCapabilities: readonly AgentCapability[],
): boolean {
  const provider = providers.find((candidate) => candidate.id === providerId)
  return requiredCapabilities.every((capability) => providerSupportsAgentCapability(provider, capability))
}


function reviewSlotId(item: AgentConfigRepairItem): string | null {
  const prefix = item.kind === 'unresolved_slot'
    ? 'slot:'
    : item.kind === 'stale_slot'
      ? 'stale-slot:'
      : null
  return prefix && item.id.startsWith(prefix) ? item.id.slice(prefix.length) : null
}
function revisePromptBlockContent(block: PromptBlock, content: unknown): PromptBlock {
  if (typeof content !== 'string' || content === block.content) return block
  const currentRevision = block.revision ?? 1
  if (!isCanonicalBlockRevision(currentRevision)
    || currentRevision === Number.MAX_SAFE_INTEGER) {
    return block
  }
  return { ...block, content, revision: currentRevision + 1 }
}

function hydrateDraftFromEditor(
  current: AgenticRuntimeSaveDraft,
  editor: AgenticRuntimeEditorProjection,
  sourceBlocks: readonly PromptBlock[],
): AgenticRuntimeSaveDraft {
  const hasConfigProjection = editor.config !== null
    && typeof editor.config === 'object'
    && !Array.isArray(editor.config)
  const rawConfig = hasConfigProjection
    ? structuredClone(editor.config) as AgenticRuntimeSaveDraft['config']
    : current.config
  const slotBindings = editor.slotBindings && typeof editor.slotBindings === 'object' && !Array.isArray(editor.slotBindings)
    ? { ...editor.slotBindings }
    : current.slotBindings
  const quarantine = getAgentConfigQuarantine(rawConfig)
  return {
    config: normalizeAgentConfigForEditor(rawConfig, sourceBlocks),
    slotBindings,
    taskTemplates: editor.taskTemplates === undefined
      ? current.taskTemplates
      : structuredClone(editor.taskTemplates as unknown as AgenticRuntimeSaveDraft['taskTemplates']),
    reviewAcknowledgements: Array.isArray(editor.reviewAcknowledgements)
      ? [...editor.reviewAcknowledgements]
      : current.reviewAcknowledgements,
    quarantinedProfiles: hasConfigProjection ? quarantine.profiles : current.quarantinedProfiles,
    quarantinedConnectionSlots: hasConfigProjection
      ? quarantine.connectionSlots
      : current.quarantinedConnectionSlots,
  }
}
type EditorIdentity = {
  presetId: string
  presetRevision: number
  configRevision: number
}

function editorIdentityMatchesParent(
  identity: EditorIdentity | null,
  presetId: string,
  presetRevision: number,
  configRevision: number,
): boolean {
  return identity !== null
    && identity.presetId === presetId
    && identity.presetRevision === presetRevision
    && identity.configRevision === configRevision
}

function editorIdentityConverged(
  identity: EditorIdentity | null,
  presetId: string,
  presetRevision: number,
  configRevision: number,
  returned: EditorIdentity | null,
): boolean {
  if (editorIdentityMatchesParent(identity, presetId, presetRevision, configRevision)) return true
  if (!identity || !returned) return false
  if (identity.presetId !== returned.presetId
    || identity.presetRevision !== returned.presetRevision
    || identity.configRevision !== returned.configRevision
    || returned.presetId !== presetId) return false
  return presetRevision <= returned.presetRevision && configRevision <= returned.configRevision
}

type GenuineConflictSource = 'save_conflict' | 'external_hydration' | 'load_failure'

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function readMatchedEditorSnapshot(value: SaveAgenticRuntimeEditorResult): {
  editor: AgenticRuntimeEditorProjection
  preset: LoomPreset
  promptOrder: PromptBlock[]
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as unknown as Record<string, unknown>
  if (!record.preset || typeof record.preset !== 'object' || Array.isArray(record.preset)) return null
  if (!record.editor || typeof record.editor !== 'object' || Array.isArray(record.editor)) return null
  const presetRecord = record.preset as Record<string, unknown>
  const editorRecord = record.editor as Record<string, unknown>
  if (typeof presetRecord.id !== 'string' || presetRecord.id.length === 0) return null
  if (typeof editorRecord.presetId !== 'string' || editorRecord.presetId.length === 0) return null
  if (!isNonNegativeSafeInteger(presetRecord.cache_revision)
    || !isNonNegativeSafeInteger(presetRecord.agent_config_revision)
    || !isNonNegativeSafeInteger(editorRecord.presetRevision)
    || !isNonNegativeSafeInteger(editorRecord.configRevision)) return null
  if (presetRecord.id !== editorRecord.presetId
    || presetRecord.cache_revision !== editorRecord.presetRevision
    || presetRecord.agent_config_revision !== editorRecord.configRevision) return null
  if (editorRecord.config === null || typeof editorRecord.config !== 'object' || Array.isArray(editorRecord.config)) return null
  try {
    const reloadedPreset = unmarshalPreset(record.preset as Parameters<typeof unmarshalPreset>[0])
    return {
      editor: record.editor as AgenticRuntimeEditorProjection,
      preset: reloadedPreset,
      promptOrder: structuredClone(reloadedPreset.blocks),
    }
  } catch {
    return null
  }
}



export default function AgenticRuntimePanel({ preset, onSave, onReload, onDirtyChange }: AgenticRuntimePanelProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.agenticRuntime' })
  const { t: agentsT } = useTranslation('panels', { keyPrefix: 'loomBuilder.agentsTools' })
  const providers = useStore((state) => state.providers)
  const initialDraft = useMemo(() => createAgenticRuntimeDraft(preset), [preset])
  const [draft, setDraft] = useState(initialDraft)
  const [promptOrder, setPromptOrder] = useState(() => structuredClone(preset.blocks))
  const draftRef = useRef(draft)
  draftRef.current = draft
  const promptOrderRef = useRef(promptOrder)
  promptOrderRef.current = promptOrder
  const saveInFlightRef = useRef(false)
  const committedDraftRef = useRef<AgenticRuntimeSaveDraft>(structuredClone(initialDraft))
  const committedPromptOrderRef = useRef<PromptBlock[]>(structuredClone(preset.blocks))
  const observedPresetIdRef = useRef(preset.id)

  const observedPresetRevisionRef = useRef(preset.cacheRevision ?? 0)
  const observedConfigRevisionRef = useRef(preset.agentConfigRevision ?? 0)
  const hydratedIdentityRef = useRef<EditorIdentity | null>(null)
  const lastReturnedIdentityRef = useRef<EditorIdentity | null>(null)
  const isHydratedRef = useRef(false)
  const pendingExternalDraftRef = useRef<AgenticRuntimeSaveDraft | null>(null)
  const pendingExternalPromptOrderRef = useRef<PromptBlock[] | null>(null)
  const conflictSourceRef = useRef<GenuineConflictSource | null>(null)
  const conflictReloadGenerationRef = useRef(0)
  const currentPresetIdentityRef = useRef<EditorIdentity>({
    presetId: preset.id,
    presetRevision: preset.cacheRevision ?? 0,
    configRevision: preset.agentConfigRevision ?? 0,
  })
  currentPresetIdentityRef.current = {
    presetId: preset.id,
    presetRevision: preset.cacheRevision ?? 0,
    configRevision: preset.agentConfigRevision ?? 0,
  }
  const [isHydrated, setIsHydrated] = useState(false)
  isHydratedRef.current = isHydrated
  const [editorLoadError, setEditorLoadError] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('activation')
  const [repairedSlotIds, setRepairedSlotIds] = useState<Set<string>>(() => new Set())
  const [selectedProfileIndex, setSelectedProfileIndex] = useState(0)
  const [hostCeilings, setHostCeilings] = useState<AgenticRuntimeHostCeilings | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'conflict' | 'error'>('idle')
  const [conflictRecoveryState, setConflictRecoveryState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [loomRevisionRestagePending, setLoomRevisionRestagePending] = useState(false)
  const [maxInvocationsInput, setMaxInvocationsInput] = useState(String(initialDraft.config.maxInvocations))
  const [maxToolCallsInput, setMaxToolCallsInput] = useState(String(initialDraft.config.maxToolCalls))
  const tabRefs = useRef(new Map<SectionId, HTMLButtonElement>())
  const fingerprint = runtimeDraftFingerprint(draft)
  const promptOrderFingerprint = JSON.stringify(promptOrder)
  const combinedFingerprint = `${fingerprint}\n${promptOrderFingerprint}`
  const [savedFingerprint, setSavedFingerprint] = useState(
    () => `${runtimeDraftFingerprint(initialDraft)}\n${JSON.stringify(preset.blocks)}`,
  )
  const dirty = combinedFingerprint !== savedFingerprint || loomRevisionRestagePending
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const draftConfigRecord = draft.config && typeof draft.config === 'object'
    ? draft.config as unknown as Record<string, unknown>
    : {}
  const draftProfiles = Array.isArray(draftConfigRecord.profiles)
    ? draftConfigRecord.profiles as AgentProfileConfigV2[]
    : []
  const draftSlotBindings = draft.slotBindings && typeof draft.slotBindings === 'object'
    ? draft.slotBindings
    : {}
  const draftTaskTemplates = draft.taskTemplates
  const draftAllowedModes = draft.config.allowedModes
  const draftLoomPolicy = useMemo(
    () => getAgentRuntimePolicyBuckets(draft.config, promptOrder),
    [draft.config, promptOrder],
  )
  const draftCustomPhases = useMemo(
    () => getAgentRuntimeCustomPhases(draft.config),
    [draft.config],
  )
  const presetRepairItems = useMemo(() => getAgenticRuntimeRepairItems(preset), [preset])
  const [editorReviewItems, setEditorReviewItems] = useState(presetRepairItems)
  const projectedReviewItems = useMemo(() => editorReviewItems.filter((item) => {
    const slotId = reviewSlotId(item)
    if (slotId === null || draftSlotBindings[slotId] == null) return true
    return item.kind === 'stale_slot' ? !repairedSlotIds.has(slotId) : false
  }), [draftSlotBindings, editorReviewItems, repairedSlotIds])
  const requiredReviewIds = useMemo(
    () => requiredReviewAcknowledgements(projectedReviewItems.map((item) => item.id), draft.reviewAcknowledgements),
    [draft.reviewAcknowledgements, projectedReviewItems],
  )
  const validation = useMemo(() => validateAgenticRuntimeDraft(
    draft,
    promptOrder,
    preset.cacheRevision ?? 0,
    requiredReviewIds,
  ), [draft, promptOrder, preset.cacheRevision, requiredReviewIds])
  const policyRepairItems = useMemo<PanelRepairItem[]>(() => {
    const seen = new Set<string>()
    return validation.issues
      .filter((issue) => /^config\.(?:runtimePolicy|cognitionPolicy)(?:\.|$)/.test(issue.path))
      .filter((issue) => {
        if (seen.has(issue.path)) return false
        seen.add(issue.path)
        return true
      })
      .map((issue) => ({
        id: `loom-policy:${issue.path}`,
        kind: issue.code === 'stale_policy_source' ? 'stale_block' as const : 'invalid_rule' as const,
        label: issue.path,
        reasonCode: issue.code,
        action: { kind: 'select_revision' as const },
        acknowledged: false,
      }))
  }, [validation.issues])
  const reviewItems = useMemo(
    () => [...projectedReviewItems, ...policyRepairItems],
    [policyRepairItems, projectedReviewItems],
  )
  const unacknowledgedReviewItems = reviewItems.filter((item) => item.id.startsWith('loom-policy:') || !draft.reviewAcknowledgements.includes(item.id))
  const selectedProfile = draftProfiles[selectedProfileIndex] ?? null
  const taskTemplateIds = draftTaskTemplates.flatMap((template) => isAgentTaskTemplate(template) ? [template.id] : [])
  const maxInvocationsInvalid = Number.isNaN(parseAgentMaxInvocationsInput(maxInvocationsInput))
  const maxToolCallsInvalid = Number.isNaN(parseAgentMaxToolCallsInput(maxToolCallsInput))
  const hydratedIdentity = hydratedIdentityRef.current
  const hasHydratedEditor = isHydrated && hydratedIdentity?.presetId === preset.id
  const isHydratedForCurrentPreset = hasHydratedEditor
    && editorIdentityConverged(
      hydratedIdentity,
      preset.id,
      preset.cacheRevision ?? 0,
      preset.agentConfigRevision ?? 0,
      lastReturnedIdentityRef.current,
    )
  const hasPendingExternalSnapshot = pendingExternalDraftRef.current !== null
    && pendingExternalPromptOrderRef.current !== null
  const canSave = isHydratedForCurrentPreset
    && dirty
    && saveState !== 'saving'
    && saveState !== 'conflict'
    && validation.valid
    && !maxInvocationsInvalid
    && !maxToolCallsInvalid
  const canReset = dirty
    && saveState !== 'saving'
    && (isHydratedForCurrentPreset
      || !editorLoadError && saveState === 'conflict' && hasPendingExternalSnapshot)
  const draftControlsLocked = !isHydratedForCurrentPreset || saveState === 'saving'




  useEffect(() => {
    onDirtyChange(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  useEffect(() => {
    conflictReloadGenerationRef.current += 1
    setConflictRecoveryState('idle')
  }, [preset.id])

  useEffect(() => {
    let active = true
    const currentPresetRevision = preset.cacheRevision ?? 0
    const currentConfigRevision = preset.agentConfigRevision ?? 0
    const revisionChanged = observedPresetIdRef.current !== preset.id
      || observedPresetRevisionRef.current !== currentPresetRevision
      || observedConfigRevisionRef.current !== currentConfigRevision

    if (
      !dirtyRef.current
      && isHydratedRef.current
      && editorIdentityConverged(
        hydratedIdentityRef.current,
        preset.id,
        currentPresetRevision,
        currentConfigRevision,
        lastReturnedIdentityRef.current,
      )
    ) {
      observedPresetIdRef.current = preset.id
      observedPresetRevisionRef.current = currentPresetRevision
      observedConfigRevisionRef.current = currentConfigRevision
      return
    }

    observedPresetIdRef.current = preset.id
    observedPresetRevisionRef.current = currentPresetRevision
    observedConfigRevisionRef.current = currentConfigRevision
    hydratedIdentityRef.current = null
    lastReturnedIdentityRef.current = null
    pendingExternalDraftRef.current = null
    pendingExternalPromptOrderRef.current = null
    setHostCeilings(null)
    setIsHydrated(false)
    setEditorLoadError(false)
    if (dirtyRef.current && revisionChanged) {
      conflictSourceRef.current = 'external_hydration'
      setSaveState('conflict')
    }
    void agenticRuntimeApi.getEditor(preset.id).then(async (projection) => {
      if (!active) return
      let hydrationPreset = preset
      let hydrationPromptOrder = preset.blocks
      let reconciledIdentity = false
      const projectionShapeValid = projection.presetId === preset.id
        && isNonNegativeSafeInteger(projection.presetRevision)
        && isNonNegativeSafeInteger(projection.configRevision)
        && projection.config !== null
        && typeof projection.config === 'object'
        && !Array.isArray(projection.config)
      const matched = projectionShapeValid
        && projection.presetRevision === currentPresetRevision
        && projection.configRevision === currentConfigRevision
      if (!projectionShapeValid || !matched && dirtyRef.current) {
        hydratedIdentityRef.current = null
        pendingExternalDraftRef.current = null
        pendingExternalPromptOrderRef.current = null
        setHostCeilings(null)
        setIsHydrated(false)
        setEditorLoadError(true)
        conflictSourceRef.current = dirtyRef.current || revisionChanged ? 'external_hydration' : null
        setSaveState(dirtyRef.current || revisionChanged ? 'conflict' : 'error')
        return
      }
      if (!matched) {
        const snapshot = readMatchedEditorSnapshot(await onReload())
        if (!active) return
        if (!snapshot
          || snapshot.editor.presetId !== preset.id
          || snapshot.editor.presetRevision < projection.presetRevision
          || snapshot.editor.configRevision < projection.configRevision) {
          throw new Error('Initial runtime reload did not return a current matched preset/editor snapshot')
        }
        projection = snapshot.editor
        hydrationPreset = snapshot.preset
        hydrationPromptOrder = snapshot.promptOrder
        reconciledIdentity = true
      }
      const projectedReviewItems = getAgenticRuntimeRepairItems({
        ...hydrationPreset,
        agentConfigReview: projection.review,
      })
      const identity = {
        presetId: projection.presetId,
        presetRevision: projection.presetRevision,
        configRevision: projection.configRevision,
      }
      if (reconciledIdentity) lastReturnedIdentityRef.current = identity
      if (dirtyRef.current) {
        pendingExternalDraftRef.current = hydrateDraftFromEditor(draftRef.current, projection, hydrationPromptOrder)
        pendingExternalPromptOrderRef.current = structuredClone(hydrationPromptOrder)
        hydratedIdentityRef.current = identity
        setHostCeilings(projection.hostCeilings)
        setEditorReviewItems(projectedReviewItems)
        setIsHydrated(true)
        setEditorLoadError(false)
        if (revisionChanged) {
          conflictSourceRef.current = 'external_hydration'
          setSaveState('conflict')
        }
        return
      }
      const hydrated = hydrateDraftFromEditor(draftRef.current, projection, hydrationPromptOrder)
      const nextPromptOrder = structuredClone(hydrationPromptOrder)
      committedDraftRef.current = structuredClone(hydrated)
      committedPromptOrderRef.current = nextPromptOrder
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      setRepairedSlotIds(new Set())
      setLoomRevisionRestagePending(false)
      setHostCeilings(projection.hostCeilings)
      setEditorReviewItems(projectedReviewItems)
      setDraft(hydrated)
      setPromptOrder(nextPromptOrder)
      setMaxInvocationsInput(String(hydrated.config.maxInvocations))
      setMaxToolCallsInput(String(hydrated.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(hydrated)}\n${JSON.stringify(nextPromptOrder)}`)
      hydratedIdentityRef.current = identity
      setIsHydrated(true)
      setEditorLoadError(false)
      conflictSourceRef.current = null
      setSaveState('idle')
    }).catch((error: unknown) => {
      if (!active) return
      const missingProjection = error instanceof ApiError && error.status === 404
      if (!missingProjection || dirtyRef.current) {
        console.error('[AgenticRuntimePanel] Failed to load the runtime editor:', error)
        hydratedIdentityRef.current = null
        pendingExternalDraftRef.current = null
        pendingExternalPromptOrderRef.current = null
        setIsHydrated(false)
        setEditorLoadError(true)
        if (dirtyRef.current) {
          conflictSourceRef.current = 'load_failure'
          setSaveState('conflict')
        } else {
          conflictSourceRef.current = null
          setSaveState('error')
        }
        return
      }
      const local = createAgenticRuntimeDraft(preset)
      const nextPromptOrder = structuredClone(preset.blocks)
      committedDraftRef.current = structuredClone(local)
      committedPromptOrderRef.current = nextPromptOrder
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      observedConfigRevisionRef.current = currentConfigRevision
      setRepairedSlotIds(new Set())
      setLoomRevisionRestagePending(false)
      setEditorReviewItems(getAgenticRuntimeRepairItems(preset))
      setDraft(local)
      setPromptOrder(nextPromptOrder)
      setMaxInvocationsInput(String(local.config.maxInvocations))
      setMaxToolCallsInput(String(local.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(local)}\n${JSON.stringify(nextPromptOrder)}`)
      hydratedIdentityRef.current = {
        presetId: preset.id,
        presetRevision: currentPresetRevision,
        configRevision: currentConfigRevision,
      }
      setIsHydrated(true)
      setEditorLoadError(false)
      conflictSourceRef.current = null
      setSaveState('idle')
    })
    return () => {
      active = false
    }
  }, [preset.id, preset.cacheRevision, preset.agentConfigRevision])

  const reloadLatestForReview = async () => {
    if (saveInFlightRef.current || conflictRecoveryState === 'loading') return
    const generation = conflictReloadGenerationRef.current + 1
    conflictReloadGenerationRef.current = generation
    const startedIdentity = { ...currentPresetIdentityRef.current }
    const targetPresetId = startedIdentity.presetId
    setConflictRecoveryState('loading')
    try {
      const reloaded = await onReload()
      if (generation !== conflictReloadGenerationRef.current) return
      const snapshot = readMatchedEditorSnapshot(reloaded)
      if (!snapshot || snapshot.editor.presetId !== targetPresetId) {
        throw new Error('Reload did not return a matched preset/editor snapshot')
      }
      const projection = snapshot.editor
      const currentIdentity = currentPresetIdentityRef.current
      const parentStillStarted = editorIdentityMatchesParent(
        currentIdentity,
        startedIdentity.presetId,
        startedIdentity.presetRevision,
        startedIdentity.configRevision,
      )
      const parentMatchesReload = editorIdentityMatchesParent(
        currentIdentity,
        projection.presetId,
        projection.presetRevision,
        projection.configRevision,
      )
      if (!parentStillStarted && !parentMatchesReload) {
        setConflictRecoveryState('idle')
        return
      }
      const nextPromptOrder = snapshot.promptOrder
      const hydrated = hydrateDraftFromEditor(draftRef.current, projection, nextPromptOrder)
      committedDraftRef.current = structuredClone(hydrated)
      committedPromptOrderRef.current = structuredClone(nextPromptOrder)
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      lastReturnedIdentityRef.current = {
        presetId: projection.presetId,
        presetRevision: projection.presetRevision,
        configRevision: projection.configRevision,
      }
      hydratedIdentityRef.current = lastReturnedIdentityRef.current
      observedPresetIdRef.current = projection.presetId
      observedPresetRevisionRef.current = projection.presetRevision
      observedConfigRevisionRef.current = projection.configRevision
      isHydratedRef.current = true
      conflictSourceRef.current = null
      setRepairedSlotIds(new Set())
      setLoomRevisionRestagePending(false)
      setHostCeilings(projection.hostCeilings)
      setEditorReviewItems(getAgenticRuntimeRepairItems({
        ...snapshot.preset,
        agentConfig: projection.config,
        agentConfigReview: projection.review,
      }))
      setDraft(hydrated)
      setPromptOrder(structuredClone(nextPromptOrder))
      setMaxInvocationsInput(String(hydrated.config.maxInvocations))
      setMaxToolCallsInput(String(hydrated.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(hydrated)}\n${JSON.stringify(nextPromptOrder)}`)
      setIsHydrated(true)
      setEditorLoadError(false)
      setSaveState('idle')
      setConflictRecoveryState('idle')
    } catch {
      if (generation !== conflictReloadGenerationRef.current) return
      if (!editorIdentityMatchesParent(
        currentPresetIdentityRef.current,
        startedIdentity.presetId,
        startedIdentity.presetRevision,
        startedIdentity.configRevision,
      )) {
        setConflictRecoveryState('idle')
        return
      }
      setConflictRecoveryState('error')
    }
  }

  const updateDraft = (updater: (current: AgenticRuntimeSaveDraft) => AgenticRuntimeSaveDraft) => {
    if (!isHydratedForCurrentPreset || saveInFlightRef.current) return
    setDraft(updater)
    setSaveState((current) => current === 'conflict' ? current : 'idle')
  }

  const updateConfig = (updater: (current: AgenticRuntimeSaveDraft['config']) => AgenticRuntimeSaveDraft['config']) => {
    updateDraft((current) => {
      const nextConfig = updater(current.config)
      const rawRuntimePolicy = (nextConfig as unknown as Record<string, unknown>).runtimePolicy
      if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
        return { ...current, config: nextConfig }
      }
      const runtimePolicy = rawRuntimePolicy as Record<string, unknown>
      try {
        if (Object.keys(runtimePolicy).some((key) => !RUNTIME_POLICY_KEYS.has(key))
          || runtimePolicy.version !== 1
          || runtimePolicy.authority !== 'loom'
          || runtimePolicy.scope !== 'preset'
          || runtimePolicy.defaultMode !== current.config.defaultMode) {
          return { ...current, config: nextConfig }
        }
        parseAgentCustomPhasesV1(runtimePolicy.phases)
        if (runtimePolicy.loomPolicy !== null) parseLoomPolicyBucketsV1(runtimePolicy.loomPolicy)
        return {
          ...current,
          config: {
            ...nextConfig,
            runtimePolicy: { ...runtimePolicy, defaultMode: nextConfig.defaultMode },
          } as AgentConfigV2,
        }
      } catch {
        return { ...current, config: nextConfig }
      }
    })
  }

  const updateProfile = (updater: (profile: AgentProfileConfigV2) => AgentProfileConfigV2) => {
    if (!isHydratedForCurrentPreset || !selectedProfile || saveInFlightRef.current) return
    const previousId = selectedProfile.id
    const updatedProfile = updater(selectedProfile)
    const nextId = updatedProfile.id
    updateConfig((config) => {
      const nextConfig = {
        ...config,
        profiles: Array.isArray(config.profiles)
          ? config.profiles.map((profile, index) => index === selectedProfileIndex ? updatedProfile : profile)
          : [updatedProfile],
      }
      return previousId === nextId
        ? nextConfig
        : updateRuntimePolicyChildProfileAssignments(nextConfig, previousId, nextId)
    })
    if (previousId !== nextId) {
      setPromptOrder((current) => current.map((block) => {
        if (typeof block.content !== 'string') return block
        const content = rewriteAgentProfileMarkers(block.content, previousId, nextId)
        return revisePromptBlockContent(block, content)
      }))
    }
  }

  const handleSectionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') nextIndex = (index + 1) % SECTION_IDS.length
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') nextIndex = (index - 1 + SECTION_IDS.length) % SECTION_IDS.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = SECTION_IDS.length - 1
    if (nextIndex === null) return
    event.preventDefault()
    const nextSection = SECTION_IDS[nextIndex]
    setActiveSection(nextSection)
    tabRefs.current.get(nextSection)?.focus()
  }

  const setAllowedMode = (mode: AgentMode, checked: boolean) => {
    if (!isHydratedForCurrentPreset || mode === 'response' || !draft.config.agentsEnabled) return
    updateConfig((config) => {
      const allowedModes: AgentMode[] = checked ? ['response', 'agentic'] : ['response']
      return {
        ...config,
        allowedModes,
        defaultMode: allowedModes.includes(config.defaultMode) ? config.defaultMode : 'response',
      }
    })
  }

  const updatePolicyEntry = (
    policyKey: PolicyKey,
    blockId: string,
    occurrence: number,
    updater: (entry: LoomPolicyEntryV1) => LoomPolicyEntryV1,
  ) => {
    updateConfig((config) => {
      const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
      const entries = buckets[policyKey]
      const index = entries.findIndex((entry) => entry.source.blockId === blockId && entry.source.promptOrder === occurrence)
      if (index < 0) return config
      const nextEntries = entries.map((entry, entryIndex) => (
        entryIndex === index ? updater(entry) : entry
      ))
      return setAgentRuntimePolicyBuckets(config, {
        ...buckets,
        [policyKey]: nextEntries,
      })
    })
  }

  const togglePolicyBlock = (policyKey: PolicyKey, block: PromptBlock, occurrence: number, checked: boolean) => {
    if (checked && block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) {
      toast.error(t('limits.invalidBlockRevision'))
      return
    }
    updateConfig((config) => {
      const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
      const currentEntries = buckets[policyKey]
      const existing = currentEntries.find((entry) => entry.source.blockId === block.id && entry.source.promptOrder === occurrence)
      const totalEntries = POLICY_KEYS.reduce((total, bucket) => total + buckets[bucket].length, 0)
      if (checked) {
        const currentBlock = promptOrder[occurrence]
        if (!currentBlock || currentBlock !== block || currentBlock.id !== block.id) return config
        const entry = createLoomPolicyEntryV1(
          policyKey,
          block,
          preset.cacheRevision ?? 0,
          occurrence,
          existing,
        )
        if (existing) {
          return setAgentRuntimePolicyBuckets(config, {
            ...buckets,
            [policyKey]: currentEntries.map((candidate) => candidate.id === existing.id ? entry : candidate),
          })
        }
        if (currentEntries.length >= AGENTIC_LOOM_POLICY_BUCKET_LIMIT) {
          toast.error(t('limits.policyBucket'))
          return config
        }
        if (totalEntries >= AGENTIC_LOOM_POLICY_LIMIT) {
          toast.error(t('limits.policyTotal'))
          return config
        }
        return setAgentRuntimePolicyBuckets(config, {
          ...buckets,
          [policyKey]: [...currentEntries, entry],
        })
      }
      return setAgentRuntimePolicyBuckets(config, {
        ...buckets,
        [policyKey]: currentEntries.filter((entry) => entry.source.blockId !== block.id || entry.source.promptOrder !== occurrence),
      })
    })
  }
  const currentLoomSourceForBlock = (blockId: string, occurrence: number): LoomPolicySourceV1 | null => {
    const block = promptOrder[occurrence]
    if (!block || block.id !== blockId || block.marker === 'category'
      || block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) {
      return null
    }
    return {
      kind: 'loom_block',
      blockId,
      presetRevision: preset.cacheRevision ?? 0,
      blockRevision: block.revision ?? 1,
      promptOrder: occurrence,
    }
  }
  const stageCurrentLoomRevisions = () => {
    if (!isHydratedForCurrentPreset || saveInFlightRef.current || saveState === 'conflict') return
    const currentPresetRevision = preset.cacheRevision ?? 0
    updateConfig((config) => {
      const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
      const restageEntry = (policyKey: PolicyKey, entry: LoomPolicyEntryV1): LoomPolicyEntryV1 => {
        const occurrence = entry.source.promptOrder
        const block = promptOrder[occurrence]
        if (!block || block.id !== entry.source.blockId || block.marker === 'category') return entry
        if (block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) return entry
        return createLoomPolicyEntryV1(policyKey, block, currentPresetRevision, occurrence, entry)
      }
      const restagedBuckets: LoomPolicyBucketsV1 = {
        version: 1,
        workPolicy: buckets.workPolicy.map((entry) => restageEntry('workPolicy', entry)),
        workspaceUsage: buckets.workspaceUsage.map((entry) => restageEntry('workspaceUsage', entry)),
        completionCriteria: buckets.completionCriteria.map((entry) => restageEntry('completionCriteria', entry)),
        renderPolicy: buckets.renderPolicy.map((entry) => restageEntry('renderPolicy', entry)),
      }
      const withBuckets = setAgentRuntimePolicyBuckets(config, restagedBuckets)
      const restagedPhases = getAgentRuntimeCustomPhases(withBuckets).map((phase) => ({
        ...phase,
        instructionRefs: phase.instructionRefs.map((source) => currentLoomSourceForBlock(source.blockId, source.promptOrder) ?? source),
        childInstructionSubsets: phase.childInstructionSubsets.map((subset) => ({
          ...subset,
          instructionRefs: subset.instructionRefs.map((source) => currentLoomSourceForBlock(source.blockId, source.promptOrder) ?? source),
        })),
      }))
      return setAgentRuntimeCustomPhases(withBuckets, restagedPhases)
    })
    setLoomRevisionRestagePending(true)
    setSaveState((current) => current === 'conflict' ? current : 'idle')
  }
  const resolveRuntimePolicyRepair = (item: PanelRepairItem) => {
    const path = item.label ?? ''
    if (item.reasonCode === 'stale_policy_source') {
      const entryMatch = /^config\.runtimePolicy\.loomPolicy\.(workPolicy|workspaceUsage|completionCriteria|renderPolicy)\.(\d+)\.source$/.exec(path)
      if (entryMatch) {
        const bucket = entryMatch[1] as PolicyKey
        const entry = draftLoomPolicy[bucket][Number(entryMatch[2])]
        const promptIndex = entry === undefined
          ? -1
          : entry.source.promptOrder
        const block = promptOrder[promptIndex]
        if (entry && block && block.marker !== 'category' && (
          block.revision === undefined || isCanonicalBlockRevision(block.revision)
        )) {
          updatePolicyEntry(bucket, entry.source.blockId, entry.source.promptOrder, (current) => (
            createLoomPolicyEntryV1(
              bucket,
              block,
              preset.cacheRevision ?? 0,
              promptIndex,
              current,
            )
          ))
          return
        }
      }
      const phaseSourceMatch = /^config\.runtimePolicy\.phases\.(\d+)\.instructionRefs\.(\d+)$/.exec(path)
      if (phaseSourceMatch) {
        const phaseIndex = Number(phaseSourceMatch[1])
        const sourceIndex = Number(phaseSourceMatch[2])
        const source = draftCustomPhases[phaseIndex]?.instructionRefs[sourceIndex]
        const replacement = source === undefined ? null : currentLoomSourceForBlock(source.blockId, source.promptOrder)
        if (source && replacement) {
          updateConfig((config) => {
            const phases = getAgentRuntimeCustomPhases(config)
            const currentPhase = phases[phaseIndex]
            if (!currentPhase) return config
            const nextPhases = phases.map((phase, index) => index === phaseIndex
              ? {
                  ...phase,
                  instructionRefs: phase.instructionRefs.map((candidate) => (
                    candidate.blockId === source.blockId && candidate.promptOrder === source.promptOrder ? replacement : candidate
                  )),
                  childInstructionSubsets: phase.childInstructionSubsets.map((subset) => ({
                    ...subset,
                    instructionRefs: subset.instructionRefs.map((candidate) => (
                      candidate.blockId === source.blockId && candidate.promptOrder === source.promptOrder ? replacement : candidate
                    )),
                  })),
                }
              : phase)
            return setAgentRuntimeCustomPhases(config, nextPhases)
          })
          return
        }
      }
    }
    updateConfig((config) => {
      const emptyBuckets: LoomPolicyBucketsV1 = {
        version: 1,
        workPolicy: [],
        workspaceUsage: [],
        completionCriteria: [],
        renderPolicy: [],
      }
      if (/^config\.cognitionPolicy(?:\.|$)/.test(path)) {
        const canonicalBuckets = getAgentRuntimePolicyBuckets(config, promptOrder)
        const canonicalPhases = getAgentRuntimeCustomPhases(config)
        const withBuckets = setAgentRuntimePolicyBuckets(config, canonicalBuckets)
        return setAgentRuntimeCustomPhases(withBuckets, canonicalPhases)
      }
      const rawRuntimePolicy = (config as unknown as Record<string, unknown>).runtimePolicy
      if (typeof rawRuntimePolicy !== 'object' || rawRuntimePolicy === null || Array.isArray(rawRuntimePolicy)) {
        const withBuckets = setAgentRuntimePolicyBuckets(config, emptyBuckets)
        return setAgentRuntimeCustomPhases(withBuckets, [])
      }
      const runtimePolicy = rawRuntimePolicy as Record<string, unknown>
      const subsetMatch = /^config\.runtimePolicy\.phases\.(\d+)\.childInstructionSubsets\.(\d+)(?:\.instructionRefs\.(\d+))?/.exec(path)
      if (subsetMatch && Array.isArray(runtimePolicy.phases)) {
        const phaseIndex = Number(subsetMatch[1])
        const subsetIndex = Number(subsetMatch[2])
        const instructionIndex = subsetMatch[3] === undefined ? null : Number(subsetMatch[3])
        const nextPhases = runtimePolicy.phases.slice()
        const rawPhase = nextPhases[phaseIndex]
        if (isObjectRecord(rawPhase) && Array.isArray(rawPhase.childInstructionSubsets)) {
          const nextSubsets = rawPhase.childInstructionSubsets.slice()
          if (isObjectRecord(nextSubsets[subsetIndex])) {
            if (instructionIndex === null) {
              nextSubsets.splice(subsetIndex, 1)
            } else if (Array.isArray(nextSubsets[subsetIndex].instructionRefs)) {
              const nextRefs = nextSubsets[subsetIndex].instructionRefs.slice()
              nextRefs.splice(instructionIndex, 1)
              nextSubsets[subsetIndex] = {
                ...nextSubsets[subsetIndex],
                instructionRefs: nextRefs,
              }
            }
            nextPhases[phaseIndex] = { ...rawPhase, childInstructionSubsets: nextSubsets }
            return {
              ...config,
              runtimePolicy: { ...runtimePolicy, phases: nextPhases },
            } as unknown as AgentConfigV2
          }
        }
      }

      const instructionMatch = /^config\.runtimePolicy\.phases\.(\d+)\.instructionRefs\.(\d+)/.exec(path)
      if (instructionMatch && Array.isArray(runtimePolicy.phases)) {
        const phaseIndex = Number(instructionMatch[1])
        const instructionIndex = Number(instructionMatch[2])
        const nextPhases = runtimePolicy.phases.slice()
        const rawPhase = nextPhases[phaseIndex]
        if (isObjectRecord(rawPhase) && Array.isArray(rawPhase.instructionRefs)) {
          const removedSource = rawPhase.instructionRefs[instructionIndex]
          const removedBlockId = isObjectRecord(removedSource) && typeof removedSource.blockId === 'string'
            ? removedSource.blockId
            : null
          const removedPromptOrder = isObjectRecord(removedSource) && Number.isSafeInteger(removedSource.promptOrder)
            ? removedSource.promptOrder
            : null
          const nextRefs = rawPhase.instructionRefs.slice()
          nextRefs.splice(instructionIndex, 1)
          const nextSubsets = Array.isArray(rawPhase.childInstructionSubsets)
            ? rawPhase.childInstructionSubsets.map((subset) => (
                isObjectRecord(subset) && Array.isArray(subset.instructionRefs) && removedBlockId !== null && removedPromptOrder !== null
                  ? {
                      ...subset,
                      instructionRefs: subset.instructionRefs.filter((source) => (
                        !isObjectRecord(source)
                          || source.blockId !== removedBlockId
                          || source.promptOrder !== removedPromptOrder
                      )),
                    }
                  : subset
              ))
            : rawPhase.childInstructionSubsets
          nextPhases[phaseIndex] = {
            ...rawPhase,
            instructionRefs: nextRefs,
            childInstructionSubsets: nextSubsets,
          }
          return {
            ...config,
            runtimePolicy: { ...runtimePolicy, phases: nextPhases },
          } as unknown as AgentConfigV2
        }
      }

      const phaseMatch = /^config\.runtimePolicy\.phases\.(\d+)/.exec(path)
      if (phaseMatch && Array.isArray(runtimePolicy.phases)) {
        const nextPhases = runtimePolicy.phases.slice()
        nextPhases.splice(Number(phaseMatch[1]), 1)
        return {
          ...config,
          runtimePolicy: { ...runtimePolicy, phases: nextPhases },
        } as unknown as AgentConfigV2
      }

      const entryMatch = /^config\.runtimePolicy\.loomPolicy\.(workPolicy|workspaceUsage|completionCriteria|renderPolicy)\.(\d+)/.exec(path)
      if (entryMatch
        && typeof runtimePolicy.loomPolicy === 'object'
        && runtimePolicy.loomPolicy !== null
        && !Array.isArray(runtimePolicy.loomPolicy)) {
        const bucket = entryMatch[1] as PolicyKey
        const rawLoomPolicy = runtimePolicy.loomPolicy as Record<string, unknown>
        const rawEntries = rawLoomPolicy[bucket]
        if (Array.isArray(rawEntries)) {
          const nextEntries = rawEntries.slice()
          nextEntries.splice(Number(entryMatch[2]), 1)
          return {
            ...config,
            runtimePolicy: {
              ...runtimePolicy,
              loomPolicy: {
                ...rawLoomPolicy,
                [bucket]: nextEntries,
              },
            },
          } as unknown as AgentConfigV2
        }
      }

      if (path.startsWith('config.runtimePolicy.loomPolicy')) {
        return {
          ...config,
          runtimePolicy: { ...runtimePolicy, loomPolicy: emptyBuckets },
        } as unknown as AgentConfigV2
      }
      if (path.startsWith('config.runtimePolicy.phases')) {
        return {
          ...config,
          runtimePolicy: { ...runtimePolicy, phases: [] },
        } as unknown as AgentConfigV2
      }
      const withBuckets = setAgentRuntimePolicyBuckets(config, emptyBuckets)
      return setAgentRuntimeCustomPhases(withBuckets, [])
    })
  }
  const updateCustomPhases = (
    updater: (phases: AgentCustomPhaseV1[]) => AgentCustomPhaseV1[],
  ) => {
    updateConfig((config) => {
      const canonicalConfig = setAgentRuntimePolicyBuckets(
        config,
        getAgentRuntimePolicyBuckets(config, promptOrder),
      )
      const currentPhases = [...getAgentRuntimeCustomPhases(canonicalConfig)]
      return setAgentRuntimeCustomPhases(canonicalConfig, updater(currentPhases))
    })
  }
  const addCustomPhase = () => {
    if (!isHydratedForCurrentPreset) return
    if (draftCustomPhases.length >= AGENTIC_CUSTOM_PHASE_LIMIT) {
      toast.error(t('limits.customPhases'))
      return
    }
    const usedIds = new Set(draftCustomPhases.map((phase) => phase.id))
    let phaseNumber = 1
    while (usedIds.has(`phase_${phaseNumber}`)) phaseNumber += 1
    const id = `phase_${phaseNumber}`
    const phase: AgentCustomPhaseV1 = {
      version: 1,
      id,
      label: t('customPhases.defaultLabel', { number: phaseNumber }),
      instructionRefs: [],
      childInstructionSubsets: [],
      required: true,
      enter: { kind: 'phase', value: 'WORK' },
      exit: { kind: 'phase', value: 'COMPLETE' },
      capabilityRequests: [],
      repeatLimit: 0,
      nextPhaseIds: [],
    }
    updateCustomPhases((phases) => [...phases, phase])
  }
  const updateCustomPhase = (
    index: number,
    updater: (phase: AgentCustomPhaseV1) => AgentCustomPhaseV1,
  ) => {
    updateCustomPhases((phases) => phases.map((phase, phaseIndex) => (
      phaseIndex === index ? updater(phase) : phase
    )))
  }
  const renameCustomPhase = (index: number, id: string) => {
    updateCustomPhases((phases) => {
      if (phases.some((phase, phaseIndex) => phaseIndex !== index && phase.id === id)) return phases
      const previousId = phases[index]?.id
      if (!previousId || previousId === id) {
        return phases.map((phase, phaseIndex) => phaseIndex === index ? { ...phase, id } : phase)
      }
      return phases.map((phase, phaseIndex) => ({
        ...phase,
        ...(phaseIndex === index ? { id } : {}),
        nextPhaseIds: phase.nextPhaseIds.map((phaseId) => phaseId === previousId ? id : phaseId),
      }))
    })
  }
  const removeCustomPhase = (index: number) => {
    updateCustomPhases((phases) => {
      const removedId = phases[index]?.id
      if (!removedId) return phases
      return phases
        .filter((_phase, phaseIndex) => phaseIndex !== index)
        .map((phase) => ({
          ...phase,
          nextPhaseIds: phase.nextPhaseIds.filter((phaseId) => phaseId !== removedId),
        }))
    })
  }
  const moveCustomPhase = (index: number, direction: -1 | 1) => {
    updateCustomPhases((phases) => {
      const targetIndex = index + direction
      if (targetIndex < 0 || targetIndex >= phases.length) return phases
      const next = [...phases]
      const [moved] = next.splice(index, 1)
      next.splice(targetIndex, 0, moved)
      return next.map((phase, phaseIndex) => {
        const nextPhaseId = next[phaseIndex + 1]?.id
        return {
          ...phase,
          nextPhaseIds: phase.nextPhaseIds.filter((phaseId) => phaseId === phase.id || phaseId === nextPhaseId),
        }
      })
    })
  }
  const toggleCustomPhaseInstruction = (
    phaseIndex: number,
    block: PromptBlock,
    occurrence: number,
    checked: boolean,
  ) => {
    if (!checked) {
      updateCustomPhase(phaseIndex, (phase) => ({
        ...phase,
        instructionRefs: phase.instructionRefs.filter((candidate) => candidate.blockId !== block.id || candidate.promptOrder !== occurrence),
        childInstructionSubsets: phase.childInstructionSubsets.map((subset) => ({
          ...subset,
          instructionRefs: subset.instructionRefs.filter((candidate) => candidate.blockId !== block.id || candidate.promptOrder !== occurrence),
        })),
      }))
      return
    }
    const source = currentLoomSourceForBlock(block.id, occurrence)
    if (!source) {
      if (block.revision !== undefined && !isCanonicalBlockRevision(block.revision)) {
        toast.error(t('limits.invalidBlockRevision'))
      }
      return
    }
    updateCustomPhase(phaseIndex, (phase) => ({
      ...phase,
      instructionRefs: [
        ...phase.instructionRefs.filter((candidate) => candidate.blockId !== block.id || candidate.promptOrder !== occurrence),
        source,
      ],
      childInstructionSubsets: phase.childInstructionSubsets.map((subset) => ({
        ...subset,
        instructionRefs: subset.instructionRefs.map((candidate) => (
          candidate.blockId === block.id && candidate.promptOrder === occurrence ? source : candidate
        )),
      })),
    }))
  }

  const toggleCustomPhaseChildSubset = (
    phaseIndex: number,
    profileId: string,
    source: LoomPolicySourceV1,
    checked: boolean,
  ) => {
    updateCustomPhase(phaseIndex, (phase) => {
      const existingIndex = phase.childInstructionSubsets.findIndex((subset) => subset.profileId === profileId)
      if (existingIndex < 0) {
        return checked
          ? {
              ...phase,
              childInstructionSubsets: [
                ...phase.childInstructionSubsets,
                { profileId, instructionRefs: [source] },
              ],
            }
          : phase
      }
      const existing = phase.childInstructionSubsets[existingIndex]!
      const sameOccurrence = (candidate: LoomPolicySourceV1) => (
        candidate.blockId === source.blockId && candidate.promptOrder === source.promptOrder
      )
      const instructionRefs = checked
        ? [
            ...existing.instructionRefs.filter((candidate) => !sameOccurrence(candidate)),
            source,
          ]
        : existing.instructionRefs.filter((candidate) => !sameOccurrence(candidate))
      return {
        ...phase,
        childInstructionSubsets: phase.childInstructionSubsets.map((subset, subsetIndex) => (
          subsetIndex === existingIndex ? { ...subset, instructionRefs } : subset
        )),
      }
    })
  }

  const toggleCustomPhaseChildSubsetAssignment = (
    phaseIndex: number,
    profileId: string,
    assigned: boolean,
  ) => {
    updateCustomPhase(phaseIndex, (phase) => {
      const existing = phase.childInstructionSubsets.some((subset) => subset.profileId === profileId)
      if (assigned) {
        return existing
          ? phase
          : {
              ...phase,
              childInstructionSubsets: [
                ...phase.childInstructionSubsets,
                { profileId, instructionRefs: [] },
              ],
            }
      }
      return existing
        ? {
            ...phase,
            childInstructionSubsets: phase.childInstructionSubsets.filter((subset) => subset.profileId !== profileId),
          }
        : phase
    })
  }
  const toggleCustomPhaseCapability = (
    phaseIndex: number,
    capability: AgentCustomPhaseCapability,
    checked: boolean,
  ) => {
    updateCustomPhase(phaseIndex, (phase) => ({
      ...phase,
      capabilityRequests: checked
        ? [...phase.capabilityRequests, capability]
        : phase.capabilityRequests.filter((candidate) => candidate !== capability),
    }))
  }
  const toggleCustomPhaseTransition = (
    phaseIndex: number,
    phaseId: string,
    checked: boolean,
  ) => {
    updateCustomPhase(phaseIndex, (phase) => ({
      ...phase,
      nextPhaseIds: checked
        ? [...phase.nextPhaseIds.filter((candidate) => candidate !== phaseId), phaseId]
        : phase.nextPhaseIds.filter((candidate) => candidate !== phaseId),
    }))
  }
  const addTaskTemplate = () => {
    if (!isHydratedForCurrentPreset) return
    if (draftTaskTemplates.length >= AGENTIC_TASK_TEMPLATE_LIMIT) {
      toast.error(t('limits.tasks'))
      return
    }
    const usedIds = new Set(draftTaskTemplates
      .filter((template) => isAgentTaskTemplate(template))
      .map((template) => template.id))
    let taskNumber = 1
    while (usedIds.has(`task_${taskNumber}`)) taskNumber += 1
    const base = `task_${taskNumber}`
    const template: AgentTaskTemplate = {
      id: base,
      label: t('tasks.defaultName', { number: taskNumber }),
      description: '',
      required: false,
      dependencies: [],
      activation: { kind: 'phase', value: 'WORK' },
    }
    updateDraft((current) => ({
      ...current,
      taskTemplates: [...(Array.isArray(current.taskTemplates) ? current.taskTemplates : []), template],
      config: {
        ...current.config,
        taskPolicy: {
          templateIds: [
            ...(current.config.taskPolicy && Array.isArray(current.config.taskPolicy.templateIds)
              ? current.config.taskPolicy.templateIds
              : []),
            template.id,
          ],
        },
      },
    }))
  }

  const updateTaskTemplate = (index: number, updater: (template: AgentTaskTemplate) => AgentTaskTemplate) => {
    updateDraft((current) => {
      if (!Array.isArray(current.taskTemplates)) return current
      const previous = current.taskTemplates[index]
      const previousId = isAgentTaskTemplate(previous) ? previous.id : null
      const updated = current.taskTemplates.map((template, templateIndex) => (
        templateIndex === index && isAgentTaskTemplate(template) ? updater(template) : template
      ))
      const next = updated[index]
      const nextId = isAgentTaskTemplate(next) ? next.id : previousId
      const renamed = previousId !== null && nextId !== null && previousId !== nextId
      const nextTemplates = renamed
        ? updated.map((template) => (
          isAgentTaskTemplate(template)
            ? {
                ...template,
                dependencies: (template.dependencies ?? []).map((dependencyId) => (
                  dependencyId === previousId ? nextId : dependencyId
                )),
                activation: template.activation
                  ? rewriteTaskTransitionReferences(template.activation, previousId, nextId) as AgentTaskTemplate['activation']
                  : template.activation,
              }
            : template
        ))
        : updated
      const runtimeConfig = renamed
        ? rewriteRuntimePolicyTaskReferences(current.config, previousId, nextId)
        : current.config
      const taskPolicy = runtimeConfig.taskPolicy
      return {
        ...current,
        taskTemplates: nextTemplates,
        config: renamed && taskPolicy && Array.isArray(taskPolicy.templateIds)
          ? {
              ...runtimeConfig,
              taskPolicy: {
                templateIds: taskPolicy.templateIds.map((templateId) => (
                  templateId === previousId ? nextId : templateId
                )),
              },
            }
          : runtimeConfig,
      }
    })
  }

  const removeTaskTemplate = (index: number) => {
    const removing = draftTaskTemplates[index]
    if (!isAgentTaskTemplate(removing)) return
    updateDraft((current) => {
      const nextTemplates = Array.isArray(current.taskTemplates)
        ? current.taskTemplates
          .filter((_template, templateIndex) => templateIndex !== index)
          .map((template) => {
            if (!isAgentTaskTemplate(template)) return template
            const dependencies = template.dependencies?.filter((dependencyId) => dependencyId !== removing.id)
            return repairTaskTransitionReferencesAfterRemoval({
              ...template,
              ...(dependencies === undefined ? {} : { dependencies }),
            }, removing.id)
          })
        : current.taskTemplates
      const runtimeConfig = repairRuntimePolicyTaskReferencesAfterRemoval(current.config, removing.id)
      return {
        ...current,
        taskTemplates: nextTemplates,
        config: {
          ...runtimeConfig,
          taskPolicy: {
            templateIds: runtimeConfig.taskPolicy && Array.isArray(runtimeConfig.taskPolicy.templateIds)
              ? runtimeConfig.taskPolicy.templateIds.filter((id) => id !== removing.id)
              : [],
          },
        },
      }
    })
  }
  const discardTaskTemplate = (index: number) => {
    updateDraft((current) => {
      if (!Array.isArray(current.taskTemplates)) return current
      const removing = current.taskTemplates[index]
      const unknownRemoving: unknown = removing
      const removingId = isAgentTaskTemplate(removing)
        ? removing.id
        : unknownRemoving && typeof unknownRemoving === 'object' && !Array.isArray(unknownRemoving)
            && 'id' in unknownRemoving && typeof unknownRemoving.id === 'string'
          ? unknownRemoving.id
          : null
      const nextTemplates = removingId === null
        ? current.taskTemplates.filter((_template, templateIndex) => templateIndex !== index)
        : current.taskTemplates
          .filter((_template, templateIndex) => templateIndex !== index)
          .map((template) => (
            isAgentTaskTemplate(template)
              ? repairTaskTransitionReferencesAfterRemoval(template, removingId)
              : template
          ))
      const runtimeConfig = removingId === null
        ? current.config
        : repairRuntimePolicyTaskReferencesAfterRemoval(current.config, removingId)
      return {
        ...current,
        taskTemplates: nextTemplates,
        config: removingId !== null
          ? {
              ...runtimeConfig,
              taskPolicy: {
                templateIds: runtimeConfig.taskPolicy && Array.isArray(runtimeConfig.taskPolicy.templateIds)
                  ? runtimeConfig.taskPolicy.templateIds.filter((id) => id !== removingId)
                  : [],
              },
            }
          : runtimeConfig,
      }
    })
  }

  const discardQuarantinedProfile = (id: string) => {
    updateDraft((current) => ({
      ...current,
      quarantinedProfiles: (current.quarantinedProfiles ?? []).filter((item) => item.id !== id),
    }))
  }
  const discardQuarantinedConnectionSlot = (id: string) => {
    updateDraft((current) => ({
      ...current,
      quarantinedConnectionSlots: (current.quarantinedConnectionSlots ?? []).filter((item) => item.id !== id),
    }))
  }


  const updateSlotBinding = (slotId: string, connectionId: string) => {
    if (!isHydratedForCurrentPreset || saveInFlightRef.current) return
    const committedBindings = committedDraftRef.current.slotBindings
    const committedConnectionId = committedBindings && typeof committedBindings === 'object'
      ? committedBindings[slotId] ?? null
      : null
    setRepairedSlotIds((current) => {
      const next = new Set(current)
      if (connectionId && connectionId !== committedConnectionId) next.add(slotId)
      else next.delete(slotId)
      return next
    })
    updateDraft((current) => ({
      ...current,
      slotBindings: {
        ...(current.slotBindings && typeof current.slotBindings === 'object' ? current.slotBindings : {}),
        [slotId]: connectionId || null,
      },
      reviewAcknowledgements: Array.isArray(current.reviewAcknowledgements)
        ? current.reviewAcknowledgements.filter(
          (id) => id !== `slot:${slotId}` && id !== `stale-slot:${slotId}`,
        )
        : [],
    }))
  }


  const handleSave = async () => {
    if (!canSave || saveInFlightRef.current) return
    const submittedIdentity = hydratedIdentityRef.current
    if (!submittedIdentity || submittedIdentity.presetId !== preset.id) return
    const submittedDraft = structuredClone(draft)
    submittedDraft.reviewAcknowledgements = submittedDraft.reviewAcknowledgements.filter((id) => requiredReviewIds.includes(id))
    const submittedPromptOrder = structuredClone(promptOrder)
    const submittedFingerprint = `${runtimeDraftFingerprint(submittedDraft)}\n${JSON.stringify(submittedPromptOrder)}`
    let acceptedSnapshot: SaveAgenticRuntimeEditorResult | null = null
    const acceptSnapshot = (result: SaveAgenticRuntimeEditorResult): boolean => {
      if (acceptedSnapshot !== null) return acceptedSnapshot === result
      const snapshot = readMatchedEditorSnapshot(result)
      if (!snapshot || snapshot.editor.presetId !== submittedIdentity.presetId) return false
      const projection = snapshot.editor
      const currentIdentity = currentPresetIdentityRef.current
      const parentStillSubmitted = editorIdentityMatchesParent(
        currentIdentity,
        submittedIdentity.presetId,
        submittedIdentity.presetRevision,
        submittedIdentity.configRevision,
      )
      const parentMatchesResult = editorIdentityMatchesParent(
        currentIdentity,
        projection.presetId,
        projection.presetRevision,
        projection.configRevision,
      )
      if (!parentStillSubmitted && !parentMatchesResult) return false

      setLoomRevisionRestagePending(false)
      lastReturnedIdentityRef.current = {
        presetId: projection.presetId,
        presetRevision: projection.presetRevision,
        configRevision: projection.configRevision,
      }
      hydratedIdentityRef.current = lastReturnedIdentityRef.current
      observedPresetIdRef.current = projection.presetId
      observedPresetRevisionRef.current = projection.presetRevision
      observedConfigRevisionRef.current = projection.configRevision
      isHydratedRef.current = true
      const liveDraft = structuredClone(draftRef.current)
      liveDraft.reviewAcknowledgements = liveDraft.reviewAcknowledgements.filter((id) => requiredReviewIds.includes(id))
      const liveFingerprint = `${runtimeDraftFingerprint(liveDraft)}\n${JSON.stringify(promptOrderRef.current)}`
      if (liveFingerprint !== submittedFingerprint) {
        conflictSourceRef.current = null
        setSaveState('idle')
        acceptedSnapshot = result
        return true
      }
      const committedPreset = snapshot.preset
      const committedPromptOrder = snapshot.promptOrder
      const hydrated = hydrateDraftFromEditor(submittedDraft, projection, committedPromptOrder)
      committedDraftRef.current = structuredClone(hydrated)
      committedPromptOrderRef.current = structuredClone(committedPromptOrder)
      draftRef.current = hydrated
      promptOrderRef.current = structuredClone(committedPromptOrder)
      dirtyRef.current = false
      pendingExternalDraftRef.current = null
      pendingExternalPromptOrderRef.current = null
      setRepairedSlotIds(new Set())
      setDraft(hydrated)
      setPromptOrder(structuredClone(committedPromptOrder))
      setHostCeilings(projection.hostCeilings)
      setEditorReviewItems(getAgenticRuntimeRepairItems({
        ...committedPreset,
        agentConfig: projection.config,
        agentConfigReview: projection.review,
      }))
      setMaxInvocationsInput(String(hydrated.config.maxInvocations))
      setMaxToolCallsInput(String(hydrated.config.maxToolCalls))
      setSavedFingerprint(`${runtimeDraftFingerprint(hydrated)}\n${JSON.stringify(committedPromptOrder)}`)
      setIsHydrated(true)
      setConflictRecoveryState('idle')
      conflictSourceRef.current = null
      setSaveState('saved')
      acceptedSnapshot = result
      return true
    }
    saveInFlightRef.current = true
    setSaveState('saving')
    try {
      const result = await onSave(
        submittedDraft,
        submittedPromptOrder,
        { ...submittedIdentity },
        acceptSnapshot,
      )
      if (acceptedSnapshot === null && !acceptSnapshot(result)) {
        throw new Error('Save did not return a matched preset/editor snapshot')
      }
    } catch (error) {
      if (!editorIdentityMatchesParent(
        currentPresetIdentityRef.current,
        submittedIdentity.presetId,
        submittedIdentity.presetRevision,
        submittedIdentity.configRevision,
      )) return
      const conflict = error instanceof ApiError && error.status === 409
      if (conflict) {
        conflictSourceRef.current = 'save_conflict'
        setConflictRecoveryState('idle')
      }
      setSaveState(conflict ? 'conflict' : 'error')
    } finally {
      saveInFlightRef.current = false
    }
  }
  const resetDraft = () => {
    if (!canReset || saveInFlightRef.current) return
    const pendingExternalDraft = pendingExternalDraftRef.current
    const pendingExternalPromptOrder = pendingExternalPromptOrderRef.current
    const externalSnapshotIncomplete = pendingExternalPromptOrder !== null && pendingExternalDraft === null
    const restoringLocalCommitted = pendingExternalDraft === null && pendingExternalPromptOrder === null
    const restoredDraft = structuredClone(pendingExternalDraft ?? committedDraftRef.current)
    const restoredPromptOrder = structuredClone(pendingExternalPromptOrder ?? committedPromptOrderRef.current)
    const acceptsCurrentFallback = hydratedIdentityRef.current === null
      && pendingExternalDraft !== null
      && pendingExternalPromptOrder !== null
      && !editorLoadError
    const restoredIdentityMatchesCurrent = acceptsCurrentFallback
      || editorIdentityConverged(
        hydratedIdentityRef.current,
        preset.id,
        preset.cacheRevision ?? 0,
        preset.agentConfigRevision ?? 0,
        lastReturnedIdentityRef.current,
      )
    pendingExternalDraftRef.current = null
    pendingExternalPromptOrderRef.current = null
    committedDraftRef.current = structuredClone(restoredDraft)
    committedPromptOrderRef.current = structuredClone(restoredPromptOrder)
    setRepairedSlotIds(new Set())
    setLoomRevisionRestagePending(false)
    if (!restoringLocalCommitted) lastReturnedIdentityRef.current = null
    setDraft(restoredDraft)
    setPromptOrder(restoredPromptOrder)
    setMaxInvocationsInput(String(restoredDraft.config.maxInvocations))
    setMaxToolCallsInput(String(restoredDraft.config.maxToolCalls))
    setSavedFingerprint(`${runtimeDraftFingerprint(restoredDraft)}\n${JSON.stringify(restoredPromptOrder)}`)
    if (acceptsCurrentFallback) {
      hydratedIdentityRef.current = {
        presetId: preset.id,
        presetRevision: preset.cacheRevision ?? 0,
        configRevision: preset.agentConfigRevision ?? 0,
      }
      setIsHydrated(true)
    }
    setConflictRecoveryState('idle')
    if (restoringLocalCommitted) {
      setSaveState(conflictSourceRef.current ? 'conflict' : 'idle')
      return
    }
    if (externalSnapshotIncomplete || !restoredIdentityMatchesCurrent) {
      if (!conflictSourceRef.current) conflictSourceRef.current = 'external_hydration'
      setSaveState('conflict')
      return
    }
    conflictSourceRef.current = null
    setSaveState('idle')
  }

  const stageAgentBlock = () => {
    if (!isHydratedForCurrentPreset || !selectedProfile || saveInFlightRef.current) return

    const block = createAgentPromptBlock(
      selectedProfile,
      agentsT('syntax.taskPlaceholder'),
      agentsT('syntax.blockName', { name: selectedProfile.name || selectedProfile.id }),
    )
    setPromptOrder((current) => [...current, block])
    setSaveState((current) => current === 'conflict' ? current : 'idle')
  }

  const renderActivation = () => (
    <>
      <SectionHeader title={t('sections.activation.title')} description={t('sections.activation.description')} />
      {unacknowledgedReviewItems.length > 0 && (
        <div className={styles.notice} role="status">
          <ShieldCheck size={20} aria-hidden="true" />
          <div><strong>{t('activation.reviewTitle')}</strong><p id={ACTIVATION_REVIEW_REASON_ID}>{t('activation.reviewDescription')}</p></div>
        </div>
      )}
      <div className={styles.settingRow}>
        <div><strong>{t('activation.enable')}</strong><small>{t('activation.enableHint')}</small></div>
        <Toggle.Switch
          checked={draft.config.agentsEnabled === true}
          onChange={(agentsEnabled) => updateConfig((config) => agentsEnabled
            ? { ...config, agentsEnabled: true }
            : { ...config, agentsEnabled: false, allowedModes: ['response'], defaultMode: 'response' })}
          disabled={unacknowledgedReviewItems.length > 0}
          aria-label={t('activation.enable')}
          aria-describedby={unacknowledgedReviewItems.length > 0 ? ACTIVATION_REVIEW_REASON_ID : undefined}
        />
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>{t('activation.allowedModes')}</legend>
        <label className={styles.modeRow}>
          <input type="checkbox" checked readOnly />
          <span><strong>{t('modes.response')}</strong><small>{t('modes.responseHint')}</small></span>
        </label>
        <label className={styles.modeRow}>
          <input
            type="checkbox"
            checked={draftAllowedModes.includes('agentic')}
            onChange={(event) => setAllowedMode('agentic', event.target.checked)}
            disabled={draft.config.agentsEnabled !== true}
          />
          <span><strong>{t('modes.agentic')}</strong><small>{t('modes.agenticHint')}</small></span>
        </label>
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend className={styles.fieldLabel}>{t('activation.defaultMode')}</legend>
        <div className={styles.segmented}>
          {draftAllowedModes.map((mode) => (
            <label key={mode} className={clsx(styles.segmentedOption, draft.config.defaultMode === mode && styles.segmentedSelected)}>
              <input
                type="radio"
                name="agentic-default-mode"
                value={mode}
                checked={draft.config.defaultMode === mode}
                onChange={() => updateConfig((config) => ({ ...config, defaultMode: mode }))}
              />
              {t(`modes.${mode}`)}
            </label>
          ))}
        </div>
      </fieldset>
    </>
  )

  const renderAgents = () => (
    <>
      <SectionHeader title={t('sections.agents.title')} description={t('sections.agents.description')} />
      {(draft.quarantinedProfiles ?? []).map((item) => (
        <div className={styles.notice} role="alert" key={item.id}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>{t('tasks.quarantined')}</strong><p>{t('tasks.quarantinedHint')}</p></div>
          <button type="button" className={styles.iconButton} onClick={() => discardQuarantinedProfile(item.id)} aria-label={t('tasks.discardQuarantined')}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className={styles.sectionActions}>
        <button
          type="button"
          className={styles.button}
          disabled={draft.config.profiles.length >= AGENT_PROFILE_LIMIT || draftControlsLocked}
          onClick={() => {
            if (saveInFlightRef.current) return
            const profile = createAgentProfileV2(
              agentsT('profiles.defaultName', { number: draft.config.profiles.length + 1 }),
              draft.config.profiles.map((candidate) => candidate.id),
            )
            updateConfig((config) => ({ ...config, profiles: [...config.profiles, profile] }))
            setSelectedProfileIndex(draft.config.profiles.length)
          }}
        >
          <Plus size={16} aria-hidden="true" /> {agentsT('profiles.add')}
        </button>
      </div>
      <div className={styles.workbench}>
        <div className={styles.itemRail} role="list" aria-label={agentsT('profiles.listAria')}>
          {draft.config.profiles.map((profile, index) => (
            <div key={`${profile.id}-${index}`} role="listitem" className={styles.itemRailItem}>
              <button
                type="button"
                className={clsx(styles.itemRailButton, index === selectedProfileIndex && styles.itemRailButtonActive)}
                aria-current={index === selectedProfileIndex ? 'true' : undefined}
                onClick={() => setSelectedProfileIndex(index)}
              >
                <strong>{profile.name || profile.id}</strong><small>{profile.id}</small>
              </button>
            </div>
          ))}
        </div>
        {selectedProfile ? (
          <div className={styles.editorStack}>
            <div className={styles.formGrid}>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.name')}</span>
                <input className={styles.input} disabled={draftControlsLocked} value={selectedProfile.name} maxLength={AGENT_PROFILE_NAME_MAX_LENGTH} onChange={(event) => updateProfile((profile) => ({ ...profile, name: event.target.value }))} />
              </label>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.id')}</span>
                <input className={styles.input} disabled={draftControlsLocked} value={selectedProfile.id} onChange={(event) => updateProfile((profile) => ({ ...profile, id: event.target.value }))} />
              </label>
            </div>
            <label className={styles.field}><span className={styles.fieldLabel}>{t('agents.connectionRef')}</span>
              <select
                className={styles.select}
                disabled={draftControlsLocked}
                value={selectedProfile.connectionRef.kind === 'slot' ? selectedProfile.connectionRef.slotId : ''}
                onChange={(event) => updateProfile((profile) => ({
                  ...profile,
                  connectionRef: event.target.value ? { kind: 'slot', slotId: event.target.value } : { kind: 'inherit_main' },
                }))}
              >
                <option value="">{agentsT('profiles.useMainConnection')}</option>
                {draft.config.connectionSlots.map((slot) => <option key={slot.id} value={slot.id}>{slot.label}</option>)}
              </select>
            </label>
            <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.systemPrompt')}</span>
              <textarea className={styles.textarea} disabled={draftControlsLocked} value={selectedProfile.systemPrompt} maxLength={AGENT_SYSTEM_PROMPT_MAX_BYTES} onChange={(event) => updateProfile((profile) => ({ ...profile, systemPrompt: event.target.value }))} />
            </label>
            <ToolChecklist selected={selectedProfile.toolIds} disabled={draftControlsLocked} onChange={(toolIds) => updateProfile((profile) => ({ ...profile, toolIds }))} legend={agentsT('profiles.tools')} />
            <WorkspaceCapabilityChecklist
              selected={selectedProfile.workspaceCapabilities ?? []}
              disabled={draftControlsLocked}
              onChange={(workspaceCapabilities) => updateProfile((profile) => ({ ...profile, workspaceCapabilities }))}
              legend={agentsT('profiles.workspaceCapabilities')}
              hint={agentsT('profiles.workspaceCapabilitiesHint')}
            />
            <div className={styles.settingRow}>
              <div><strong>{agentsT('profiles.delegation')}</strong><small>{agentsT('profiles.delegationHint')}</small></div>
              <Toggle.Switch disabled={draftControlsLocked} checked={selectedProfile.allowMainDelegation} onChange={(allowMainDelegation) => updateProfile((profile) => ({ ...profile, allowMainDelegation }))} aria-label={agentsT('profiles.delegation')} />
            </div>
            <div className={styles.settingRow}>
              <div><strong>{agentsT('profiles.activity')}</strong><small>{agentsT('profiles.activityHint')}</small></div>
              <Toggle.Switch disabled={draftControlsLocked} checked={selectedProfile.streamActivity} onChange={(streamActivity) => updateProfile((profile) => ({ ...profile, streamActivity }))} aria-label={agentsT('profiles.activity')} />
            </div>
            <div className={styles.formGrid}>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.failurePolicy')}</span>
                <select className={styles.select} disabled={draftControlsLocked} value={selectedProfile.failurePolicy} onChange={(event) => updateProfile((profile) => ({ ...profile, failurePolicy: event.target.value === 'optional' ? 'optional' : 'required' }))}>
                  <option value="required">{agentsT('profiles.failureRequired')}</option><option value="optional">{agentsT('profiles.failureOptional')}</option>
                </select>
              </label>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.maxOutputTokens')}</span>
                <input type="number" className={styles.input} disabled={draftControlsLocked} min={AGENT_MAX_OUTPUT_TOKENS_MIN} max={AGENT_MAX_OUTPUT_TOKENS_MAX} step={1} value={selectedProfile.maxOutputTokens} onChange={(event) => updateProfile((profile) => ({ ...profile, maxOutputTokens: Number(event.target.value) }))} />
              </label>
              <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('profiles.timeout')}</span>
                <input type="number" className={styles.input} disabled={draftControlsLocked} min={agentTimeoutMsToSeconds(AGENT_TIMEOUT_MS_MIN)} step={1} value={agentTimeoutMsToSeconds(selectedProfile.timeoutMs)} onChange={(event) => updateProfile((profile) => ({ ...profile, timeoutMs: parseAgentTimeoutSecondsInput(event.target.value) }))} />
              </label>
            </div>
            <div className={styles.sectionActions}>
              <button type="button" className={styles.button} disabled={draftControlsLocked} onClick={stageAgentBlock}>
                <Plus size={16} aria-hidden="true" /> {agentsT('syntax.createBlock')}
              </button>
              <code className={styles.code}>{`{{agent::${selectedProfile.id}::as=${getAgentResultName(selectedProfile.id)}}}`}</code>
              <button
                type="button"
                className={styles.dangerButton}
                disabled={draftControlsLocked}
                onClick={() => {
                  if (!isHydratedForCurrentPreset || saveInFlightRef.current) return
                  const removedProfileId = selectedProfile.id
                  updateConfig((config) => {
                    const nextConfig = {
                      ...config,
                      profiles: config.profiles.filter((_profile, index) => index !== selectedProfileIndex),
                    }
                    return updateRuntimePolicyChildProfileAssignments(nextConfig, removedProfileId, null)
                  })
                  setPromptOrder((current) => current.map((block) => {
                    if (typeof block.content !== 'string') return block
                    const content = removeAgentProfileMarkers(block.content, removedProfileId)
                    return revisePromptBlockContent(block, content)
                  }))
                  setSelectedProfileIndex((index) => Math.max(0, index - 1))
                }}
              ><Trash2 size={16} aria-hidden="true" /> {agentsT('actions.delete')}</button>
            </div>
          </div>
        ) : <p className={styles.empty}>{agentsT('profiles.empty')}</p>}
      </div>
    </>
  )

  const renderTools = () => (
    <>
      <SectionHeader title={t('sections.tools.title')} description={t('sections.tools.description')} />
      <div className={styles.formGrid}>
        <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('maxInvocations.label')}</span>
          <input id="agents-max-invocations" type="number" className={styles.input} min={AGENT_INVOCATION_MIN} step={1} value={maxInvocationsInput} aria-invalid={maxInvocationsInvalid} disabled={draftControlsLocked} onChange={(event) => {
            if (!isHydratedForCurrentPreset || saveInFlightRef.current) return
            setMaxInvocationsInput(event.target.value)
            const maxInvocations = parseAgentMaxInvocationsInput(event.target.value)
            if (!Number.isNaN(maxInvocations)) updateConfig((config) => ({ ...config, maxInvocations }))
          }} />

          <FieldError>{maxInvocationsInvalid ? agentsT('maxInvocations.error') : undefined}</FieldError>
        </label>
        <label className={styles.field}><span className={styles.fieldLabel}>{agentsT('maxToolCalls.label')}</span>
          <input id="agents-max-tool-calls" type="number" className={styles.input} min={AGENT_TOOL_CALL_MIN} step={1} value={maxToolCallsInput} aria-invalid={maxToolCallsInvalid} disabled={draftControlsLocked} onChange={(event) => {
            if (!isHydratedForCurrentPreset || saveInFlightRef.current) return
            setMaxToolCallsInput(event.target.value)
            const maxToolCalls = parseAgentMaxToolCallsInput(event.target.value)
            if (!Number.isNaN(maxToolCalls)) updateConfig((config) => ({ ...config, maxToolCalls }))
          }} />
          <FieldError>{maxToolCallsInvalid ? agentsT('maxToolCalls.error') : undefined}</FieldError>
        </label>
      </div>
      <ToolChecklist selected={draft.config.mainToolIds} disabled={draftControlsLocked} onChange={(mainToolIds) => updateConfig((config) => ({ ...config, mainToolIds }))} legend={agentsT('tools.legend')} />
      <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{agentsT('scope.label')}</legend>
        <div className={styles.segmented}>{(['active', 'all_owned'] as const).map((scope) => (
          <label key={scope} className={clsx(styles.segmentedOption, draft.config.mainLoreScope === scope && styles.segmentedSelected)}>
            <input type="radio" disabled={draftControlsLocked} name="main-lore-scope" checked={draft.config.mainLoreScope === scope} onChange={() => updateConfig((config) => ({ ...config, mainLoreScope: scope }))} />
            {agentsT(`scope.${scope}`)}
          </label>
        ))}</div>
      </fieldset>
    </>
  )
  const renderCustomPhases = () => (
    <section className={styles.editorStack} aria-labelledby="agentic-custom-phases-title">
      <div className={styles.sectionHeader}>
        <div>
          <h3 id="agentic-custom-phases-title">{t('customPhases.title')}</h3>
          <p>{t('customPhases.description')}</p>
        </div>
        <button
          type="button"
          className={styles.button}
          onClick={addCustomPhase}
          disabled={draftControlsLocked || draftCustomPhases.length >= AGENTIC_CUSTOM_PHASE_LIMIT}
        >
          <Plus size={16} aria-hidden="true" /> {t('customPhases.add')}
        </button>
      </div>
      {draftCustomPhases.length === 0 && <p className={styles.empty}>{t('customPhases.empty')}</p>}
      {draftCustomPhases.map((phase, phaseIndex) => {
        const nextPhase = draftCustomPhases[phaseIndex + 1]
        const selectedPromptOccurrences = new Set(phase.instructionRefs.map((source) => `${source.blockId}\u0000${source.promptOrder}`))
        const transitionTargets = [...new Set([
          phase.id,
          ...(nextPhase ? [nextPhase.id] : []),
          ...phase.nextPhaseIds.filter((phaseId) => phaseId !== phase.id && phaseId !== nextPhase?.id),
        ])]
        return (
          <details className={styles.disclosure} key={`${phase.id}-${phaseIndex}`} open={phaseIndex === 0}>
            <summary>
              <span>{phase.label || phase.id}</span>
              <small>{t('customPhases.summary', { number: phaseIndex + 1, id: phase.id })}</small>
              <ChevronDown size={18} aria-hidden="true" />
            </summary>
            <div className={styles.editorStack}>
              <div className={styles.readOnlyHeader}>
                <div>
                  <strong>{t('customPhases.order', { number: phaseIndex + 1 })}</strong>
                  <small>{t('customPhases.orderHint')}</small>
                </div>
                <div className={styles.inlineFields}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={phaseIndex === 0}
                    onClick={() => moveCustomPhase(phaseIndex, -1)}
                    aria-label={t('customPhases.moveUp', { label: phase.label || phase.id })}
                  >
                    <ChevronUp size={16} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className={styles.iconButton}
                    disabled={phaseIndex === draftCustomPhases.length - 1}
                    onClick={() => moveCustomPhase(phaseIndex, 1)}
                    aria-label={t('customPhases.moveDown', { label: phase.label || phase.id })}
                  >
                    <ChevronDown size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className={styles.formGrid}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('customPhases.id')}</span>
                  <input
                    className={styles.input}
                    disabled={draftControlsLocked}
                    value={phase.id}
                    maxLength={64}
                    pattern="[a-z][a-z0-9_]{0,63}"
                    required
                    aria-label={t('customPhases.idFor', { label: phase.label || phase.id })}
                    onChange={(event) => {
                      if (event.currentTarget.validity.valid && isEditablePredicateId(event.target.value)) {
                        renameCustomPhase(phaseIndex, event.target.value)
                      }
                    }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('customPhases.label')}</span>
                  <input
                    className={styles.input}
                    value={phase.label}
                    maxLength={AGENTIC_LABEL_MAX_LENGTH}
                    aria-label={t('customPhases.labelFor', { id: phase.id })}
                    onChange={(event) => updateCustomPhase(phaseIndex, (current) => ({ ...current, label: event.target.value }))}
                  />
                </label>
                <label className={styles.settingRow}>
                  <span><strong>{t('customPhases.required')}</strong><small>{t('customPhases.requiredHint')}</small></span>
                  <input
                    type="checkbox"
                    checked={phase.required}
                    aria-label={t('customPhases.requiredFor', { label: phase.label || phase.id })}
                    onChange={(event) => updateCustomPhase(phaseIndex, (current) => ({ ...current, required: event.target.checked }))}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{t('customPhases.repeatLimit')}</span>
                  <input
                    type="number"
                    className={styles.input}
                    min={0}
                    max={4}
                    step={1}
                    value={phase.repeatLimit}
                    aria-label={t('customPhases.repeatLimitFor', { label: phase.label || phase.id })}
                    onChange={(event) => {
                      const value = Number.parseInt(event.target.value, 10)
                      const repeatLimit = Number.isSafeInteger(value) ? Math.min(4, Math.max(0, value)) : 0
                      updateCustomPhase(phaseIndex, (current) => ({
                        ...current,
                        repeatLimit,
                        nextPhaseIds: repeatLimit === 0
                          ? current.nextPhaseIds.filter((phaseId) => phaseId !== current.id)
                          : current.nextPhaseIds,
                      }))
                    }}
                  />
                  <small>{t('customPhases.repeatLimitHint')}</small>
                </label>
              </div>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.instructions')}</legend>
                <p className={styles.muted}>{t('customPhases.instructionsHint')}</p>
                <div className={styles.optionList}>
                  {promptOrder.map((block, promptIndex) => {
                    if (block.marker === 'category') return null
                    const source = phase.instructionRefs.find((candidate) => candidate.blockId === block.id && candidate.promptOrder === promptIndex)
                    const blockRevision = block.revision === undefined
                      ? 1
                      : isCanonicalBlockRevision(block.revision) ? block.revision : null
                    const needsRepair = source !== undefined && (
                      blockRevision === null
                      || source.presetRevision !== (preset.cacheRevision ?? 0)
                      || source.blockRevision !== blockRevision
                      || source.promptOrder !== promptIndex
                    )
                    return (
                      <div className={styles.sourceChoiceRow} key={`${phase.id}-instruction-${block.id}-${promptIndex}`}>
                        <label className={clsx(
                          styles.listChoice,
                          (needsRepair || blockRevision === null) && styles.listChoiceInvalid,
                        )}>
                          <input
                            type="checkbox"
                            checked={selectedPromptOccurrences.has(`${block.id}\u0000${promptIndex}`)}
                            disabled={blockRevision === null && source === undefined}
                            aria-invalid={needsRepair || blockRevision === null}
                            onChange={(event) => toggleCustomPhaseInstruction(phaseIndex, block, promptIndex, event.target.checked)}
                          />
                          <span>
                            <strong>{block.name}</strong>
                            <small>{block.id}</small>
                            <small>{source ? t('phases.sourceRevision', {
                              presetRevision: source.presetRevision,
                              blockRevision: source.blockRevision,
                              promptOrder: source.promptOrder,
                            }) : t('customPhases.notSelected')}</small>
                            {needsRepair && <small role="alert">{t('phases.stale')}</small>}
                            {blockRevision === null && <small role="alert">{t('limits.invalidBlockRevision')}</small>}
                          </span>
                        </label>
                        {source && needsRepair && blockRevision !== null && (
                          <button
                            type="button"
                            className={styles.button}
                            onClick={() => toggleCustomPhaseInstruction(phaseIndex, block, promptIndex, true)}
                          >
                            <RefreshCw size={16} aria-hidden="true" />
                            {t('repair.actions.select_revision')}
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {phase.instructionRefs
                    .filter((source) => {
                      const block = promptOrder[source.promptOrder]
                      return !block || block.id !== source.blockId || block.marker === 'category'
                    })
                    .map((source) => (
                      <div role="alert" className={clsx(styles.listChoice, styles.listChoiceInvalid, styles.sourceChoiceStatic)} key={`${phase.id}-unknown-${source.blockId}-${source.promptOrder}`}>
                        <span>
                          <strong>{source.blockId}</strong>
                          <small>{t('customPhases.unavailableInstruction', { id: source.blockId })}</small>
                          <small>{t('phases.sourceRevision', {
                            presetRevision: source.presetRevision,
                            blockRevision: source.blockRevision,
                            promptOrder: source.promptOrder,
                          })}</small>
                        </span>
                        <button
                          type="button"
                          className={styles.iconButton}
                          onClick={() => updateCustomPhase(phaseIndex, (current) => ({
                            ...current,
                            instructionRefs: current.instructionRefs.filter((candidate) => candidate.blockId !== source.blockId || candidate.promptOrder !== source.promptOrder),
                            childInstructionSubsets: current.childInstructionSubsets.map((subset) => ({
                              ...subset,
                              instructionRefs: subset.instructionRefs.filter((candidate) => candidate.blockId !== source.blockId || candidate.promptOrder !== source.promptOrder),
                            })),
                          }))}
                          aria-label={t('customPhases.removeInstruction', { id: source.blockId })}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                </div>
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.childInstructionSubsets')}</legend>
                <p className={styles.muted}>{t('customPhases.childInstructionSubsetsHint')}</p>
                {draftProfiles.length === 0 ? (
                  <p className={styles.empty}>{t('customPhases.childInstructionSubsetsNoProfiles')}</p>
                ) : (
                  <div className={styles.childSubsetList}>
                    {draftProfiles.map((profile) => {
                      const subsetIndex = phase.childInstructionSubsets.findIndex((subset) => subset.profileId === profile.id)
                      const subset = subsetIndex < 0 ? undefined : phase.childInstructionSubsets[subsetIndex]
                      const assignedPromptOccurrences = new Set(subset?.instructionRefs.map((source) => `${source.blockId}\u0000${source.promptOrder}`) ?? [])
                      const subsetHasRepair = subsetIndex >= 0 && validation.issues.some((issue) => (
                        issue.path.startsWith(
                          `config.runtimePolicy.phases.${phaseIndex}.childInstructionSubsets.${subsetIndex}`,
                        )
                      ))
                      return (
                        <div
                          className={clsx(styles.childSubsetCard, subsetHasRepair && styles.listChoiceInvalid)}
                          key={`${phase.id}-child-subset-${profile.id}`}
                        >
                          <div className={styles.childSubsetHeader}>
                            <div>
                              <strong>{profile.name || profile.id}</strong>
                              <small>{t('customPhases.childSubsetProfileId', { id: profile.id })}</small>
                            </div>
                            <label className={styles.inlineCheckbox}>
                              <input
                                type="checkbox"
                                checked={subset !== undefined}
                                disabled={draftControlsLocked}
                                aria-label={t('customPhases.childSubsetAssignFor', { id: profile.id })}
                                onChange={(event) => toggleCustomPhaseChildSubsetAssignment(
                                  phaseIndex,
                                  profile.id,
                                  event.target.checked,
                                )}
                              />
                              {t('customPhases.childSubsetAssign')}
                            </label>
                          </div>
                          <p className={styles.muted}>
                            {subset === undefined
                              ? t('customPhases.childSubsetUnassigned')
                              : subset.instructionRefs.length === 0
                                ? t('customPhases.childSubsetEmpty')
                                : t('customPhases.childSubsetCount', { count: subset.instructionRefs.length })}
                          </p>
                          {subsetHasRepair && (
                            <p className={styles.fieldError} role="alert">{t('customPhases.childSubsetRepair')}</p>
                          )}
                          <div className={styles.optionList}>
                            {phase.instructionRefs.map((source) => {
                              const block = promptOrder[source.promptOrder]
                              const promptIndex = block === undefined || block.id !== source.blockId ? -1 : source.promptOrder
                              const blockRevision = block === undefined
                                ? null
                                : block.revision === undefined
                                  ? 1
                                  : isCanonicalBlockRevision(block.revision) ? block.revision : null
                              const stale = block === undefined
                                || block.marker === 'category'
                                || source.presetRevision !== (preset.cacheRevision ?? 0)
                                || source.blockRevision !== blockRevision
                                || source.promptOrder !== promptIndex
                              return (
                                <label
                                  className={clsx(styles.listChoice, stale && styles.listChoiceInvalid)}
                                  key={`${phase.id}-${profile.id}-child-instruction-${source.blockId}-${source.promptOrder}`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={assignedPromptOccurrences.has(`${source.blockId}\u0000${source.promptOrder}`)}
                                    aria-invalid={stale}
                                    disabled={subset === undefined || draftControlsLocked}
                                    onChange={(event) => toggleCustomPhaseChildSubset(
                                      phaseIndex,
                                      profile.id,
                                      source,
                                      event.target.checked,
                                    )}
                                  />
                                  <span>
                                    <strong>{block?.name ?? source.blockId}</strong>
                                    <small>{source.blockId}</small>
                                    <small>{t('phases.sourceRevision', {
                                      presetRevision: source.presetRevision,
                                      blockRevision: source.blockRevision,
                                      promptOrder: source.promptOrder,
                                    })}</small>
                                    {stale && <small>{t('customPhases.childSubsetRepair')}</small>}
                                  </span>
                                </label>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                    {phase.childInstructionSubsets.map((subset, subsetIndex) => {
                      if (draftProfiles.some((profile) => profile.id === subset.profileId)) return null
                      return (
                        <div
                          className={clsx(styles.childSubsetCard, styles.listChoiceInvalid)}
                          key={`${phase.id}-orphan-child-subset-${subset.profileId}-${subsetIndex}`}
                        >
                          <div className={styles.childSubsetHeader}>
                            <div>
                              <strong>{t('customPhases.childSubsetUnknownProfile', { id: subset.profileId })}</strong>
                              <small>{t('customPhases.childSubsetRepair')}</small>
                            </div>
                            <button
                              type="button"
                              className={styles.iconButton}
                              disabled={draftControlsLocked}
                              onClick={() => updateCustomPhase(phaseIndex, (current) => ({
                                ...current,
                                childInstructionSubsets: current.childInstructionSubsets.filter(
                                  (_candidate, candidateIndex) => candidateIndex !== subsetIndex,
                                ),
                              }))}
                              aria-label={t('customPhases.childSubsetRemove', { id: subset.profileId })}
                            >
                              <Trash2 size={16} aria-hidden="true" />
                            </button>
                          </div>
                          <p className={styles.fieldError} role="alert">{t('customPhases.childSubsetRepair')}</p>
                          <div className={styles.optionList}>
                            {subset.instructionRefs.map((source) => (
                              <div className={styles.listChoiceInvalid} key={`${phase.id}-orphan-${subset.profileId}-${source.blockId}-${source.promptOrder}`}>
                                <span>
                                  <strong>{source.blockId}</strong>
                                  <small>{t('phases.sourceRevision', {
                                    presetRevision: source.presetRevision,
                                    blockRevision: source.blockRevision,
                                    promptOrder: source.promptOrder,
                                  })}</small>
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.enter')}</legend>
                <p className={styles.muted}>{t('customPhases.enterHint')}</p>
                <PredicateEditor value={phase.enter} taskTemplateIds={taskTemplateIds} disabled={draftControlsLocked} onChange={(enter) => updateCustomPhase(phaseIndex, (current) => ({ ...current, enter }))} />
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.exit')}</legend>
                <p className={styles.muted}>{t('customPhases.exitHint')}</p>
                <PredicateEditor value={phase.exit} taskTemplateIds={taskTemplateIds} disabled={draftControlsLocked} onChange={(exit) => updateCustomPhase(phaseIndex, (current) => ({ ...current, exit }))} />
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.skip')}</legend>
                <label className={styles.settingRow}>
                  <span><strong>{t('customPhases.skipEnabled')}</strong><small>{t('customPhases.skipHint')}</small></span>
                  <input
                    type="checkbox"
                    checked={phase.skip !== undefined}
                    disabled={draftControlsLocked}
                    aria-label={t('customPhases.skipFor', { label: phase.label || phase.id })}
                    onChange={(event) => updateCustomPhase(phaseIndex, (current) => {
                      if (!event.target.checked) {
                        const next = { ...current }
                        delete next.skip
                        return next
                      }
                      return { ...current, skip: current.skip ?? makePredicate('phase') }
                    })}
                  />
                </label>
                {phase.skip && <PredicateEditor value={phase.skip} taskTemplateIds={taskTemplateIds} disabled={draftControlsLocked} onChange={(skip) => updateCustomPhase(phaseIndex, (current) => ({ ...current, skip }))} />}
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.capabilities')}</legend>
                <p className={styles.muted}>{t('customPhases.capabilitiesHint')}</p>
                <div className={styles.toolGrid}>
                  {AGENT_CUSTOM_PHASE_CAPABILITIES.map((capability) => (
                    <label className={clsx(styles.choiceCard, phase.capabilityRequests.includes(capability) && styles.choiceCardSelected)} key={`${phase.id}-capability-${capability}`}>
                      <input
                        type="checkbox"
                        checked={phase.capabilityRequests.includes(capability)}
                        onChange={(event) => toggleCustomPhaseCapability(phaseIndex, capability, event.target.checked)}
                      />
                      <span><strong>{t(`customPhases.capabilitiesList.${capability}`)}</strong></span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className={styles.fieldset}>
                <legend className={styles.fieldLabel}>{t('customPhases.transitions')}</legend>
                <p className={styles.muted}>{t('customPhases.transitionsHint')}</p>
                <div className={styles.readOnlyHeader}>
                  <div>
                    <strong>{phase.nextPhaseIds.length === 0
                      ? t('customPhases.transitionAutomatic')
                      : t('customPhases.transitionExplicit')}</strong>
                    <small>{phase.nextPhaseIds.length === 0
                      ? t('customPhases.transitionAutomaticHint')
                      : t('customPhases.transitionExplicitHint')}</small>
                  </div>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={phase.nextPhaseIds.length === 0 && !nextPhase && phase.repeatLimit === 0}
                    onClick={() => updateCustomPhase(phaseIndex, (current) => ({
                      ...current,
                      nextPhaseIds: current.nextPhaseIds.length === 0
                        ? nextPhase
                          ? [nextPhase.id]
                          : current.repeatLimit > 0
                            ? [current.id]
                            : []
                        : [],
                    }))}
                  >
                    {phase.nextPhaseIds.length === 0
                      ? t('customPhases.useExplicitTransitions')
                      : t('customPhases.useAutomaticTransition')}
                  </button>
                </div>
                {phase.nextPhaseIds.length === 0 ? (
                  <p className={styles.muted}>
                    {nextPhase
                      ? t('customPhases.transitionAutomaticNext', { label: nextPhase.label || nextPhase.id })
                      : t('customPhases.transitionAutomaticTerminal')}
                  </p>
                ) : (
                  <div className={styles.optionList}>
                    {transitionTargets.map((target) => (
                      <label className={styles.listChoice} key={`${phase.id}-transition-${target}`}>
                        <input
                          type="checkbox"
                          checked={phase.nextPhaseIds.includes(target)}
                          disabled={target === phase.id && phase.repeatLimit === 0 && !phase.nextPhaseIds.includes(target)}
                          onChange={(event) => toggleCustomPhaseTransition(phaseIndex, target, event.target.checked)}
                        />
                        <span>
                          <strong>
                            {target === phase.id
                              ? t('customPhases.repeatTarget')
                              : target === nextPhase?.id
                                ? t('customPhases.nextTarget', { label: nextPhase.label || nextPhase.id })
                                : t('customPhases.invalidTarget', { id: target })}
                          </strong>
                          <small>{target}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
              <button type="button" className={styles.dangerButton} onClick={() => removeCustomPhase(phaseIndex)}>
                <Trash2 size={16} aria-hidden="true" /> {t('customPhases.remove')}
              </button>
            </div>
          </details>
        )
      })}
    </section>
  )


  const renderPhases = () => {
    const responseOmissionEntries = POLICY_KEYS.flatMap((policyKey) => (
      draftLoomPolicy[policyKey]
    ))
    const responseOmissionPhases = draftCustomPhases
    return (
      <>
        <SectionHeader title={t('sections.phases.title')} description={t('sections.phases.description')} />
        {(responseOmissionEntries.length > 0 || responseOmissionPhases.length > 0) && (
          <div className={styles.notice} role="status">
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <strong>{t('phases.responseOmissionTitle')}</strong>
              <p>{t('phases.responseOmissionHint')}</p>
              <ul className={styles.selectionList}>
                {responseOmissionEntries.map((entry) => (
                  <li key={`response-omission-${entry.id}`}>
                    <span>
                      <strong>{entry.source.blockId}</strong>
                      <small>{t('phases.responseOmissionRoute', {
                        destination: t(`phases.destinations.${entry.destination}`),
                        checkpoint: t(`phases.checkpoints.${entry.checkpoint}`),
                      })}</small>
                      <small>{t('phases.responseOmissionEntry', { id: entry.id })}</small>
                      <small>{t('phases.sourceRevision', {
                        presetRevision: entry.source.presetRevision,
                        blockRevision: entry.source.blockRevision,
                        promptOrder: entry.source.promptOrder,
                      })}</small>
                    </span>
                  </li>
                ))}
                {responseOmissionPhases.map((phase, phaseIndex) => (
                  <li key={`response-omission-phase-${phase.id}-${phaseIndex}`}>
                    <span>
                      <strong>{phase.label || phase.id}</strong>
                      <small>{t('customPhases.summary', { number: phaseIndex + 1, id: phase.id })}</small>
                      {phase.instructionRefs.map((source) => (
                        <small key={`response-omission-phase-${phase.id}-${source.blockId}-${source.promptOrder}`}>
                          {t('phases.responseOmissionPhaseInstruction', {
                            blockId: source.blockId,
                            blockRevision: source.blockRevision,
                          })}
                          {' · '}
                          {t('phases.sourceRevision', {
                            presetRevision: source.presetRevision,
                            blockRevision: source.blockRevision,
                            promptOrder: source.promptOrder,
                          })}
                        </small>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        {renderCustomPhases()}
        {POLICY_KEYS.map((policyKey) => {
          const entries = draftLoomPolicy[policyKey]
          const policyDestination = POLICY_DESTINATIONS[policyKey]
          const policyCheckpoint = POLICY_CHECKPOINTS[policyKey]
          return (
            <details className={styles.disclosure} key={policyKey} open={policyKey === 'workPolicy'}>
              <summary><span>{t(`phases.${policyKey}.title`)}</span><small>{t(`phases.${policyKey}.description`)}</small><ChevronDown size={18} aria-hidden="true" /></summary>
              <div className={styles.editorStack}>
                <div className={styles.readOnlyHeader}>
                  <div>
                    <strong>{t('phases.routing')}</strong>
                    <small>{t('phases.routingHint')}</small>
                  </div>
                  <span>{t('phases.routingValue', {
                    destination: t(`phases.destinations.${policyDestination}`),
                    checkpoint: t(`phases.checkpoints.${policyCheckpoint}`),
                  })}</span>
                </div>
                <div className={styles.optionList}>
                  {promptOrder.map((block, promptIndex) => {
                    if (block.marker === 'category') return null
                    const entry = entries.find((candidate) => candidate.source.blockId === block.id && candidate.source.promptOrder === promptIndex)
                    const blockRevision = block.revision === undefined
                      ? 1
                      : isCanonicalBlockRevision(block.revision) ? block.revision : null
                    const needsRepair = entry !== undefined && (
                      blockRevision === null
                      || entry.source.presetRevision !== (preset.cacheRevision ?? 0)
                      || entry.source.blockRevision !== blockRevision
                      || entry.source.promptOrder !== promptIndex
                    )
                    return (
                      <div key={`${policyKey}-${block.id}-${promptIndex}`} className={styles.editorStack}>
                        <div className={styles.sourceChoiceRow}>
                          <label className={clsx(
                            styles.listChoice,
                            (needsRepair || blockRevision === null) && styles.listChoiceInvalid,
                          )}>
                            <input
                              type="checkbox"
                              checked={entry !== undefined}
                              disabled={blockRevision === null && entry === undefined}
                              aria-invalid={needsRepair || blockRevision === null}
                              onChange={(event) => togglePolicyBlock(policyKey, block, promptIndex, event.target.checked)}
                            />
                            <span>
                              <strong>{block.name}</strong>
                              <small>{block.id}</small>
                              <small>{entry ? t('phases.sourceRevision', {
                                presetRevision: entry.source.presetRevision,
                                blockRevision: entry.source.blockRevision,
                                promptOrder: entry.source.promptOrder,
                              }) : t('phases.notSelected')}</small>
                              {needsRepair && <small role="alert">{t('phases.stale')}</small>}
                              {blockRevision === null && <small role="alert">{t('limits.invalidBlockRevision')}</small>}
                            </span>
                          </label>
                          {entry && needsRepair && blockRevision !== null && (
                            <button
                              type="button"
                              className={styles.button}
                              onClick={() => togglePolicyBlock(policyKey, block, promptIndex, true)}
                            >
                              <RefreshCw size={16} aria-hidden="true" />
                              {t('repair.actions.select_revision')}
                            </button>
                          )}
                        </div>
                        {entry && (
                          <div className={styles.editorStack}>
                            <div className={styles.readOnlyHeader}>
                              <div>
                                <strong>{t('phases.source')}</strong>
                                <small>{entry.source.blockId}</small>
                              </div>
                              <code className={styles.code}>{entry.id}</code>
                            </div>
                            <div className={styles.formGrid}>
                              <label className={styles.settingRow}>
                                <span><strong>{t('phases.required')}</strong><small>{t('phases.requiredHint')}</small></span>
                                <input
                                  type="checkbox"
                                  checked={entry.required}
                                  aria-label={t('phases.requiredFor', { name: block.name })}
                                  onChange={(event) => updatePolicyEntry(policyKey, block.id, promptIndex, (current) => ({ ...current, required: event.target.checked }))}
                                />
                              </label>
                              <label className={styles.settingRow}>
                                <span><strong>{t('phases.condition')}</strong><small>{t('phases.conditionHint')}</small></span>
                                <input
                                  type="checkbox"
                                  checked={entry.condition !== undefined}
                                  aria-label={t('phases.conditionFor', { name: block.name })}
                                  onChange={(event) => updatePolicyEntry(policyKey, block.id, promptIndex, (current) => {
                                    if (event.target.checked) {
                                      return {
                                        ...current,
                                        condition: current.condition ?? { kind: 'phase', value: policyCheckpoint },
                                      }
                                    }
                                    const { condition: _condition, ...withoutCondition } = current
                                    return withoutCondition
                                  })}
                                />
                              </label>
                            </div>
                            {entry.condition !== undefined && (
                              <PredicateEditor
                                value={entry.condition}
                                taskTemplateIds={taskTemplateIds}
                                disabled={draftControlsLocked}
                                onChange={(condition) => updatePolicyEntry(policyKey, block.id, promptIndex, (current) => ({ ...current, condition }))}
                              />
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                  {entries
                    .filter((entry) => {
                      const block = promptOrder[entry.source.promptOrder]
                      return !block || block.id !== entry.source.blockId || block.marker === 'category'
                    })
                    .map((entry) => (
                      <div
                        role="alert"
                        className={clsx(styles.listChoice, styles.listChoiceInvalid, styles.sourceChoiceStatic)}
                        key={`${policyKey}-unknown-${entry.id}`}
                      >
                        <span>
                          <strong>{entry.source.blockId}</strong>
                          <small>{t('customPhases.unavailableInstruction', { id: entry.source.blockId })}</small>
                          <small>{t('phases.sourceRevision', {
                            presetRevision: entry.source.presetRevision,
                            blockRevision: entry.source.blockRevision,
                            promptOrder: entry.source.promptOrder,
                          })}</small>
                          <small>{entry.id}</small>
                        </span>
                        <button
                          type="button"
                          className={styles.button}
                          onClick={() => updateConfig((config) => {
                            const buckets = getAgentRuntimePolicyBuckets(config, promptOrder)
                            return setAgentRuntimePolicyBuckets(config, {
                              ...buckets,
                              [policyKey]: buckets[policyKey].filter((candidate) => candidate.id !== entry.id),
                            })
                          })}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                          {t('repair.actions.discard')}
                        </button>
                      </div>
                    ))}
                </div>
              </div>
            </details>
          )
        })}
      </>
    )
  }


  const renderTasks = () => (
    <>
      <SectionHeader title={t('sections.tasks.title')} description={t('sections.tasks.description')} />
      <div className={styles.sectionActions}><button type="button" className={styles.button} disabled={draft.taskTemplates.length >= AGENTIC_TASK_TEMPLATE_LIMIT} onClick={addTaskTemplate}><Plus size={16} aria-hidden="true" /> {t('tasks.add')}</button></div>
      {draft.taskTemplates.map((template, index) => {
        if (!isAgentTaskTemplate(template)) {
          return (
            <div className={styles.notice} role="alert" key={`quarantined-task-${index}`}>
              <AlertTriangle size={18} aria-hidden="true" />
              <div><strong>{t('tasks.quarantined')}</strong><p>{t('tasks.quarantinedHint')}</p></div>
              <button type="button" className={styles.iconButton} onClick={() => discardTaskTemplate(index)} aria-label={t('tasks.discardQuarantined')}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          )
        }
        return (
          <details className={styles.disclosure} key={`${template.id}-${index}`}>
            <summary><span>{template.label || template.id}</span><small>{template.required ? t('tasks.required') : t('tasks.optional')}</small><ChevronDown size={18} aria-hidden="true" /></summary>
            <div className={styles.editorStack}>
              <div className={styles.formGrid}><label className={styles.field}><span className={styles.fieldLabel}>{t('tasks.id')}</span><input className={styles.input} disabled={draftControlsLocked} value={template.id} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, id: event.target.value }))} /></label><label className={styles.field}><span className={styles.fieldLabel}>{t('tasks.label')}</span><input className={styles.input} value={template.label ?? ''} maxLength={AGENTIC_LABEL_MAX_LENGTH} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, label: event.target.value }))} /></label></div>
              <label className={styles.field}><span className={styles.fieldLabel}>{t('tasks.description')}</span><textarea className={styles.textarea} value={template.description ?? ''} maxLength={AGENTIC_DESCRIPTION_MAX_BYTES} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, description: event.target.value }))} /></label>
              <label className={styles.settingRow}><span><strong>{t('tasks.required')}</strong><small>{t('tasks.requiredHint')}</small></span><input type="checkbox" checked={template.required} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, required: event.target.checked }))} /></label>
              <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{t('tasks.dependencies')}</legend><div className={styles.optionList}>{draft.taskTemplates.filter((_candidate, candidateIndex) => candidateIndex !== index).filter((candidate) => isAgentTaskTemplate(candidate)).map((candidate) => <label className={styles.listChoice} key={candidate.id}><input type="checkbox" checked={(template.dependencies ?? []).includes(candidate.id)} onChange={(event) => updateTaskTemplate(index, (current) => ({ ...current, dependencies: event.target.checked ? [...(current.dependencies ?? []), candidate.id] : (current.dependencies ?? []).filter((id) => id !== candidate.id) }))} /><span><strong>{candidate.label || candidate.id}</strong><small>{candidate.id}</small></span></label>)}</div></fieldset>
              <PredicateEditor value={template.activation ?? { kind: 'phase', value: 'WORK' }} taskTemplateIds={taskTemplateIds} disabled={draftControlsLocked} onChange={(activation) => updateTaskTemplate(index, (current) => ({ ...current, activation }))} />
              <button type="button" className={styles.dangerButton} onClick={() => removeTaskTemplate(index)}><Trash2 size={16} aria-hidden="true" /> {t('tasks.remove')}</button>
            </div>
          </details>
        )
      })}
    </>
  )

  const renderWorkspace = () => (
    <>
      <SectionHeader title={t('sections.workspace.title')} description={t('sections.workspace.description')} />
      <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{t('workspace.retention')}</legend>{(['turn_terminal', 'chat_lifetime'] as const).map((retention) => <label className={styles.modeRow} key={retention}><input type="radio" name="workspace-retention" checked={(draft.config.workspacePolicy?.retention ?? 'turn_terminal') === retention} onChange={() => updateConfig((config) => ({ ...config, workspacePolicy: { retention, sharing: config.workspacePolicy?.sharing ?? 'view_only' } }))} /><span><strong>{t(`workspace.retentionOptions.${retention}`)}</strong><small>{t(`workspace.retentionHints.${retention}`)}</small></span></label>)}</fieldset>
      <fieldset className={styles.fieldset}><legend className={styles.fieldLabel}>{t('workspace.sharing')}</legend>{(['root_only', 'view_only'] as const).map((sharing) => <label className={styles.modeRow} key={sharing}><input type="radio" name="workspace-sharing" checked={(draft.config.workspacePolicy?.sharing ?? 'view_only') === sharing} onChange={() => updateConfig((config) => ({ ...config, workspacePolicy: { retention: config.workspacePolicy?.retention ?? 'turn_terminal', sharing } }))} /><span><strong>{t(`workspace.sharingOptions.${sharing}`)}</strong><small>{t(`workspace.sharingHints.${sharing}`)}</small></span></label>)}</fieldset>
      <div className={styles.readOnlyHeader}><div><strong>{t('workspace.ceilings')}</strong><small>{t('workspace.ceilingsHint')}</small></div><span>{t('workspace.readOnly')}</span></div>
      {hostCeilings ? <dl className={styles.ceilingGrid}>{Object.entries(hostCeilings).map(([key, value]) => <div key={key}><dt>{t(`workspace.ceilingLabels.${key}`)}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl> : <p className={styles.muted}>{t('workspace.loading')}</p>}
    </>
  )

  const renderRepair = () => (
    <>
      <SectionHeader title={t('sections.repair.title')} description={t('sections.repair.description')} />
      {(draft.quarantinedConnectionSlots ?? []).map((item) => (
        <div className={styles.notice} role="alert" key={item.id}>
          <AlertTriangle size={18} aria-hidden="true" />
          <div><strong>{t('tasks.quarantined')}</strong><p>{t('tasks.quarantinedHint')}</p></div>
          <button type="button" className={styles.iconButton} onClick={() => discardQuarantinedConnectionSlot(item.id)} aria-label={t('tasks.discardQuarantined')}>
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      {draft.config.connectionSlots.length > 0 && (
        <div className={styles.editorStack}>
          {draft.config.connectionSlots.map((slot) => (
            <div className={styles.slotRow} key={slot.id}>
              <span><strong>{slot.label}</strong><small>{slot.id} · {slot.requiredCapabilities.join(', ')}</small></span>
              <ConnectionSelect
                kind="llm"
                value={draft.slotBindings[slot.id] ?? ''}
                onChange={(connectionId) => updateSlotBinding(slot.id, connectionId)}
                optionFilter={(profile) => providerSupportsAgentCapabilities(providers, profile.provider, slot.requiredCapabilities)}
                optionState={(profile) => providerSupportsAgentCapabilities(providers, profile.provider, slot.requiredCapabilities)
                  ? undefined
                  : {
                      disabled: true,
                      annotation: t('repair.reasons.capability_mismatch'),
                    }}
                placeholder={t('repair.chooseConnection')}
                searchPlaceholder={t('repair.searchConnections')}
                emptyMessage={t('repair.noConnections')}
                ariaLabel={t('repair.mapSlot', { name: slot.label })}
                clearable
                portal
              />
            </div>
          ))}
        </div>
      )}
      {reviewItems.length > 0 ? (
        <ul className={styles.repairList}>
          {reviewItems.map((item) => (
            <RepairRow
              key={item.id}
              item={item}
              acknowledged={draft.reviewAcknowledgements.includes(item.id)}
              onAcknowledge={(checked) => updateDraft((current) => ({
                ...current,
                reviewAcknowledgements: checked
                  ? [...new Set([...current.reviewAcknowledgements, item.id])]
                  : current.reviewAcknowledgements.filter((id) => id !== item.id),
              }))}
              onRepair={item.id.startsWith('loom-policy:')
                ? () => resolveRuntimePolicyRepair(item)
                : undefined}
            />
          ))}
        </ul>
      ) : draft.config.agentsEnabled && isHydratedForCurrentPreset ? null : (
        <div className={styles.successNotice}><Check size={18} aria-hidden="true" /><span>{t('repair.ready')}</span></div>
      )}
      {draft.config.agentsEnabled && isHydratedForCurrentPreset ? (
        <div className={styles.notice} role="status">
          <RefreshCw size={18} aria-hidden="true" />
          <div>
            <p>{loomRevisionRestagePending ? t('repair.selectCurrentLoomRevisionsPending') : t('repair.selectCurrentLoomRevisionsHint')}</p>
            <button
              type="button"
              className={styles.button}
              onClick={stageCurrentLoomRevisions}
              disabled={draftControlsLocked || saveState === 'conflict'}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {t('repair.selectCurrentLoomRevisions')}
            </button>
          </div>
        </div>
      ) : null}
      <div className={styles.boundaryNotice}><ClipboardCheck size={18} aria-hidden="true" /><p>{t('repair.boundary')}</p></div>
    </>
  )

  const sectionContent: Record<SectionId, () => ReactNode> = {
    activation: renderActivation,
    agents: renderAgents,
    tools: renderTools,
    phases: renderPhases,
    tasks: renderTasks,
    workspace: renderWorkspace,
    repair: renderRepair,
  }

  const firstIssue = validation.issues[0]
  const validationStatus = validation.issues.length === 0
    ? null
    : validation.issues.map((issue) => `${t(`validation.${issue.code}`, { defaultValue: t('validation.invalid_config') })} (${issue.path})`).join(' ')
  const runtimeStatus = editorLoadError
    ? t('load.error')
    : !isHydratedForCurrentPreset
      ? t('load.loading')
      : draft.config.agentsEnabled
        ? t('status.enabled')
        : t('status.disabled')
  const saveStatus = editorLoadError
    ? t('load.error')
    : !isHydratedForCurrentPreset
      ? saveState === 'conflict'
        ? t('save.conflict')
        : t('load.loading')
      : saveState === 'saving'
        ? t('save.saving')
        : saveState === 'conflict'
          ? t('save.conflict')
          : saveState === 'error'
            ? t('save.error')
            : validationStatus
              ? validationStatus
              : dirty
                ? t('save.unsaved')
                : t('save.saved')
  return (
    <div className={styles.panel}>
      <header className={styles.hero}>
        <div><p className={styles.eyebrow}>{t('eyebrow')}</p><h2>{t('title')}</h2><p>{t('description')}</p></div>
        <span className={clsx(styles.statusBadge, isHydratedForCurrentPreset && draft.config.agentsEnabled && styles.statusBadgeEnabled)}>{runtimeStatus}</span>
      </header>
      <div className={styles.boundaryNotice} role="note">
        <ShieldCheck size={18} aria-hidden="true" />
        <p>{t('nativeContextNotice')}</p>
      </div>
      {hasHydratedEditor && saveState === 'conflict' && (
        <div className={styles.notice} role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>{t('save.conflict')}</strong>
            <p>{hasPendingExternalSnapshot ? t('save.latestReady') : t('save.conflictHint')}</p>
            {conflictRecoveryState === 'error' && <p>{t('save.reloadError')}</p>}
            {!hasPendingExternalSnapshot && (
              <button type="button" className={styles.button} onClick={() => { void reloadLatestForReview() }} disabled={conflictRecoveryState === 'loading'}>
                <RefreshCw size={16} aria-hidden="true" />
                {conflictRecoveryState === 'loading' ? t('save.reloadingLatest') : t('save.reloadLatest')}
              </button>
            )}
          </div>
        </div>
      )}
      {editorLoadError ? (
        <div className={clsx(styles.notice, styles.loadError)} role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>{t('load.error')}</strong>
            {saveState === 'conflict' && <p>{t('save.conflictHint')}</p>}
            {conflictRecoveryState === 'error' && <p>{t('save.reloadError')}</p>}
            <button
              type="button"
              className={styles.button}
              onClick={() => { void reloadLatestForReview() }}
              disabled={saveState === 'saving' || conflictRecoveryState === 'loading'}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {saveState === 'conflict'
                ? conflictRecoveryState === 'loading' ? t('save.reloadingLatest') : t('save.reloadLatest')
                : t('load.retry')}
            </button>
          </div>
        </div>
      ) : !hasHydratedEditor && saveState === 'conflict' ? (
        <div className={styles.notice} role="alert">
          <AlertTriangle size={20} aria-hidden="true" />
          <div>
            <strong>{t('save.conflict')}</strong>
            <p>{t('save.conflictHint')}</p>
            {conflictRecoveryState === 'error' && <p>{t('save.reloadError')}</p>}
            <button type="button" className={styles.button} onClick={() => { void reloadLatestForReview() }} disabled={conflictRecoveryState === 'loading'}>
              <RefreshCw size={16} aria-hidden="true" />
              {t('load.retry')}
            </button>
            <button type="button" className={styles.button} onClick={() => { void reloadLatestForReview() }} disabled={conflictRecoveryState === 'loading'}>
              <RefreshCw size={16} aria-hidden="true" />
              {conflictRecoveryState === 'loading' ? t('save.reloadingLatest') : t('save.reloadLatest')}
            </button>
          </div>
        </div>
      ) : !hasHydratedEditor ? (
        <div className={styles.notice} role="status">
          <span>{t('load.loading')}</span>
        </div>
      ) : (
      <div className={styles.shell}>
        {!isHydratedForCurrentPreset && (
          <div className={styles.notice} role="status">
            <RefreshCw size={20} aria-hidden="true" />
            <div>
              <strong>{t('load.loading')}</strong>
              {conflictRecoveryState === 'error' && <p>{t('save.reloadError')}</p>}
              <button
                type="button"
                className={styles.button}
                onClick={() => { void reloadLatestForReview() }}
                disabled={conflictRecoveryState === 'loading' || saveState === 'saving'}
              >
                <RefreshCw size={16} aria-hidden="true" />
                {conflictRecoveryState === 'loading' ? t('save.reloadingLatest') : t('save.reloadLatest')}
              </button>
            </div>
          </div>
        )}
        <nav className={styles.sectionNav} role="tablist" aria-label={t('navigation.ariaLabel')} aria-orientation="vertical">
          {SECTION_IDS.map((sectionId, index) => {
            const Icon = SECTION_ICONS[sectionId]
            return <button key={sectionId} ref={(element) => { if (element) tabRefs.current.set(sectionId, element); else tabRefs.current.delete(sectionId) }} type="button" role="tab" id={`agentic-runtime-tab-${sectionId}`} aria-controls="agentic-runtime-panel" aria-selected={activeSection === sectionId} tabIndex={activeSection === sectionId ? 0 : -1} className={clsx(styles.sectionTab, activeSection === sectionId && styles.sectionTabActive)} onClick={() => setActiveSection(sectionId)} onKeyDown={(event) => handleSectionKeyDown(event, index)}><Icon size={18} aria-hidden="true" /><span>{t(`sections.${sectionId}.nav`)}</span>{sectionId === 'repair' && unacknowledgedReviewItems.length > 0 && <span className={styles.countBadge}>{unacknowledgedReviewItems.length}</span>}</button>
          })}
        </nav>
        <section className={styles.sectionPanel} role="tabpanel" id="agentic-runtime-panel" aria-labelledby={`agentic-runtime-tab-${activeSection}`} tabIndex={0}>
          <fieldset disabled={draftControlsLocked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            {sectionContent[activeSection]()}
          </fieldset>
        </section>
      </div>
      )}
      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">{saveStatus}</div>
      <footer className={styles.saveBar}>
        <span id={SAVE_VALIDATION_REASON_ID} className={clsx(styles.saveStatus, (editorLoadError || firstIssue || saveState === 'conflict' || saveState === 'error') && styles.saveStatusError)}>{saveStatus}</span>
        <button type="button" className={styles.button} disabled={!canReset} onClick={resetDraft}>{saveState === 'conflict' && hasPendingExternalSnapshot && hasHydratedEditor ? t('save.reviewLatest') : t('save.reset')}</button>
        <button type="button" className={styles.primaryButton} disabled={!canSave} aria-describedby={SAVE_VALIDATION_REASON_ID} onClick={() => { void handleSave() }}><Save size={17} aria-hidden="true" />{saveState === 'saving' ? t('save.saving') : t('save.action')}</button>
      </footer>
    </div>
  )
}
