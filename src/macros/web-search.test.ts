import { beforeAll, describe, expect, test } from "bun:test";
import { evaluate } from "./MacroEvaluator";
import { initMacros } from "./index";
import { registry } from "./MacroRegistry";
import type { MacroEnv } from "./types";
import { INLINE_WEB_SEARCH_CONTEXT_SLOT_MARKER } from "../services/inline-web-search";

beforeAll(() => initMacros());

function makeEnv(promptBlock?: MacroEnv["promptBlock"]): MacroEnv {
  return {
    commit: true,
    names: {} as MacroEnv["names"],
    character: {} as MacroEnv["character"],
    chat: {} as MacroEnv["chat"],
    system: {} as MacroEnv["system"],
    variables: { local: new Map(), global: new Map(), chat: new Map() },
    dynamicMacros: {},
    extra: {},
    ...(promptBlock ? { promptBlock } : {}),
  };
}

describe("webSearchContext macro", () => {
  test("creates an internal slot only while rendering a preset block", async () => {
    const inBlock = await evaluate(
      "before {{webSearchContext}} after",
      makeEnv({ id: "block-1", role: "system", position: "relative", depth: 0 }),
      registry,
    );
    const outsideBlock = await evaluate("{{webSearchContext}}", makeEnv(), registry);

    expect(inBlock.text).toBe(`before ${INLINE_WEB_SEARCH_CONTEXT_SLOT_MARKER} after`);
    expect(outsideBlock.text).toBe("");
  });
});
