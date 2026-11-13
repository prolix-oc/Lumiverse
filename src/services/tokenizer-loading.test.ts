import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { initDatabase, closeDatabase, getDb } from "../db/connection";
import { tokenizerFingerprint } from "./tokenizer-resource-cache";
import type { TokenizerResource } from "./tokenizer-resource-cache";

const tokens = Array.from({ length: 256 }, (_, i) => Buffer.from([i]).toString("base64"));
const bpe = `! 0 ${tokens.join(" ")} YWI=`;
let requested: string[] = [];
let discarded: string[] = [];
let read: (url: string) => Promise<TokenizerResource>;
const payload = (text = bpe): TokenizerResource => ({ text, source: "network", expiresAt: Date.now() + 60_000 });
mock.module("./tokenizer-resource-cache", () => ({ tokenizerFingerprint,
  readTokenizerResource: (url: string) => { requested.push(url); return read(url); },
  discardTokenizerResource: async (url: string) => { discarded.push(url); },
}));
const service = await import("./tokenizer.service");

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  getDb().exec(readFileSync(new URL("../db/migrations/022_tokenizers.sql", import.meta.url), "utf8"));
  requested = [];
  discarded = [];
  read = async () => payload();
  getDb().query("INSERT INTO tokenizer_configs (id, name, type, config) VALUES ('test', 'Test', 'tiktoken', ?)")
    .run(JSON.stringify({ url: "https://example.com/model", pat_str: ".+" }));
  getDb().exec("INSERT INTO tokenizer_model_patterns (id, tokenizer_id, pattern) VALUES ('test', 'test', '^model$')");
});
afterEach(closeDatabase);

describe("tokenizer loading lifecycle", () => {
  test("an unusable vocabulary is discarded so the next retry can recover", async () => {
    read = async () => payload("<html>temporary upstream error</html>");
    expect((await service.resolveCounter("model")).name).toBe("approximate");
    expect(discarded).toEqual(["https://example.com/model"]);
    read = async () => payload();
    service.invalidate("test");
    expect((await service.resolveCounter("model")).count("ab")).toBe(1);
  });

  test("concurrent counts share a load and a memo hit survives instance eviction", async () => {
    const result = await Promise.all(Array.from({ length: 8 }, () => service.countWithTokenizer("test", "ab")));
    expect(result).toEqual(Array(8).fill(1));
    expect(requested).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      const id = `other-${i}`;
      getDb().query("INSERT INTO tokenizer_configs (id, name, type) VALUES (?, ?, 'approximate')").run(id, id);
      await service.countWithTokenizer(id, "abc");
    }
    expect(service.getCachedTokenizerIds()).not.toContain("test");
    expect(await service.countWithTokenizer("test", "ab")).toBe(1);
    expect(requested).toHaveLength(1);
    expect(await service.countWithTokenizer("test", "abc")).toBe(2);
    expect(requested).toHaveLength(2);
  });

  test("failed loads use a cooldown that explicit invalidation clears", async () => {
    read = async () => { throw new Error("offline"); };
    expect((await service.resolveCounter("model")).name).toBe("approximate");
    const fallback = await service.resolveCounter("model");
    expect(fallback.metrics.instance).toBe("cooldown");
    expect(requested).toHaveLength(1);
    read = async () => payload();
    service.invalidate("test");
    expect((await service.resolveCounter("model")).name).toBe("Test");
    expect(requested).toHaveLength(2);
  });

  test("config invalidation during a download cannot publish the old encoding", async () => {
    let finish!: (value: TokenizerResource) => void;
    read = () => new Promise(resolve => { finish = resolve; });
    const pending = service.countWithTokenizer("test", "ab");
    await Promise.resolve();
    getDb().exec("UPDATE tokenizer_configs SET type = 'approximate', config = '{\"charsPerToken\":1}' WHERE id = 'test'");
    service.invalidate("test");
    finish(payload());
    expect(await pending).toBe(2);
    expect(await service.countWithTokenizer("test", "ab")).toBe(2);
  });

  test("memory release while loading does not refill the instance cache", async () => {
    let finish!: (value: TokenizerResource) => void;
    read = () => new Promise(resolve => { finish = resolve; });
    const pending = service.resolveCounter("model");
    await Promise.resolve();
    service.releaseTokenizerMemory();
    finish(payload());
    expect((await pending).count("ab")).toBe(1);
    expect(service.getCachedTokenizerIds()).toEqual([]);
  });

  test("model and optional config loads overlap, and changed artifacts do not reuse old counts", async () => {
    getDb().query("UPDATE tokenizer_configs SET config = ? WHERE id = 'test'")
      .run(JSON.stringify({ url: "https://example.com/model", configUrl: "https://example.com/config", pat_str: ".+" }));
    const finishes = new Map<string, (resource: TokenizerResource) => void>();
    read = url => new Promise(resolve => finishes.set(url, resolve));
    const pending = service.countWithTokenizer("test", "ab");
    await Promise.resolve();
    expect(requested).toHaveLength(2);
    finishes.get("https://example.com/model")!(payload());
    finishes.get("https://example.com/config")!(payload("{}"));
    expect(await pending).toBe(1);
    // Expire the artifact lease on construction so a subsequent resolution
    // must load the changed vocabulary and count against its content revision.
    service.invalidate("test");
    read = async url => ({ ...payload(url.endsWith("config") ? "{}" : bpe), expiresAt: 0 });
    expect(await service.countWithTokenizer("test", "ab")).toBe(1);
    read = async url => payload(url.endsWith("config") ? "{}" : `! 0 ${tokens.join(" ")}`);
    expect(await service.countWithTokenizer("test", "ab")).toBe(2);
  });
});
