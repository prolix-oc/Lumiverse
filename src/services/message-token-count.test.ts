import { describe, expect, test } from "bun:test";
import {
  computeMessageTokenCount,
  type MessageTokenCountDeps,
} from "./message-token-count";

function makeDeps(over: Partial<MessageTokenCountDeps> = {}): MessageTokenCountDeps {
  return {
    isEnabled: () => true,
    resolveModel: () => "gpt-4",
    countForModel: async () => 7,
    ...over,
  };
}

describe("computeMessageTokenCount", () => {
  test("returns the tokenizer count for resolvable content", async () => {
    const result = await computeMessageTokenCount("u1", "hello world", undefined, makeDeps());
    expect(result).toBe(7);
  });

  test("passes content and resolved model through to the counter", async () => {
    let seenModel: string | undefined;
    let seenText: string | undefined;
    const deps = makeDeps({
      resolveModel: () => "claude-3",
      countForModel: async (model, text) => {
        seenModel = model;
        seenText = text;
        return text.length;
      },
    });
    const result = await computeMessageTokenCount("u1", "abcd", undefined, deps);
    expect(seenModel).toBe("claude-3");
    expect(seenText).toBe("abcd");
    expect(result).toBe(4);
  });

  test("forwards an explicit connectionId to model resolution", async () => {
    let seenUser: string | undefined;
    let seenConn: string | undefined;
    const deps = makeDeps({
      resolveModel: (userId, connectionId) => {
        seenUser = userId;
        seenConn = connectionId;
        return "gpt-4";
      },
    });
    await computeMessageTokenCount("u9", "hi", "conn-123", deps);
    expect(seenUser).toBe("u9");
    expect(seenConn).toBe("conn-123");
  });

  test("returns undefined and skips work when token counts are disabled", async () => {
    let resolved = false;
    let counted = false;
    const deps = makeDeps({
      isEnabled: () => false,
      resolveModel: () => {
        resolved = true;
        return "gpt-4";
      },
      countForModel: async () => {
        counted = true;
        return 5;
      },
    });
    expect(await computeMessageTokenCount("u1", "hello", undefined, deps)).toBeUndefined();
    expect(resolved).toBe(false);
    expect(counted).toBe(false);
  });

  test("computes when token counts are enabled", async () => {
    const deps = makeDeps({ isEnabled: () => true, countForModel: async () => 12 });
    expect(await computeMessageTokenCount("u1", "hello", undefined, deps)).toBe(12);
  });

  test("swallows errors from the enabled check", async () => {
    const deps = makeDeps({
      isEnabled: () => {
        throw new Error("settings store down");
      },
    });
    expect(await computeMessageTokenCount("u1", "text", undefined, deps)).toBeUndefined();
  });

  test("returns undefined for empty content without touching the tokenizer", async () => {
    let counted = false;
    const deps = makeDeps({
      countForModel: async () => {
        counted = true;
        return 5;
      },
    });
    expect(await computeMessageTokenCount("u1", "", undefined, deps)).toBeUndefined();
    expect(counted).toBe(false);
  });

  test("returns undefined when no model can be resolved", async () => {
    expect(
      await computeMessageTokenCount("u1", "text", undefined, makeDeps({ resolveModel: () => null })),
    ).toBeUndefined();
    expect(
      await computeMessageTokenCount("u1", "text", undefined, makeDeps({ resolveModel: () => undefined })),
    ).toBeUndefined();
  });

  test("returns undefined when the model has no matching tokenizer", async () => {
    const deps = makeDeps({ countForModel: async () => null });
    expect(await computeMessageTokenCount("u1", "text", undefined, deps)).toBeUndefined();
  });

  test("swallows tokenizer errors so message persistence is never blocked", async () => {
    const deps = makeDeps({
      countForModel: async () => {
        throw new Error("tokenizer exploded");
      },
    });
    expect(await computeMessageTokenCount("u1", "text", undefined, deps)).toBeUndefined();
  });

  test("swallows model-resolution errors", async () => {
    const deps = makeDeps({
      resolveModel: () => {
        throw new Error("no connection store");
      },
    });
    expect(await computeMessageTokenCount("u1", "text", undefined, deps)).toBeUndefined();
  });

  test("treats a zero token count as a real value, not absent", async () => {
    const deps = makeDeps({ countForModel: async () => 0 });
    expect(await computeMessageTokenCount("u1", "x", undefined, deps)).toBe(0);
  });
});
