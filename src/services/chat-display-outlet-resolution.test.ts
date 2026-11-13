import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { closeDatabase, getDb, initDatabase } from "../db/connection";
import * as charactersSvc from "./characters.service";
import * as chatsSvc from "./chats.service";
import * as worldBooksSvc from "./world-books.service";
import { setCharacterWorldBookIds } from "../utils/character-world-books";
import { resolveRenderedMessageContent } from "./chat-macro-render.service";
import {
  getActivatedWorldInfoEntriesForChat,
  resolveWorldInfoOutlets,
} from "./prompt-assembly.service";

const USER_ID = "display-outlet-user";

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
}

/**
 * Mirrors the composition used by runDisplayPreprocessItem (chats.routes.ts):
 * build the macro env, populate world-info outlets from the activated entries,
 * then resolve the message content. The display-preprocess path previously
 * left {{outlet::name}} unresolved because it never ran WI activation — these
 * tests pin the fix that makes displayed greetings match the assembled prompt.
 */
async function resolveForDisplay(content: string): Promise<string> {
  const env = chatsSvc.buildMacroEnvForChat(USER_ID, chatId);
  if (!env) throw new Error("buildMacroEnvForChat returned null");
  const entries = await getActivatedWorldInfoEntriesForChat(USER_ID, chatId);
  await resolveWorldInfoOutlets(entries, env);
  return resolveRenderedMessageContent(content, env);
}

let chatId: string;
const OUTLET_CONTENT = "Secret lore: the amulet glows blue at dusk.";

describe("display-preprocess outlet macro resolution", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();

    const book = worldBooksSvc.createWorldBook(USER_ID, { name: "Lore Book" });
    const entry = worldBooksSvc.createEntry(USER_ID, book.id, {
      key: ["lore"],
      content: OUTLET_CONTENT,
      comment: "constant lore outlet",
      constant: true,
      outlet_name: "lore",
    });
    if (!entry) throw new Error("Failed to create world-book entry");

    const character = charactersSvc.createCharacter(USER_ID, {
      name: "TestChar",
      first_mes: `Greetings, traveler. {{outlet::lore}}`,
      extensions: setCharacterWorldBookIds({}, [book.id]),
    });

    chatId = chatsSvc.createChat(USER_ID, { character_id: character.id }).id;
  });

  afterEach(() => {
    closeDatabase();
  });

  test("{{outlet::name}} in a greeting resolves to the activated outlet entry content", async () => {
    const resolved = await resolveForDisplay(`Greetings, traveler. {{outlet::lore}}`);
    expect(resolved).toBe(`Greetings, traveler. ${OUTLET_CONTENT}`);
  });

  test("getActivatedWorldInfoEntriesForChat returns the constant outlet entry", async () => {
    const entries = await getActivatedWorldInfoEntriesForChat(USER_ID, chatId);
    const loreEntry = entries.find((e) => e.outlet_name === "lore");
    expect(loreEntry).toBeTruthy();
    expect(loreEntry!.content).toBe(OUTLET_CONTENT);
  });

  test("an unknown outlet resolves to empty string without throwing", async () => {
    const resolved = await resolveForDisplay(`Before{{outlet::nonexistent}}After`);
    expect(resolved).toBe("BeforeAfter");
  });

  test("base macros still resolve when no outlet is referenced", async () => {
    const resolved = await resolveForDisplay(`Hi, I am {{char}}.`);
    expect(resolved).toBe("Hi, I am TestChar.");
  });
});
