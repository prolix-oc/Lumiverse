import type { ConnectionLibraryKind } from './connection-library'

export type RecentConnections = Partial<Record<ConnectionLibraryKind, string[]>>
const LIMIT = 8

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id))].slice(0, LIMIT)
    : []
}

export function recentConnectionIds(value: RecentConnections | undefined, kind: ConnectionLibraryKind, legacyText?: unknown): string[] {
  return ids(value && Object.hasOwn(value, kind) ? value[kind] : kind === 'llm' ? legacyText : [])
}

export function withRecentConnection(value: RecentConnections | undefined, kind: ConnectionLibraryKind, id: string, legacyText?: unknown): RecentConnections {
  if (!id) return value ?? {}
  return { ...value, [kind]: [id, ...recentConnectionIds(value, kind, legacyText).filter(previous => previous !== id)].slice(0, LIMIT) }
}

