import type { CortexMemory, LinkedCortexResult } from "./memory-cortex/types";

/** `similarityThreshold` is a maximum cosine distance, with 0 disabling it.
 * A rank, keyword hit, or recency fallback is not a vector measurement. */
export function passesMemoryDistanceThreshold(distance: unknown, threshold: number): boolean {
  return threshold <= 0 || (typeof distance === "number" && Number.isFinite(distance) && distance >= 0 && distance <= threshold);
}

export function filterCortexMemoriesByDistance(memories: CortexMemory[], threshold: number): CortexMemory[] {
  return threshold > 0 ? memories.filter((m) => passesMemoryDistanceThreshold(m.vectorDistance, threshold)) : memories;
}

/** Recheck warm snapshots against current settings without changing the cache. */
export function filterLinkedCortexByDistance(result: LinkedCortexResult, threshold: number): LinkedCortexResult {
  if (!(threshold > 0)) return result;
  return {
    vaults: result.vaults.map((vault) => ({ ...vault,
      memories: vault.memories ? filterCortexMemoriesByDistance(vault.memories, threshold) : undefined,
    })),
    interlinks: result.interlinks.map((link) => ({ ...link,
      result: { ...link.result, memories: filterCortexMemoriesByDistance(link.result.memories, threshold) },
    })),
  };
}
