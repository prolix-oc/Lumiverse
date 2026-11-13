import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import type { AssemblyContext } from "../llm/types";
import type { Preset, PromptBlock } from "../types/preset";
import { createCharacter } from "./characters.service";
import { createChat } from "./chats.service";
import { createPreset, updatePreset } from "./presets.service";
import { setChatBinding, updateChatPromptVariables } from "./preset-profiles.service";
import { prefetchAssemblyData } from "./prompt-assembly-prefetch";
import { assemblePrompt } from "./prompt-assembly.service";

const userId = "profile-assembly-user";
let chatId: string;
let preset: Preset;

function block(overrides: Partial<PromptBlock>): PromptBlock {
  return {
    id: crypto.randomUUID(), name: "Prompt", content: "", role: "system",
    enabled: true, position: "pre_history", depth: 0, marker: null,
    isLocked: false, color: null, injectionTrigger: [], group: null,
    ...overrides,
  };
}

beforeEach(async () => {
  closeDatabase();
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  initMacros();
  const character = createCharacter(userId, { name: "Character" });
  chatId = createChat(userId, { character_id: character.id }).id;
  preset = createPreset(userId, {
    name: "Bound preset", provider: "openai",
    metadata: { promptVariables: { style: { tone: "preset tone" } } },
    prompt_order: [
      block({
        id: "style", content: "BEFORE {{var::tone}}", enabled: false,
        variables: [{ id: "tone", name: "tone", label: "Tone", type: "text", defaultValue: "default tone" }],
      }),
      block({ id: "base-only", content: "BASE_ONLY" }),
      block({ id: "history", marker: "chat_history" }),
    ],
  });
  setChatBinding(userId, chatId, preset.id,
    { style: true, "base-only": false },
    { style: { tone: "profile tone" } },
  );
});

afterEach(() => closeDatabase());

async function assemble(ctx: AssemblyContext, prefetched: boolean) {
  return assemblePrompt(prefetched
    ? { ...ctx, prefetched: await prefetchAssemblyData(ctx) }
    : ctx);
}

describe("generation profile binding after preset edits", () => {
  for (const prefetched of [false, true]) {
    const path = prefetched ? "prefetched" : "direct";
    test(`${path} assembly retains profile block states and variables across edits`, async () => {
      const ctx: AssemblyContext = { userId, chatId, presetId: preset.id, generationType: "normal" };
      const before = await assemble(ctx, prefetched);
      expect(JSON.stringify(before.messages)).toContain("BEFORE profile tone");
      expect(JSON.stringify(before.messages)).not.toContain("BASE_ONLY");

      updatePreset(userId, preset.id, {
        prompt_order: preset.prompt_order.map((prompt) => prompt.id === "style"
          ? { ...prompt, content: "AFTER {{var::tone}}" }
          : prompt),
        metadata: { ...preset.metadata, promptVariables: { style: { tone: "edited preset tone" } } },
      });
      for (const generationType of ["normal", "continue", "regenerate", "swipe", "quiet", "impersonate"] as const) {
        const after = await assemble({ ...ctx, generationType, impersonateMode: "prompts" }, prefetched);
        const text = JSON.stringify(after.messages);
        expect(text).toContain("AFTER profile tone");
        expect(text).not.toContain("BASE_ONLY");
        expect(text).not.toContain("edited preset tone");
        expect(after.resolvedPreset?.id).toBe(preset.id);
      }

      updateChatPromptVariables(userId, chatId, { style: { tone: "edited profile tone" } });
      expect(JSON.stringify((await assemble(ctx, prefetched)).messages)).toContain("AFTER edited profile tone");
    });

    test(`${path} assembly preserves explicit dedicated impersonation preset overrides`, async () => {
      const dedicated = createPreset(userId, {
        name: "Dedicated impersonation", provider: "openai",
        prompt_order: [block({ content: "DEDICATED_PRESET" })],
      });
      const ctx: AssemblyContext = {
        userId, chatId, presetId: dedicated.id,
        generationType: "impersonate", impersonateMode: "preset",
      };
      const bound = await assemble(ctx, prefetched);
      expect(bound.resolvedPreset?.id).toBe(preset.id);
      expect(JSON.stringify(bound.messages)).toContain("BEFORE profile tone");
      expect(JSON.stringify(bound.messages)).not.toContain("DEDICATED_PRESET");

      const forced = await assemble({ ...ctx, forcePresetId: true }, prefetched);
      expect(forced.resolvedPreset?.id).toBe(dedicated.id);
      expect(JSON.stringify(forced.messages)).toContain("DEDICATED_PRESET");
      expect(JSON.stringify(forced.messages)).not.toContain("profile tone");
    });
  }
});
