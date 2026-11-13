import type { VectorStore } from "../vector-store/types";

/** Keep service tests off native stores; unexpected storage operations fail. */
export function stubVectorStore(overrides: Partial<VectorStore>): VectorStore {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected vector-store operation in service test");
  };
  return {
    id: "lancedb",
    capabilities: {
      nativeLexical: false,
      requiresUuidIds: false,
      requiresExplicitFlush: false,
      requiresLoadBeforeQuery: false,
      scoreKind: "cosine_distance",
      managesOwnIndexes: true,
      externalService: false,
      supportsOptimize: true,
      dimensionLockedAtCreate: true,
    },
    init: unexpected,
    ensureCollection: unexpected,
    getStoredDimension: unexpected,
    upsert: unexpected,
    getRowsByFilter: unexpected,
    deleteByFilter: unexpected,
    deleteByIds: unexpected,
    vectorSearch: unexpected,
    lexicalSearch: unexpected,
    countRows: unexpected,
    optimize: unexpected,
    health: unexpected,
    reset: unexpected,
    close: unexpected,
    ...overrides,
  };
}
