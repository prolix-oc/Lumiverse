#!/usr/bin/env bun

/**
 * Backfill `metadata.auto_managed_by_character` for legacy auto-imported
 * character lorebooks.
 *
 * Dry-run by default. Pass `--apply` to persist changes.
 *
 * Conservative heuristic:
 * - world book metadata source is `character`
 * - metadata has `source_character_id`
 * - `auto_managed_by_character` is not already set
 * - source character still exists and still has an embedded character_book
 * - world book is attached to the source character
 * - world book is not attached to any other character/persona/chat
 * - world book and character were created in the same unix-epoch second
 *
 * This intentionally leaves ambiguous cases untouched.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCharacterWorldBookIds } from "../src/utils/character-world-books";

const DATA_DIR = process.env.DATA_DIR || "data";
const DB_PATH = join(DATA_DIR, "lumiverse.db");
const APPLY = process.argv.includes("--apply");

if (!existsSync(DB_PATH)) {
  console.error(`Database not found at ${DB_PATH}`);
  process.exit(1);
}

type CharacterRow = {
  id: string;
  user_id: string;
  name: string;
  extensions: string;
  created_at: number;
};

type WorldBookRow = {
  id: string;
  user_id: string;
  name: string;
  description: string;
  metadata: string;
  created_at: number;
};

type PersonaRow = {
  id: string;
  user_id: string;
  attached_world_book_id: string | null;
};

type ChatRow = {
  id: string;
  user_id: string;
  metadata: string;
};

type CharacterRecord = {
  id: string;
  userId: string;
  name: string;
  createdAt: number;
  extensions: Record<string, any>;
  attachedWorldBookIds: string[];
  hasEmbeddedCharacterBook: boolean;
};

type WorldBookRecord = {
  id: string;
  userId: string;
  name: string;
  description: string;
  createdAt: number;
  metadata: Record<string, any>;
};

type AttachmentUsage = {
  characters: string[];
  personas: string[];
  chats: string[];
};

type Candidate = {
  worldBook: WorldBookRecord;
  sourceCharacter: CharacterRecord;
  usage: AttachmentUsage;
};

type AmbiguousCase = {
  worldBook: WorldBookRecord;
  reason: string;
};

function parseJsonObject(value: string, fallback: Record<string, any> = {}): Record<string, any> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

const characterRows = db.query(
  "SELECT id, user_id, name, extensions, created_at FROM characters"
).all() as CharacterRow[];

const worldBookRows = db.query(
  "SELECT id, user_id, name, description, metadata, created_at FROM world_books"
).all() as WorldBookRow[];

const personaRows = db.query(
  "SELECT id, user_id, attached_world_book_id FROM personas"
).all() as PersonaRow[];

const chatRows = db.query(
  "SELECT id, user_id, metadata FROM chats"
).all() as ChatRow[];

const characters = new Map<string, CharacterRecord>();
for (const row of characterRows) {
  const extensions = parseJsonObject(row.extensions);
  const charBook = extensions.character_book;
  const entries = Array.isArray(charBook?.entries)
    ? charBook.entries
    : Object.values(charBook?.entries || {});

  characters.set(row.id, {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: row.created_at,
    extensions,
    attachedWorldBookIds: getCharacterWorldBookIds(extensions),
    hasEmbeddedCharacterBook: entries.length > 0,
  });
}

const worldBooks = worldBookRows.map((row): WorldBookRecord => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  description: row.description,
  createdAt: row.created_at,
  metadata: parseJsonObject(row.metadata),
}));

const usageByWorldBook = new Map<string, AttachmentUsage>();

function ensureUsage(worldBookId: string): AttachmentUsage {
  let usage = usageByWorldBook.get(worldBookId);
  if (!usage) {
    usage = { characters: [], personas: [], chats: [] };
    usageByWorldBook.set(worldBookId, usage);
  }
  return usage;
}

for (const character of characters.values()) {
  for (const worldBookId of character.attachedWorldBookIds) {
    ensureUsage(worldBookId).characters.push(character.id);
  }
}

for (const row of personaRows) {
  if (!row.attached_world_book_id) continue;
  ensureUsage(row.attached_world_book_id).personas.push(row.id);
}

for (const row of chatRows) {
  const metadata = parseJsonObject(row.metadata);
  const worldBookIds = Array.isArray(metadata.chat_world_book_ids)
    ? metadata.chat_world_book_ids.filter((id: unknown) => typeof id === "string" && id)
    : [];
  for (const worldBookId of worldBookIds) {
    ensureUsage(worldBookId).chats.push(row.id);
  }
}

for (const usage of usageByWorldBook.values()) {
  usage.characters = unique(usage.characters);
  usage.personas = unique(usage.personas);
  usage.chats = unique(usage.chats);
}

const candidates: Candidate[] = [];
const ambiguous: AmbiguousCase[] = [];
let alreadyTagged = 0;
let ignored = 0;

for (const worldBook of worldBooks) {
  const metadata = worldBook.metadata;
  if (metadata.source !== "character") {
    ignored += 1;
    continue;
  }

  if (metadata.auto_managed_by_character === true) {
    alreadyTagged += 1;
    continue;
  }

  const sourceCharacterId = typeof metadata.source_character_id === "string"
    ? metadata.source_character_id
    : "";
  if (!sourceCharacterId) {
    ambiguous.push({ worldBook, reason: "Missing source_character_id metadata" });
    continue;
  }

  const sourceCharacter = characters.get(sourceCharacterId);
  if (!sourceCharacter || sourceCharacter.userId !== worldBook.userId) {
    ambiguous.push({ worldBook, reason: "Source character no longer exists" });
    continue;
  }

  if (!sourceCharacter.hasEmbeddedCharacterBook) {
    ambiguous.push({ worldBook, reason: "Source character no longer has an embedded character_book" });
    continue;
  }

  const usage = usageByWorldBook.get(worldBook.id) || { characters: [], personas: [], chats: [] };
  const attachedToSourceCharacter = usage.characters.includes(sourceCharacter.id);
  const onlySourceCharacterAttached = usage.characters.length === 1 && attachedToSourceCharacter;
  const hasOtherConsumers = usage.personas.length > 0 || usage.chats.length > 0;
  const sameCreatedSecond = worldBook.createdAt === sourceCharacter.createdAt;

  if (attachedToSourceCharacter && onlySourceCharacterAttached && !hasOtherConsumers && sameCreatedSecond) {
    candidates.push({ worldBook, sourceCharacter, usage });
    continue;
  }

  const reasons: string[] = [];
  if (!attachedToSourceCharacter) reasons.push("Not attached to source character");
  if (!onlySourceCharacterAttached) reasons.push("Attached to another character or detached from source character");
  if (hasOtherConsumers) reasons.push("Referenced by persona or chat metadata");
  if (!sameCreatedSecond) reasons.push("Creation timestamp does not exactly match source character import second");
  ambiguous.push({ worldBook, reason: reasons.join("; ") || "Did not meet strict backfill heuristic" });
}

console.log(`${APPLY ? "Applying" : "Dry run:"} legacy character lorebook ownership backfill`);
console.log(`Database: ${DB_PATH}`);
console.log("");
console.log(`Character-sourced world books scanned: ${worldBooks.length}`);
console.log(`Already tagged: ${alreadyTagged}`);
console.log(`High-confidence backfill candidates: ${candidates.length}`);
console.log(`Ambiguous legacy cases left untouched: ${ambiguous.length}`);
console.log(`Ignored non-character books: ${ignored}`);

if (candidates.length > 0) {
  console.log("\nHigh-confidence candidates:");
  for (const candidate of candidates.slice(0, 25)) {
    console.log(
      `- ${candidate.worldBook.name} [${candidate.worldBook.id}] <- ${candidate.sourceCharacter.name} [${candidate.sourceCharacter.id}]`
    );
  }
  if (candidates.length > 25) {
    console.log(`- ...and ${candidates.length - 25} more`);
  }
}

if (ambiguous.length > 0) {
  console.log("\nAmbiguous cases:");
  for (const item of ambiguous.slice(0, 25)) {
    console.log(`- ${item.worldBook.name} [${item.worldBook.id}]: ${item.reason}`);
  }
  if (ambiguous.length > 25) {
    console.log(`- ...and ${ambiguous.length - 25} more`);
  }
}

if (APPLY && candidates.length > 0) {
  const update = db.prepare("UPDATE world_books SET metadata = ?, updated_at = ? WHERE id = ?");
  const now = Math.floor(Date.now() / 1000);
  const tx = db.transaction(() => {
    for (const candidate of candidates) {
      const nextMetadata = {
        ...candidate.worldBook.metadata,
        auto_managed_by_character: true,
      };
      update.run(JSON.stringify(nextMetadata), now, candidate.worldBook.id);
    }
  });
  tx();
  console.log(`\nUpdated ${candidates.length} world book(s).`);
} else if (APPLY) {
  console.log("\nNo high-confidence candidates to update.");
} else {
  console.log("\nNo changes written. Re-run with --apply to persist the high-confidence candidates.");
}

db.close();
