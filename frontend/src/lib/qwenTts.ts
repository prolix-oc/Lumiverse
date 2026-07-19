import type { QwenCustomVoice, TtsConnectionProfile } from '@/types/api'

export const QWEN_TTS_PROVIDER = 'qwen3_tts_server'
export const QWEN_SPEAKER_PREFIX = 'speaker:'
export const QWEN_PROMPT_PREFIX = 'prompt:'
export const QWEN_LANGUAGE_OPTIONS = [
  { value: 'Auto', label: 'Auto' },
  { value: 'Chinese', label: '中文' },
  { value: 'English', label: 'English' },
  { value: 'Japanese', label: '日本語' },
  { value: 'Korean', label: '한국어' },
  { value: 'German', label: 'Deutsch' },
  { value: 'French', label: 'Français' },
  { value: 'Russian', label: 'Русский' },
  { value: 'Portuguese', label: 'Português' },
  { value: 'Spanish', label: 'Español' },
  { value: 'Italian', label: 'Italiano' },
] as const

export function isQwenTtsProvider(provider: string): boolean {
  return provider === QWEN_TTS_PROVIDER
}

export function readQwenCustomVoices(metadata: Record<string, any> | null | undefined): QwenCustomVoice[] {
  const raw = metadata?.qwen?.custom_voices
  if (!Array.isArray(raw)) return []

  const seen = new Set<string>()
  const voices: QwenCustomVoice[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const promptId = typeof row.prompt_id === 'string' ? row.prompt_id.trim() : ''
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!promptId || !name) continue
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `${QWEN_PROMPT_PREFIX}${promptId}`
    if (seen.has(id)) continue
    seen.add(id)
    voices.push({
      id,
      name,
      prompt_id: promptId,
      transcript: typeof row.transcript === 'string' && row.transcript.trim() ? row.transcript.trim() : undefined,
      source_filename: typeof row.source_filename === 'string' && row.source_filename.trim() ? row.source_filename.trim() : undefined,
      created_at: typeof row.created_at === 'number' && Number.isFinite(row.created_at) ? row.created_at : 0,
    })
  }

  voices.sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at
    return a.name.localeCompare(b.name)
  })
  return voices
}

export function formatQwenVoiceLabel(
  voiceId: string,
  metadata: Record<string, any> | null | undefined,
): string {
  const trimmed = voiceId.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith(QWEN_SPEAKER_PREFIX)) {
    return trimmed.slice(QWEN_SPEAKER_PREFIX.length) || trimmed
  }
  if (trimmed.startsWith(QWEN_PROMPT_PREFIX)) {
    const saved = readQwenCustomVoices(metadata).find((voice) => voice.id === trimmed)
    return saved?.name || trimmed.slice(QWEN_PROMPT_PREFIX.length) || trimmed
  }
  return trimmed
}

export function formatTtsConnectionVoiceLabel(profile: Pick<TtsConnectionProfile, 'provider' | 'voice' | 'metadata'>): string {
  if (!profile.voice) return ''
  if (isQwenTtsProvider(profile.provider)) {
    return formatQwenVoiceLabel(profile.voice, profile.metadata)
  }
  return profile.voice
}
