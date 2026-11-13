import { expect, test } from "bun:test";
import { filterLinkedCortexByDistance, passesMemoryDistanceThreshold } from "./chat-memory-distance";
import type { CortexMemory, CortexResult } from "./memory-cortex/types";

test("a maximum distance accepts closer values and the boundary, rejecting unknown or invalid measurements", () => {
  for (const distance of [0, 0.35, 0.6]) expect(passesMemoryDistanceThreshold(distance, 0.6)).toBe(true);
  for (const distance of [0.60001, 1.2, null, undefined, -0.1, NaN, Infinity, "0.35"]) {
    expect(passesMemoryDistanceThreshold(distance, 0.6)).toBe(false);
  }
  expect(passesMemoryDistanceThreshold(null, 0)).toBe(true);
});

test("current cutoffs filter vault and interlink snapshots without comparing ranks or mutating the cache", () => {
  const memories = [
    { vectorDistance: 0.35, finalScore: 0.2 }, { vectorDistance: 0.61, finalScore: 0.99 }, { finalScore: 0.9 },
  ] as CortexMemory[];
  const linked = { vaults: [{ vaultId: "v", vaultName: "Vault", entities: [], relations: [], memories }],
    interlinks: [{ targetChatId: "chat", targetChatName: "Chat", result: { memories } as CortexResult }],
  };
  const filtered = filterLinkedCortexByDistance(linked, 0.6);
  expect(filtered.vaults[0].memories).toEqual([memories[0]]);
  expect(filtered.interlinks[0].result.memories).toEqual([memories[0]]);
  expect(linked.vaults[0].memories).toHaveLength(3);
  expect(linked.interlinks[0].result.memories).toHaveLength(3);
  expect(filterLinkedCortexByDistance(linked, 0)).toBe(linked);
});
