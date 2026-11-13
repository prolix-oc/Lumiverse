#!/usr/bin/env bun

import sharp from "sharp";
import { cpus, platform, release } from "node:os";
import { extname, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

type Codec = "webp" | "avif";
type Tier = "sm" | "lg";

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

interface EncodeMeasurement {
  codec: Codec;
  tier: Tier;
  bytes: number;
  encodeMs: number;
  pixels: number;
}

interface QualityAccumulator {
  samples: number;
  values: number;
  squaredError: number;
}

interface BrowserMeasurement {
  codec: Codec;
  tier: Tier;
  decodeMs: number;
  pixels: number;
}

interface AssetPair {
  webp: string;
  avif: string;
  tier: Tier;
  pixels: number;
}

type PlaywrightModule = typeof import("./e2e-diagnostics/node_modules/playwright");
type PlaywrightBrowser = Awaited<ReturnType<PlaywrightModule["chromium"]["launch"]>>;

const PLAYWRIGHT_MODULE_PATH = "./e2e-diagnostics/node_modules/playwright/index.mjs";

function arg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} must be a positive integer`);
  return value;
}

function integerList(name: string, fallback: string): number[] {
  const values = arg(name, fallback)!
    .split(",")
    .map(Number)
    .filter((value) => Number.isInteger(value));
  if (values.length === 0) throw new Error(`--${name} must contain at least one integer`);
  return values;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * fraction) - 1));
  return sortedValues[index]!;
}

function summarize(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    total,
    mean: values.length ? total / values.length : 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

function evenlySample<T>(values: T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit === 1) return [values[0]!];
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.round(index * (values.length - 1) / (limit - 1));
    return values[sourceIndex]!;
  });
}

function psnr(accumulator: QualityAccumulator): number {
  if (accumulator.values === 0) return 0;
  const mse = accumulator.squaredError / accumulator.values;
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

function squaredError(reference: Uint8Array, decoded: Uint8Array): number {
  if (reference.byteLength !== decoded.byteLength) {
    throw new Error(`Decoded pixel length ${decoded.byteLength} does not match reference ${reference.byteLength}`);
  }
  let sum = 0;
  for (let index = 0; index < reference.byteLength; index++) {
    const difference = reference[index]! - decoded[index]!;
    sum += difference * difference;
  }
  return sum;
}

const corpusArgument = process.argv.slice(2).find((value) => !value.startsWith("--"));
if (!corpusArgument) {
  throw new Error(
    "Image directory required. Usage: bun run bench:thumbnail-codecs -- /path/to/images [--limit=2000]",
  );
}

const corpus = resolve(corpusArgument);
const limit = positiveInteger("limit", 2_000);
const concurrency = positiveInteger("concurrency", 4);
const sharpConcurrency = positiveInteger("sharp-concurrency", 4);
const calibrationLimit = positiveInteger("calibration", 24);
const qualitySampleLimit = positiveInteger("quality-samples", 128);
const decodeRounds = positiveInteger("decode-rounds", 1);
const webpQuality = positiveInteger("webp-quality", 80);
const webpEffort = Number(arg("webp-effort", "4"));
const avifEffort = Number(arg("avif-effort", "4"));
const sizes = integerList("sizes", "300,700");
const avifCandidates = integerList("avif-candidates", "35,40,45,50,55,60,65,70,75,80")
  .filter((value) => value >= 1 && value <= 100);
const requestedAvifQuality = arg("avif-quality", "auto")!;
const requestedAvifQualities = arg("avif-qualities")
  ?.split(",")
  .map(Number);
const outputRoot = resolve(arg("output", `.tmp/thumbnail-codec-benchmark-${Date.now()}`)!);
const resultsPath = resolve(arg("results", join(outputRoot, "results.json"))!);
const extensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

if (sizes.length !== 2 || sizes.some((value) => value < 1)) {
  throw new Error("--sizes must contain the two positive thumbnail tier sizes");
}
if (webpQuality > 100) throw new Error("--webp-quality must be between 1 and 100");
if (!Number.isInteger(webpEffort) || webpEffort < 0 || webpEffort > 6) {
  throw new Error("--webp-effort must be between 0 and 6");
}
if (!Number.isInteger(avifEffort) || avifEffort < 0 || avifEffort > 9) {
  throw new Error("--avif-effort must be between 0 and 9");
}
if (avifCandidates.length === 0) throw new Error("--avif-candidates must contain qualities between 1 and 100");
if (requestedAvifQuality !== "auto") {
  const quality = Number(requestedAvifQuality);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new Error("--avif-quality must be auto or an integer between 1 and 100");
  }
}
if (requestedAvifQualities && (
  requestedAvifQualities.length !== sizes.length
  || requestedAvifQualities.some((quality) => !Number.isInteger(quality) || quality < 1 || quality > 100)
)) {
  throw new Error("--avif-qualities must contain one quality between 1 and 100 for each --sizes value");
}

const tierForSize = (size: number, index: number): Tier => {
  if (sizes.length === 2 && sizes[0] === 300 && sizes[1] === 700) return index === 0 ? "sm" : "lg";
  return size === Math.min(...sizes) ? "sm" : "lg";
};

const glob = new Bun.Glob("**/*");
const corpusFiles: string[] = [];
for await (const path of glob.scan({ cwd: corpus, absolute: true, onlyFiles: true })) {
  if (extensions.has(extname(path).toLowerCase())) corpusFiles.push(path);
}
corpusFiles.sort();
if (corpusFiles.length === 0) throw new Error(`No supported images found under ${corpus}`);
const files = evenlySample(corpusFiles, limit);

sharp.concurrency(sharpConcurrency);
sharp.cache({ memory: 64, files: 128, items: 256 });

mkdirSync(outputRoot, { recursive: true });
for (const codec of ["webp", "avif"] as const) mkdirSync(join(outputRoot, codec), { recursive: true });

async function preprocess(path: string, size: number): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .resize(size, size, { fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: 4 };
}

async function encode(raw: RawImage, codec: Codec, avifQuality: number): Promise<Buffer> {
  const pipeline = sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels },
  });
  if (codec === "webp") {
    return pipeline.webp({ quality: webpQuality, effort: webpEffort }).toBuffer();
  }
  return pipeline.avif({
    quality: avifQuality,
    effort: avifEffort,
    chromaSubsampling: "4:2:0",
  }).toBuffer();
}

async function decodePixels(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer).ensureAlpha().raw().toBuffer();
}

console.log(JSON.stringify({
  corpus,
  corpusImages: corpusFiles.length,
  sampledImages: files.length,
  sampleMethod: "evenly spaced over lexicographically sorted paths",
  sizes,
  webp: { quality: webpQuality, effort: webpEffort },
  avif: {
    quality: requestedAvifQualities ?? requestedAvifQuality,
    candidates: requestedAvifQuality === "auto" && !requestedAvifQualities ? avifCandidates : undefined,
    effort: avifEffort,
    chromaSubsampling: "4:2:0",
  },
  concurrency,
  sharpConcurrency,
  decodeRounds,
  outputRoot,
}, null, 2));

async function calibrateAvifQuality() {
  if (requestedAvifQualities) {
    return {
      selectedQualities: Object.fromEntries(sizes.map((size, index) => [
        tierForSize(size, index),
        requestedAvifQualities[index]!,
      ])) as Record<Tier, number>,
      method: "explicit per tier" as const,
      sampleImages: 0,
      webpPsnr: null,
      candidates: [],
    };
  }
  if (requestedAvifQuality !== "auto") {
    return {
      selectedQualities: { sm: Number(requestedAvifQuality), lg: Number(requestedAvifQuality) },
      method: "explicit" as const,
      sampleImages: 0,
      webpPsnr: null,
      candidates: [],
    };
  }

  const calibrationFiles = evenlySample(files, Math.min(calibrationLimit, files.length));
  const webpAccumulators = new Map<Tier, QualityAccumulator>();
  const candidateAccumulators = new Map<string, QualityAccumulator>();
  const candidateBytes = new Map<string, number>();
  for (const tier of ["sm", "lg"] as const) {
    webpAccumulators.set(tier, { samples: 0, values: 0, squaredError: 0 });
    for (const quality of avifCandidates) {
      candidateAccumulators.set(`${tier}:${quality}`, { samples: 0, values: 0, squaredError: 0 });
      candidateBytes.set(`${tier}:${quality}`, 0);
    }
  }

  console.log(`Calibrating AVIF quality on ${calibrationFiles.length} images x ${sizes.length} tiers...`);
  for (let fileIndex = 0; fileIndex < calibrationFiles.length; fileIndex++) {
    const path = calibrationFiles[fileIndex]!;
    for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
      const size = sizes[sizeIndex]!;
      const tier = tierForSize(size, sizeIndex);
      const raw = await preprocess(path, size);
      const webp = await encode(raw, "webp", 50);
      const webpDecoded = await decodePixels(webp);
      const webpAccumulator = webpAccumulators.get(tier)!;
      webpAccumulator.samples++;
      webpAccumulator.values += raw.data.byteLength;
      webpAccumulator.squaredError += squaredError(raw.data, webpDecoded);

      for (const quality of avifCandidates) {
        const avif = await encode(raw, "avif", quality);
        const decoded = await decodePixels(avif);
        const key = `${tier}:${quality}`;
        const accumulator = candidateAccumulators.get(key)!;
        accumulator.samples++;
        accumulator.values += raw.data.byteLength;
        accumulator.squaredError += squaredError(raw.data, decoded);
        candidateBytes.set(key, candidateBytes.get(key)! + avif.byteLength);
      }
    }
    console.error(`Calibration ${fileIndex + 1}/${calibrationFiles.length}`);
  }

  const candidates = (["sm", "lg"] as const).flatMap((tier) => {
    const webpPsnr = psnr(webpAccumulators.get(tier)!);
    return avifCandidates.map((quality) => {
      const key = `${tier}:${quality}`;
      const accumulator = candidateAccumulators.get(key)!;
      return {
        tier,
        quality,
        psnr: psnr(accumulator),
        psnrDelta: psnr(accumulator) - webpPsnr,
        meanBytes: candidateBytes.get(key)! / accumulator.samples,
      };
    });
  });
  const selectedQualities = Object.fromEntries((["sm", "lg"] as const).map((tier) => {
    const selected = candidates
      .filter((candidate) => candidate.tier === tier)
      .sort((a, b) => Math.abs(a.psnrDelta) - Math.abs(b.psnrDelta) || a.meanBytes - b.meanBytes)[0]!;
    return [tier, selected.quality];
  })) as Record<Tier, number>;

  console.table(candidates.map((candidate) => ({
    tier: candidate.tier,
    "AVIF quality": candidate.quality,
    "PSNR (dB)": candidate.psnr.toFixed(3),
    "vs WebP (dB)": candidate.psnrDelta.toFixed(3),
    "mean bytes": candidate.meanBytes.toFixed(0),
  })));
  console.log(`Selected AVIF qualities ${JSON.stringify(selectedQualities)} for WebP q${webpQuality}.`);
  return {
    selectedQualities,
    method: "nearest per-tier aggregate RGBA PSNR to WebP" as const,
    sampleImages: calibrationFiles.length,
    webpPsnr: Object.fromEntries((["sm", "lg"] as const).map((tier) => [tier, psnr(webpAccumulators.get(tier)!)])),
    candidates,
  };
}

const calibration = await calibrateAvifQuality();
const avifQualities = calibration.selectedQualities;
const measurements: EncodeMeasurement[] = [];
const preprocessMeasurements: Array<{ tier: Tier; preprocessMs: number; pixels: number }> = [];
const qualityAccumulators = new Map<string, QualityAccumulator>();
const assetPairs: AssetPair[] = [];
const qualityIndices = new Set(
  evenlySample(Array.from({ length: files.length }, (_, index) => index), Math.min(qualitySampleLimit, files.length)),
);

let cursor = 0;
let completed = 0;
let failures = 0;
const failureSamples: Array<{ path: string; error: string }> = [];
const encodeStartedAt = performance.now();
const progress = setInterval(() => {
  const elapsedSeconds = (performance.now() - encodeStartedAt) / 1_000;
  const rate = completed / Math.max(elapsedSeconds, 0.001);
  const remainingMinutes = (files.length - completed) / Math.max(rate, 0.001) / 60;
  console.error(`Encode ${completed}/${files.length} (${rate.toFixed(2)} images/s, ETA ${remainingMinutes.toFixed(1)}m)`);
}, 10_000);

async function measureQuality(codec: Codec, tier: Tier, raw: RawImage, encoded: Buffer): Promise<void> {
  const decoded = await decodePixels(encoded);
  const key = `${codec}:${tier}`;
  const accumulator = qualityAccumulators.get(key) ?? { samples: 0, values: 0, squaredError: 0 };
  accumulator.samples++;
  accumulator.values += raw.data.byteLength;
  accumulator.squaredError += squaredError(raw.data, decoded);
  qualityAccumulators.set(key, accumulator);
}

async function processFile(index: number): Promise<void> {
  const path = files[index]!;
  try {
    for (let sizeIndex = 0; sizeIndex < sizes.length; sizeIndex++) {
      const size = sizes[sizeIndex]!;
      const tier = tierForSize(size, sizeIndex);
      const preprocessStartedAt = performance.now();
      const raw = await preprocess(path, size);
      preprocessMeasurements.push({
        tier,
        preprocessMs: performance.now() - preprocessStartedAt,
        pixels: raw.width * raw.height,
      });

      const buffers = {} as Record<Codec, Buffer>;
      const codecOrder: Codec[] = (index + sizeIndex) % 2 === 0 ? ["webp", "avif"] : ["avif", "webp"];
      for (const codec of codecOrder) {
        const startedAt = performance.now();
        const buffer = await encode(raw, codec, avifQualities[tier]);
        const encodeMs = performance.now() - startedAt;
        buffers[codec] = buffer;
        measurements.push({ codec, tier, bytes: buffer.byteLength, encodeMs, pixels: raw.width * raw.height });
      }

      const stem = `${String(index).padStart(5, "0")}-${tier}`;
      const webpPath = join(outputRoot, "webp", `${stem}.webp`);
      const avifPath = join(outputRoot, "avif", `${stem}.avif`);
      await Promise.all([Bun.write(webpPath, buffers.webp), Bun.write(avifPath, buffers.avif)]);
      assetPairs.push({
        webp: webpPath,
        avif: avifPath,
        tier,
        pixels: raw.width * raw.height,
      });

      if (qualityIndices.has(index)) {
        await Promise.all([
          measureQuality("webp", tier, raw, buffers.webp),
          measureQuality("avif", tier, raw, buffers.avif),
        ]);
      }
    }
  } catch (error) {
    failures++;
    if (failureSamples.length < 20) {
      failureSamples.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    completed++;
  }
}

async function worker(): Promise<void> {
  while (true) {
    const index = cursor++;
    if (index >= files.length) return;
    await processFile(index);
  }
}

try {
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
} finally {
  clearInterval(progress);
}
const encodeWallMs = performance.now() - encodeStartedAt;
assetPairs.sort((a, b) => a.webp.localeCompare(b.webp));

async function runBrowserDecode(): Promise<{ browserVersion: string; measurements: BrowserMeasurement[] }> {
  const assets = new Map<string, { path: string; contentType: string }>();
  const browserPairs = assetPairs.map((pair, index) => {
    const webpUrl = `/asset/${index}.webp`;
    const avifUrl = `/asset/${index}.avif`;
    assets.set(webpUrl, { path: pair.webp, contentType: "image/webp" });
    assets.set(avifUrl, { path: pair.avif, contentType: "image/avif" });
    return { webp: webpUrl, avif: avifUrl, tier: pair.tier, pixels: pair.pixels };
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const asset = assets.get(new URL(request.url).pathname);
      if (!asset) return new Response("not found", { status: 404 });
      return new Response(Bun.file(asset.path), {
        headers: { "content-type": asset.contentType, "cache-control": "public, max-age=3600" },
      });
    },
  });

  let browser: PlaywrightBrowser | undefined;
  try {
    const { chromium } = await import(PLAYWRIGHT_MODULE_PATH) as PlaywrightModule;
    browser = await chromium.launch({ headless: true });
    const browserVersion = await browser.version();
    const page = await browser.newPage();
    page.setDefaultTimeout(30 * 60 * 1_000);
    await page.goto(`http://127.0.0.1:${server.port}/asset/0.webp`);
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const browserMeasurements = await page.evaluate(async ({ pairs, rounds, origin }) => {
      const output: Array<{ codec: "webp" | "avif"; tier: "sm" | "lg"; decodeMs: number; pixels: number }> = [];

      async function decode(url: string): Promise<number> {
        const response = await fetch(origin + url);
        if (!response.ok) throw new Error(`Fetch failed for ${url}: ${response.status}`);
        const blob = await response.blob();
        const startedAt = performance.now();
        const bitmap = await createImageBitmap(blob);
        const elapsed = performance.now() - startedAt;
        bitmap.close();
        return elapsed;
      }

      for (const pair of pairs.slice(0, Math.min(8, pairs.length))) {
        await decode(pair.webp);
        await decode(pair.avif);
      }

      for (let round = 0; round < rounds; round++) {
        for (let index = 0; index < pairs.length; index++) {
          const pair = pairs[index]!;
          const order: Array<"webp" | "avif"> = (index + round) % 2 === 0
            ? ["webp", "avif"]
            : ["avif", "webp"];
          for (const codec of order) {
            output.push({
              codec,
              tier: pair.tier,
              decodeMs: await decode(pair[codec]),
              pixels: pair.pixels,
            });
          }
        }
      }
      return output;
    }, { pairs: browserPairs, rounds: decodeRounds, origin: baseUrl });
    return { browserVersion, measurements: browserMeasurements };
  } finally {
    await browser?.close();
    server.stop(true);
  }
}

