import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHAT_MEMORY_SETTINGS,
  getWorldBookVectorWriteFingerprint,
  normalizeChatMemorySettings,
} from "./embeddings.service";

describe("normalizeChatMemorySettings", () => {
  test("upgrades legacy default memory templates", () => {
    const normalized = normalizeChatMemorySettings({
      memoryHeaderTemplate: "Relevant context from earlier in this conversation:\n{{memories}}",
      chunkTemplate: "{{content}}",
    });

    expect(normalized.memoryHeaderTemplate).toBe(DEFAULT_CHAT_MEMORY_SETTINGS.memoryHeaderTemplate);
    expect(normalized.chunkTemplate).toBe(DEFAULT_CHAT_MEMORY_SETTINGS.chunkTemplate);
  });

  test("preserves customized memory templates", () => {
    const normalized = normalizeChatMemorySettings({
      memoryHeaderTemplate: "Custom header\n{{memories}}",
      chunkTemplate: "Custom chunk: {{content}}",
    });

    expect(normalized.memoryHeaderTemplate).toBe("Custom header\n{{memories}}");
    expect(normalized.chunkTemplate).toBe("Custom chunk: {{content}}");
  });
});

describe("getWorldBookVectorWriteFingerprint", () => {
  test("changes when world-book write-relevant embedding config changes", () => {
    const base = getWorldBookVectorWriteFingerprint({
      enabled: true,
      vectorize_world_books: true,
      provider: "openai_compat",
      model: "text-embedding-3-small",
      dimensions: 1536,
      api_url: "https://example.test/v1",
      vertex_region: "",
    });

    expect(base).toBe(getWorldBookVectorWriteFingerprint({
      enabled: true,
      vectorize_world_books: true,
      provider: "openai_compat",
      model: "text-embedding-3-small",
      dimensions: 1536,
      api_url: "https://example.test/v1",
      vertex_region: "",
    }));
    expect(base).not.toBe(getWorldBookVectorWriteFingerprint({
      enabled: false,
      vectorize_world_books: true,
      provider: "openai_compat",
      model: "text-embedding-3-small",
      dimensions: 1536,
      api_url: "https://example.test/v1",
      vertex_region: "",
    }));
    expect(base).not.toBe(getWorldBookVectorWriteFingerprint({
      enabled: true,
      vectorize_world_books: false,
      provider: "openai_compat",
      model: "text-embedding-3-small",
      dimensions: 1536,
      api_url: "https://example.test/v1",
      vertex_region: "",
    }));
    expect(base).not.toBe(getWorldBookVectorWriteFingerprint({
      enabled: true,
      vectorize_world_books: true,
      provider: "openai_compat",
      model: "text-embedding-3-large",
      dimensions: 1536,
      api_url: "https://example.test/v1",
      vertex_region: "",
    }));
  });
});
