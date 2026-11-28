export type CharacterSearchScope = 'metadata' | 'all'

/** Mirrors the server's Unicode-character minimum for trigram content search. */
export function isCharacterContentSearchValid(query: string): boolean {
  return query.trim().split(/\s+/).filter(Boolean).every(word => Array.from(word).length >= 3)
}
