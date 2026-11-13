import { afterEach, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, initDatabase } from "../db/connection";
import { initMacros } from "../macros";
import { setCharacterWorldBookIds } from "../utils/character-world-books";
import type { PromptBlock } from "../types/preset";
import { createCharacter } from "./characters.service";
import { createChat, createMessage } from "./chats.service";
import { createWorldBook, createEntry } from "./world-books.service";
import { createPreset } from "./presets.service";
import { putSetting } from "./settings.service";
import { assemblePrompt } from "./prompt-assembly.service";
import { rankVectorWorldInfoCandidates } from "./world-info-vector-ranking";

mock.module("./vectorization-queue.service", () => ({
  queueWorldBookEntryVectorization: () => {},
}));

afterEach(() => closeDatabase());

test("prompt assembly applies the saved mode to precomputed vectors under entry and token budgets", async () => {
  const db = initDatabase(":memory:");
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "../db/baseline.sql")).text());
  initMacros();

  const userId = "vector-first-assembly";
  const book = createWorldBook(userId, { name: "Vector First" });
  const keyword = createEntry(userId, book.id, {
    key: ["Silvergate"], content: "KEYWORD_LORE", comment: "Town history",
    position: 0, priority: 100, order_value: 1,
  })!;
  const semantic = createEntry(userId, book.id, {
    content: "SEMANTIC_LORE", comment: "Guard patrols", vectorized: true,
    position: 0, priority: 1, order_value: 1000,
  })!;
  db.query("UPDATE world_book_entries SET vector_index_status = 'indexed', vector_indexed_at = 0 WHERE id = ?").run(semantic.id);
  semantic.vector_index_status = "indexed";
  semantic.vector_indexed_at = 0;
  const character = createCharacter(userId, {
    name: "Character", extensions: setCharacterWorldBookIds({}, [book.id]),
  });
  const chat = createChat(userId, { character_id: character.id });
  const message = createMessage(chat.id, {
    is_user: true, name: "User", content: "Silvergate guards patrol the plaza.",
  }, userId);
  const blocks: PromptBlock[] = ["world_info_before", "chat_history"].map((marker) => ({
    id: marker, name: marker, enabled: true, role: "system", marker, content: "",
    position: "pre_history", depth: 0, isLocked: false, color: null, injectionTrigger: [], group: null,
  }));
  const preset = createPreset(userId, { name: "Vector First", provider: "openai", prompt_order: blocks });
  const precomputedVectorEntries = rankVectorWorldInfoCandidates({
    eligibleEntries: [semantic],
    pooledCandidates: [{ entry: semantic, candidate: {
      entry_id: semantic.id, distance: 0.3, lexical_score: null, lexical_strength: 0,
      content: semantic.content, searchTextPreview: semantic.content, metadata: {},
    } }],
    queryText: message.content, hybridWeightMode: "vector_first",
    similarityThreshold: 0, rerankCutoff: 0, topK: 1,
  }).shortlistedEntries;
  expect(precomputedVectorEntries).toHaveLength(1);

  for (const hybridWeightMode of ["vector_first", "balanced", "keyword_first"] as const) {
    putSetting(userId, "embeddingConfig", {
      enabled: false, hybrid_weight_mode: hybridWeightMode,
      similarity_threshold: 0, rerank_cutoff: 0,
    });
    for (const budget of [{ maxActivatedEntries: 1 }, { maxTokenBudget: 4 }]) {
      putSetting(userId, "worldInfoSettings", budget);
      const result = await assemblePrompt({
        userId, chatId: chat.id, presetOverride: preset,
        generationType: "normal", skipPromptRegex: true, macroCommit: false,
        precomputedVectorEntries,
      });
      const expected = hybridWeightMode === "vector_first" ? semantic : keyword;
      expect(result.activatedWorldInfo?.map((entry) => entry.id)).toEqual([expected.id]);
      const contents = result.messages.map((row) => row.content).join("\n");
      expect(contents).toContain(expected.content);
      expect(contents).not.toContain(hybridWeightMode === "vector_first" ? keyword.content : semantic.content);
    }
  }
});
