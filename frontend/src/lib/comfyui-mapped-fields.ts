import type {
  ComfyUIFieldMapping,
  ComfyUIMappedFieldSemantic,
  ComfyUIWorkflowConfig,
} from '@/api/image-gen-connections'
import type { ComfyUICapabilities } from '@/api/image-gen'
import i18n from '@/i18n'

export interface ComfyMappedFieldControl {
  key: string
  label: string
  kind: 'textarea' | 'number' | 'text' | 'select'
  required?: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: unknown
}

const CUSTOM_CONTROL_PREFIX = 'custom:'

const SEMANTIC_ORDER: ComfyUIMappedFieldSemantic[] = [
  'positive_prompt',
  'negative_prompt',
  'seed',
  'steps',
  'cfg',
  'width',
  'height',
  'checkpoint',
  'sampler_name',
  'scheduler',
]

const SEMANTIC_LABELS: Record<Exclude<ComfyUIMappedFieldSemantic, 'custom'>, string> = {
  positive_prompt: 'Positive Prompt',
  negative_prompt: 'Negative Prompt',
  seed: 'Seed',
  steps: 'Steps',
  cfg: 'CFG',
  sampler_name: 'Sampler',
  scheduler: 'Scheduler',
  width: 'Width',
  height: 'Height',
  checkpoint: 'Checkpoint',
}

function formatLabel(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function getMappingFieldKey(mapping: Pick<ComfyUIFieldMapping, 'nodeId' | 'fieldName'>): string {
  return `${mapping.nodeId}:${mapping.fieldName}`
}

function getWorkflowFieldValue(
  config: Pick<ComfyUIWorkflowConfig, 'workflow_api_json'>,
  mapping: Pick<ComfyUIFieldMapping, 'nodeId' | 'fieldName'>,
): unknown {
  const node = config.workflow_api_json?.[mapping.nodeId]
  if (!node || typeof node.inputs !== 'object') return undefined
  return node.inputs[mapping.fieldName]
}

function getSemanticOptions(
  semantic: Exclude<ComfyUIMappedFieldSemantic, 'custom'>,
  capabilities: ComfyUICapabilities | null,
): string[] {
  switch (semantic) {
    case 'checkpoint':
      return capabilities?.checkpoints ?? []
    case 'sampler_name':
      return capabilities?.samplers ?? []
    case 'scheduler':
      return capabilities?.schedulers ?? []
    default:
      return []
  }
}

function toSelectOptions(values: string[]): Array<{ value: string; label: string }> {
  return values.map((value) => ({ value, label: value }))
}

function resolveControlOptions(
  config: Pick<ComfyUIWorkflowConfig, 'field_options'>,
  mapping: Pick<ComfyUIFieldMapping, 'nodeId' | 'fieldName' | 'mappedAs'>,
  capabilities: ComfyUICapabilities | null,
  defaultValue: unknown,
): Array<{ value: string; label: string }> | undefined {
  if (mapping.mappedAs !== 'custom') {
    const semanticOptions = getSemanticOptions(mapping.mappedAs, capabilities)
    if (semanticOptions.length > 0) {
      return toSelectOptions(semanticOptions)
    }
  }

  const fieldOptions = config.field_options?.[getMappingFieldKey(mapping)] ?? []
  if (fieldOptions.length > 0) {
    return toSelectOptions(fieldOptions)
  }

  if (typeof defaultValue === 'boolean') {
    return [
      { value: 'true', label: i18n.t('common:actions.enabled') },
      { value: 'false', label: i18n.t('common:actions.disabled') },
    ]
  }

  return undefined
}

function resolveControlKind(
  defaultValue: unknown,
  options?: Array<{ value: string; label: string }>,
): ComfyMappedFieldControl['kind'] {
  if (options && options.length > 0) return 'select'
  if (typeof defaultValue === 'number') return 'number'
  return 'text'
}

function buildSemanticControl(
  semantic: Exclude<ComfyUIMappedFieldSemantic, 'custom'>,
  mappings: ComfyUIFieldMapping[],
  config: ComfyUIWorkflowConfig,
  capabilities: ComfyUICapabilities | null,
): ComfyMappedFieldControl | null {
  const primaryMapping = mappings[0]
  if (!primaryMapping) return null

  const defaultValue = getWorkflowFieldValue(config, primaryMapping)
  const options = resolveControlOptions(config, primaryMapping, capabilities, defaultValue)

  return {
    key: semantic,
    label: SEMANTIC_LABELS[semantic],
    kind: resolveControlKind(defaultValue, options),
    options,
    defaultValue,
    required: semantic === 'positive_prompt',
  }
}

function buildCustomControls(
  mappings: ComfyUIFieldMapping[],
  config: ComfyUIWorkflowConfig,
): ComfyMappedFieldControl[] {
  const labelCounts = new Map<string, number>()
  for (const mapping of mappings) {
    const baseLabel = formatLabel(mapping.fieldName)
    labelCounts.set(baseLabel, (labelCounts.get(baseLabel) ?? 0) + 1)
  }

  return mappings.map((mapping) => {
    const baseLabel = formatLabel(mapping.fieldName)
    const classType = String(config.workflow_api_json?.[mapping.nodeId]?.class_type ?? '').trim()
    const defaultValue = getWorkflowFieldValue(config, mapping)
    const options = resolveControlOptions(config, mapping, null, defaultValue)
    const needsNodeContext = (labelCounts.get(baseLabel) ?? 0) > 1 && classType

    return {
      key: `${CUSTOM_CONTROL_PREFIX}${getMappingFieldKey(mapping)}`,
      label: needsNodeContext ? `${baseLabel} · ${formatLabel(classType)}` : baseLabel,
      kind: resolveControlKind(defaultValue, options),
      options,
      defaultValue,
    }
  })
}

export function buildMappedFieldControls(
  config: ComfyUIWorkflowConfig,
  capabilities: ComfyUICapabilities | null,
): ComfyMappedFieldControl[] {
  const mappingsBySemantic = new Map<ComfyUIMappedFieldSemantic, ComfyUIFieldMapping[]>()
  for (const mapping of config.field_mappings) {
    const existing = mappingsBySemantic.get(mapping.mappedAs) ?? []
    existing.push(mapping)
    mappingsBySemantic.set(mapping.mappedAs, existing)
  }

  const controls: ComfyMappedFieldControl[] = []
  for (const semantic of SEMANTIC_ORDER) {
    if (semantic === 'custom') continue
    const mappings = mappingsBySemantic.get(semantic)
    if (!mappings?.length) continue

    const control = buildSemanticControl(semantic, mappings, config, capabilities)
    if (control) controls.push(control)
  }

  const customMappings = mappingsBySemantic.get('custom') ?? []
  controls.push(...buildCustomControls(customMappings, config))

  return controls
}
