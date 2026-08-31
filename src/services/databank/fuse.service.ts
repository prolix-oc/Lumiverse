/**
 * Databank Fuse Service — Merges one databank into another.
 *
 * Moves all source documents into the target bank, preserving existing
 * embeddings (the LanceDB owner_id is rewritten rather than re-vectorized).
 * Duplicate documents (matching content_hash) are dropped from the source
 * instead of being copied. Any character/chat that referenced the source
 * bank is rewired to the target. The source bank is deleted at the end.
 *
 * Allows cross-scope fusion — moved docs adopt the target bank's scope.
 */

import { getDb } from "../../db/connection";
import { bumpChatGenerationRevision } from "../chat-generation-revision.service";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import * as filesSvc from "../files.service";
import * as embeddingsSvc from "../embeddings.service";
import * as settingsSvc from "../settings.service";
import { getDatabank } from "./databank-crud.service";
import { abortDatabankProcessing } from "./vectorization.service";
import { invalidateDatabankCaches } from "./retrieval-cache.service";
import type { Databank, DatabankDocumentRow } from "./types";
import {
  computeUserDataSourceDigest,
  getUserDataProjectionStamp,
  withUserDataMutation,
  withUserDataProjection,
} from "../user-data/snapshot";

export interface FuseResult {
  databank: Databank;
  moved: number;
  skipped: number;
}

export async function fuseDatabanks(
  userId: string,
  targetId: string,
  sourceId: string,
): Promise<FuseResult> {
  if (!targetId || !sourceId) {
    throw new FuseError("invalid", "targetId and sourceId are required");
  }
  if (targetId === sourceId) {
    throw new FuseError("invalid", "Cannot fuse a databank into itself");
  }

  const canonical = await withUserDataMutation(userId, async () => {
    const target = getDatabank(userId, targetId);
    if (!target) throw new FuseError("not_found", "Target databank not found");
    const source = getDatabank(userId, sourceId);
    if (!source) throw new FuseError("not_found", "Source databank not found");

    invalidateDatabankCaches(userId, targetId);
    invalidateDatabankCaches(userId, sourceId);

    const db = getDb();
    const now = Math.floor(Date.now() / 1000);

    // In-flight processing on source docs would race against the move.
    abortDatabankProcessing(sourceId);

    const sourceDocs = db
      .query("SELECT * FROM databank_documents WHERE databank_id = ? AND user_id = ?")
      .all(sourceId, userId) as DatabankDocumentRow[];

    const targetHashRows = db
      .query("SELECT content_hash FROM databank_documents WHERE databank_id = ? AND user_id = ?")
      .all(targetId, userId) as Array<{ content_hash: string }>;
    const targetHashes = new Set(
      targetHashRows.map((r) => r.content_hash).filter((h): h is string => Boolean(h)),
    );

    const toMove: DatabankDocumentRow[] = [];
    const toSkip: DatabankDocumentRow[] = [];
    for (const doc of sourceDocs) {
      if (doc.content_hash && targetHashes.has(doc.content_hash)) {
        toSkip.push(doc);
      } else {
        toMove.push(doc);
      }
    }

    // Move kept docs: rewrite databank_id on the document + chunk rows.
    const movedChunkIds: string[] = [];
    if (toMove.length > 0) {
      const docIds = toMove.map((d) => d.id);
      const placeholders = docIds.map(() => "?").join(",");

      movedChunkIds.push(...(
        db
          .query(
            `SELECT id FROM databank_chunks WHERE document_id IN (${placeholders}) AND user_id = ?`,
          )
          .all(...docIds, userId) as Array<{ id: string }>
      ).map((r) => r.id));

      db.transaction(() => {
        db.run(
          `UPDATE databank_documents SET databank_id = ?, updated_at = ? WHERE id IN (${placeholders}) AND user_id = ?`,
          [targetId, now, ...docIds, userId],
        );
        db.run(
          `UPDATE databank_chunks SET databank_id = ? WHERE document_id IN (${placeholders}) AND user_id = ?`,
          [targetId, ...docIds, userId],
        );
      })();
    }

    // Delete duplicate source docs and files. Their vector IDs are retained
    // for the post-commit projection, so no derived row is touched here.
    const skippedChunkIds: string[] = [];
    for (const doc of toSkip) {
      try {
        await filesSvc.deleteFile(userId, doc.file_path, "databank");
      } catch {
        // non-fatal — file may already be gone
      }
      skippedChunkIds.push(...(
        db
          .query("SELECT id FROM databank_chunks WHERE document_id = ? AND user_id = ?")
          .all(doc.id, userId) as Array<{ id: string }>
      ).map((r) => r.id));
      // CASCADE removes the chunk rows when we drop the document.
      db.run("DELETE FROM databank_documents WHERE id = ? AND user_id = ?", [doc.id, userId]);
    }

    // Rewrite any character/chat bindings that reference the source bank.
    rewriteCharacterBindings(userId, sourceId, targetId);
    rewriteChatBindings(userId, sourceId, targetId);
    rewriteGlobalSettingBindings(userId, sourceId, targetId);

    // Drop the now-empty source bank. CASCADE handles any stragglers.
    db.run("DELETE FROM databanks WHERE id = ? AND user_id = ?", [sourceId, userId]);
    db.run("UPDATE databanks SET updated_at = ? WHERE id = ? AND user_id = ?", [now, targetId, userId]);

    const refreshedTarget = getDatabank(userId, targetId);
    if (!refreshedTarget) {
      throw new FuseError("not_found", "Target databank disappeared during fuse");
    }

    return {
      refreshedTarget,
      movedChunkIds,
      skippedChunkIds,
      moved: toMove.length,
      skipped: toSkip.length,
    };
  });

  // Canonical rows/files are committed before touching derived vectors. The
  // projection fence deliberately remains uncovered while these operations
  // run, so concurrent exports report rebuild_required rather than claiming a
  // stable vector dump.
  try {
    const stamp = getUserDataProjectionStamp(userId);
    const sourceDigest = computeUserDataSourceDigest(getDb(), userId);
    await withUserDataProjection(userId, stamp.sourceEpoch, sourceDigest, async () => {
      if (canonical.skippedChunkIds.length > 0) {
        await embeddingsSvc.deleteDatabankChunksByIds(userId, canonical.skippedChunkIds);
      }
      if (canonical.movedChunkIds.length > 0) {
        await embeddingsSvc.moveDatabankChunkVectorsToOwner(
          userId,
          canonical.movedChunkIds,
          targetId,
        );
      }
    });
  } catch (error) {
    // Canonical fusion is durable and must not be rolled back after the
    // filesystem/relational commit. Leave projection coverage stale so the
    // next export records rebuild_required and a later repair can retry.
    console.warn("[databank] Vector projection after fuse failed:", error);
  }

  eventBus.emit(EventType.DATABANK_DELETED, { databankId: sourceId }, userId);
  eventBus.emit(
    EventType.DATABANK_CHANGED,
    { databankId: canonical.refreshedTarget.id, databank: canonical.refreshedTarget },
    userId,
  );

  return {
    databank: canonical.refreshedTarget,
    moved: canonical.moved,
    skipped: canonical.skipped,
  };
}


