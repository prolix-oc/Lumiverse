import type { DreamWeaverVoiceGuidance } from '@/api/dream-weaver'
import type { Character } from '@/types/api'

export interface DreamWeaverCharacterMetadata {
  appearance: string
  appearanceData: Record<string, string>
  voiceGuidance: DreamWeaverVoiceGuidance
}

export const EMPTY_DREAM_WEAVER_VOICE_GUIDANCE: DreamWeaverVoiceGuidance = {
  compiled: '',
  rules: {
    baseline: [],
    rhythm: [],
    diction: [],
    quirks: [],
    hard_nos: [],
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}

  const next: Record<string, string> = {}
  for (const [key, rawValue] of Object.entries(value)) {
    if (!key.trim() || typeof rawValue !== 'string' || !rawValue.trim()) continue
    next[key] = rawValue.trim()
  }
  return next
}

function titleCaseLabel(label: string): string {
  return label
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

export function getDreamWeaverCharacterMetadata(
  character: Pick<Character, 'extensions'> | null | undefined,
): DreamWeaverCharacterMetadata | null {
  const dreamWeaver = character?.extensions?.dream_weaver
  if (!isRecord(dreamWeaver)) return null

  const voice = isRecord(dreamWeaver.voice_guidance) ? dreamWeaver.voice_guidance : {}
  const rules = isRecord(voice.rules) ? voice.rules : {}

  return {
    appearance: normalizeString(dreamWeaver.appearance),
    appearanceData: normalizeStringRecord(dreamWeaver.appearance_data),
    voiceGuidance: {
      compiled: normalizeString(voice.compiled),
      rules: {
        baseline: normalizeStringArray(rules.baseline),
        rhythm: normalizeStringArray(rules.rhythm),
        diction: normalizeStringArray(rules.diction),
        quirks: normalizeStringArray(rules.quirks),
        hard_nos: normalizeStringArray(rules.hard_nos),
      },
    },
  }
}

export function getDreamWeaverAppearanceText(
  metadata: DreamWeaverCharacterMetadata | null | undefined,
): string {
  const appearance = metadata?.appearance.trim()
  if (appearance) return appearance

  const appearanceData = metadata?.appearanceData ?? {}
  return Object.entries(appearanceData)
    .map(([key, value]) => `${titleCaseLabel(key)}: ${value}`)
    .join('\n')
}

export function hasDreamWeaverAppearance(
  metadata: DreamWeaverCharacterMetadata | null | undefined,
): boolean {
  return Boolean(getDreamWeaverAppearanceText(metadata).trim())
}

function formatStructuredVoiceSection(label: string, items: string[]): string {
  if (items.length === 0) return ''
  return `${label}:\n${items.map((item) => `- ${item}`).join('\n')}`
}

export function hasDreamWeaverVoiceGuidance(
  metadata: DreamWeaverCharacterMetadata | null | undefined,
): boolean {
  if (!metadata) return false

  if (metadata.voiceGuidance.compiled.trim()) return true
  return Object.values(metadata.voiceGuidance.rules).some((items) => items.length > 0)
}

export function getDreamWeaverVoiceDisplayText(
  metadata: DreamWeaverCharacterMetadata | null | undefined,
): string {
  if (!metadata) return ''

  const { rules, compiled } = metadata.voiceGuidance
  const structuredSections = [
    formatStructuredVoiceSection('Baseline', rules.baseline),
    formatStructuredVoiceSection('Rhythm', rules.rhythm),
    formatStructuredVoiceSection('Diction', rules.diction),
    formatStructuredVoiceSection('Quirks', rules.quirks),
    formatStructuredVoiceSection('Hard Nos', rules.hard_nos),
  ].filter(Boolean)

  if (structuredSections.length > 0) {
    return structuredSections.join('\n\n')
  }

  return compiled.trim()
}
