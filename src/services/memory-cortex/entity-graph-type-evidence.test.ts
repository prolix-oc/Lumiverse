import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { getEntity, processProvisionalEntities, upsertEntity } from "./entity-graph";
import type { ExtractedEntity } from "./types";

function initEntityGraphTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();

  db.run(`CREATE TABLE memory_entities (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    entity_type TEXT DEFAULT 'concept',
    aliases TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    first_seen_chunk_id TEXT,
    last_seen_chunk_id TEXT,
    first_seen_at INTEGER,
    last_seen_at INTEGER,
    mention_count INTEGER DEFAULT 0,
    salience_avg REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    status_changed_at INTEGER,
    facts TEXT DEFAULT '[]',
    emotional_valence TEXT DEFAULT '{}',
    metadata TEXT DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    fact_extraction_status TEXT DEFAULT 'never',
    fact_extraction_last_attempt INTEGER,
    salience_breakdown TEXT DEFAULT '{"mentionComponent":0,"arcComponent":0,"graphComponent":0,"total":0}',
    last_mention_timestamp INTEGER,
    recent_mention_count INTEGER DEFAULT 0,
    confidence TEXT DEFAULT 'confirmed'
  )`);

  db.run(`CREATE TABLE chat_chunks (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
}

function seedChunk(chatId: string, id: string, createdAt: number): void {
  getDb().query("INSERT INTO chat_chunks (id, chat_id, created_at) VALUES (?, ?, ?)").run(id, chatId, createdAt);
}

function makeEntity(name: string, type: ExtractedEntity["type"], confidence: number, provisional = false): ExtractedEntity {
  return {
    name,
    type,
    aliases: [],
    confidence,
    provisional,
  };
}

beforeEach(() => {
  initEntityGraphTestDb();
});

afterEach(() => {
  closeDatabase();
});

describe("entity graph type evidence", () => {
  test("promotes a concept to faction after corroborated cross-chunk evidence", () => {
    const chatId = "chat-faction";
    seedChunk(chatId, "c1", 100);
    seedChunk(chatId, "c2", 200);
    seedChunk(chatId, "c3", 300);

    const entityId = upsertEntity(chatId, makeEntity("Azure Guard", "concept", 0.45), "c1", 100);
    expect(getEntity(entityId)?.entityType).toBe("concept");

    upsertEntity(chatId, makeEntity("Azure Guard", "faction", 0.72), "c2", 200);
    expect(getEntity(entityId)?.entityType).toBe("concept");

    upsertEntity(chatId, makeEntity("Azure Guard", "faction", 0.74), "c3", 300);
    const entity = getEntity(entityId);
    expect(entity?.entityType).toBe("faction");
    expect((entity?.metadata as any)?.typeEvidence?.counts?.faction).toBe(2);
  });

  test("demotes a weak faction back to concept when later evidence contradicts it", () => {
    const chatId = "chat-demotion";
    seedChunk(chatId, "c1", 100);
    seedChunk(chatId, "c2", 200);
    seedChunk(chatId, "c3", 300);

    const entityId = upsertEntity(chatId, makeEntity("The Accord", "faction", 0.82), "c1", 100);
    expect(getEntity(entityId)?.entityType).toBe("faction");

    upsertEntity(chatId, makeEntity("The Accord", "concept", 0.65), "c2", 200);
    upsertEntity(chatId, makeEntity("The Accord", "concept", 0.68), "c3", 300);

    const entity = getEntity(entityId);
    expect(entity?.entityType).toBe("concept");
    expect((entity?.metadata as any)?.typeEvidence?.counts?.concept).toBe(2);
  });

  test("processProvisionalEntities confirms provisional entities using accumulated event evidence", () => {
    const chatId = "chat-event";
    seedChunk(chatId, "c1", 100);
    seedChunk(chatId, "c2", 200);

    const entityId = upsertEntity(chatId, makeEntity("Black Tide Incident", "event", 0.81, true), "c1", 100);
    expect(getEntity(entityId)?.confidence).toBe("provisional");

    upsertEntity(chatId, makeEntity("Black Tide Incident", "event", 0.84, true), "c2", 200);
    const result = processProvisionalEntities(chatId, 2, 50);
    const entity = getEntity(entityId);

    expect(result.promoted).toBe(1);
    expect(entity?.confidence).toBe("confirmed");
    expect(entity?.entityType).toBe("event");
  });
});
