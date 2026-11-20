type JsonRecord = Record<string, unknown>

export interface GreetingMetadata extends JsonRecord {
  id?: string
  title?: string
  description?: string
  contentHash?: number
}

export interface GreetingToolsData extends JsonRecord {
  mainGreeting?: GreetingMetadata | null
  greetings?: Record<string, GreetingMetadata>
  indexMap?: Record<string, string>
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readGreetingTools(extensions: Record<string, any> | undefined): GreetingToolsData | null {
  const value = extensions?.greeting_tools
  return isRecord(value) ? value as GreetingToolsData : null
}

function normalizeTitle(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const title = value.trim()
  return title || null
}

function generateGreetingId(): string {
  return `g_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Read a Greeting Tools-compatible title by Lumiverse's overall greeting
 * index: 0 is the main greeting and 1+ are alternate greetings.
 */
export function getGreetingTitle(
  extensions: Record<string, any> | undefined,
  greetingIndex: number,
): string | null {
  if (!Number.isInteger(greetingIndex) || greetingIndex < 0) return null
  const tools = readGreetingTools(extensions)
  if (!tools) return null

  if (greetingIndex === 0) {
    return normalizeTitle(tools.mainGreeting?.title)
  }

  const alternateIndex = greetingIndex - 1
  const greetingId = isRecord(tools.indexMap) ? tools.indexMap[String(alternateIndex)] : undefined
  if (typeof greetingId !== 'string' || !isRecord(tools.greetings)) return null
  return normalizeTitle(tools.greetings[greetingId]?.title)
}

/**
 * Update one title without replacing Greeting Tools descriptions, hashes,
 * stable IDs, or fields added by newer versions of the extension.
 */
export function setGreetingTitle(
  extensions: Record<string, any>,
  greetingIndex: number,
  value: string,
  idFactory: () => string = generateGreetingId,
): Record<string, any> {
  if (!Number.isInteger(greetingIndex) || greetingIndex < 0) return extensions
  const title = normalizeTitle(value)
  const existingTools = readGreetingTools(extensions)

  if (!existingTools && !title) return extensions

  const tools: GreetingToolsData = { ...(existingTools ?? {}) }

  if (greetingIndex === 0) {
    const existingMain = isRecord(tools.mainGreeting)
      ? tools.mainGreeting as GreetingMetadata
      : null
    if (!existingMain && !title) return extensions

    const mainGreeting: GreetingMetadata = {
      ...(existingMain ?? {}),
      id: typeof existingMain?.id === 'string' ? existingMain.id : idFactory(),
    }
    if (title) mainGreeting.title = title
    else delete mainGreeting.title
    tools.mainGreeting = mainGreeting
    return { ...extensions, greeting_tools: tools }
  }

  const alternateIndex = greetingIndex - 1
  const indexMap = isRecord(tools.indexMap) ? { ...tools.indexMap } as Record<string, string> : {}
  const greetings = isRecord(tools.greetings)
    ? { ...tools.greetings } as Record<string, GreetingMetadata>
    : {}
  const mappedId = indexMap[String(alternateIndex)]
  const existingMetadata = typeof mappedId === 'string' && isRecord(greetings[mappedId])
    ? greetings[mappedId]
    : null

  if (!existingMetadata && !title) return extensions

  const greetingId = typeof mappedId === 'string' && mappedId ? mappedId : idFactory()
  const metadata: GreetingMetadata = {
    ...(existingMetadata ?? {}),
    id: typeof existingMetadata?.id === 'string' ? existingMetadata.id : greetingId,
  }
  if (title) metadata.title = title
  else delete metadata.title

  indexMap[String(alternateIndex)] = greetingId
  greetings[greetingId] = metadata
  tools.indexMap = indexMap
  tools.greetings = greetings
  return { ...extensions, greeting_tools: tools }
}

/** Remove a zero-based alternate greeting and shift later Greeting Tools indices. */
export function removeAlternateGreetingMetadata(
  extensions: Record<string, any>,
  removedAlternateIndex: number,
): Record<string, any> {
  if (!Number.isInteger(removedAlternateIndex) || removedAlternateIndex < 0) return extensions
  const existingTools = readGreetingTools(extensions)
  if (!existingTools || !isRecord(existingTools.indexMap)) return extensions

  const oldIndexMap = existingTools.indexMap as Record<string, unknown>
  const removedId = oldIndexMap[String(removedAlternateIndex)]
  const indexMap: Record<string, unknown> = {}

  for (const [rawIndex, greetingId] of Object.entries(oldIndexMap)) {
    const index = Number(rawIndex)
    if (!Number.isInteger(index) || index < 0) {
      indexMap[rawIndex] = greetingId
    } else if (index < removedAlternateIndex) {
      indexMap[String(index)] = greetingId
    } else if (index > removedAlternateIndex) {
      indexMap[String(index - 1)] = greetingId
    }
  }

  const tools: GreetingToolsData = {
    ...existingTools,
    indexMap: indexMap as Record<string, string>,
  }

  if (isRecord(existingTools.greetings)) {
    const greetings = { ...existingTools.greetings } as Record<string, GreetingMetadata>
    if (typeof removedId === 'string' && !Object.values(indexMap).includes(removedId)) {
      delete greetings[removedId]
    }
    tools.greetings = greetings
  }

  return { ...extensions, greeting_tools: tools }
}

/** Move a zero-based alternate greeting while preserving its stable metadata ID. */
export function moveAlternateGreetingMetadata(
  extensions: Record<string, any>,
  oldAlternateIndex: number,
  newAlternateIndex: number,
): Record<string, any> {
  if (
    !Number.isInteger(oldAlternateIndex)
    || !Number.isInteger(newAlternateIndex)
    || oldAlternateIndex < 0
    || newAlternateIndex < 0
    || oldAlternateIndex === newAlternateIndex
  ) return extensions

  const existingTools = readGreetingTools(extensions)
  if (!existingTools || !isRecord(existingTools.indexMap)) return extensions

  const indexMap = { ...existingTools.indexMap } as Record<string, string>
  const movedId = indexMap[String(oldAlternateIndex)]

  if (oldAlternateIndex < newAlternateIndex) {
    for (let index = oldAlternateIndex; index < newAlternateIndex; index += 1) {
      const nextId = indexMap[String(index + 1)]
      if (typeof nextId === 'string') indexMap[String(index)] = nextId
      else delete indexMap[String(index)]
    }
  } else {
    for (let index = oldAlternateIndex; index > newAlternateIndex; index -= 1) {
      const previousId = indexMap[String(index - 1)]
      if (typeof previousId === 'string') indexMap[String(index)] = previousId
      else delete indexMap[String(index)]
    }
  }

  if (typeof movedId === 'string') indexMap[String(newAlternateIndex)] = movedId
  else delete indexMap[String(newAlternateIndex)]

  return {
    ...extensions,
    greeting_tools: { ...existingTools, indexMap },
  }
}

/** Remap an overall greeting index after moving one indexed greeting. */
export function remapGreetingIndexForMove(
  greetingIndex: number,
  oldGreetingIndex: number,
  newGreetingIndex: number,
): number {
  if (greetingIndex === oldGreetingIndex) return newGreetingIndex
  if (oldGreetingIndex < newGreetingIndex) {
    return greetingIndex > oldGreetingIndex && greetingIndex <= newGreetingIndex
      ? greetingIndex - 1
      : greetingIndex
  }
  return greetingIndex >= newGreetingIndex && greetingIndex < oldGreetingIndex
    ? greetingIndex + 1
    : greetingIndex
}