console.log(`Encoding complete in ${(encodeWallMs / 1_000).toFixed(1)}s. Starting real Chromium decode...`);
const browser = await runBrowserDecode();

function encodeSummary(codec: Codec, tier?: Tier) {
  const selected = measurements.filter((item) => item.codec === codec && (!tier || item.tier === tier));
  const bytes = summarize(selected.map((item) => item.bytes));
  const times = summarize(selected.map((item) => item.encodeMs));
  const megapixels = selected.reduce((sum, item) => sum + item.pixels, 0) / 1_000_000;
  return { bytes, encodeMs: times, megapixelsPerSecond: times.total ? megapixels / (times.total / 1_000) : 0 };
}

function decodeSummary(codec: Codec, tier?: Tier) {
  const selected = browser.measurements.filter((item) => item.codec === codec && (!tier || item.tier === tier));
  const times = summarize(selected.map((item) => item.decodeMs));
  const megapixels = selected.reduce((sum, item) => sum + item.pixels, 0) / 1_000_000;
  return { decodeMs: times, megapixelsPerSecond: times.total ? megapixels / (times.total / 1_000) : 0 };
}

function qualitySummary(codec: Codec, tier?: Tier) {
  const selected = [...qualityAccumulators.entries()]
    .filter(([key]) => key.startsWith(`${codec}:`) && (!tier || key === `${codec}:${tier}`))
    .map(([, value]) => value);
  const combined = selected.reduce<QualityAccumulator>((total, value) => ({
    samples: total.samples + value.samples,
    values: total.values + value.values,
    squaredError: total.squaredError + value.squaredError,
  }), { samples: 0, values: 0, squaredError: 0 });
  return { samples: combined.samples, psnr: psnr(combined) };
}

