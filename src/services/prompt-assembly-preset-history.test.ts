import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../db/connection";
import { createCharacter } from "./characters.service";
import { addSwipe, createChat, createMessage, getMessage } from "./chats.service";
import { createPreset } from "./presets.service";
import { assemblePrompt } from "./prompt-assembly.service";
import { prefetchAssemblyData } from "./prompt-assembly-prefetch";
import { readPresetHistoryEntry } from "../types/preset-history";
import type { AssemblyContext } from "../llm/types";
import type { PromptBlock } from "../types/preset";
import { readMessageRevision } from "../utils/message-revision";

const userId = "assembly-history";
beforeEach(async () => {
  closeDatabase(); const db = initDatabase(":memory:"); db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
});
afterEach(closeDatabase);
function block(content: string, marker: string | null = null): PromptBlock {
  return { id: crypto.randomUUID(), name: "History", content, marker, enabled: true, role: "system", position: "pre_history",
    depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null };
}
function setup() {
  const character = createCharacter(userId, { name: "Assistant" });
  const chat = createChat(userId, { character_id: character.id });
  const preset = createPreset(userId, { name: "Current", provider: "openai", prompt_order: [block("HISTORY={{lastPresets::3::|}}"), block("", "chat_history")] });
  const reply = (name: string, content = "Reply") => createMessage(chat.id, { is_user: false, name: "Assistant", content,
    extra: { generationMetrics: { presetId: name, presetName: name } } }, userId);
  return { chat, preset, reply };
}
for (const prefetched of [false, true]) for (const select of [false, true]) {
  test(`regeneration preserves the original selection (prefetched=${prefetched}, foreground=${select})`, async () => {
    const { chat, preset, reply } = setup(); reply("Older");
    const target = reply("Original", "ORIGINAL_TARGET_TEXT");
    const original = readPresetHistoryEntry(target);
    addSwipe(userId, target.id, "", { select });
    const ctx: AssemblyContext = { userId, chatId: chat.id, presetOverride: preset, generationType: "regenerate", excludeMessageId: target.id,
      rejectedPresetHistory: { messageId: target.id, entry: original }, skipPromptRegex: true, macroCommit: false };
    const result = await assemblePrompt(prefetched ? { ...ctx, prefetched: await prefetchAssemblyData(ctx) } : ctx);
    expect(JSON.stringify(result.messages)).toContain("HISTORY=Original|Older");
    expect(JSON.stringify(result.messages)).not.toContain("ORIGINAL_TARGET_TEXT");
    expect(getMessage(userId, target.id)!.content).toBe(select ? "" : "ORIGINAL_TARGET_TEXT");
  });
}
test("Edit-and-Send caps preset history at the committed user turn", async () => {
  const { chat, preset, reply } = setup(); reply("Before");
  const edited = createMessage(chat.id, { is_user: true, name: "User", content: "Edited" }, userId);
  reply("Future");
  const ctx: AssemblyContext = { userId, chatId: chat.id, presetOverride: preset, generationType: "normal", skipPromptRegex: true, macroCommit: false,
    editAndSendContext: { editedUserMessageId: edited.id, committedRevision: readMessageRevision(edited)! } };
  const result = await assemblePrompt({ ...ctx, prefetched: await prefetchAssemblyData(ctx) });
  expect(JSON.stringify(result.messages)).toContain("HISTORY=Before");
  expect(JSON.stringify(result.messages)).not.toContain("Future");
});
