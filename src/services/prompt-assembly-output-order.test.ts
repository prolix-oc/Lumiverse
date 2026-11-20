import { expect, test } from "bun:test";
import { join } from "node:path";
import type { PromptBlock } from "../types/preset";
import { closeDatabase, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import { worldInfoInterceptorChain } from "../spindle/world-info-interceptor";
import { setCharacterWorldBookIds } from "../utils/character-world-books";
import { createCharacter } from "./characters.service";
import { createChat, createMessage } from "./chats.service";
import { createWorldBook, createEntry } from "./world-books.service";
import { createPreset } from "./presets.service";
import { assemblePrompt } from "./prompt-assembly.service";

test("assembled messages honor output ordering while default and selection diagnostics remain unchanged", async () => {
  const db = initDatabase(":memory:");
  let unregister = () => {};
  try {
    db.run("PRAGMA foreign_keys = OFF");
    db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
    initMacros();
    const userId = "output-order-user";
    const book = createWorldBook(userId, { name: "Ordering" });
    const entries = ["A", "B", "C"].map((name, index) => createEntry(userId, book.id, {
      key: ["match"], content: `LORE_${name}`, comment: name, position: 0,
      order_value: (index + 1) * 100, priority: (index + 1) * 100,
    })!);
    const character = createCharacter(userId, {
      name: "Character", extensions: setCharacterWorldBookIds({}, [book.id]),
    });
    const chat = createChat(userId, { character_id: character.id });
    createMessage(chat.id, { is_user: true, name: "User", content: "match" }, userId);
    const blocks: PromptBlock[] = ["world_info_before", "chat_history"].map(marker => ({
      id: marker, name: marker, enabled: true, role: "system", marker, content: "",
      position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null,
    }));
    const preset = createPreset(userId, { name: "Ordering", provider: "openai", prompt_order: blocks });
    const ctx = { userId, chatId: chat.id, presetOverride: preset, generationType: "normal" as const, skipPromptRegex: true, macroCommit: false };
    const native = await assemblePrompt(ctx);
    const labels = (result: typeof native) => result.messages.map(row => row.content).join("\n").match(/LORE_[ABC]/g);
    expect(labels(native)).toEqual(["LORE_C", "LORE_B", "LORE_A"]);
    unregister = worldInfoInterceptorChain.register({ extensionId: "ordering", userId, priority: 0, handler: async () => ({
      mutated: entries.map(row => ({ id: row.id, outputOrder: "insertion" as const })),
    }) });
    const ordered = await assemblePrompt(ctx);
    expect(labels(ordered)).toEqual(["LORE_A", "LORE_B", "LORE_C"]);
    expect(ordered.activatedWorldInfo).toEqual(native.activatedWorldInfo);
    unregister();
    expect(labels(await assemblePrompt(ctx))).toEqual(labels(native));
  } finally {
    unregister();
    closeDatabase();
  }
});