const webp = encodeSummary("webp");
const avif = encodeSummary("avif");
const webpDecode = decodeSummary("webp");
const avifDecode = decodeSummary("avif");
const result = {
  createdAt: new Date().toISOString(),
  corpus: { path: corpus, images: corpusFiles.length, sampledImages: files.length },
  settings: {
    sizes,
    sampleMethod: "evenly spaced over lexicographically sorted paths",
    concurrency,
    sharpConcurrency,
    qualitySamples: qualityIndices.size,
    decodeRounds,
    webp: { quality: webpQuality, effort: webpEffort },
    avif: { qualities: avifQualities, effort: avifEffort, chromaSubsampling: "4:2:0" },
  },
  runtime: {
    bun: Bun.version,
    sharp: sharp.versions.sharp,
    libvips: sharp.versions.vips,
    libwebp: sharp.versions.webp,
    libaom: sharp.versions.aom,
    libheif: sharp.versions.heif,
    browser: `Chromium ${browser.browserVersion}`,
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
  },
  calibration,
  failures: { count: failures, samples: failureSamples },
  encodeWallMs,
  preprocessing: {
    all: summarize(preprocessMeasurements.map((item) => item.preprocessMs)),
    byTier: Object.fromEntries((["sm", "lg"] as const).map((tier) => [
      tier,
      summarize(preprocessMeasurements.filter((item) => item.tier === tier).map((item) => item.preprocessMs)),
    ])),
  },
  codecs: {
    webp: {
      encode: webp,
      decode: webpDecode,
      quality: qualitySummary("webp"),
      byTier: Object.fromEntries((["sm", "lg"] as const).map((tier) => [tier, {
        encode: encodeSummary("webp", tier),
        decode: decodeSummary("webp", tier),
        quality: qualitySummary("webp", tier),
      }])),
    },
    avif: {
      encode: avif,
      decode: avifDecode,
      quality: qualitySummary("avif"),
      byTier: Object.fromEntries((["sm", "lg"] as const).map((tier) => [tier, {
        encode: encodeSummary("avif", tier),
        decode: decodeSummary("avif", tier),
        quality: qualitySummary("avif", tier),
      }])),
    },
  },
  comparison: {
    avifBytesVsWebpPct: webp.bytes.total ? (avif.bytes.total / webp.bytes.total - 1) * 100 : 0,
    avifEncodeTimeVsWebp: webp.encodeMs.total ? avif.encodeMs.total / webp.encodeMs.total : 0,
    avifBrowserDecodeTimeVsWebp: webpDecode.decodeMs.total
      ? avifDecode.decodeMs.total / webpDecode.decodeMs.total
      : 0,
  },
  outputRoot,
};

