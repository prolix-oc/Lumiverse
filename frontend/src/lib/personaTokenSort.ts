import type { Persona } from '@/types/api'
import type { PersonaSortDirection } from '@/types/store'

export function approximateTokenCount(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0
}

export function buildApproximatePersonaTokenCounts(personas: Persona[]): Record<string, number> {
  return Object.fromEntries(personas.map((persona) => [persona.id, approximateTokenCount(persona.description)]))
}

export function comparePersonasByTokenCount(
  a: Persona,
  b: Persona,
  counts: Record<string, number>,
  direction: PersonaSortDirection,
): number {
  const aCount = counts[a.id] ?? approximateTokenCount(a.description)
  const bCount = counts[b.id] ?? approximateTokenCount(b.description)
  const tokenOrder = (direction === 'desc' ? -1 : 1) * (aCount - bCount)
  if (tokenOrder !== 0) return tokenOrder
  const nameOrder = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return nameOrder !== 0 ? nameOrder : a.id.localeCompare(b.id)
}

/** Small generation guard that rejects token-count responses from stale models/data. */
export class PersonaTokenCountRequestGuard {
  private generation = 0

  begin(): number {
    this.generation += 1
    return this.generation
  }

  invalidate(): void {
    this.generation += 1
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation
  }
}
