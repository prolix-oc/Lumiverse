#!/usr/bin/env bun

import sharp from "sharp";
import { mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

type Engine = "bun" | "sharp";

interface RunResult {
  engine: Engine;
  concurrency: number;
  files: number;
  completed: number;
  failures: number;
  elapsedMs: number;
  outputBytes: number;
  failureSamples: Array<{ path: string; error: string }>;
}

interface ResultFile {
  corpus: string;
  corpusFileCount: number;
  fileCount: number;
  width: number;
  height: number;
  quality: number;
  sharpConcurrency: number;
  bunVersion: string;
  createdAt: string;
  results: RunResult[];
}

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const corpusArgument = process.argv.slice(2).find((value) => !value.startsWith("--"));
if (!corpusArgument) {
  throw new Error(
    "Image directory required. Usage: bun run bench:images -- /path/to/images [--concurrency=1,2,4,8]",
  );
}

const corpus = resolve(corpusArgument);
const width = Number(arg("width", "512"));
const height = Number(arg("height", "512"));
const quality = Number(arg("quality", "80"));
const concurrencyLevels = arg("concurrency", "1,2,4,8")!
  .split(",")
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);
const sharpConcurrency = Number(arg("sharp-concurrency", "4"));
const limit = Number(arg("limit", "0"));
const requestedEngines = arg("engines", "bun,sharp")!
  .split(",")
  .filter((engine): engine is Engine => engine === "bun" || engine === "sharp");
const resultsPath = resolve(arg("results", ".tmp/bun-image-sharp-benchmark.json")!);
const resume = process.argv.includes("--resume");
const extensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
  throw new Error("--width and --height must be positive integers");
}
if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
  throw new Error("--quality must be between 1 and 100");
}
if (concurrencyLevels.length === 0) throw new Error("--concurrency must contain a positive integer");
if (!Number.isInteger(sharpConcurrency) || sharpConcurrency < 1) {
  throw new Error("--sharp-concurrency must be a positive integer");
}
if (!Number.isInteger(limit) || limit < 0) throw new Error("--limit must be a non-negative integer");
if (requestedEngines.length === 0) throw new Error("--engines must include bun and/or sharp");
mkdirSync(dirname(resultsPath), { recursive: true });

const glob = new Bun.Glob("**/*");
const files: string[] = [];
for await (const path of glob.scan({ cwd: corpus, absolute: true, onlyFiles: true })) {
  if (extensions.has(extname(path).toLowerCase())) files.push(path);
}
files.sort();
if (files.length === 0) throw new Error(`No supported images found under ${corpus}`);
const corpusFileCount = files.length;
if (limit > 0 && files.length > limit) files.length = limit;

sharp.concurrency(sharpConcurrency);
sharp.cache({ memory: 64, files: 128, items: 256 });

let resultFile: ResultFile = {
  corpus,
  corpusFileCount,
  fileCount: files.length,
  width,
  height,
  quality,
  sharpConcurrency,
  bunVersion: Bun.version,
  createdAt: new Date().toISOString(),
  results: [],
};

if (resume && await Bun.file(resultsPath).exists()) {
  const stored = await Bun.file(resultsPath).json() as ResultFile;
  const compatible = stored.corpus === corpus
    && stored.fileCount === files.length
    && stored.width === width
    && stored.height === height
    && stored.quality === quality
    && stored.sharpConcurrency === sharpConcurrency;
  if (!compatible) throw new Error(`Existing result file is incompatible: ${resultsPath}`);
  resultFile = stored;
}

