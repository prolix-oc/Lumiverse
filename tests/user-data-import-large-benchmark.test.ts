/**
 * Opt-in end-to-end memory benchmark for the largest supported backup shape.
 *
 * Run only this file so it has exclusive ownership of the process-wide import
 * slot and temporary data directory:
 *
 *   IMPORT_BENCHMARK_GB=4 bun test tests/user-data-import-large-benchmark.test.ts
 *
 * `IMPORT_BENCHMARK_MODE=deflate` is the default and streams incompressible
 * data through ZIP DEFLATE, exercising the bounded zlib extraction path.
 * Set it to `store` to isolate raw archive/staging/copy throughput.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomFillSync } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { ZipArchive } from "archiver";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { env } from "../src/env";
import { cancelJob, getJob, startImport } from "../src/services/user-data/import.service";

const USER_ID = "large-import-benchmark-user";
const GIB = 1024 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    producer: "lumiverse",
    exportedAt: 0,
    archiveId: crypto.randomUUID(),
    producerVersion: "benchmark",
    includeVectors: false,
    embeddingConfig: { provider: null, model: null, dimension: null },
    counts: {},
    missingFiles: [],
  };
}

function generatedStream(totalBytes: number, mode: "store" | "deflate"): Readable {
  let remaining = totalBytes;
  return new Readable({
    read() {
      while (remaining > 0) {
        const length = Math.min(CHUNK_BYTES, remaining);
        remaining -= length;
        const chunk = new Uint8Array(length);
        if (mode === "deflate") randomFillSync(chunk);
        if (!this.push(chunk)) return;
      }
      this.push(null);
    },
  });
}

async function buildBenchmarkArchive(
  path: string,
  payloadBytes: number,
  mode: "store" | "deflate",
): Promise<void> {
  const store = mode === "store";
  const archive = new ZipArchive({ forceZip64: true, store, zlib: { level: 1 } });
  const output = createWriteStream(path, { highWaterMark: CHUNK_BYTES });
  const closed = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
  });
  archive.pipe(output);
  archive.append(JSON.stringify(manifest()), { name: "manifest.json", store: true });
  archive.append(generatedStream(payloadBytes, mode), {
    name: "files/databank/benchmark.bin",
    store,
  });
  await archive.finalize();
  await closed;
}

type MemorySample = ReturnType<typeof process.memoryUsage>;

function samplePeak(peak: MemorySample, sample: MemorySample): void {
  peak.rss = Math.max(peak.rss, sample.rss);
  peak.heapTotal = Math.max(peak.heapTotal, sample.heapTotal);
  peak.heapUsed = Math.max(peak.heapUsed, sample.heapUsed);
  peak.external = Math.max(peak.external, sample.external);
  peak.arrayBuffers = Math.max(peak.arrayBuffers, sample.arrayBuffers);
}

async function waitForTerminal(jobId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJob(jobId)!;
    if (["complete", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for import job");
}

let workDir = "";
let originalDataDir = "";
let activeJobId: string | null = null;

beforeEach(async () => {
  closeDatabase();
  workDir = mkdtempSync(join(tmpdir(), "lvbak-large-benchmark-"));
  originalDataDir = env.dataDir;
  env.dataDir = workDir;
  initDatabase(":memory:");
  const baseline = await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text();
  getDb().run("PRAGMA foreign_keys = OFF");
  getDb().run(baseline);
  getDb()
    .query(
      "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
    )
    .run(USER_ID, "Large Benchmark", "benchmark@example.com", 0, 0);
});

afterEach(async () => {
  if (activeJobId) {
    cancelJob(activeJobId);
    try {
      await waitForTerminal(activeJobId, 60_000);
    } catch {
      /* the test runner is already reporting the primary benchmark failure */
    }
    activeJobId = null;
  }
  closeDatabase();
  env.dataDir = originalDataDir;
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
});

test.skipIf(!process.env.IMPORT_BENCHMARK_GB)(
  "imports a 4–6 GiB ZIP with bounded process memory",
  async () => {
    const targetGiB = Number(process.env.IMPORT_BENCHMARK_GB);
    if (!Number.isInteger(targetGiB) || targetGiB < 4 || targetGiB > 6) {
      throw new Error("IMPORT_BENCHMARK_GB must be an integer from 4 through 6");
    }
    const mode = process.env.IMPORT_BENCHMARK_MODE === "store" ? "store" : "deflate";
    const payloadBytes = targetGiB * GIB;
    const fs = statfsSync(workDir);
    const available = BigInt(fs.bavail) * BigInt(fs.bsize);
    const required = BigInt(payloadBytes * 3) + BigInt(512 * 1024 * 1024);
    if (available < required) {
      throw new Error(`benchmark needs at least ${required} free bytes; only ${available} are available`);
    }

    const archivePath = join(workDir, `import-${targetGiB}gib-${mode}.lvbak`);
    const buildStarted = performance.now();
    await buildBenchmarkArchive(archivePath, payloadBytes, mode);
    const buildMs = performance.now() - buildStarted;
    const archiveBytes = statSync(archivePath).size;
    expect(archiveBytes).toBeGreaterThanOrEqual(payloadBytes);

    const baseline = process.memoryUsage();
    const peak = { ...baseline };
    const sampler = setInterval(() => samplePeak(peak, process.memoryUsage()), 100);
    const importStarted = performance.now();
    try {
      const job = startImport({ userId: USER_ID, archivePath, jobId: crypto.randomUUID() });
      activeJobId = job.jobId;
      const finished = await waitForTerminal(job.jobId, 60 * 60 * 1000);
      activeJobId = null;
      expect(finished.status).toBe("complete");
    } finally {
      clearInterval(sampler);
      samplePeak(peak, process.memoryUsage());
    }
    const importMs = performance.now() - importStarted;
    const heapDeltaMiB = (peak.heapUsed - baseline.heapUsed) / (1024 * 1024);
    const rssDeltaMiB = (peak.rss - baseline.rss) / (1024 * 1024);
    const result = {
      targetGiB,
      mode,
      archiveGiB: archiveBytes / GIB,
      buildSeconds: buildMs / 1000,
      importSeconds: importMs / 1000,
      baselineMiB: {
        heapUsed: baseline.heapUsed / (1024 * 1024),
        rss: baseline.rss / (1024 * 1024),
      },
      peakMiB: {
        heapUsed: peak.heapUsed / (1024 * 1024),
        rss: peak.rss / (1024 * 1024),
      },
      deltaMiB: { heapUsed: heapDeltaMiB, rss: rssDeltaMiB },
    };
    console.info("[user-data import benchmark]", JSON.stringify(result));

    const maxHeapDeltaMiB = Number(process.env.IMPORT_BENCHMARK_MAX_HEAP_MB || 512);
    const maxRssDeltaMiB = Number(process.env.IMPORT_BENCHMARK_MAX_RSS_MB || 768);
    expect(heapDeltaMiB).toBeLessThan(maxHeapDeltaMiB);
    expect(rssDeltaMiB).toBeLessThan(maxRssDeltaMiB);
  },
  60 * 60 * 1000,
);