mkdirSync(resolve(resultsPath, ".."), { recursive: true });
await Bun.write(resultsPath, `${JSON.stringify(result, null, 2)}\n`);

console.table([
  {
    codec: `WebP q${webpQuality}`,
    "total MiB": (webp.bytes.total / 1024 / 1024).toFixed(2),
    "mean KiB": (webp.bytes.mean / 1024).toFixed(2),
    "encode ms/img": webp.encodeMs.mean.toFixed(2),
    "encode MP/s": webp.megapixelsPerSecond.toFixed(2),
    "decode ms/img": webpDecode.decodeMs.mean.toFixed(3),
    "decode MP/s": webpDecode.megapixelsPerSecond.toFixed(2),
    "PSNR dB": qualitySummary("webp").psnr.toFixed(3),
  },
  {
    codec: avifQualities.sm === avifQualities.lg
      ? `AVIF q${avifQualities.sm}`
      : `AVIF q${avifQualities.sm}/${avifQualities.lg}`,
    "total MiB": (avif.bytes.total / 1024 / 1024).toFixed(2),
    "mean KiB": (avif.bytes.mean / 1024).toFixed(2),
    "encode ms/img": avif.encodeMs.mean.toFixed(2),
    "encode MP/s": avif.megapixelsPerSecond.toFixed(2),
    "decode ms/img": avifDecode.decodeMs.mean.toFixed(3),
    "decode MP/s": avifDecode.megapixelsPerSecond.toFixed(2),
    "PSNR dB": qualitySummary("avif").psnr.toFixed(3),
  },
]);
console.log(JSON.stringify(result.comparison, null, 2));
console.log(`Detailed results: ${resultsPath}`);
