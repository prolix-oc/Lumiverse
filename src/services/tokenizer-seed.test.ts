import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { seedTokenizers } from "./tokenizer-seed";
import { _resetForTests, getConfig, getTokenizerIdForModel } from "./tokenizer.service";

function createTokenizerTables(): void {
  getDb().run(`CREATE TABLE tokenizer_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    config TEXT NOT NULL,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
  getDb().run(`CREATE TABLE tokenizer_model_patterns (
    id TEXT PRIMARY KEY,
    tokenizer_id TEXT NOT NULL,
    pattern TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 0,
    is_built_in INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
}

beforeEach(() => {
  closeDatabase();
  initDatabase(":memory:");
  createTokenizerTables();
  _resetForTests();
  seedTokenizers();
});

afterEach(() => closeDatabase());

describe("built-in tokenizer defaults", () => {
  test("resolves Kimi K3 and GLM 5.3 to their dedicated current tokenizers", () => {
    expect(getConfig("kimi-k3")?.config.url).toBe(
      "https://huggingface.co/moonshotai/Kimi-K3/resolve/main/tiktoken.model",
    );
    expect(getTokenizerIdForModel("moonshotai/kimi-k3")).toBe("kimi-k3");
    expect(getTokenizerIdForModel("glm-5.2")).toBe("glm-5-2");
    expect(getTokenizerIdForModel("z-ai/glm-5.3")).toBe("glm-5-2");
  });

  test("continues to resolve dated DeepSeek V4 release identifiers", () => {
    expect(getTokenizerIdForModel("deepseek-v4-pro-0813")).toBe("deepseek-v4-pro");
    expect(getTokenizerIdForModel("deepseek-ai/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash");
  });
});
