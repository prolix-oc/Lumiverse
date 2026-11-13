import type { GuidedGeneration } from '@/types/store'

export interface GuidedGenerationContext {
  connectionProfileId?: string | null
  chatId?: string | null
  characterId?: string | null
}

export function isGuideAutoEnabled(
  guide: GuidedGeneration,
  context: GuidedGenerationContext,
): boolean {
  const rule = guide.autoEnable
  if (!rule?.id) return false

  if (rule.scope === 'connection') return rule.id === context.connectionProfileId
  if (rule.scope === 'chat') return rule.id === context.chatId
  if (rule.scope === 'character') return rule.id === context.characterId
  return false
}

export function isGuideActive(
  guide: GuidedGeneration,
  context: GuidedGenerationContext,
): boolean {
  return guide.enabled || isGuideAutoEnabled(guide, context)
}
