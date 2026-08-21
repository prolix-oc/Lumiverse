import type { ReasoningBindings, ReasoningEffort, ReasoningSettings } from '@/types/store'

const REASONING_PRESETS: Array<{ label: string; prefix: string; suffix: string }> = [
  { label: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' },
  { label: 'Claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { label: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

export interface EffortOption {
  value: ReasoningEffort
  label: string
}

/** GLM-5.3 exposes the three native effort levels documented by Z.AI. */
const ZAI_GLM_53_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

function isZaiGlm53(model: string | null | undefined): boolean {
  return !!model && /^glm-5\.3(?:$|[\[.:@-])/i.test(model)
}

/** Whether the active model has no selectable native reasoning effort. */
export function isToggleOnlyProvider(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  return provider === 'moonshot' || (provider === 'zai' && !isZaiGlm53(model))
}

const OPENROUTER_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None (disabled)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
]

const GOOGLE_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const ANTHROPIC_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

const ANTHROPIC_OPUS_XHIGH_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
]

const NANOGPT_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None (disabled)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
]

// Amazon Bedrock's OpenAI-compatible endpoint exposes a single `reasoning_effort`
// string (none/minimal/low/medium/high) that it maps to each model family's
// native mechanism — gpt-oss reasoning, Claude thinking.budget_tokens / adaptive
// thinking, etc. — so one flat list covers every Bedrock model.
const BEDROCK_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'none', label: 'None (disabled)' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

const OPENAI_COMPATIBLE_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
]

const GENERIC_EFFORTS: EffortOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

const TOGGLE_ONLY_EFFORTS: EffortOption[] = [{ value: 'auto', label: 'Auto' }]

const EFFORT_RANKS: Record<Exclude<ReasoningEffort, 'auto'>, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
}

export function getEffortOptions(provider: string | null | undefined, model: string | null | undefined): EffortOption[] {
  switch (provider) {
    case 'openai':
    case 'custom':
      return OPENAI_COMPATIBLE_EFFORTS
    case 'openrouter':
      return OPENROUTER_EFFORTS
    case 'google':
    case 'google_vertex':
      return GOOGLE_EFFORTS
    case 'anthropic':
      return model && /claude-opus-4[-.](7|8)/i.test(model) ? ANTHROPIC_OPUS_XHIGH_EFFORTS : ANTHROPIC_EFFORTS
    case 'nanogpt':
      return NANOGPT_EFFORTS
    case 'bedrock':
      return BEDROCK_EFFORTS
    case 'moonshot':
      return TOGGLE_ONLY_EFFORTS
    case 'zai':
      return isZaiGlm53(model) ? ZAI_GLM_53_EFFORTS : TOGGLE_ONLY_EFFORTS
    default:
      return GENERIC_EFFORTS
  }
}

function getNearestSupportedEffort(
  effort: Exclude<ReasoningEffort, 'auto' | 'none'>,
  supportedEfforts: ReasoningEffort[],
): ReasoningEffort {
  let best = supportedEfforts[0]
  let bestDistance = Number.POSITIVE_INFINITY
  let bestRank = -1
  const sourceRank = EFFORT_RANKS[effort]

  for (const candidate of supportedEfforts) {
    if (candidate === 'auto' || candidate === 'none') continue
    const rank = EFFORT_RANKS[candidate]
    const distance = Math.abs(rank - sourceRank)
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      best = candidate
      bestDistance = distance
      bestRank = rank
    }
  }

  return best
}

export function normalizeReasoningSettingsForProvider(
  settings: ReasoningSettings,
  provider: string | null | undefined,
  model: string | null | undefined,
): ReasoningSettings {
  // Connection snapshots predate some provider-specific controls. A JSON
  // `null` from an old snapshot has the same meaning as an absent value: let
  // the provider default apply. Canonicalize it before applying or comparing a
  // binding so legacy snapshots do not look locally modified on selection.
  const normalizedSettings = { ...settings }
  if (typeof normalizedSettings.clearThinking !== 'boolean') {
    delete normalizedSettings.clearThinking
  }
  if (typeof normalizedSettings.replayThoughtSignatures !== 'boolean') {
    delete normalizedSettings.replayThoughtSignatures
  }

  const supportedEfforts = getEffortOptions(provider, model).map((option) => option.value)
  const supportedSet = new Set(supportedEfforts)

  if (supportedSet.has(normalizedSettings.reasoningEffort)) return normalizedSettings

  if (normalizedSettings.reasoningEffort === 'none') {
    return {
      ...normalizedSettings,
      apiReasoning: false,
      reasoningEffort: 'auto',
    }
  }

  if (normalizedSettings.reasoningEffort === 'auto') return { ...normalizedSettings, reasoningEffort: 'auto' }

  const explicitEfforts = supportedEfforts.filter((effort) => effort !== 'auto' && effort !== 'none')
  if (explicitEfforts.length === 0) {
    return {
      ...normalizedSettings,
      reasoningEffort: 'auto',
    }
  }

  return {
    ...normalizedSettings,
    reasoningEffort: getNearestSupportedEffort(normalizedSettings.reasoningEffort, explicitEfforts),
  }
}

