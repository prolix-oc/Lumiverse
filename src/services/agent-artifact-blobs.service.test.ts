import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runMigrations } from "../db/migrate";
import type { WorkspaceArtifactProvenanceV1 } from "../types/turn-workspace";
import {
  ArtifactBlobStore,
  artifactDigest,
  getArtifactReconcileStatus,
  releaseArtifactBlobReference,
  withArtifactUserDeletionFence,
  publishArtifactCommit,
  type ArtifactBlobHandle,
  type ArtifactBlobWriteInput,
  type ArtifactPublicationInput,
  type ArtifactReconcileResult,
} from "./agent-artifact-blobs.service";

const USER_ID = "artifact-user";
const CHAT_ID = "artifact-chat";
const TURN_ID = "artifact-turn";
const EXECUTION_ID = TURN_ID;
const WORKSPACE_ID = "artifact-workspace";
const OTHER_USER_ID = "artifact-user-two";
const OTHER_TURN_ID = "artifact-turn-two";
const OTHER_WORKSPACE_ID = "artifact-workspace-two";
const NOW_MS = 1_700_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const PROVENANCE: WorkspaceArtifactProvenanceV1 = "root";

let db: Database;
let rootDir: string;
let store: ArtifactBlobStore;

function insertHostRows(): void {
  db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(USER_ID, "Artifact User", "artifact@example.test");
  db.query("INSERT INTO chats (id, character_id, name, metadata, user_id) VALUES (?, NULL, ?, '{}', ?)").run(CHAT_ID, "Artifact Chat", USER_ID);
  db.query(`
    INSERT INTO agent_turn_executions
      (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
       runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
       workspace_id, commit_key, expires_at)
    VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, ?, 'PREPARE_COMMIT', '{}', '{}', ?, ?, ?)
  `).run(TURN_ID, USER_ID, CHAT_ID, TURN_ID, NOW_SECONDS + 60, WORKSPACE_ID, "commit-key", NOW_SECONDS + 600);
  db.query(`
    INSERT INTO agent_turn_workspaces
      (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json,
       state, operation_caps_json, field_caps_json, retention, expires_at,
       quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes)
    VALUES (?, ?, ?, ?, ?, 'objective', '{}', 'active', '{}', '{}', 'chat_lifetime', ?, 16, 16, 16, 16, 1048576)
  `).run(WORKSPACE_ID, TURN_ID, EXECUTION_ID, USER_ID, CHAT_ID, NOW_SECONDS + 600);
}

async function insertWorkspaceReference(input: { digest: string; byteCount: number; mimeType: string; artifactId?: string }, publicationState: "attached" | "proposed" = "proposed"): Promise<string> {
  const artifactId = input.artifactId ?? `workspace-artifact-${input.digest.slice(0, 8)}`;
  db.query(`
    INSERT INTO agent_workspace_artifacts
      (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
       byte_count, provenance_json, publication_state, retention, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chat_lifetime', ?)
  `).run(artifactId, WORKSPACE_ID, TURN_ID, USER_ID, CHAT_ID, input.digest, input.mimeType, input.byteCount, JSON.stringify(PROVENANCE), publicationState, NOW_SECONDS + 600);
  return artifactId;
}
function insertPersistentWorkspace(id: string): void {
  db.query("INSERT INTO persistent_workspaces (workspace_id, user_id, chat_id) VALUES (?, ?, ?)").run(id, USER_ID, CHAT_ID);
}

function insertPersistentArtifactReference(digest: string, byteCount: number, mimeType: string, workspaceId: string, artifactId: string): void {
  db.query(`
    INSERT INTO persistent_workspace_artifacts
      (artifact_id, workspace_id, user_id, chat_id, blob_digest, mime_type, byte_count, provenance_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, '{}')
  `).run(artifactId, workspaceId, USER_ID, CHAT_ID, digest, mimeType, byteCount);
}

function insertPersistentArtifactPublication(digest: string, byteCount: number, workspaceId: string, publicationId: string): void {
  const copy = JSON.stringify({ category: "artifact", id: "persistent-source", blobDigest: digest, mimeType: "application/octet-stream", byteCount, provenance: "{}" });
  db.query(`
    INSERT INTO persistent_workspace_publications
      (publication_id, workspace_id, user_id, chat_id, category, source_id, source_revision,
       source_provenance_json, source_created_at, source_updated_at, copy_json, copy_digest,
       byte_count, published_by)
    VALUES (?, ?, ?, ?, 'artifact', 'persistent-source', 1, '{}', ?, ?, ?, ?, ?, 'test')
  `).run(publicationId, workspaceId, USER_ID, CHAT_ID, NOW_SECONDS, NOW_SECONDS, copy, artifactDigest(new TextEncoder().encode(copy)), byteCount);
}

