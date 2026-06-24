/** Provider accent colours; `custom` is the fallback for unlisted providers. */
export const PROVIDER_COLORS: Record<string, string> = {
  // LLM
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  google_vertex: '#34a853',
  bedrock: '#ff9900',
  openrouter: '#6366f1',
  infermatic: '#8b5cf6',
  nanogpt: '#10b981',
  pollinations_text: '#f89c73',
  pollinations: '#ff6b35',
  // image-gen
  google_gemini: '#4285f4',
  novelai: '#8b5cf6',
  // tts
  openai_tts: '#10a37f',
  elevenlabs: '#8b5cf6',
  kokoro: '#f59e0b',
  cartesia: '#5046e5',
  // fallback
  custom: 'var(--lumiverse-text-dim)',
}

export function providerColor(provider: string): string {
  return PROVIDER_COLORS[provider] || PROVIDER_COLORS.custom
}
