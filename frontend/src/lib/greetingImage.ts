import { imagesApi } from '@/api/images'
import type { Character, Message } from '@/types/api'
import { resolveGalleryImageId } from './galleryImageReference'

const RISU_IMAGE_RE = /<img\s*=\s*["']([^"']+)["'][^>]*>/gi
const HTML_IMAGE_RE = /<img\b[^>]*?\ssrc\s*=\s*["']([^"']+)["'][^>]*>/gi
const MARKDOWN_IMAGE_RE = /!\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))/g
const MARKDOWN_IMAGE_MARKUP_RE = /!\[[^\]]*]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g

export interface GreetingMessageImage {
  url: string
  greetingIndex: number
  /** Present only when the same image already appears in the message. */
  embeddedSource?: string
}

function greetingMessageDisplayUrl(url: string): string {
  if (!/^(?:https?:)?\/\//i.test(url)) return url
  const origin = typeof window !== 'undefined' ? window.location?.origin : undefined
  try {
    const parsed = new URL(url, origin || 'http://localhost')
    if (origin && parsed.origin === origin) return url
    return imagesApi.displayUrl(parsed.href)
  } catch {
    return url
  }
}

function assetStem(name: string): string {
  const base = name.split('/').pop() || name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function containsGreetingImageMarkup(content: string): boolean {
  return /<img\b/i.test(content) || /!\[[^\]]*]\([^)]*\)/.test(content)
}

export function findEmbeddedGreetingImageSource(content: string): string | null {
  const matches: Array<{ index: number; source: string }> = []
  const collect = (pattern: RegExp, sourceGroup: number) => {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const source = match[sourceGroup]?.trim()
      if (source) matches.push({ index: match.index, source })
    }
  }

  collect(RISU_IMAGE_RE, 1)
  collect(HTML_IMAGE_RE, 1)

  MARKDOWN_IMAGE_RE.lastIndex = 0
  let markdownMatch: RegExpExecArray | null
  while ((markdownMatch = MARKDOWN_IMAGE_RE.exec(content)) !== null) {
    const source = (markdownMatch[1] || markdownMatch[2])?.trim()
    if (source) matches.push({ index: markdownMatch.index, source })
  }

  matches.sort((a, b) => a.index - b.index)
  return matches[0]?.source ?? null
}

export function resolveEmbeddedGreetingImage(
  content: string,
  assetMap: unknown,
): { imageId: string } | { url: string } | null {
  const source = findEmbeddedGreetingImageSource(content)
  if (!source) return null

  if (assetMap && typeof assetMap === 'object' && !Array.isArray(assetMap)) {
    const map = assetMap as Record<string, string>
    const galleryImageId = resolveGalleryImageId(source, map)
    const cleaned = source.startsWith('embeded://') ? source.slice('embeded://'.length) : source
    const imageId = galleryImageId || map[cleaned] || map[assetStem(cleaned)]
    if (typeof imageId === 'string' && imageId) return { imageId }
  }

  if (/^(?:https?:\/\/|\/|data:image\/|blob:)/i.test(source)) return { url: source }
  return null
}

export function getGreetingCellImageUrl(
  character: Character,
  greetingIndex: number,
  content: string,
): string | null {
  const backgrounds = character.extensions?.greeting_backgrounds
  if (backgrounds && typeof backgrounds === 'object' && !Array.isArray(backgrounds)) {
    const explicitImageId = backgrounds[greetingIndex]
    if (typeof explicitImageId === 'string' && explicitImageId) {
      return imagesApi.smallUrl(explicitImageId)
    }
  }

  const embedded = resolveEmbeddedGreetingImage(content, character.extensions?.risu_asset_map)
  if (!embedded) return null
  return 'imageId' in embedded ? imagesApi.smallUrl(embedded.imageId) : embedded.url
}

/** The stored greeting owner survives conversion between solo and group chats. */
export function getGreetingMessageCharacterId(
  message: Pick<Message, 'extra'>,
  activeCharacterId: string | null,
): string | null {
  const owner = message.extra?.greeting_character_id
  return typeof owner === 'string' && owner.trim() ? owner : activeCharacterId
}

function greetingList(character: Character): Array<string | undefined> {
  return [character.first_mes, ...(character.alternate_greetings || [])]
}

function normalizeGreetingContent(value: string): string {
  return value.replace(/\r\n/g, '\n').trim()
}

function matchingGreetingIndices(character: Character, content: string): number[] {
  const normalizedContent = normalizeGreetingContent(content)
  return greetingList(character).flatMap((greeting, index) =>
    typeof greeting === 'string' && normalizeGreetingContent(greeting) === normalizedContent
      ? [index]
      : [],
  )
}

