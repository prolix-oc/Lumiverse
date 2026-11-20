import { describe, expect, test } from "bun:test";
import type { ChubExpressionAsset } from "./chub-api.service";
import type { ExpressionImageData } from "./expressions.service";
import {
  ChubExpressionImportQueue,
  importChubExpressionAssetsBatched,
} from "./chub-expression-import.service";

function assets(count: number): ChubExpressionAsset[] {
  return Array.from({ length: count }, (_, index) => ({
    label: `expression-${index}`,
    url: `https://example.com/${index}.png`,
  }));
}

describe("Chub expression backend queue", () => {
  test("serializes pack jobs and deduplicates the same character", async () => {
    const queue = new ChubExpressionImportQueue(1);
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    let firstRuns = 0;
    let secondRuns = 0;

    const first = queue.enqueue("user:character-a", async () => {
      firstRuns++;
      await firstGate.promise;
      return "first";
    });
    const duplicate = queue.enqueue<string>("user:character-a", async () => {
      throw new Error("duplicate work must not run");
    });
    const second = queue.enqueue("user:character-b", async () => {
      secondRuns++;
      await secondGate.promise;
      return "second";
    });

    await Promise.resolve();
    expect(queue.status()).toEqual({ active: 1, queued: 1 });
    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(0);

    firstGate.resolve();
    expect(await duplicate).toBe("first");
    expect(await first).toBe("first");
    await Promise.resolve();
    expect(secondRuns).toBe(1);
    expect(queue.status()).toEqual({ active: 1, queued: 0 });

    secondGate.resolve();
    expect(await second).toBe("second");
    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(1);
  });

  test("downloads and stores a large pack in bounded batches", async () => {
    const storedBatchSizes: number[] = [];
    let activeDownloads = 0;
    let maxActiveDownloads = 0;

    const result = await importChubExpressionAssetsBatched("user", "character", assets(10), {
      batchSize: 4,
      downloadWorkers: 2,
      download: async (asset, index): Promise<ExpressionImageData> => {
        activeDownloads++;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        await Promise.resolve();
        activeDownloads--;
        return {
          label: asset.label,
          data: new Uint8Array([index]),
          filename: `${index}.png`,
          mimeType: "image/png",
        };
      },
      storeBatch: async (_userId, _characterId, batch) => {
        storedBatchSizes.push(batch.length);
        return { importedLabels: batch.map((item) => item.label), failed: 0 };
      },
    });

    expect(storedBatchSizes).toEqual([4, 4, 2]);
    expect(maxActiveDownloads).toBe(2);
    expect(result.importedLabels).toHaveLength(10);
    expect(result.failed).toBe(0);
  });

  test("isolates failed downloads without retaining them for later batches", async () => {
    const stored: string[][] = [];
    const result = await importChubExpressionAssetsBatched("user", "character", assets(5), {
      batchSize: 2,
      downloadWorkers: 2,
      download: async (asset, index) => index % 2 === 0
        ? {
            label: asset.label,
            data: new Uint8Array([index]),
            filename: `${index}.png`,
            mimeType: "image/png",
          }
        : null,
      storeBatch: async (_userId, _characterId, batch) => {
        stored.push(batch.map((item) => item.label));
        return { importedLabels: batch.map((item) => item.label), failed: 0 };
      },
    });

    expect(stored).toEqual([
      ["expression-0"],
      ["expression-2"],
      ["expression-4"],
    ]);
    expect(result.importedLabels).toEqual(["expression-0", "expression-2", "expression-4"]);
    expect(result.failed).toBe(2);
  });
});