function writeInput(bytes: Uint8Array, overrides: Partial<ArtifactBlobWriteInput> = {}): ArtifactBlobWriteInput {
  return {
    userId: USER_ID,
    turnId: TURN_ID,
    workspaceId: WORKSPACE_ID,
    bytes,
    digest: artifactDigest(bytes),
    mimeType: "application/octet-stream",
    provenance: PROVENANCE,
    retention: "turn_terminal",
    expiresAt: NOW_SECONDS + 600,
    fence: 1,
    assertFence: () => {},
    creatorToken: undefined,
    ...overrides,
  };
}

function publication(handle: ArtifactBlobHandle, sourceArtifactId: string): ArtifactPublicationInput {
  return {
    digest: handle.digest,
    byteCount: handle.byteCount,
    mimeType: handle.mimeType,
    provenance: PROVENANCE,
    retention: "chat_lifetime",
    messageId: null,
    swipeId: null,
    workspaceArtifactId: sourceArtifactId,
  };
}

function publish(handle: ArtifactBlobHandle, sourceArtifactId: string, commitKey = "commit-key") {
  return db.transaction(() => publishArtifactCommit(db, {
    userId: USER_ID,
    chatId: CHAT_ID,
    turnId: TURN_ID,
    executionId: EXECUTION_ID,
    workspaceId: WORKSPACE_ID,
    commitKey,
    receiptId: `receipt-${commitKey}`,
    targetMessageId: null,
    targetSwipeId: null,
    assertFence: () => {},
    refs: [publication(handle, sourceArtifactId)],
  }))();
}
async function hasFiles(path: string): Promise<boolean> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await hasFiles(join(path, entry.name))) return true;
  }
  return false;
}

beforeEach(async () => {
  db = new Database(":memory:");
  await runMigrations(db);
  db.run("PRAGMA foreign_keys = ON");
  insertHostRows();
  rootDir = await mkdtemp(join(tmpdir(), "lumiverse-agent-artifacts-"));
  store = new ArtifactBlobStore({ db, rootDir, now: () => NOW_MS });
});

afterEach(async () => {
  db.close();
  await rm(rootDir, { recursive: true, force: true });
});

