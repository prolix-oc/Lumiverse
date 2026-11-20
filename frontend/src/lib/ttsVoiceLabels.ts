import type { TtsVoice } from '@/types/api'

export function getTtsVoiceLabel(voice: TtsVoice): string {
  const gender = voice.gender?.trim()
  const genderLabels: Record<string, string> = {
    feminine: 'Female',
    female: 'Female',
    masculine: 'Male',
    male: 'Male',
    neutral: 'Neutral',
  }
  const label = gender ? genderLabels[gender.toLowerCase()] ?? gender : undefined
  return label ? `${voice.name} (${label})` : voice.name
}

export function getTtsVoiceSublabel(voice: TtsVoice): string | undefined {
  return [voice.description, voice.language].filter(Boolean).join(' · ') || undefined
}
