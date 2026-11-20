import type { Message } from '@/types/api'

export const presetHistoryDependency = (chatId: string) => `context:presetHistory:${chatId}`

/** Only selected provenance affects history. Streaming text and inactive swipe metadata do not. */
export function selectedPresetHistorySignature(message: Message | null | undefined): string {
  if (!message || message.is_user || !message.content.trim() || message.extra?.spindle_role === 'system'
    || message.extra?.hidden || message.extra?._loom_inject || message.extra?.greeting
    || !Number.isSafeInteger(message.swipe_id) || message.swipe_id < 0) return ''
  const extra = message.extra ?? {}
  const selected = (key: string) => Array.isArray(extra[`${key}BySwipe`])
    ? extra[`${key}BySwipe`][message.swipe_id] : extra[key]
  const contexts = extra.spindle_metadata?.preset_contexts
  const context = Array.isArray(contexts) ? contexts[message.swipe_id] : undefined
  const activation = selected('promptActivation')
  const metrics = selected('generationMetrics')
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
  let id = text(context?.preset_id)
  if (!id && activation && Object.hasOwn(activation, 'preset_id')) {
    id = text(activation.preset_id)
    if (!id) return ''
  }
  id ??= text(metrics?.presetId)
  const metricId = text(metrics?.presetId)
  const name = (id ? metricId === id : !metricId) ? text(metrics?.presetName) : undefined
  return id || name ? JSON.stringify([id, name]) : ''
}
