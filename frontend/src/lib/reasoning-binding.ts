import type { ReasoningEffort, ReasoningSettings } from '@/types/store'

const REASONING_PRESETS: Array<{ label: string; prefix: string; suffix: string }> = [
  { label: 'DeepSeek', prefix: '<think>\n', suffix: '\n</think>' },
  { label: 'Claude', prefix: '<thinking>\n', suffix: '\n</thinking>' },
  { label: 'o1', prefix: '<reasoning>\n', suffix: '\n</reasoning>' },
]

export interface EffortOption {
  value: ReasoningEffort
  label: string
}

export const TOGGLE_ONLY_PROVIDERS = new Set(['moonshot', 'zai'])

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
    case 'zai':
      return TOGGLE_ONLY_EFFORTS
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
  const supportedEfforts = getEffortOptions(provider, model).map((option) => option.value)
  const supportedSet = new Set(supportedEfforts)

  if (supportedSet.has(settings.reasoningEffort)) return { ...settings }

  if (settings.reasoningEffort === 'none') {
    return {
      ...settings,
      apiReasoning: false,
      reasoningEffort: 'auto',
    }
  }

  if (settings.reasoningEffort === 'auto') return { ...settings, reasoningEffort: 'auto' }

  const explicitEfforts = supportedEfforts.filter((effort) => effort !== 'auto' && effort !== 'none')
  if (explicitEfforts.length === 0) {
    return {
      ...settings,
      reasoningEffort: 'auto',
    }
  }

  return {
    ...settings,
    reasoningEffort: getNearestSupportedEffort(settings.reasoningEffort, explicitEfforts),
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
    parts.push('keep all history')
  } else if (settings.keepInHistory === 0) {
    parts.push('strip history')
  } else {
    parts.push(`keep ${settings.keepInHistory} history`)
  }

  if (!settings.autoParse) parts.push('manual parse')
  if (settings.thinkingDisplay !== 'auto') parts.push(`display ${settings.thinkingDisplay}`)

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
}
