/** Provider accent colours; `custom` is the fallback for unlisted providers. */
export const PROVIDER_COLORS: Record<string, string> = {
  // LLM
  openai: '#10a37f',
  anthropic: '#d97757',
  mistral: '#f97316',
  cohere: '#39594d',
  google: '#4285f4',
  google_vertex: '#34a853',
  bedrock: '#ff9900',
  openrouter: '#6366f1',
  typesafe: '#22c55e',
  infermatic: '#8b5cf6',
  nanogpt: '#10b981',
  pollinations_text: '#f89c73',
  pollinations: '#ff6b35',
  // image-gen
  google_gemini: '#4285f4',
  novelai: '#8b5cf6',
  custom_openai: '#64748b',
  together: '#0f6fff',
  xai: '#111111',
  venice: '#e11d48',
  venice_compat: '#e11d48',
  recraft: '#7c3aed',
  deepinfra: '#2563eb',
  ideogram: '#ef4444',
  fireworks: '#f97316',
  stability: '#6d28d9',
  bfl: '#0ea5e9',
  fal: '#a855f7',
  replicate: '#0f172a',
  leonardo: '#f59e0b',
  runware: '#14b8a6',
  civitai: '#3b82f6',
  civitai_chat: '#3b82f6',
  huggingface: '#fbbf24',
  // tts
  openai_tts: '#10a37f',
  elevenlabs: '#8b5cf6',
  kokoro: '#f59e0b',
  cartesia: '#5046e5',
  qwen3_tts_server: '#f97316',
  google_tts: '#4285f4',
  google_vertex_tts: '#34a853',
  fish_audio: '#ff5c5c',
  // fallback
  custom: 'var(--lumiverse-text-dim)',
}

export function providerColor(provider: string): string {
  return PROVIDER_COLORS[provider] || PROVIDER_COLORS.custom
}
