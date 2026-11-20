import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenizerResourceCache, tokenizerFingerprint, releaseTokenizerResourceLocks } from "./tokenizer-resource-cache";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "lumiverse-tokenizer-cache-"));
  directories.push(path);
  return path;
}
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });

describe("tokenizer resource cache", () => {
  test("discarding an unusable resource permits a retry without deleting a newer replacement", async () => {
    let text = "unusable vocabulary";
    const cache = new TokenizerResourceCache({ directory: await directory(), fetchText: async () => text });
    await cache.read("https://example.com/model", "v1");
    await cache.discard("https://example.com/model", "v1", text);
    text = "recovered";
    expect((await cache.read("https://example.com/model", "v1")).text).toBe(text);
    await cache.discard("https://example.com/model", "v1", "unusable vocabulary");
    expect((await cache.read("https://example.com/model", "v1")).source).toBe("disk");
  });

  test("a terminated worker's lease is released immediately for the next runtime", async () => {
    const path = await directory();
    const owner = crypto.randomUUID();
    const worker = new Worker(new URL("./test-fixtures/tokenizer-cache-worker.ts", import.meta.url));
    try {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = event => { if (event.data === "locked") resolve(); };
        worker.onerror = event => reject(new Error(event.message));
        worker.postMessage({ directory: path, owner });
      });
    } finally { worker.terminate(); }
    await releaseTokenizerResourceLocks(owner, path);
    expect((await readdir(path)).some(name => name.endsWith(".lock"))).toBe(false);
    const next = new TokenizerResourceCache({ directory: path, fetchText: async () => "next-worker" });
    expect((await next.read("https://example.com/model", "v1")).text).toBe("next-worker");
  });

  test("malformed JSON is not committed to the persistent cache", async () => {
    const path = await directory();
    let text = "not json";
    const cache = new TokenizerResourceCache({ directory: path, fetchText: async () => text });
    await expect(cache.read("https://example.com/config", "v1", "json")).rejects.toThrow();
    expect((await readdir(path)).some(name => name.endsWith(".cache"))).toBe(false);
    text = "{}";
    expect((await cache.read("https://example.com/config", "v1", "json")).text).toBe("{}");
  });
  test("coalesces concurrent loads across cache instances and survives a fresh runtime", async () => {
    const path = await directory();
    let requests = 0;
    const options = { directory: path, fetchText: async () => { requests++; await Bun.sleep(40); return "vocabulary"; } };
    const a = new TokenizerResourceCache(options);
    const b = new TokenizerResourceCache(options);
    const result = await Promise.all([a.read("https://example.com/model", "v1"), a.read("https://example.com/model", "v1"), b.read("https://example.com/model", "v1")]);
    expect(requests).toBe(1);
    expect(result.map(r => r.text)).toEqual(["vocabulary", "vocabulary", "vocabulary"]);
    const restarted = new TokenizerResourceCache({ directory: path, fetchText: async () => { throw new Error("offline"); } });
    expect((await restarted.read("https://example.com/model", "v1")).source).toBe("disk");
  });

  test("config and auth changes isolate resources, and fingerprints ignore object key order", async () => {
    expect(tokenizerFingerprint({ type: "hf", config: { a: 1, b: 2 } })).toBe(tokenizerFingerprint({ config: { b: 2, a: 1 }, type: "hf" }));
    let auth = "first";
    let requests = 0;
    const cache = new TokenizerResourceCache({ directory: await directory(), headers: async () => ({ authorization: auth }), fetchText: async () => String(++requests) });
    expect((await cache.read("https://example.com/model", "v1")).text).toBe("1");
    expect((await cache.read("https://example.com/model", "v2")).text).toBe("2");
    auth = "second";
    expect((await cache.read("https://example.com/model", "v2")).text).toBe("3");
    expect((await cache.read("https://example.com/model", "v2")).source).toBe("disk");
    expect(requests).toBe(3);
  });

  test("expired or truncated cache files are fetched again", async () => {
    const path = await directory();
    let requests = 0;
    const options = { directory: path, fetchText: async () => String(++requests) };
    const expired = new TokenizerResourceCache({ ...options, ttlMs: -1 });
    await expired.read("https://example.com/model", "v1");
    const cache = new TokenizerResourceCache(options);
    expect((await cache.read("https://example.com/model", "v1")).text).toBe("2");
    const filename = (await readdir(path)).find(name => name.endsWith(".cache"))!;
    await writeFile(join(path, filename), "truncated");
    expect((await cache.read("https://example.com/model", "v1")).text).toBe("3");
  });

  test("a hung fetch times out and releases its pending load and disk lock", async () => {
    const path = await directory();
    let signal: AbortSignal | undefined;
    let hangs = true;
    const cache = new TokenizerResourceCache({ directory: path, timeoutMs: 20, fetchText: async (_url, _headers, s) => {
      signal = s;
      return hangs ? new Promise<string>(() => {}) : "recovered";
    } });
    await expect(cache.read("https://example.com/model", "v1")).rejects.toThrow();
    expect(signal?.aborted).toBe(true);
    expect((await readdir(path)).some(name => name.endsWith(".lock"))).toBe(false);
    hangs = false;
    expect((await cache.read("https://example.com/model", "v1")).text).toBe("recovered");
    await expect(cache.read("file:///etc/passwd", "v1")).rejects.toThrow();
  });
});
