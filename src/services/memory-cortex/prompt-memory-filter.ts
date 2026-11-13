import { getDb } from "../../db/connection";
import type { CortexMemory } from "./types";

function messageIds(raw: string): string[] | null {
  try {
    const ids: unknown = JSON.parse(raw);
    return Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string") ? ids : null;
  } catch {
    return null;
  }
}

/** Revalidate only the retrieved sources when the live tail changes. Unknown
 * provenance is omitted; safe older memories can survive an ordinary new turn. */
export function filterCortexMemoriesForPrompt(
  chatId: string,
  memories: CortexMemory[],
  excludedMessageIds: string[],
): CortexMemory[] {
  if (memories.length === 0 || excludedMessageIds.length === 0) return memories;
  const db = getDb();
  const excluded = new Set(excludedMessageIds);
  const chunks = new Map<string, string[] | null>();
  const consolidationSources = new Map<string, Set<string>>();
  const chunkIds = new Set(memories.filter((m) => m.source === "chunk").map((m) => m.sourceId));
  const consolidationIds = [...new Set(memories.filter((m) => m.source === "consolidation").map((m) => m.sourceId))];

  for (let i = 0; i < consolidationIds.length; i += 500) {
    const batch = consolidationIds.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.query(`SELECT id, source_chunk_ids FROM memory_consolidations
      WHERE chat_id = ? AND tier = 1 AND id IN (${placeholders})`)
      .all(chatId, ...batch) as Array<{ id: string; source_chunk_ids: string }>;
    for (const row of rows) {
      const sources = new Set(messageIds(row.source_chunk_ids) ?? []);
      consolidationSources.set(row.id, sources);
      for (const id of sources) chunkIds.add(id);
    }
    // Include all linked chunks, even when a summary's source list is incomplete.
    const linked = db.query(`SELECT id, consolidation_id FROM chat_chunks
      WHERE chat_id = ? AND consolidation_id IN (${placeholders})`)
      .all(chatId, ...batch) as Array<{ id: string; consolidation_id: string }>;
    for (const row of linked) {
      consolidationSources.get(row.consolidation_id)?.add(row.id);
      chunkIds.add(row.id);
    }
  }

  const ids = [...chunkIds];
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db.query(`SELECT id, message_ids FROM chat_chunks WHERE chat_id = ? AND id IN (${placeholders})`)
      .all(chatId, ...batch) as Array<{ id: string; message_ids: string }>;
    for (const row of rows) chunks.set(row.id, messageIds(row.message_ids));
  }

  const safeChunk = (id: string) => {
    const sourceIds = chunks.get(id);
    return !!sourceIds && sourceIds.every((id) => !excluded.has(id));
  };
  return memories.filter((memory) => {
    if (memory.source === "chunk") return safeChunk(memory.sourceId);
    const sources = consolidationSources.get(memory.sourceId);
    return !!sources?.size && [...sources].every(safeChunk);
  });
}