async function transform(engine: Engine, path: string): Promise<Buffer> {
  if (engine === "bun") {
    return new Bun.Image(path, { autoOrient: false })
      .resize(width, height, { fit: "inside", withoutEnlargement: true })
      .webp({ quality })
      .buffer();
  }
  return sharp(path)
    .resize(width, height, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
}

function isWebp(buffer: Uint8Array): boolean {
  return buffer.byteLength >= 12
    && Buffer.from(buffer.buffer, buffer.byteOffset, 4).toString("ascii") === "RIFF"
    && Buffer.from(buffer.buffer, buffer.byteOffset + 8, 4).toString("ascii") === "WEBP";
}

async function run(engine: Engine, concurrency: number): Promise<RunResult> {
  let cursor = 0;
  let completed = 0;
  let failures = 0;
  let outputBytes = 0;
  const failureSamples: RunResult["failureSamples"] = [];
  const startedAt = performance.now();
  const progress = setInterval(() => {
    const elapsedSeconds = (performance.now() - startedAt) / 1_000;
    const rate = completed / Math.max(elapsedSeconds, 0.001);
    const remainingSeconds = (files.length - completed) / Math.max(rate, 0.001);
    console.error(
      `[${engine} c=${concurrency}] ${completed}/${files.length} `
      + `(${rate.toFixed(1)} images/s, ETA ${(remainingSeconds / 60).toFixed(1)}m, failures=${failures})`,
    );
  }, 10_000);

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor++;
      if (index >= files.length) return;
      const path = files[index]!;
      try {
        const output = await transform(engine, path);
        if (!isWebp(output)) throw new Error("encoder returned a non-WebP buffer");
        outputBytes += output.byteLength;
      } catch (error) {
        failures++;
        if (failureSamples.length < 20) {
          failureSamples.push({
            path,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        completed++;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  } finally {
    clearInterval(progress);
  }

  return {
    engine,
    concurrency,
    files: files.length,
    completed,
    failures,
    elapsedMs: performance.now() - startedAt,
    outputBytes,
    failureSamples,
  };
}

async function save(): Promise<void> {
  await Bun.write(resultsPath, `${JSON.stringify(resultFile, null, 2)}\n`);
}

console.log(JSON.stringify({
  corpus,
  images: files.length,
  corpusImages: corpusFileCount,
  resize: `${width}x${height} inside`,
  quality,
  concurrencyLevels,
  sharpConcurrency,
  engines: requestedEngines,
  bunVersion: Bun.version,
  resultsPath,
}, null, 2));

// Pay one-time module/codec startup before the corpus-sized timed runs.
for (const engine of requestedEngines) {
  for (const path of files.slice(0, 4)) await transform(engine, path);
}

for (let i = 0; i < concurrencyLevels.length; i++) {
  const concurrency = concurrencyLevels[i]!;
  const preferredOrder: Engine[] = i % 2 === 0 ? ["bun", "sharp"] : ["sharp", "bun"];
  const engines = preferredOrder.filter((engine) => requestedEngines.includes(engine));
  for (const engine of engines) {
    if (resultFile.results.some((result) => result.engine === engine && result.concurrency === concurrency)) {
      console.log(`Skipping completed run: ${engine} concurrency=${concurrency}`);
      continue;
    }
    Bun.gc(true);
    sharp.cache(false);
    sharp.cache({ memory: 64, files: 128, items: 256 });
    console.log(`Starting ${engine} concurrency=${concurrency}...`);
    const result = await run(engine, concurrency);
    resultFile.results.push(result);
    await save();
    console.log(JSON.stringify(result));
  }
}

const rows = concurrencyLevels.map((concurrency) => {
  const bun = resultFile.results.find((result) => result.engine === "bun" && result.concurrency === concurrency);
  const sharpResult = resultFile.results.find(
    (result) => result.engine === "sharp" && result.concurrency === concurrency,
  );
  const bunRate = bun ? bun.completed / (bun.elapsedMs / 1_000) : 0;
  const sharpRate = sharpResult ? sharpResult.completed / (sharpResult.elapsedMs / 1_000) : 0;
  return {
    concurrency,
    "Bun images/s": bunRate.toFixed(2),
    "Sharp images/s": sharpRate.toFixed(2),
    "Bun speedup": bun && sharpResult ? `${(bunRate / sharpRate).toFixed(2)}x` : "n/a",
    "Bun failures": bun?.failures ?? "n/a",
    "Sharp failures": sharpResult?.failures ?? "n/a",
  };
});
console.table(rows);
