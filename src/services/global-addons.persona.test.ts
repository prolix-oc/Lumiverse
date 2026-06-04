import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import { resolvePersonaGlobalAddons } from "./global-addons.service";
import { buildEnv } from "../macros/MacroEnv";
import type { Persona } from "../types/persona";
import type { Character } from "../types/character";
import type { Chat } from "../types/chat";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  getDb().run(`CREATE TABLE global_addons (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0
  )`);
}

function insertGlobalAddon(o: {
  id: string;
  user_id: string;
  content: string;
  sort_order?: number;
}): void {
  getDb().run(
    `INSERT INTO global_addons (id, user_id, label, content, sort_order, metadata, created_at, updated_at)
     VALUES (?, ?, '', ?, ?, '{}', 0, 0)`,
    [o.id, o.user_id, o.content, o.sort_order ?? 0],
  );
}

function makePersona(metadata: Record<string, any>): Persona {
  return {
    id: "p1",
    name: "Alice",
    description: "Base persona description.",
    metadata,
  } as Persona;
}

const USER = "u1";

beforeEach(initTestDb);
afterEach(() => closeDatabase());

describe("resolvePersonaGlobalAddons", () => {
  test("injects enabled attached global add-ons as _resolvedGlobalAddons", () => {
    insertGlobalAddon({ id: "g1", user_id: USER, content: "Global one", sort_order: 0 });
    insertGlobalAddon({ id: "g2", user_id: USER, content: "Global two", sort_order: 1 });

    const persona = makePersona({
      attached_global_addons: [
        { id: "g1", enabled: true },
        { id: "g2", enabled: true },
      ],
    });

    const resolved = resolvePersonaGlobalAddons(USER, persona);
    const injected = resolved?.metadata?._resolvedGlobalAddons;
    expect(Array.isArray(injected)).toBe(true);
    expect(injected.map((a: any) => a.content)).toEqual(["Global one", "Global two"]);
  });

  test("excludes disabled attached refs and returns persona unchanged when none enabled", () => {
    insertGlobalAddon({ id: "g1", user_id: USER, content: "Global one" });

    const persona = makePersona({
      attached_global_addons: [{ id: "g1", enabled: false }],
    });

    const resolved = resolvePersonaGlobalAddons(USER, persona);
    // Nothing enabled -> same object reference, no injection
    expect(resolved).toBe(persona);
    expect(resolved?.metadata?._resolvedGlobalAddons).toBeUndefined();
  });

  test("handles null persona", () => {
    expect(resolvePersonaGlobalAddons(USER, null)).toBeNull();
  });
});

describe("{{persona}} macro includes resolved global add-ons", () => {
  test("renders base + local + global add-on content", () => {
    insertGlobalAddon({ id: "g1", user_id: USER, content: "Global addon content", sort_order: 0 });

    const persona = resolvePersonaGlobalAddons(
      USER,
      makePersona({
        addons: [{ id: "l1", label: "", content: "Local addon content", enabled: true, sort_order: 0 }],
        attached_global_addons: [{ id: "g1", enabled: true }],
      }),
    );

    const env = buildEnv({
      character: { id: "c1", name: "Bob", description: "" } as Character,
      persona,
      chat: { id: "chat1", character_id: "c1", name: "", metadata: {}, created_at: 0, updated_at: 0 } as Chat,
      messages: [],
      generationType: "normal",
    });

    expect(env.character.persona).toBe(
      "Base persona description.\nLocal addon content\nGlobal addon content",
    );
  });
});
