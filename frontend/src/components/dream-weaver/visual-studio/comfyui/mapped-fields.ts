import type {
  ComfyUIFieldMapping,
  ComfyUIMappedFieldSemantic,
  ComfyUIWorkflowConfig,
  DreamWeaverVisualAsset,
} from '@/api/dream-weaver'
import type { ComfyUICapabilities } from '@/api/image-gen'

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

function hasSemanticMapping(
  config: Pick<ComfyUIWorkflowConfig, 'field_mappings'> | null | undefined,
  semantic: ComfyUIMappedFieldSemantic,
): boolean {
  return Boolean(config?.field_mappings.some((mapping) => mapping.mappedAs === semantic))
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
      { value: 'true', label: 'Enabled' },
      { value: 'false', label: 'Disabled' },
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

export function hasComfyRequiredPromptMappings(
  config: Pick<ComfyUIWorkflowConfig, 'field_mappings'> | null | undefined,
): boolean {
  return hasSemanticMapping(config, 'positive_prompt') && hasSemanticMapping(config, 'negative_prompt')
}

export function isComfyWorkflowRunnable(config: ComfyUIWorkflowConfig | null): boolean {
  return hasComfyRequiredPromptMappings(config)
}

export function readComfyControlValue(
  asset: DreamWeaverVisualAsset | null | undefined,
  control: ComfyMappedFieldControl,
): string | number {
  const extras = asset?.provider_state?.comfyui_field_values ?? {}

  if (control.key === 'seed') {
    return asset?.seed ?? normalizeControlValue(control.defaultValue)
  }
  if (control.key === 'width') {
    return asset?.width ?? normalizeControlValue(control.defaultValue)
  }
  if (control.key === 'height') {
    return asset?.height ?? normalizeControlValue(control.defaultValue)
  }
  if (control.key.startsWith(CUSTOM_CONTROL_PREFIX)) {
    const customKey = control.key.slice(CUSTOM_CONTROL_PREFIX.length)
    const customValues = extras.custom ?? {}
    return normalizeControlValue(customValues[customKey] ?? control.defaultValue)
  }

  return normalizeControlValue(extras[control.key] ?? control.defaultValue)
}

function normalizeControlValue(value: unknown): string | number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value
  return ''
}

function parseControlValue(
  control: ComfyMappedFieldControl,
  value: string,
): string | number | boolean | undefined {
  if (value === '') return undefined
  if (control.kind === 'number') return Number(value)
  if (control.options && typeof control.defaultValue === 'boolean') {
    return value === 'true'
  }
  return value
}

export function writeComfyControlPatch(
  asset: DreamWeaverVisualAsset,
  control: ComfyMappedFieldControl,
  value: string,
): Partial<DreamWeaverVisualAsset> {
  const parsedValue = parseControlValue(control, value)
  const extras = asset.provider_state?.comfyui_field_values ?? {}

  if (control.key === 'seed') {
    return { seed: parsedValue === undefined ? null : Number(parsedValue) }
  }
  if (control.key === 'width') {
    return {
      width:
        parsedValue === undefined
          ? typeof control.defaultValue === 'number'
            ? control.defaultValue
            : asset.width
          : Number(parsedValue),
    }
  }
  if (control.key === 'height') {
    return {
      height:
        parsedValue === undefined
          ? typeof control.defaultValue === 'number'
            ? control.defaultValue
            : asset.height
          : Number(parsedValue),
    }
  }
  if (control.key.startsWith(CUSTOM_CONTROL_PREFIX)) {
    const customKey = control.key.slice(CUSTOM_CONTROL_PREFIX.length)
    const nextCustom = { ...(extras.custom ?? {}) }
    if (parsedValue === undefined) {
      delete nextCustom[customKey]
    } else {
      nextCustom[customKey] = parsedValue
    }

    return {
      provider_state: {
        ...asset.provider_state,
        comfyui_field_values: {
          ...extras,
          custom: nextCustom,
        },
      },
    }
  }

  const nextExtras = { ...extras }
  if (parsedValue === undefined) {
    delete nextExtras[control.key]
  } else {
    nextExtras[control.key] = parsedValue
  }

  return {
    provider_state: {
      ...asset.provider_state,
      comfyui_field_values: nextExtras,
    },
  }
}
