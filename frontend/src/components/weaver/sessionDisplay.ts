import type { WeaverBuildType, WeaverSession } from '@/api/weaver'
import type { Character } from '@/types/api'
import { deriveTitle, tileIconFor } from './primitives'

export interface SessionDisplay {
  title: string
  excerpt: string
  icon: string | null
  empty: boolean
}

export function sessionDisplay(
  session: WeaverSession,
  buildTypes: WeaverBuildType[],
  characters: Character[],
  untitled: string,
): SessionDisplay {
  const characterName = session.character_id
    ? characters.find((c) => c.id === session.character_id)?.name
    : undefined
  const seed = session.seed.text.trim()
  const title = characterName || session.display_name || deriveTitle(seed) || untitled
  return {
    title,
    excerpt: seed.replace(/\s+/g, ' '),
    icon: tileIconFor(buildTypes.find((bt) => bt.id === session.build_type)),
    empty: seed.length === 0,
  }
}

export function isEmptyDraft(session: WeaverSession): boolean {
  return session.status === 'draft' && session.stage === 'dream' && !session.seed.text.trim()
}

export function shortDate(ts: number): string {
  if (!ts) return ''
  const ms = ts < 1e12 ? ts * 1000 : ts
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
