/**
 * Exercise Whistle's published WASM runtime without changing Lumiverse's STT providers.
 * See developer-docs/docs/research/whistle-stt.md for pinned asset download commands.
 *
 * bun run scripts/whistle-smoke.ts <asset-directory> [16-kHz-mono-PCM16.wav]
 */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";

interface NeedleRuntime {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  _needle_load(pointer: number, size: bigint): number;
  _needle_models(): number;
  _needle_last_error(): number;
  _needle_transcribe(pcm: number, samples: number, language: number, keywords: number,
    timestamps: number, output: number, capacity: number): number;
  UTF8ToString(pointer: number): string;
}

interface Transcript {
  text: string;
  language: string;
  ttft_ms: number;
  decode_tps: number;
  words?: Array<{ word: string; start: number; end: number; probability: number }>;
}

const [assetDirectory, wavPath] = process.argv.slice(2);
if (!assetDirectory) {
  throw new Error("Usage: bun run scripts/whistle-smoke.ts <asset-directory> [16-kHz-mono-PCM16.wav]");
}

function readPcm16Wav(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => new TextDecoder().decode(bytes.subarray(offset, offset + 4));
  assert.equal(tag(0), "RIFF", "Expected a RIFF WAV fixture");
  assert.equal(tag(8), "WAVE", "Expected a WAV fixture");
  let formatFound = false;
  let samples: Float32Array | undefined;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    assert.ok(start + size <= bytes.length, "Truncated WAV chunk");
    if (tag(offset) === "fmt ") {
      assert.ok(size >= 16, "Truncated WAV format");
      assert.equal(view.getUint16(start, true), 1, "Fixture must contain integer PCM");
      assert.equal(view.getUint16(start + 2, true), 1, "Fixture must be mono");
      assert.equal(view.getUint32(start + 4, true), 16000, "Fixture must be 16 kHz");
      assert.equal(view.getUint16(start + 14, true), 16, "Fixture must be PCM16");
      formatFound = true;
    } else if (tag(offset) === "data") {
      assert.equal(size % 2, 0, "Incomplete PCM16 sample");
      samples = new Float32Array(size / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(start + i * 2, true) / 32768;
    }
    offset = start + size + (size % 2);
  }
  assert.ok(formatFound && samples, "Missing WAV format or audio data");
  assert.ok(samples.length > 0 && samples.length <= 480000, "Fixture must be 0–30 seconds");
  return samples;
}

const assets = await Promise.all(["needle.js", "needle.wasm", "whistle.cact"].map(async (name) => {
  const bytes = new Uint8Array(await Bun.file(resolve(assetDirectory, name)).arrayBuffer());
  return { name, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}));
const require = createRequire(import.meta.url);
const createNeedle = require(resolve(assetDirectory, "needle.js")) as
  (options: { wasmBinary: Uint8Array }) => Promise<NeedleRuntime>;
const runtimeStarted = performance.now();
const runtime = await createNeedle({ wasmBinary: assets[1]!.bytes });
const runtimeMs = performance.now() - runtimeStarted;
const model = assets[2]!.bytes;
const modelPointer = runtime._malloc(model.length);
assert.ok(modelPointer, "Model allocation failed");
let loadMs: number;
try {
  runtime.HEAPU8.set(model, modelPointer);
  const started = performance.now();
  const code = runtime._needle_load(modelPointer, BigInt(model.length));
  loadMs = performance.now() - started;
  assert.ok(code >= 0, runtime.UTF8ToString(runtime._needle_last_error()));
  assert.equal(runtime._needle_models(), 2, "Expected only the speech model to be loaded");
} finally {
  runtime._free(modelPointer);
}

function transcribe(pcm: Float32Array, language?: string, timestamps = false, keywords?: string) {
  const allocations: number[] = [];
  const allocate = (size: number) => {
    const pointer = runtime._malloc(Math.max(1, size));
    assert.ok(pointer, "WASM allocation failed");
    allocations.push(pointer);
    return pointer;
  };
  const string = (value?: string) => {
    if (!value) return 0;
    const bytes = new TextEncoder().encode(value + "\0");
    const pointer = allocate(bytes.length);
    runtime.HEAPU8.set(bytes, pointer);
    return pointer;
  };
  try {
    const pcmPointer = allocate(pcm.byteLength);
    const capacity = 1 << 18;
    const outputPointer = allocate(capacity);
    const languagePointer = string(language);
    const keywordsPointer = string(keywords);
    // Allocations can grow WASM memory and detach old views. Acquire the view last.
    new Float32Array(runtime.HEAPU8.buffer, pcmPointer, pcm.length).set(pcm);
    const started = performance.now();
    const code = runtime._needle_transcribe(pcmPointer, pcm.length, languagePointer, keywordsPointer,
      Number(timestamps), outputPointer, capacity);
    const wallMs = performance.now() - started;
    if (code < 0) {
      return { code, wallMs, error: runtime.UTF8ToString(runtime._needle_last_error()) };
    }
    const result = JSON.parse(runtime.UTF8ToString(outputPointer)) as Transcript;
    assert.equal(typeof result.text, "string");
    assert.equal(typeof result.language, "string");
    assert.ok(Number.isFinite(result.ttft_ms) && result.ttft_ms >= 0);
    assert.ok(Number.isFinite(result.decode_tps) && result.decode_tps >= 0);
    return { code, wallMs, result };
  } finally {
    for (const pointer of allocations.reverse()) runtime._free(pointer);
  }
}

const silence = transcribe(new Float32Array(16000));
assert.equal(silence.result?.text, "", silence.error);
assert.equal(silence.result?.language, "", "Silence should not detect a language");
const limit = transcribe(new Float32Array(480000));
assert.equal(limit.result?.text, "", limit.error);
const tooLong = transcribe(new Float32Array(480001));
assert.ok(tooLong.code < 0 && /30 s/.test(tooLong.error || ""), "Expected an explicit 30-second error");
const report: Record<string, unknown> = {
  runtime: { bun: Bun.version, platform: process.platform, arch: process.arch },
  assets: assets.map(({ name, bytes, sha256 }) => ({ name, bytes: bytes.length, sha256 })),
  runtimeMs, loadMs,
  silence, limit, tooLong,
};

if (wavPath) {
  const pcm = readPcm16Wav(new Uint8Array(await Bun.file(wavPath).arrayBuffer()));
  const speech = transcribe(pcm, "en", true, "Lumiverse");
  assert.ok(speech.result, speech.error);
  assert.ok(speech.result.text.trim(), "Expected speech in the fixture");
  assert.equal(speech.result.language, "en");
  assert.ok(speech.result.words?.length, "Expected word timestamps");
  let previousStart = 0;
  for (const word of speech.result.words) {
    assert.ok(word.start >= previousStart && word.start >= 0 && word.start <= word.end);
    assert.ok(word.end <= pcm.length / 16000 + 0.02 && word.probability >= 0 && word.probability <= 1);
    previousStart = word.start;
  }
  const detected = transcribe(pcm);
  assert.ok(detected.result, detected.error);
  assert.ok(detected.result.text.trim(), "Expected speech in the fixture");
  assert.equal(detected.result.language, "en");
  // Report invalid-language behavior; adapters must enforce their own supported-language list.
  const unsupportedLanguage = transcribe(pcm, "ja");
  report.fixture = { path: resolve(wavPath), seconds: pcm.length / 16000, speech, detected, unsupportedLanguage };
}
report.heapBytes = runtime.HEAPU8.buffer.byteLength;
report.sharedMemory = runtime.HEAPU8.buffer instanceof SharedArrayBuffer;
console.log(JSON.stringify(report, null, 2));
