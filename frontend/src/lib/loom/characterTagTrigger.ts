const TAG_SEPARATOR_RE = /[\s._\-:/\\|()[\]{}+,;'"`~!?@#$%^&*=<>]+/g

function normalizeTagToken(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(TAG_SEPARATOR_RE, '')
}

export function sanitizeCharacterTagTrigger(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const out: string[] = []

  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (!trimmed) continue
    const normalized = normalizeTagToken(trimmed)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(trimmed)
  }

  return out
}

export function splitCharacterTagTriggerInput(value: string): string[] {
  return sanitizeCharacterTagTrigger(value.split(/[\n,]+/g))
}

export function matchesCharacterTagTrigger(trigger: unknown, characterTags: unknown): boolean {
  const requiredTags = sanitizeCharacterTagTrigger(trigger)
  if (requiredTags.length === 0) return true
  if (!Array.isArray(characterTags) || characterTags.length === 0) return false

  const normalizedRequired = requiredTags
    .map((tag) => normalizeTagToken(tag))
    .filter(Boolean)
  if (normalizedRequired.length === 0) return true

  const normalizedCharacterTags = characterTags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => normalizeTagToken(tag))
    .filter(Boolean)
  if (normalizedCharacterTags.length === 0) return false

  return normalizedCharacterTags.some((characterTag) =>
    normalizedRequired.some((requiredTag) => characterTag.includes(requiredTag)),
  )
}