describe("agent artifact blob store", () => {
  test("deduplicates identical digest bytes and keeps one immutable blob", async () => {
    const bytes = new TextEncoder().encode("same bytes");
    const first = await store.stageArtifact(writeInput(bytes));
    const second = await store.stageArtifact(writeInput(bytes));
    expect(second.digest).toBe(first.digest);
    expect(second.createdByThisOperation).toBe(false);

    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs").get()).toEqual({ count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blob_journal").get()).toEqual({ count: 1 });
  });
  test("scopes same-digest blobs, metadata, paths, and refcounts by user", async () => {
    const bytes = new TextEncoder().encode("same digest across users");
    db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(OTHER_USER_ID, "Artifact User Two", "artifact-two@example.test");
    const other = await store.stageArtifact(writeInput(bytes, {
      userId: OTHER_USER_ID,
      turnId: OTHER_TURN_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      mimeType: "text/plain",
      retention: "chat_lifetime",
    }));
    const first = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    expect(other.digest).toBe(first.digest);
    expect(other.storagePath).not.toBe(first.storagePath);
    expect(db.query("SELECT mime_type, storage_path, published_reference_count FROM agent_artifact_blobs WHERE digest = ? AND user_id = ?").get(first.digest, OTHER_USER_ID)).toEqual({
      mime_type: "text/plain",
      storage_path: other.storagePath,
      published_reference_count: 0,
    });
    const sourceArtifactId = await insertWorkspaceReference(first);
    publish(first, sourceArtifactId);
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE digest = ? AND user_id = ?").get(first.digest, USER_ID)).toEqual({ published_reference_count: 1 });
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE digest = ? AND user_id = ?").get(other.digest, OTHER_USER_ID)).toEqual({ published_reference_count: 0 });
    expect(db.query("SELECT storage_path FROM agent_published_workspace_artifacts WHERE blob_digest = ? AND user_id = ?").get(first.digest, USER_ID)).toEqual({ storage_path: `${first.digest}.blob` });
  });
  test("repairs a legacy absolute publication path during idempotent republish", async () => {
    const handle = await store.stageArtifact(writeInput(new TextEncoder().encode("portable republish")));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    publish(handle, sourceArtifactId);
    db.run("DROP TRIGGER trg_agent_published_artifact_relative_path_update");
    db.query(
      "UPDATE agent_published_workspace_artifacts SET storage_path = ? WHERE user_id = ? AND blob_digest = ?",
    ).run(handle.storagePath, USER_ID, handle.digest);
    db.query("UPDATE agent_workspace_artifacts SET publication_state = 'proposed' WHERE artifact_id = ?")
      .run(sourceArtifactId);

    expect(publish(handle, sourceArtifactId).duplicate).toBe(true);
    expect(db.query(
      "SELECT storage_path FROM agent_published_workspace_artifacts WHERE user_id = ? AND blob_digest = ?",
    ).get(USER_ID, handle.digest)).toEqual({ storage_path: `${handle.digest}.blob` });
  });

  test("rejects nonportable canonical publication paths at the database boundary", async () => {
    const handle = await store.stageArtifact(writeInput(new TextEncoder().encode("portable guard")));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    publish(handle, sourceArtifactId);
    expect(() => db.query(
      "UPDATE agent_published_workspace_artifacts SET storage_path = ? WHERE user_id = ? AND blob_digest = ?",
    ).run(handle.storagePath, USER_ID, handle.digest)).toThrow(
      "published artifact storage_path must be portable and owner-relative",
    );
  });
  test("counts a deduped blob once per turn while enforcing turn quota", async () => {
    const bounded = new ArtifactBlobStore({ db, rootDir, now: () => NOW_MS, limits: { maxTurnBytes: 3 } });
    const bytes = new TextEncoder().encode("abc");
    await bounded.stageArtifact(writeInput(bytes));
    await bounded.stageArtifact(writeInput(bytes));
    await expect(bounded.stageArtifact(writeInput(new Uint8Array([1])))).rejects.toMatchObject({ code: "artifact_turn_quota_exceeded" });
    expect(db.query("SELECT COALESCE(SUM(byte_count), 0) AS bytes FROM agent_artifact_blob_journal WHERE turn_id = ? AND state != 'removed'").get(TURN_ID)).toEqual({ bytes: 3 });
  });


  test("accepts a preexisting same-digest destination without claiming its identity", async () => {
    const bytes = new TextEncoder().encode("preexisting");
    const digest = artifactDigest(bytes);
    const userRoot = join(rootDir, USER_ID);
    await mkdir(userRoot, { recursive: true });
    await Bun.write(join(userRoot, `${digest}.blob`), bytes);
    const handle = await store.stageArtifact(writeInput(bytes));
    expect(handle.createdByThisOperation).toBe(false);
    const before = statSync(handle.storagePath);
    await store.reconcile();
    expect(Bun.file(handle.storagePath).size).toBe(bytes.byteLength);
    expect(statSync(handle.storagePath).ino).toBe(before.ino);
  });

  test("rejects a caller-supplied digest mismatch before writing bytes", async () => {
    const bytes = new TextEncoder().encode("digest mismatch");
    await expect(store.stageArtifact(writeInput(bytes, { digest: "0".repeat(64) }))).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs").get()).toEqual({ count: 0 });
  });
  test("does not overwrite a same-path file whose bytes mismatch the requested digest", async () => {
    const requested = new TextEncoder().encode("requested bytes");
    const existing = new TextEncoder().encode("different bytes");
    const digest = artifactDigest(requested);
    const userRoot = join(rootDir, USER_ID);
    await mkdir(userRoot, { recursive: true });
    const path = join(userRoot, `${digest}.blob`);
    await Bun.write(path, existing);
    await expect(store.stageArtifact(writeInput(requested))).rejects.toMatchObject({ code: "artifact_digest_conflict" });
    expect(new TextDecoder().decode(await Bun.file(path).arrayBuffer())).toBe("different bytes");
    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs").get()).toEqual({ count: 0 });
  });

  test("rejects a symlinked destination before registering bytes", async () => {
    const bytes = new TextEncoder().encode("symlink target");
    const digest = artifactDigest(bytes);
    const userRoot = join(rootDir, USER_ID);
    const outsideRoot = await mkdtemp(join(tmpdir(), "lumiverse-artifact-symlink-"));
    try {
      await mkdir(userRoot, { recursive: true });
      const outsidePath = join(outsideRoot, "outside.blob");
      await Bun.write(outsidePath, bytes);
      await symlink(outsidePath, join(userRoot, `${digest}.blob`));

      await expect(store.stageArtifact(writeInput(bytes))).rejects.toMatchObject({ code: "artifact_digest_conflict" });
      expect(await Bun.file(outsidePath).exists()).toBe(true);
      expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs").get()).toEqual({ count: 0 });
    } finally {
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  test("reconciles a crash after link and before the journal result", async () => {
    const bytes = new TextEncoder().encode("crash window");
    let checks = 0;
    const input = writeInput(bytes, {
      creatorToken: "crash-owner",
      assertFence: () => {
        checks++;
        if (checks === 3) throw new Error("stale after link");
      },
    });
    await expect(store.stageArtifact(input)).rejects.toMatchObject({ code: "artifact_fence_lost" });
    const digest = artifactDigest(bytes);
    const finalPath = join(rootDir, USER_ID, `${digest}.blob`);
    expect(await Bun.file(finalPath).exists()).toBe(true);
    const result = await store.reconcile();
    expect(result.removed).toBe(1);
    expect(await Bun.file(finalPath).exists()).toBe(false);
    expect(db.query("SELECT state FROM agent_artifact_blob_journal WHERE blob_digest = ?").get(digest)).toBeNull();
  });

  test("does not start filesystem work after a stale fence", async () => {
    const bytes = new TextEncoder().encode("stale fence");
    await expect(store.stageArtifact(writeInput(bytes, {
      assertFence: () => { throw new Error("owner changed"); },
    }))).rejects.toMatchObject({ code: "artifact_fence_lost" });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs").get()).toEqual({ count: 0 });
    expect(await hasFiles(rootDir)).toBe(false);
  });
  test("rejects an attached workspace artifact until the host proposes publication", async () => {
    const bytes = new TextEncoder().encode("attached only");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    const sourceArtifactId = await insertWorkspaceReference(handle, "attached");
    expect(() => publish(handle, sourceArtifactId)).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(sourceArtifactId)).toEqual({ publication_state: "attached" });
  });


  test("publishes a chat-owned reference and increments the blob refcount atomically", async () => {
    const bytes = new TextEncoder().encode("publish me");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    const before = statSync(handle.storagePath);
    const receipt = publish(handle, sourceArtifactId);
    expect(receipt.duplicate).toBe(false);
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE digest = ?").get(handle.digest)).toEqual({ published_reference_count: 1 });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE blob_digest = ?").get(handle.digest)).toEqual({ count: 1 });
    expect(db.query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(sourceArtifactId)).toEqual({ publication_state: "published" });
    expect(statSync(handle.storagePath).ino).toBe(before.ino);
    expect(statSync(handle.storagePath).size).toBe(before.size);
  });
  test("settles an authorized deduplicated source without increasing the durable refcount", async () => {
    const bytes = new TextEncoder().encode("deduplicated publication");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    const firstSource = await insertWorkspaceReference(handle, "proposed");
    publish(handle, firstSource, "dedup-first");

    const secondTurnId = "artifact-turn-dedup";
    const secondWorkspaceId = "artifact-workspace-dedup";
    const secondSource = "workspace-artifact-dedup";
    db.query(`
      INSERT INTO agent_turn_executions
        (id, user_id, chat_id, generation_id, target_kind, target_chat_revision, mode,
         runtime_epoch, deadline_at, state, root_ledger_json, frame_capabilities_json,
         workspace_id, commit_key, expires_at)
      VALUES (?, ?, ?, ?, 'normal', 0, 'agentic', 1, ?, 'PREPARE_COMMIT', '{}', '{}', ?, ?, ?)
    `).run(secondTurnId, USER_ID, CHAT_ID, "artifact-generation-dedup", NOW_SECONDS + 60, secondWorkspaceId, "commit-dedup", NOW_SECONDS + 600);
    db.query(`
      INSERT INTO agent_turn_workspaces
        (workspace_id, turn_id, execution_id, user_id, chat_id, objective, constraints_json,
         state, operation_caps_json, field_caps_json, retention, expires_at,
         quota_tasks, quota_records, quota_submissions, quota_artifacts, quota_bytes)
      VALUES (?, ?, ?, ?, ?, 'objective', '{}', 'active', '{}', '{}', 'chat_lifetime', ?, 16, 16, 16, 16, 1048576)
    `).run(secondWorkspaceId, secondTurnId, secondTurnId, USER_ID, CHAT_ID, NOW_SECONDS + 600);
    const secondHandle = await store.stageArtifact(writeInput(bytes, {
      turnId: secondTurnId,
      workspaceId: secondWorkspaceId,
      retention: "chat_lifetime",
    }));
    db.query(`
      INSERT INTO agent_workspace_artifacts
        (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
         byte_count, provenance_json, publication_state, retention, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'chat_lifetime', ?)
    `).run(secondSource, secondWorkspaceId, secondTurnId, USER_ID, CHAT_ID, secondHandle.digest, secondHandle.mimeType, secondHandle.byteCount, JSON.stringify(PROVENANCE), NOW_SECONDS + 600);
    const receipt = db.transaction(() => publishArtifactCommit(db, {
      userId: USER_ID,
      chatId: CHAT_ID,
      turnId: secondTurnId,
      executionId: secondTurnId,
      workspaceId: secondWorkspaceId,
      commitKey: "dedup-second",
      receiptId: "receipt-dedup-second",
      targetMessageId: null,
      targetSwipeId: null,
      assertFence: () => {},
      refs: [publication(secondHandle, secondSource)],
    }))();
    expect(receipt.duplicate).toBe(true);
    expect(db.query("SELECT publication_state FROM agent_workspace_artifacts WHERE artifact_id = ?").get(secondSource)).toEqual({ publication_state: "published" });
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER_ID, handle.digest)).toEqual({ published_reference_count: 1 });
    expect(db.query("SELECT receipt_id FROM agent_published_workspace_artifacts WHERE user_id = ? AND blob_digest = ?").get(USER_ID, handle.digest)).toEqual({ receipt_id: "receipt-dedup-second" });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts WHERE user_id = ? AND blob_digest = ?").get(USER_ID, handle.digest)).toEqual({ count: 1 });
  });

  test("keeps persistent artifact publication bytes live through source deletion and releases the final copy for cleanup", async () => {
    const bytes = new TextEncoder().encode("persistent publication bytes");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime", expiresAt: 1 }));
    const persistentWorkspaceId = "persistent-artifact-liveness";
    insertPersistentWorkspace(persistentWorkspaceId);
    insertPersistentArtifactReference(handle.digest, handle.byteCount, handle.mimeType, persistentWorkspaceId, "persistent-source-artifact");
    insertPersistentArtifactPublication(handle.digest, handle.byteCount, persistentWorkspaceId, "persistent-copy-publication");

    const protectedCleanup = await store.cleanup({ now: 2 });
    expect(protectedCleanup.skippedReferenced).toBe(1);
    expect(await Bun.file(handle.storagePath).exists()).toBe(true);

    db.query("DELETE FROM persistent_workspace_artifacts WHERE artifact_id = ?").run("persistent-source-artifact");
    const sourceDeleted = await store.reconcile();
    expect(sourceDeleted.retained).toBeGreaterThan(0);
    expect(new Uint8Array(await Bun.file(handle.storagePath).arrayBuffer())).toEqual(bytes);

    db.query("DELETE FROM persistent_workspace_publications WHERE publication_id = ?").run("persistent-copy-publication");
    releaseArtifactBlobReference(db, handle.digest, USER_ID);
    const releasedReconcile = await store.reconcile();
    expect(releasedReconcile.removed).toBe(1);
    expect(await Bun.file(handle.storagePath).exists()).toBe(false);
    const releasedCleanup = await store.cleanup({ now: 2 });
    expect(releasedCleanup.removed).toBe(0);
  });

  test("rejects publication when the journaled final bytes are missing", async () => {
    const bytes = new TextEncoder().encode("missing publication bytes");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    await rm(handle.storagePath, { force: true });
    expect(() => publish(handle, sourceArtifactId, "missing-bytes")).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER_ID, handle.digest)).toEqual({ published_reference_count: 0 });
  });

  test("cleanup cannot remove an artifact that is published while cleanup is queued", async () => {
    const bytes = new TextEncoder().encode("cleanup publication fence");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime", expiresAt: 1 }));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    const cleanupPromise = Promise.resolve().then(() => store.cleanup({ now: 2 }));
    publish(handle, sourceArtifactId, "cleanup-publication");
    const cleanup = await cleanupPromise;
    expect(cleanup.removed).toBe(0);
    expect(await Bun.file(handle.storagePath).exists()).toBe(true);
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE user_id = ? AND digest = ?").get(USER_ID, handle.digest)).toEqual({ published_reference_count: 1 });
  });
  test("reconciliation waits for an in-flight staging fence before inspecting bytes", async () => {
    const bytes = new TextEncoder().encode("reconcile during stage");
    const sourceArtifactId = "workspace-artifact-stage-fence";
    let checks = 0;
    let reconcilePromise: Promise<ArtifactReconcileResult> | undefined;
    const handle = await store.stageArtifact(writeInput(bytes, {
      assertFence: () => {
        checks++;
        if (checks !== 2) return;
        reconcilePromise = store.reconcile();
        db.query(`
          INSERT INTO agent_workspace_artifacts
            (artifact_id, workspace_id, turn_id, user_id, chat_id, blob_digest, mime_type,
             byte_count, provenance_json, publication_state, retention, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 'chat_lifetime', ?)
        `).run(sourceArtifactId, WORKSPACE_ID, TURN_ID, USER_ID, CHAT_ID, artifactDigest(bytes), "application/octet-stream", bytes.byteLength, JSON.stringify(PROVENANCE), NOW_SECONDS + 600);
      },
    }));
    const result = await reconcilePromise!;
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(result.retained).toBe(1);
    expect(await Bun.file(handle.storagePath).exists()).toBe(true);
    expect(db.query("SELECT state FROM agent_artifact_blob_journal WHERE user_id = ? AND blob_digest = ?").get(USER_ID, handle.digest)).toEqual({ state: "installed" });
  });

  test("restart reconciliation clears a stale deletion marker without deleting referenced bytes", async () => {
    const bytes = new TextEncoder().encode("restart protected bytes");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    await insertWorkspaceReference(handle);
    const journal = db.query("SELECT observed_identity FROM agent_artifact_blob_journal WHERE user_id = ? AND blob_digest = ?").get(USER_ID, handle.digest) as { observed_identity: string };
    const marker = JSON.parse(journal.observed_identity) as Record<string, unknown>;
    db.query("UPDATE agent_artifact_blob_journal SET observed_identity = ? WHERE user_id = ? AND blob_digest = ?").run(JSON.stringify({ ...marker, deleting: true }), USER_ID, handle.digest);
    const restarted = new ArtifactBlobStore({ db, rootDir, now: () => NOW_MS });
    const result = await restarted.reconcile();
    expect(result.retained).toBe(1);
    expect(await Bun.file(handle.storagePath).exists()).toBe(true);
    const repaired = db.query("SELECT observed_identity FROM agent_artifact_blob_journal WHERE user_id = ? AND blob_digest = ?").get(USER_ID, handle.digest) as { observed_identity: string };
    expect(JSON.parse(repaired.observed_identity).deleting).toBe(false);
  });
  test("rejects a published source on a fresh commit instead of replaying publication", async () => {
    const bytes = new TextEncoder().encode("published source");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    const first = publish(handle, sourceArtifactId);
    expect(first.duplicate).toBe(false);
    expect(() => publish(handle, sourceArtifactId, "replay-key")).toThrow();
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE digest = ?").get(handle.digest)).toEqual({ published_reference_count: 1 });
  });

  test("rolls back all relational publication rows when a later artifact is unauthorized", async () => {
    const bytes = new TextEncoder().encode("rollback");
    const handle = await store.stageArtifact(writeInput(bytes, { retention: "chat_lifetime" }));
    const sourceArtifactId = await insertWorkspaceReference(handle);
    const invalid: ArtifactPublicationInput = {
      digest: "f".repeat(64),
      byteCount: 1,
      mimeType: "application/octet-stream",
      provenance: PROVENANCE,
      retention: "chat_lifetime",
      messageId: null,
      workspaceArtifactId: "missing-workspace-artifact",
      swipeId: null,
    };
    expect(() => db.transaction(() => publishArtifactCommit(db, {
      userId: USER_ID,
      chatId: CHAT_ID,
      turnId: TURN_ID,
      executionId: EXECUTION_ID,
      workspaceId: WORKSPACE_ID,
      commitKey: "rollback-key",
      receiptId: "receipt-rollback-key",
      targetMessageId: null,
      targetSwipeId: null,
      assertFence: () => {},
      refs: [publication(handle, sourceArtifactId), invalid],
    }))()).toThrow();
    expect(db.query("SELECT COUNT(*) AS count FROM agent_published_workspace_artifacts").get()).toEqual({ count: 0 });
    expect(db.query("SELECT published_reference_count FROM agent_artifact_blobs WHERE digest = ?").get(handle.digest)).toEqual({ published_reference_count: 0 });
  });

  test("cleans expired creator-owned bytes but never removes a same-digest preexisting file", async () => {
    const owned = await store.stageArtifact(writeInput(new TextEncoder().encode("owned"), { expiresAt: 1, creatorToken: "cleanup-owned" }));
    const existingBytes = new TextEncoder().encode("shared");
    const existingDigest = artifactDigest(existingBytes);
    await Bun.write(join(rootDir, USER_ID, `${existingDigest}.blob`), existingBytes);
    const existing = await store.stageArtifact(writeInput(existingBytes, { expiresAt: 1, creatorToken: "cleanup-shared" }));
    const result = await store.cleanup({ now: 2 });
    expect(result.removed).toBe(1);
    expect(await Bun.file(owned.storagePath).exists()).toBe(false);

    expect(await Bun.file(existing.storagePath).exists()).toBe(true);
  });
  test("quarantines foreign journal paths without deleting their bytes", async () => {
    const foreignRoot = await mkdtemp(join(tmpdir(), "lumiverse-foreign-artifacts-"));
    try {
      const bytes = new TextEncoder().encode("foreign bytes");
      const digest = artifactDigest(bytes);
      const finalPath = join(foreignRoot, `${digest}.blob`);
      await Bun.write(finalPath, bytes);
      db.query(`
        INSERT INTO agent_artifact_blobs
          (digest, user_id, byte_count, mime_type, storage_path, provenance_json, retention, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'turn_terminal', ?)
      `).run(digest, USER_ID, bytes.byteLength, "application/octet-stream", finalPath, JSON.stringify(PROVENANCE), 1);
      db.query(`
        INSERT INTO agent_artifact_blob_journal
          (journal_id, blob_digest, user_id, turn_id, creator_token, fence_generation,
           staged_path, final_path, state, observed_identity, byte_count, digest)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'installed', ?, ?, ?)
      `).run("foreign-journal", digest, USER_ID, TURN_ID, "foreign-creator", finalPath, finalPath, JSON.stringify({ before: null, createdByUs: true }), bytes.byteLength, digest);
      const result = await store.reconcile();
      expect(result.quarantined).toBe(1);
      expect(await Bun.file(finalPath).exists()).toBe(true);
      expect(db.query("SELECT state FROM agent_artifact_blob_journal WHERE journal_id = ?").get("foreign-journal")).toEqual({ state: "installed" });
    } finally {
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });
  test("waits for an in-flight stage before account deletion and blocks later stages", async () => {
    let deletion: Promise<string> | undefined;
    let checkpoints = 0;
    const bytes = new TextEncoder().encode("stage then purge");
    const handle = await store.stageArtifact(writeInput(bytes, {
      assertFence: () => {
        checkpoints++;
        if (checkpoints === 1) {
          deletion = withArtifactUserDeletionFence(USER_ID, async () => "purged");
        }
      },
    }));
    expect(handle.digest).toBe(artifactDigest(bytes));
    expect(await deletion).toBe("purged");

    const held = withArtifactUserDeletionFence(USER_ID, async () => "done");
    await expect(store.stageArtifact(writeInput(new TextEncoder().encode("blocked after purge")))).rejects.toMatchObject({ code: "artifact_fence_lost" });
    expect(await held).toBe("done");
  });

  test("purge failure releases only its user lifecycle fence", async () => {
    await expect(withArtifactUserDeletionFence(USER_ID, async () => {
      throw new Error("purge failed");
    })).rejects.toThrow("purge failed");
    const other = await withArtifactUserDeletionFence(OTHER_USER_ID, async () => "other-user");
    expect(other).toBe("other-user");
    const bytes = new TextEncoder().encode("reuse after failed purge");
    await expect(store.stageArtifact(writeInput(bytes))).resolves.toMatchObject({ digest: artifactDigest(bytes) });
  });
  test("stale stage cannot recreate a purged user, but a recreated user may stage again", async () => {
    await withArtifactUserDeletionFence(USER_ID, async () => {
      db.run("PRAGMA foreign_keys = OFF");
      db.query('DELETE FROM "user" WHERE id = ?').run(USER_ID);
      db.run("PRAGMA foreign_keys = ON");
      await rm(join(rootDir, USER_ID), { recursive: true, force: true });
    });
    const staleBytes = new TextEncoder().encode("stale post-purge stage");
    await expect(store.stageArtifact(writeInput(staleBytes))).rejects.toMatchObject({ code: "artifact_invalid_user" });
    db.query('INSERT INTO "user" (id, name, email) VALUES (?, ?, ?)').run(USER_ID, "Recreated Artifact User", "recreated-artifact@example.test");
    const recreatedBytes = new TextEncoder().encode("recreated user stage");
    await expect(store.stageArtifact(writeInput(recreatedBytes))).resolves.toMatchObject({ digest: artifactDigest(recreatedBytes) });
  });


  test("retries lifecycle-blocked reconciliation to convergence after the deletion fence releases", async () => {
    const bytes = new TextEncoder().encode("blocked reconcile retry");
    const handle = await store.stageArtifact(writeInput(bytes));
    let blocked: ArtifactReconcileResult | undefined;
    await withArtifactUserDeletionFence(USER_ID, async () => {
      blocked = await store.reconcile({ userId: USER_ID });
      expect(blocked.pendingUsers).toBeGreaterThan(0);
      expect(getArtifactReconcileStatus().healthy).toBe(false);
    });
    await store.reconcilePendingUsers();
    expect(getArtifactReconcileStatus().pendingUsers).toBe(0);
    expect(await Bun.file(handle.storagePath).exists()).toBe(false);
  });
  test("keeps global reconciliation unhealthy when a bounded pass leaves durable rows", async () => {
    const maxRows = 128;
    for (let index = 0; index <= maxRows; index++) {
      await store.stageArtifact(writeInput(new TextEncoder().encode(`bounded global ${index}`)));
    }

    const first = await store.reconcile({ maxRows });
    expect(first.inspected).toBe(maxRows);
    expect(first.removed).toBe(maxRows);
    expect(first.pendingUsers).toBe(0);
    expect(first.pendingOverflow).toBe(false);
    expect(first.healthy).toBe(false);
    expect(getArtifactReconcileStatus().healthy).toBe(false);

    const second = await store.reconcile({ maxRows });
    expect(second.inspected).toBe(1);
    expect(second.removed).toBe(1);
    expect(second.healthy).toBe(true);
    expect(getArtifactReconcileStatus().healthy).toBe(true);
  });
  test("advances global reconciliation past a retained bounded page", async () => {
    const maxRows = 128;
    for (let index = 0; index <= maxRows; index++) {
      const handle = await store.stageArtifact(writeInput(new TextEncoder().encode(`bounded retained ${index}`)));
      await insertWorkspaceReference(handle);
    }

    const first = await store.reconcile({ maxRows });
    expect(first.inspected).toBe(maxRows);
    expect(first.retained).toBe(maxRows);
    expect(first.pendingUsers).toBe(0);
    expect(first.healthy).toBe(false);

    const second = await store.reconcile({ maxRows });
    expect(second.inspected).toBe(1);
    expect(second.retained).toBe(1);
    expect(second.healthy).toBe(true);
    expect(getArtifactReconcileStatus().healthy).toBe(true);
  });


  test("resets global continuation when the database authority is replaced", async () => {
    const maxRows = 128;
    for (let index = 0; index <= maxRows; index++) {
      await store.stageArtifact(writeInput(new TextEncoder().encode(`authority replacement ${index}`)));
    }
    const first = await store.reconcile({ maxRows });
    expect(first.healthy).toBe(false);

    const replacementDb = new Database(":memory:");
    const replacementRoot = await mkdtemp(join(tmpdir(), "lumiverse-agent-artifacts-replacement-"));
    try {
      await runMigrations(replacementDb);
      const replacementStore = new ArtifactBlobStore({ db: replacementDb, rootDir: replacementRoot, now: () => NOW_MS });
      const replacement = await replacementStore.reconcile({ maxRows });
      expect(replacement.inspected).toBe(0);
      expect(replacement.healthy).toBe(true);
      expect(getArtifactReconcileStatus().healthy).toBe(true);
    } finally {
      replacementDb.close();
      await rm(replacementRoot, { recursive: true, force: true });
    }
  });
  test("enforces MIME and per-artifact byte caps before allocating filesystem state", async () => {
    const bounded = new ArtifactBlobStore({ db, rootDir, now: () => NOW_MS, limits: { maxArtifactBytes: 2 } });
    await expect(bounded.stageArtifact(writeInput(new Uint8Array([1, 2, 3])))).rejects.toMatchObject({ code: "artifact_size_limit_exceeded" });
    await expect(store.stageArtifact(writeInput(new Uint8Array([1]), { mimeType: "not-a-mime" }))).rejects.toMatchObject({ code: "artifact_invalid_mime" });
    expect(db.query("SELECT COUNT(*) AS count FROM agent_artifact_blobs").get()).toEqual({ count: 0 });
  });
});
