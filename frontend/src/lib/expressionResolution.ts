import type { Character } from '@/types/api'
import type { ExpressionConfig, ExpressionSlot } from '@/types/expressions'
import type { ExpressionSlice } from '@/types/store'

/** Detached display fallback: active image, configured default, then first mapping. */
export function resolveExpression(
  config: ExpressionConfig | null | undefined,
  active?: { label: string; imageId: string | null } | null,
): ExpressionSlot | null {
  if (active?.imageId) return { label: active.label, imageId: active.imageId }
  if (!config) return null
  const mappings = config.mappings ?? {}
  const label = config.defaultExpression && mappings[config.defaultExpression]
    ? config.defaultExpression
    : Object.keys(mappings)[0]
  return label && mappings[label] ? { label, imageId: mappings[label] } : null
}

type ExpressionAvatarState = Pick<ExpressionSlice,
  'expressionCharacterId' | 'currentExpression' | 'currentExpressionImageId' | 'groupExpressions'
> & { activeChatId: string | null; isGroupChat: boolean }

/** Resolve only character message avatars, using the existing reactive expression identity. */
export function resolveMessageExpressionImageId(
  state: ExpressionAvatarState,
  character: Pick<Character, 'id' | 'extensions'> | null | undefined,
  characterId: string | null,
  chatId: string,
  isUser: boolean,
): string | null {
  if (isUser || state.activeChatId !== chatId || !characterId || character?.id !== characterId) return null
  // Named groups on a multi-character card have no single message-avatar identity.
  if (Object.keys(character.extensions?.expression_groups ?? {}).length > 0) return null
  const config = character.extensions?.expressions as ExpressionConfig | undefined
  if (!config?.enabled || config.useAsAvatar !== true) return null

  const active = state.isGroupChat
    ? state.groupExpressions?.[characterId]
    : state.expressionCharacterId === characterId && state.currentExpression
      ? { label: state.currentExpression, imageId: state.currentExpressionImageId }
      : null

  // An old event must not resurrect a removed/replaced mapping. Only the event's
  // resolved image ID is used; no detection request or speaker selection occurs here.
  if (active && (!active.imageId || config.mappings?.[active.label] !== active.imageId)) return null
  if (!active && config.defaultExpression && !config.mappings?.[config.defaultExpression]) return null
  const expression = resolveExpression(config, active)
  return typeof expression?.imageId === 'string' && expression.imageId.trim() ? expression.imageId : null
}
