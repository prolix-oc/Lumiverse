import type { NanoGptConnectionSettings, NanoGptProviderRouting } from '@/api/nanogpt'

export function updateNanoGptModelRouting(
  settings: NanoGptConnectionSettings,
  model: string,
  patch: Partial<NanoGptProviderRouting>,
): NanoGptConnectionSettings {
  const modelId = model.trim()
  if (!modelId) return settings
  const routing = { ...settings.model_overrides?.[modelId], ...patch }
  for (const key of Object.keys(routing) as (keyof NanoGptProviderRouting)[]) {
    const value = routing[key]
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete routing[key]
  }
  const model_overrides = { ...settings.model_overrides }
  if (Object.keys(routing).length) model_overrides[modelId] = routing
  else delete model_overrides[modelId]
  return { ...settings, model_overrides }
}

export function buildNanoGptSettingsMetadata(settings: NanoGptConnectionSettings): NanoGptConnectionSettings | undefined {
  const model_overrides = Object.fromEntries(Object.entries(settings.model_overrides || {}).filter(([, route]) => route && Object.keys(route).length))
  if (!settings.billing_mode && !Object.keys(model_overrides).length) return undefined
  return {
    ...(settings.billing_mode === 'paygo' ? { billing_mode: 'paygo' as const } : {}),
    ...(Object.keys(model_overrides).length ? { model_overrides } : {}),
  }
}
