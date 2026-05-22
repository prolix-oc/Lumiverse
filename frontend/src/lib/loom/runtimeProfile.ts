let runtimeProfileKey: string | null = null

function makeKey(
  presetId: string | null | undefined,
  chatId: string | null | undefined,
  characterId: string | null | undefined,
  connectionId: string | null | undefined,
): string | null {
  if (!presetId || !chatId) return null
  return `${presetId}:${chatId}:${characterId ?? 'none'}:${connectionId ?? 'none'}`
}

export function markLoomRuntimeProfileContext(
  presetId: string | null | undefined,
  chatId: string | null | undefined,
  characterId: string | null | undefined,
  connectionId?: string | null | undefined,
) {
  runtimeProfileKey = makeKey(presetId, chatId, characterId, connectionId)
}

export function shouldForceLoomRuntimePreset(
  presetId: string | null | undefined,
  chatId: string | null | undefined,
  characterId: string | null | undefined,
  connectionId?: string | null | undefined,
): boolean {
  const key = makeKey(presetId, chatId, characterId, connectionId)
  return !!key && key === runtimeProfileKey
}
