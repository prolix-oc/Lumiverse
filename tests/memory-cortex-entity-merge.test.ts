import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "path";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import { mergeEntitiesInternal } from "../src/services/memory-cortex/entity-graph";

const CHAT_ID = "merge-chat";
const NOW = 1_700_000_000;

async function applyBaseline(): Promise<void> {
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
}

function insertEntity(id: string, name: string, mentionCount = 1): void {
  getDb()
    .query(
      `INSERT INTO memory_entities
       (id, chat_id, name, entity_type, aliases, facts, mention_count,
        salience_avg, salience_peak, created_at, updated_at)
       VALUES (?, ?, ?, 'character', '[]', '[]', ?, 0.5, 0.5, ?, ?)`,
    )
    .run(id, CHAT_ID, name, mentionCount, NOW, NOW);
}

function insertMention(
  id: string,
  entityId: string,
  chunkId: string,
  role: string,
  excerpt: string | null,
  sentiment: number,
  createdAt = NOW,
): void {
  getDb()
    .query(
      `INSERT INTO memory_mentions
       (id, entity_id, chunk_id, chat_id, role, excerpt, sentiment, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, entityId, chunkId, CHAT_ID, role, excerpt, sentiment, createdAt);
}

function insertRelation(
  id: string,
  sourceId: string,
  targetId: string,
  type: string,
  evidenceChunkIds: string[],
): void {
  getDb()
    .query(
      `INSERT INTO memory_relations
       (id, chat_id, source_entity_id, target_entity_id, relation_type,
        strength, sentiment, evidence_chunk_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0.5, 0.1, ?, ?, ?)`,
    )
    .run(id, CHAT_ID, sourceId, targetId, type, JSON.stringify(evidenceChunkIds), NOW, NOW);
}

describe("memory cortex entity merge", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("coalesces overlapping mentions instead of violating entity/chunk uniqueness", () => {
    insertEntity("source", "Ally");
    insertEntity("target", "Alice");
    insertMention("target-c1", "target", "chunk-1", "present", null, 0.1, NOW + 10);
    insertMention("source-c1", "source", "chunk-1", "subject", "Ally speaks.", -0.8, NOW);
    insertMention("source-c2", "source", "chunk-2", "referenced", "Ally was there.", 0.2, NOW + 20);

    mergeEntitiesInternal("source", "target");

    const rows = getDb()
      .query("SELECT * FROM memory_mentions ORDER BY chunk_id")
      .all() as any[];

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.entity_id === "target")).toBe(true);
    expect(rows.map((row) => row.chunk_id)).toEqual(["chunk-1", "chunk-2"]);

    const chunkOne = rows.find((row) => row.chunk_id === "chunk-1")!;
    expect(chunkOne.id).toBe("target-c1");
    expect(chunkOne.role).toBe("subject");
    expect(chunkOne.excerpt).toBe("Ally speaks.");
    expect(chunkOne.sentiment).toBe(-0.8);
    expect(chunkOne.created_at).toBe(NOW);
  });

  test("coalesces relation evidence and deletes self-relations during merge", () => {
    insertEntity("source", "Ally");
    insertEntity("target", "Alice");
    insertEntity("other", "Bob");
    insertRelation("canonical", "target", "other", "ally", ["chunk-1"]);
    insertRelation("absorbed", "source", "other", "ally", ["chunk-2"]);
    insertRelation("self-after-merge", "source", "target", "ally", ["chunk-3"]);

    mergeEntitiesInternal("source", "target");

    const rows = getDb()
      .query("SELECT * FROM memory_relations")
      .all() as any[];

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("canonical");
    expect(rows[0].source_entity_id).toBe("target");
    expect(rows[0].target_entity_id).toBe("other");
    expect(JSON.parse(rows[0].evidence_chunk_ids).sort()).toEqual(["chunk-1", "chunk-2"]);
  });
});
