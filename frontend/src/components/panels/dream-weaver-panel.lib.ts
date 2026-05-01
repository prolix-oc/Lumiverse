import type { DreamWeaverSession } from '@/api/dream-weaver'

export const DEFAULT_VISIBLE_SESSIONS = 5

export interface SessionArchiveGroup {
  key: 'today' | 'thisWeek' | 'older' | 'results'
  label: string
  sessions: DreamWeaverSession[]
}

export interface DreamWeaverSelectablePersona {
  id: string
  is_default?: boolean | null
}

export function getDreamWeaverSessionTitle(session: DreamWeaverSession): string {
  const source = session.dream_text.trim()
  if (source) return source.length > 48 ? `${source.slice(0, 48).trimEnd()}…` : source
  return session.workspace_kind === 'scenario' ? 'Untitled scenario studio' : 'Untitled character studio'
}

export function getDreamWeaverSessionPreview(session: DreamWeaverSession): string {
  return session.dream_text || (session.workspace_kind === 'scenario' ? 'Blank scenario studio' : 'Blank character studio')
}

export function formatDreamWeaverSessionTimestamp(updatedAt: number, now = new Date()): string {
  const date = new Date(updatedAt * 1000)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())

  if (startOfDate.getTime() === startOfToday.getTime()) {
    return `Today, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  }

  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }

  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function buildDreamWeaverSessionArchive(
  sessions: DreamWeaverSession[],
  query: string,
  now = new Date(),
): SessionArchiveGroup[] {
  const sortedSessions = [...sessions].sort((a, b) => b.updated_at - a.updated_at)
  const normalizedQuery = query.trim().toLowerCase()

  if (normalizedQuery) {
    const matches = sortedSessions.filter((session) => buildSearchableText(session).includes(normalizedQuery))
    return matches.length
      ? [{ key: 'results', label: 'Results', sessions: matches }]
      : []
  }

  const grouped: Record<'today' | 'thisWeek' | 'older', DreamWeaverSession[]> = {
    today: [],
    thisWeek: [],
    older: [],
  }

  for (const session of sortedSessions) {
    grouped[getRecencyBucket(session.updated_at, now)].push(session)
  }

  const groupOrder: Array<Pick<SessionArchiveGroup, 'key' | 'label'>> = [
    { key: 'today', label: 'Today' },
    { key: 'thisWeek', label: 'This Week' },
    { key: 'older', label: 'Older' },
  ]

  return groupOrder
    .map((group) => ({ ...group, sessions: grouped[group.key] }))
    .filter((group) => group.sessions.length > 0)
}

export function getDefaultExpandedDreamWeaverArchiveKeys(
  groups: ReadonlyArray<Pick<SessionArchiveGroup, 'key'>>,
): SessionArchiveGroup['key'][] {
  if (groups.some((group) => group.key === 'results')) {
    return ['results']
  }

  const recentKeys = groups
    .filter((group) => group.key !== 'older')
    .map((group) => group.key)

  if (recentKeys.length > 0) {
    return recentKeys
  }

  return groups[0] ? [groups[0].key] : []
}

export function resolveSelectedDreamWeaverPersonaId(
  sessionPersonaId: string | null | undefined,
  activePersonaId: string | null | undefined,
  personas: ReadonlyArray<DreamWeaverSelectablePersona>,
): string | null {
  if (sessionPersonaId && personas.some((persona) => persona.id === sessionPersonaId)) {
    return sessionPersonaId
  }

  if (activePersonaId && personas.some((persona) => persona.id === activePersonaId)) {
    return activePersonaId
  }

  const defaultPersona = personas.find((persona) => persona.is_default)
  return defaultPersona?.id ?? personas[0]?.id ?? null
}

function buildSearchableText(session: DreamWeaverSession): string {
  return [
    session.dream_text,
    session.workspace_kind,
    session.tone,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function getRecencyBucket(
  updatedAt: number,
  now: Date,
): 'today' | 'thisWeek' | 'older' {
  const updated = new Date(updatedAt * 1000)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  if (updated >= startOfToday) {
    return 'today'
  }

  const startOfWeek = new Date(startOfToday)
  const weekday = startOfWeek.getDay()
  const daysFromMonday = weekday === 0 ? 6 : weekday - 1
  startOfWeek.setDate(startOfWeek.getDate() - daysFromMonday)

  if (updated >= startOfWeek) {
    return 'thisWeek'
  }

  return 'older'
}
