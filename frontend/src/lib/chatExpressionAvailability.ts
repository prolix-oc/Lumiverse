import type { ExpressionConfig } from '@/types/expressions'

export function hasDisplayableExpressions(
  config: ExpressionConfig | null | undefined,
): boolean {
  return !!config?.enabled && Object.keys(config.mappings ?? {}).length > 0
}

export function getChatExpressionCharacterIds(
  activeCharacterId: string | null,
  isGroupChat: boolean,
  groupCharacterIds: readonly string[],
): string[] {
  const candidates = isGroupChat
    ? groupCharacterIds
    : activeCharacterId
      ? [activeCharacterId]
      : []

  return [...new Set(candidates.filter((id) => typeof id === 'string' && id.length > 0))]
}

export async function chatHasDisplayableExpressions(
  characterIds: readonly string[],
  loadConfig: (characterId: string) => Promise<ExpressionConfig | null | undefined>,
): Promise<boolean> {
  if (characterIds.length === 0) return false

  const configs = await Promise.all(
    characterIds.map((id) => loadConfig(id).catch(() => null)),
  )
  return configs.some(hasDisplayableExpressions)
}
