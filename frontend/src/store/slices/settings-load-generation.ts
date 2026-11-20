export interface SettingsLoadGenerationGuard {
  begin(): number
  isCurrent(generation: number): boolean
}

export function createSettingsLoadGenerationGuard(): SettingsLoadGenerationGuard {
  let currentGeneration = 0

  return {
    begin: () => ++currentGeneration,
    isCurrent: (generation) => generation === currentGeneration,
  }
}
