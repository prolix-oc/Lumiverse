/**
 * Single source of truth for provider accent colours, shared by the connection
 * panels (ConnectionItem / TTSConnectionItem / …) and the ConnectionSelect
 * dropdown so the two render the same provider identity. Merged union of the
 * per-kind maps that used to live in each *ConnectionItem; `custom` is the
 * fallback for any provider not listed.
 */
export const PROVIDER_COLORS: Record<string, string> = {
  // LLM
  openai: '#10a37f',
  anthropic: '#d97757',
  google: '#4285f4',
  google_vertex: '#34a853',
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
  // fallback
  custom: 'var(--lumiverse-text-dim)',
}

/** Accent colour for a provider id, falling back to the neutral `custom` tone. */
export function providerColor(provider: string): string {
  return PROVIDER_COLORS[provider] || PROVIDER_COLORS.custom
}
