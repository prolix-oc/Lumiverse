type JsonRecord = Record<string, unknown>

const CHUB_HOSTS = new Set([
  'chub.ai',
  'www.chub.ai',
  'characterhub.org',
  'www.characterhub.org',
])

const HUB_HOSTS = new Map<string, 'lumihub' | 'illarin'>([
  ['lumi.spot', 'lumihub'],
  ['www.lumi.spot', 'lumihub'],
  ['illarin.com', 'illarin'],
  ['www.illarin.com', 'illarin'],
])

export type CharacterSource =
  | { provider: 'chub'; url: string; fullPath: string }
  | { provider: 'lumihub' | 'illarin'; url: string }

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value).trim()
    return decoded || null
  } catch {
    return null
  }
}

function pathFromSegments(segments: string[]): string | null {
  let start = 0
  if (CHUB_HOSTS.has(segments[0]?.toLowerCase())) start += 1
  if (segments[start]?.toLowerCase() === 'characters') start += 1

  const creator = decodeSegment(segments[start] ?? '')
  const character = decodeSegment(segments[start + 1] ?? '')
  return creator && character ? `${creator}/${character}` : null
}

/** Read the portable Chub attribution path used by existing character cards. */
export function readChubFullPath(extensions: unknown): string | null {
  if (!isRecord(extensions)) return null

  const chub = isRecord(extensions.chub) ? extensions.chub : null
  const value =
    typeof chub?.full_path === 'string' ? chub.full_path
      : typeof chub?.fullPath === 'string' ? chub.fullPath
        : typeof extensions._lumiverse_chub_slug === 'string' ? extensions._lumiverse_chub_slug
          : ''

  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^https?:\/\//i.test(trimmed)) return parseChubSourceInput(trimmed)
  return trimmed.replace(/^\/+|\/+$/g, '') || null
}

/** Accept a Chub/CharacterHub URL or a portable creator/character path. */
export function parseChubSourceInput(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    if (!/^https?:\/\//i.test(trimmed)) return null
    try {
      const parsed = new URL(trimmed)
      if (!CHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null
      return pathFromSegments(parsed.pathname.split('/').filter(Boolean))
    } catch {
      return null
    }
  }

  const withoutQuery = trimmed.split(/[?#]/, 1)[0]
  return pathFromSegments(withoutQuery.split('/').filter(Boolean))
}

export function chubSourceUrl(fullPath: string | null): string | null {
  if (!fullPath) return null
  const encodedPath = fullPath.split('/').map(encodeURIComponent).join('/')
  return `https://chub.ai/characters/${encodedPath}`
}

/** Accept supported attribution URLs, including hub profiles, or a Chub path. */
export function parseCharacterSourceInput(value: string): CharacterSource | null {
  let trimmed = value.trim()
  if (!trimmed) return null

  const host = trimmed.split(/[/?#]/, 1)[0].toLowerCase()
  if (CHUB_HOSTS.has(host) || HUB_HOSTS.has(host)) trimmed = `https://${trimmed}`
  if (trimmed.startsWith('//')) trimmed = `https:${trimmed}`

  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null

      const provider = HUB_HOSTS.get(parsed.hostname)
      if (provider) {
        if (!parsed.pathname.split('/').some(Boolean)) return null
        return { provider, url: parsed.href }
      }
      if (!CHUB_HOSTS.has(parsed.hostname)) return null
      trimmed = parsed.href
    } catch {
      return null
    }
  }

  const fullPath = parseChubSourceInput(trimmed)
  return fullPath ? { provider: 'chub', fullPath, url: chubSourceUrl(fullPath)! } : null
}

/** Prefer an explicit source URL, falling back to legacy Chub card metadata. */
export function readCharacterSourceUrl(extensions: unknown): string | null {
  if (!isRecord(extensions)) return null
  if (typeof extensions._lumiverse_source_url === 'string') {
    const source = parseCharacterSourceInput(extensions._lumiverse_source_url)
    if (source) return source.url
  }
  return chubSourceUrl(readChubFullPath(extensions))
}

/** Replace attribution without storing another provider's URL as a Chub slug. */
export function setCharacterSource(
  extensions: Record<string, any>,
  source: CharacterSource | null,
): Record<string, any> {
  const next = setChubFullPath(extensions, source?.provider === 'chub' ? source.fullPath : null)
  delete next._lumiverse_source_url
  if (source && source.provider !== 'chub') next._lumiverse_source_url = source.url
  return next
}

/** Update only source attribution fields, preserving all unrelated metadata. */
export function setChubFullPath(
  extensions: Record<string, any>,
  fullPath: string | null,
): Record<string, any> {
  const normalized = fullPath?.trim().replace(/^\/+|\/+$/g, '') || null
  const next = { ...extensions }
  const existingChub = isRecord(next.chub) ? next.chub : null
  const chub = { ...(existingChub ?? {}) }

  delete chub.full_path
  delete chub.fullPath

  if (normalized) {
    chub.full_path = normalized
    next.chub = chub
    if (typeof next._lumiverse_chub_slug === 'string') {
      next._lumiverse_chub_slug = normalized
    }
  } else {
    if (Object.keys(chub).length > 0) next.chub = chub
    else delete next.chub
    delete next._lumiverse_chub_slug
  }

  return next
}
