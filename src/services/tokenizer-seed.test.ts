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
  test("seeds and resolves the current MiMo and MiniMax Hugging Face tokenizers", () => {
    expect(getConfig("mimo-v2-5")?.config.url).toBe(
      "https://huggingface.co/XiaomiMiMo/MiMo-V2.5/resolve/main/tokenizer.json",
    );
    expect(getConfig("mimo-v2-5-pro")?.config.url).toBe(
      "https://huggingface.co/XiaomiMiMo/MiMo-V2.5-Pro/resolve/main/tokenizer.json",
    );
    expect(getConfig("minimax-m3")?.config.url).toBe(
      "https://huggingface.co/MiniMaxAI/MiniMax-M3/resolve/main/tokenizer.json",
    );

    expect(getTokenizerIdForModel("XiaomiMiMo/MiMo-V2.5")).toBe("mimo-v2-5");
    expect(getTokenizerIdForModel("mimo-v2.5-pro")).toBe("mimo-v2-5-pro");
    expect(getTokenizerIdForModel("MiniMaxAI/MiniMax-M3")).toBe("minimax-m3");
  });

  test.each(["pro", "flash"])("resolves MiMo V2.6 %s API and checkpoint identifiers", (variant) => {
    const tokenizerId = `mimo-v2-6-${variant}`;
    for (const modelId of [
      `mimo-v2.6-${variant}`,
      `xiaomi/mimo-v2.6-${variant}`,
      `XiaomiMiMo/MiMo-V2.6-${variant}-RL`,
      `XiaomiMiMo/MiMo-V2.6-${variant}-MOPD`,
      `mimo-v2-6-${variant}`,
      `mimov2.6.${variant}`,
      `publisher:mimo-v2.6-${variant}`,
      `xiaomi.mimo-v2.6-${variant}-20260925`,
    ]) {
      expect(getTokenizerIdForModel(modelId)).toBe(tokenizerId);
    }
    expect(getConfig(tokenizerId)?.is_built_in).toBe(true);
    expect(getConfig(tokenizerId)?.type).toBe("huggingface");
  });

  test("does not route other MiMo versions or unrelated names to V2.6", () => {
    expect(getTokenizerIdForModel("xiaomi/mimo-v2.5-pro")).toBe("mimo-v2-5-pro");
    expect(getTokenizerIdForModel("xiaomi/mimo-v2.5")).toBe("mimo-v2-5");
    expect(getTokenizerIdForModel("mimo-v2.7-pro")).toBe("approximate-4");
    expect(getTokenizerIdForModel("notmimo-v2.6-flash")).toBe("approximate-4");
  });

  test("resolves DeepSeek V4.1 Flash separately from the V4 tokenizer", () => {
    expect(getConfig("deepseek-v4-1-flash")?.config.url).toBe(
      "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer.json",
    );
    expect(getTokenizerIdForModel("deepseek-ai/DeepSeek-V4.1-Flash")).toBe(
      "deepseek-v4-1-flash",
    );
    expect(getTokenizerIdForModel("deepseek-v4-1-flash")).toBe("deepseek-v4-1-flash");
  });

  test("resolves the unversioned deepseek-flash API id to the current Flash tokenizer", () => {
    for (const modelId of [
      "deepseek-flash",
      "deepseek-ai/deepseek-flash",
      "openrouter/deepseek/deepseek-flash",
      "publisher:deepseek-flash",
      "deepseek.deepseek-flash-1017",
    ]) {
      expect(getTokenizerIdForModel(modelId)).toBe("deepseek-v4-1-flash");
    }
    expect(getConfig("deepseek-v4-1-flash")?.is_built_in).toBe(true);
  });

  test("keeps versioned and unrelated DeepSeek ids off the unversioned Flash match", () => {
    expect(getTokenizerIdForModel("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(getTokenizerIdForModel("deepseek-v4.1-flash")).toBe("deepseek-v4-1-flash");
    expect(getTokenizerIdForModel("notdeepseek-flash")).toBe("approximate-4");
  });

  test("resolves Kimi K3 and GLM 5.3 to their dedicated current tokenizers", () => {
    expect(getConfig("kimi-k3")?.config.url).toBe(
      "https://huggingface.co/moonshotai/Kimi-K3/resolve/main/tiktoken.model",
    );
    expect(getTokenizerIdForModel("moonshotai/kimi-k3")).toBe("kimi-k3");
    expect(getTokenizerIdForModel("glm-5.2")).toBe("glm-5-2");
    expect(getTokenizerIdForModel("z-ai/glm-5.3")).toBe("glm-5-2");
    expect(getTokenizerIdForModel("glm-5.3-flash")).toBe("glm-5-2");
  });

  test("continues to resolve dated DeepSeek V4 release identifiers", () => {
    expect(getTokenizerIdForModel("deepseek-v4-pro-0813")).toBe("deepseek-v4-pro");
    expect(getTokenizerIdForModel("deepseek-ai/deepseek-v4-flash-0731")).toBe("deepseek-v4-flash");
  });
});
