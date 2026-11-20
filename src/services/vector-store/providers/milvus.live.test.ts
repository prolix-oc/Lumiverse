import { describe, expect, test } from "bun:test";
import { connectMilvusMaintenance } from "./milvus-maintenance";
import { benchmarkMilvus } from "./milvus-benchmark";
import type { VectorRow } from "../types";

// Deliberately separate from normal connection env: ordinary test runs never
// create collections on a configured production server.
const address = process.env.LUMIVERSE_MILVUS_TEST_ADDRESS;
describe.skipIf(!address)("Milvus live cross-client integration", () => {
  test("inserts, updates, deletes, scopes every read leg, and benchmarks an isolated collection", async () => {
    const config = { address: address!, database: process.env.LUMIVERSE_MILVUS_TEST_DATABASE,
      username: process.env.LUMIVERSE_MILVUS_TEST_USERNAME, ssl: process.env.LUMIVERSE_MILVUS_TEST_SSL === "true" };
    const writer = await connectMilvusMaintenance(config, process.env.LUMIVERSE_MILVUS_TEST_PASSWORD ?? null);
    let reader: Awaited<ReturnType<typeof connectMilvusMaintenance>> | undefined;
    try {
      reader = await connectMilvusMaintenance(config, process.env.LUMIVERSE_MILVUS_TEST_PASSWORD ?? null);
      const rows: VectorRow[] = Array.from({ length: 32 }, (_, i) => ({
        id: `live-${String(i).padStart(4, "0")}`, user_id: `user-${i % 2}`, source_type: "databank", source_id: `source-${i}`, owner_id: "live-bank", chunk_index: 0,
        content: `sword forest adventure ${i}`, metadata_json: "{}", updated_at: 1, vector: [1, i / 32, 0, 0],
      }));
      const result = await benchmarkMilvus(writer, reader, rows, { queries: 4, timeoutMs: 120_000, text: process.env.LUMIVERSE_MILVUS_TEST_TEXT === "true" });
      expect(result.immediateCrossClientVisibility).toBe(true);
      expect(result.tenantIsolation).toBe(true);
      expect(result.denseRecallAt10).toBeGreaterThanOrEqual(0.9);
    } finally {
      await Promise.allSettled([writer.closeConnection(), reader?.closeConnection()]);
    }
  }, 180_000);
});
