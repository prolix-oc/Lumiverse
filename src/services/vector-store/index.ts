/**
 * Vector store factory + barrel.
 *
 * `getActiveVectorStore()` resolves the configured provider (env override >
 * owner's stored config > lancedb default) and memoizes it for the process
 * lifetime. Optional providers (Qdrant/Milvus) are dynamically imported so the
 * default LanceDB install never references them.
 *
 * Re-exports the addressing helpers + types so orchestration (embeddings.service)
 * can import everything vector-store-related from one place.
 */
import { LanceDbStore } from "./providers/lancedb";
import type { VectorStore } from "./types";
import {
  getResolvedVectorStoreConfig,
  getVectorStoreConnectionSecrets,
  type VectorStoreConfig,
  type VectorStoreConnectionSecrets,
} from "../vector-store-config.service";

let activeStore: VectorStore | null = null;

/**
 * Construct (but do not memoize) a store for an explicit config + secrets.
 * Used by `getActiveVectorStore` and by the validate-before-commit path when
 * switching/testing a provider. Optional providers load via dynamic `import()`
 * and surface a helpful error if the optional dependency is missing.
 */
export async function buildVectorStore(
  config: VectorStoreConfig,
  secrets: VectorStoreConnectionSecrets,
): Promise<VectorStore> {
  switch (config.provider) {
    case "lancedb":
      return new LanceDbStore();
    case "qdrant": {
      const { QdrantStore } = await import("./providers/qdrant");
      return new QdrantStore(config.qdrant, secrets.qdrantApiKey, config.tuningProfile);
    }
    case "milvus": {
      const { MilvusStore } = await import("./providers/milvus");
      return new MilvusStore(config.milvus, secrets.milvusPassword, config.tuningProfile);
    }
    default:
      return new LanceDbStore();
  }
}

/**
 * Resolve the active vector store, memoized for the process lifetime. `init()`
 * is idempotent and safe to repeat.
 */
export async function getActiveVectorStore(): Promise<VectorStore> {
  if (!activeStore) {
    const config = getResolvedVectorStoreConfig();
    const secrets = await getVectorStoreConnectionSecrets();
    activeStore = await buildVectorStore(config, secrets);
  }
  await activeStore.init();
  return activeStore;
}

/** Clear the memoized store handle (e.g. after a provider config change). */
export function resetActiveVectorStore(): void {
  if (activeStore) {
    // Best-effort close; never throw out of a reset.
    Promise.resolve(activeStore.close()).catch(() => {});
  }
  activeStore = null;
}

export * from "./types";
export * from "./addressing";
export { LANCEDB_CAPABILITIES } from "./capabilities";
