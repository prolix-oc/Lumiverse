import { cpus } from "node:os";
import { orderWorldInfoForOutput } from "../src/services/world-info-output-order";
import { materializeWorldInfoCache } from "../src/services/world-info-activation.service";
import type { WorldBookEntry } from "../src/types/world-book";

const none = new Set<string>();
const noRequests = new Map<string, string>();
let sink = 0;
function measure(run: () => number, iterations: number) {
  for (let i = 0; i < 100; i++) sink += run();
  const samples: number[] = [];
  for (let sample = 0; sample < 11; sample++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink += run();
    samples.push((performance.now() - start) / iterations);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: samples[5], p90Ms: samples[9] };
}

const results = [];
for (const count of [1, 100, 1_000, 10_000]) {
  for (const large of [false, true]) {
    const text = "x".repeat(large ? Math.ceil(4_000_000 / count) : 32);
    let seed = 12345;
    const entries = Array.from({ length: count }, (_, index) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return {
        id: String(index), comment: String(index), content: text,
        position: 0, role: "system", order_value: seed % 1000,
      } as WorldBookEntry;
    });
    const requests = new Map(entries.map(row => [row.id, "extension"]));
    const mixedRequests = new Map(entries.filter((_, index) => index % 3 !== 0)
      .map((row, index) => [row.id, `extension-${index % 2}`]));
    const cache = materializeWorldInfoCache(entries);
    const prepare = (groups: ReadonlyMap<string, string>) => {
      const ordered = orderWorldInfoForOutput(entries, groups, none);
      const output = ordered === entries ? cache : materializeWorldInfoCache(ordered);
      return output.before.length;
    };
    const iterations = Math.max(10, Math.ceil(100_000 / count));
    results.push({
      entries: count, totalCharacters: text.length * count,
      hostEstimatedTokens: Math.ceil(text.length / 4) * count,
      iterations, before: measure(() => cache.before.length, iterations),
      noOptIn: measure(() => prepare(noRequests), iterations),
      optedIn: measure(() => prepare(requests), iterations),
      mixedExtensions: measure(() => prepare(mixedRequests), iterations),
    });
  }
}
console.log(JSON.stringify({
  runtime: Bun.version, platform: process.platform, cpu: cpus()[0]?.model,
  scope: "Final output preparation only: cached baseline versus ordering plus bucket rebuild. Selection, tokenization, RPC and model requests are excluded. Shared synthetic text is allocated before timing; token counts use the host characters/4 estimate.",
  warmups: 100, samples: 11, results, sink,
}, null, 2));