function rewriteCharacterBindings(userId: string, sourceId: string, targetId: string): void {
  const db = getDb();
  const rows = db
    .query(
      `SELECT id, extensions FROM characters
       WHERE user_id = ? AND extensions LIKE ?`,
    )
    .all(userId, `%${sourceId}%`) as Array<{ id: string; extensions: string }>;

  const now = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    let ext: Record<string, unknown>;
    try {
      ext = JSON.parse(row.extensions || "{}");
    } catch {
      continue;
    }
    const ids = ext.databank_ids;
    if (!Array.isArray(ids) || !ids.includes(sourceId)) continue;
    const filtered = ids.filter((id) => typeof id === "string" && id !== sourceId);
    const next = filtered.includes(targetId) ? filtered : [...filtered, targetId];
    const updatedExt = { ...ext, databank_ids: next };
    db.run(
      `UPDATE characters SET extensions = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      [JSON.stringify(updatedExt), now, row.id, userId],
    );
  }
}

function rewriteChatBindings(userId: string, sourceId: string, targetId: string): void {
  const db = getDb();
  const rows = db
    .query(
      `SELECT id, metadata FROM chats
       WHERE user_id = ? AND metadata LIKE ?`,
    )
    .all(userId, `%${sourceId}%`) as Array<{ id: string; metadata: string }>;

  for (const row of rows) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata || "{}");
    } catch {
      continue;
    }
    const ids = meta.chat_databank_ids;
    if (!Array.isArray(ids) || !ids.includes(sourceId)) continue;
    const filtered = ids.filter((id) => typeof id === "string" && id !== sourceId);
    const next = filtered.includes(targetId) ? filtered : [...filtered, targetId];
    const updatedMeta = { ...meta, chat_databank_ids: next };
    db.transaction(() => {
      db.run(
        `UPDATE chats SET metadata = ? WHERE id = ? AND user_id = ?`,
        [JSON.stringify(updatedMeta), row.id, userId],
      );
      bumpChatGenerationRevision(db, row.id, userId);
    })();
  }
}

function rewriteGlobalSettingBindings(userId: string, sourceId: string, targetId: string): void {
  const setting = settingsSvc.getSetting(userId, "globalDatabanks");
  const ids = setting?.value;
  if (!Array.isArray(ids) || !ids.includes(sourceId)) return;

  const filtered = ids.filter((id: unknown) => typeof id === "string" && id !== sourceId);
  const next = filtered.includes(targetId) ? filtered : [...filtered, targetId];
  settingsSvc.putSetting(userId, "globalDatabanks", next);
}

export class FuseError extends Error {
  constructor(public readonly type: "invalid" | "not_found", message: string) {
    super(message);
    this.name = "FuseError";
  }
}
