export type WorldBookVectorPresetMode = 'lean' | 'balanced' | 'deep' | 'custom'

export interface WorldBookVectorSettings {
  presetMode: WorldBookVectorPresetMode
  chunkTargetTokens: number
  chunkMaxTokens: number
  chunkOverlapTokens: number
  retrievalTopK: number
  maxChunksPerEntry: number
}