function isValidGreetingIndex(character: Character, value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value < greetingList(character).length
}

/**
 * Only a marked greeting, a stored greeting index, or content that still
 * matches a greeting proves this message is the opening greeting. A first
 * assistant reply (for example a regenerated opening) has none of these and
 * must not inherit the character's greeting art.
 */
function hasGreetingIdentity(
  character: Character,
  message: Pick<Message, 'content' | 'extra'>,
): boolean {
  return message.extra?.greeting === true
    || isValidGreetingIndex(character, message.extra?.greeting_index)
    || matchingGreetingIndices(character, message.content).length > 0
}

/**
 * Recover the selected greeting after a character's greetings were reordered.
 * Stored metadata still identifies edited greetings and ambiguous duplicates.
 */
export function resolveGreetingMessageIndex(
  character: Character,
  message: Pick<Message, 'content' | 'extra'>,
  chatMetadata?: Record<string, any> | null,
): number {
  const greetings = greetingList(character)
  const validIndex = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < greetings.length

  const storedIndex = message.extra?.greeting_index
  const matchingIndices = matchingGreetingIndices(character, message.content)
  if (validIndex(storedIndex)) {
    return matchingIndices.length === 1 && matchingIndices[0] !== storedIndex
      ? matchingIndices[0]
      : storedIndex
  }
  if (matchingIndices.length === 1) return matchingIndices[0]

  // Group metadata has one selection per character; the solo selection may
  // belong to a different group member and must not be reused here.
  const selectedIndex = chatMetadata?.group
    ? chatMetadata.group_active_greeting_indices?.[character.id]
    : chatMetadata?.activeGreetingIndex
  return validIndex(selectedIndex) ? selectedIndex : matchingIndices[0] ?? 0
}

/** Resolve the opening assistant message's art using full-size originals. */
export function getGreetingMessageImage(
  character: Character,
  message: Pick<Message, 'index_in_chat' | 'is_user' | 'content' | 'extra'>,
  chatMetadata?: Record<string, any> | null,
): GreetingMessageImage | null {
  if (message.index_in_chat !== 0 || message.is_user) return null
  const owner = message.extra?.greeting_character_id
  if (typeof owner === 'string' && owner && owner !== character.id) return null
  if (!hasGreetingIdentity(character, message)) return null

  const greetingIndex = resolveGreetingMessageIndex(character, message, chatMetadata)
  const assetMap = character.extensions?.risu_asset_map
  const embeddedSource = findEmbeddedGreetingImageSource(message.content)
  const embedded = resolveEmbeddedGreetingImage(message.content, assetMap)
  const backgrounds = character.extensions?.greeting_backgrounds
  const explicitImageId = backgrounds && typeof backgrounds === 'object' && !Array.isArray(backgrounds)
    ? backgrounds[greetingIndex]
    : null

  if (typeof explicitImageId === 'string' && explicitImageId) {
    const url = imagesApi.url(explicitImageId)
    const matchesEmbedded = embedded && (
      'imageId' in embedded ? embedded.imageId === explicitImageId : embedded.url === url
    )
    return { url, greetingIndex, ...(matchesEmbedded && embeddedSource ? { embeddedSource } : {}) }
  }

  // Imported greetings may have already had their inline image transformed;
  // the selected character greeting still supplies the associated image.
  const originalGreeting = greetingIndex === 0
    ? character.first_mes
    : character.alternate_greetings?.[greetingIndex - 1]
  const selected = embedded || resolveEmbeddedGreetingImage(originalGreeting || '', assetMap)
  if (!selected) return null
  return {
    url: 'imageId' in selected ? imagesApi.url(selected.imageId) : greetingMessageDisplayUrl(selected.url),
    greetingIndex,
    ...(embedded && embeddedSource ? { embeddedSource } : {}),
  }
}

/** Remove one matching image from a display copy, preserving other content. */
export function removeGreetingImageMarkup(content: string, source: string): string {
  const matches: Array<{ index: number; length: number }> = []
  const collect = (pattern: RegExp, sourceGroups: number[]) => {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      const candidate = sourceGroups.map((group) => match![group]).find(Boolean)?.trim()
      if (candidate === source) matches.push({ index: match.index, length: match[0].length })
    }
  }
  collect(RISU_IMAGE_RE, [1])
  collect(HTML_IMAGE_RE, [1])
  collect(MARKDOWN_IMAGE_MARKUP_RE, [1, 2])
  matches.sort((a, b) => a.index - b.index)
  const first = matches[0]
  return first ? content.slice(0, first.index) + content.slice(first.index + first.length) : content
}