/**
 * Captures the current Reasoning tab state in the same provider-normalized
 * shape used by a connection profile. Keeping this in one place lets both the
 * Connection editor and the Reasoning tab re-bind identical snapshots.
 */
export function captureReasoningBindings(
  settings: ReasoningSettings,
  promptBias: string,
  provider: string | null | undefined,
  model: string | null | undefined,
): ReasoningBindings {
  return {
    settings: normalizeReasoningSettingsForProvider(settings, provider, model),
    promptBias,
  }
}

function formatTagValue(value: string): string {
  const compact = value.replace(/\n/g, '\\n') || '(empty)'
  return compact.length > 40 ? `${compact.slice(0, 37)}...` : compact
}

export function getReasoningPresetLabel(settings: ReasoningSettings): string | null {
  return REASONING_PRESETS.find((preset) => (
    preset.prefix === settings.prefix && preset.suffix === settings.suffix
  ))?.label ?? null
}

export function getReasoningBindingSummary(settings: ReasoningSettings, promptBias?: string | null): string {
  const parts: string[] = []
  const presetLabel = getReasoningPresetLabel(settings)

  parts.push(presetLabel ? `${presetLabel} tags` : 'Custom tags')
  parts.push(settings.apiReasoning ? 'API reasoning on' : 'API reasoning off')

  if (settings.apiReasoning || settings.reasoningEffort !== 'auto') {
    parts.push(`effort ${settings.reasoningEffort}`)
  }

  if (settings.keepInHistory === -1) {
    parts.push('keep all prompt history')
  } else if (settings.keepInHistory === 0) {
    parts.push('strip prompt history')
  } else {
    parts.push(`keep ${settings.keepInHistory} prompt blocks`)
  }

  if (!settings.autoParse) parts.push('manual parse')
  if (settings.thinkingDisplay !== 'auto') parts.push(`display ${settings.thinkingDisplay}`)
  if (typeof settings.clearThinking === 'boolean') {
    parts.push(`clear thinking ${settings.clearThinking ? 'on' : 'off'}`)
  }
  if (settings.replayThoughtSignatures) parts.push('replay thought signatures')
  if (settings.customBody?.enabled) parts.push('custom body on')

  if (typeof promptBias === 'string') {
    parts.push(promptBias.trim() ? `prefill ${formatTagValue(promptBias)}` : 'no prefill')
  }

  return parts.join(' · ')
}

export function getReasoningBindingTitle(settings: ReasoningSettings, promptBias?: string | null): string {
  const lines = [
    getReasoningBindingSummary(settings, promptBias),
    `Prefix: ${formatTagValue(settings.prefix)}`,
    `Suffix: ${formatTagValue(settings.suffix)}`,
  ]
  if (typeof promptBias === 'string') {
    lines.push(`Start Reply With: ${formatTagValue(promptBias)}`)
  }
  return lines.join('\n')
}

export function areReasoningSettingsEqual(a: ReasoningSettings, b: ReasoningSettings): boolean {
  return a.prefix === b.prefix
    && a.suffix === b.suffix
    && a.autoParse === b.autoParse
    && a.apiReasoning === b.apiReasoning
    && a.reasoningEffort === b.reasoningEffort
    && a.keepInHistory === b.keepInHistory
    && a.thinkingDisplay === b.thinkingDisplay
    // Old snapshots may contain JSON null for newer optional fields. It is
    // semantically identical to an omitted setting, so it must not mark the
    // binding as changed.
    && (typeof a.clearThinking === 'boolean' ? a.clearThinking : undefined)
      === (typeof b.clearThinking === 'boolean' ? b.clearThinking : undefined)
    && (typeof a.replayThoughtSignatures === 'boolean' ? a.replayThoughtSignatures : undefined)
      === (typeof b.replayThoughtSignatures === 'boolean' ? b.replayThoughtSignatures : undefined)
    && (a.customBody?.enabled ?? false) === (b.customBody?.enabled ?? false)
    && (
      !(a.customBody?.enabled ?? false)
      || a.customBody?.rawJson === b.customBody?.rawJson
    )
}
