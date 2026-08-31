import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { link, mkdtemp, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import { runMigrations } from "../../db/migrate";
import { env } from "../../env";
import {
  __test__,
  cancelImportForUser,
  getJob,
  isOwnedImportStagingPath,
  pruneTerminalImportJobs,
  reconcileUserDataImports,
  MAX_IMPORT_STARTUP_RECONCILIATION_ROWS,
  releaseImportUpload,
  reserveImportUpload,
  startImport,
  type ImportJob,
} from "./import.service";
import { getArchiveTableSpec } from "./table-registry";

const roots: string[] = [];

afterEach(async () => {

  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable import startup recovery", () => {
  let workDir = "";
  let originalDataDir = "";

  beforeEach(async () => {
    closeDatabase();
    workDir = await mkdtemp(join(tmpdir(), "lumiverse-import-reconcile-"));
    roots.push(workDir);
    originalDataDir = env.dataDir;
    env.dataDir = workDir;
    initDatabase(":memory:");

    await runMigrations(getDb());
    getDb().query(
      "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
    ).run("reconcile-user", "Reconcile User", "reconcile@example.com", 0, 0);
  });

  async function createExpiredFileJournal(
    jobId: string,
    mode: "linked" | "tampered" | "unproven-fallback",
    keepLiveReference = false,
    payloadBytes: Uint8Array = Buffer.from("creator-proof"),
  ): Promise<{ finalPath: string; stagingPath: string; filename: string; archivePath: string }> {
    const filename = jobId === "crash-link"
      ? "11111111-1111-1111-1111-111111111111.mp3"
      : jobId === "live-reference"
        ? "22222222-2222-2222-2222-222222222222.mp3"
        : "33333333-3333-3333-3333-333333333333.mp3";
    const stagingDir = join(workDir, "imports", "reconcile-user", jobId, "staging");
    const archivePath = join(dirname(stagingDir), "archive.lvbak");
    const stagingPath = join(stagingDir, filename);
    const bytes = Buffer.from(payloadBytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const token = crypto.randomUUID();
    const finalPath = mode === "unproven-fallback"
      ? join(workDir, "audio", ".lv-import", `${jobId}-${digest}-${filename}`)
      : join(workDir, "audio", filename);
    await mkdir(stagingDir, { recursive: true });
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(archivePath, "uploaded-archive");
    await writeFile(stagingPath, bytes);
    if (mode === "linked") await link(stagingPath, finalPath);
    else if (mode === "tampered") await writeFile(finalPath, "tampered");
    else await writeFile(finalPath, bytes);
    const staged = await stat(stagingPath);
    const observed = mode === "linked" ? await stat(finalPath) : null;
    const observedJson = observed
      ? JSON.stringify({
        dev: Number(observed.dev),
        ino: Number(observed.ino),
        size: observed.size,
        mtimeMs: observed.mtimeMs,
      })
      : null;
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'installing', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      `archive-${jobId}`,
      `idempotency-${jobId}`,
      "0".repeat(64),
      "{}",
      stagingDir,
      join(stagingDir, "staging.sqlite"),
      "old-owner",
      now - 1,
      now - 10,
      now - 10,
    );
    getDb().query(
      `INSERT INTO user_data_import_files
        (job_id,archive_path,kind,staged_path,final_path,sha256,byte_count,required,
         install_token,staged_identity,observed_final_identity,install_state,created_at,updated_at)
       VALUES (?, ?, 'file', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      `files/audio/${filename}`,
      stagingPath,
      finalPath,
      digest,
      bytes.byteLength,
      token,
      JSON.stringify({
        dev: Number(staged.dev),
        ino: Number(staged.ino),
        size: staged.size,
        mtimeMs: staged.mtimeMs,
        creatorToken: token,
      }),
      observedJson,
      mode === "linked" ? "created" : "pending",
      now - 10,
      now - 10,
    );
    if (keepLiveReference) {
      getDb().query(
        `INSERT INTO audio_files
          (id,user_id,filename,original_filename,mime_type,size_bytes,duration_ms,created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        jobId,
        "reconcile-user",
        filename,
        filename,
        "audio/mpeg",
        bytes.byteLength,
        now,
      );
    }
    return { finalPath, stagingPath, filename, archivePath };
  }
  test("cancellation releases the durable reservation and global slot", async () => {
    const jobId = reserveImportUpload("reconcile-user");
    expect(jobId).toBeString();
    if (!jobId) return;

    expect(await cancelImportForUser("reconcile-user", jobId)).toBe("cancelled");
    expect(getDb().query("SELECT state FROM user_data_imports WHERE job_id = ?").get(jobId))
      .toEqual({ state: "cancelled" });

    const retryJobId = reserveImportUpload("reconcile-user");
    expect(retryJobId).toBeString();
    if (retryJobId) releaseImportUpload("reconcile-user", retryJobId);
  });

  test("cancels an ownerless parked job after restart and removes its staging", async () => {
    const jobId = "ownerless-cancel";
    const stagingPath = join(workDir, "imports", "reconcile-user", jobId, "staging");
    const archivePath = join(dirname(stagingPath), "archive.lvbak");
    await mkdir(stagingPath, { recursive: true });
    await writeFile(join(stagingPath, "sentinel"), "parked");
    await writeFile(archivePath, "archive");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_ticket', NULL, NULL, ?, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-ownerless-cancel",
      "idempotency-ownerless-cancel",
      "0".repeat(64),
      "{}",
      stagingPath,
      join(stagingPath, "staging.sqlite"),
      4,
      now - 10,
      now - 10,
    );

    expect(await cancelImportForUser("reconcile-user", jobId)).toBe("cancelled");
    expect(getDb().query(
      "SELECT state, staging_path, staging_db_path FROM user_data_imports WHERE job_id = ?",
    ).get(jobId)).toEqual({ state: "cancelled", staging_path: "", staging_db_path: "" });
    expect(await Bun.file(archivePath).exists()).toBe(false);
    expect(await Bun.file(stagingPath).exists()).toBe(false);
  });

  test("counts a leased ticket wait and never adopts its live lease", async () => {
    const jobId = "leased-awaiting";
    const archivePath = join(workDir, "leased-awaiting.lvbak");
    await writeFile(archivePath, "not a complete archive");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_ticket', ?, ?, ?, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-leased-awaiting",
      "idempotency-leased-awaiting",
      "0".repeat(64),
      "{}",
      "",
      "",
      "live-owner",
      now + 300,
      7,
      now - 10,
      now - 10,
    );

    await expect(startImport({
      userId: "reconcile-user",
      archivePath,
      jobId: "new-while-leased",
    })).rejects.toThrow("already running");
    await expect(startImport({
      userId: "reconcile-user",
      archivePath,
      jobId,
    })).rejects.toThrow("already leased");
    expect(getDb().query(
      "SELECT lease_owner, lease_generation FROM user_data_imports WHERE job_id = ?",
    ).get(jobId)).toEqual({ lease_owner: "live-owner", lease_generation: 7 });
  });

  test("does not renew an expired lease", () => {
    const jobId = "stale-renew";
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validating', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-stale-renew",
      "idempotency-stale-renew",
      "0".repeat(64),
      "{}",
      "",
      "",
      "old-owner",
      now - 1,
      now - 10,
      now - 10,
    );
    const staleJob: ImportJob = {
      jobId,
      userId: "reconcile-user",
      archiveId: "archive-stale-renew",
      status: "running",
      archivePath: "",
      startedAt: now - 10,
      finishedAt: null,
      manifest: null,
      summary: {},
      fileSummary: {},
      error: null,
      abort: new AbortController(),
      ticketGateState: "open",
      idempotencyKey: "idempotency-stale-renew",
      archiveDigest: "0".repeat(64),
      leaseOwner: "old-owner",
      leaseGeneration: 0,
      stagingDbPath: null,
      commitStarted: false,
    };
    expect(() => __test__.renewImportLease(staleJob)).toThrow("import lease fence lost");
    expect(getDb().query("SELECT lease_expires_at FROM user_data_imports WHERE job_id = ?").get(jobId))
      .toEqual({ lease_expires_at: now - 1 });
  });
  test("precomputes live references once for multi-file rollback", async () => {
    const referenceCount = 256;
    for (let index = 0; index < referenceCount; index++) {
      const filename = `live-reference-${index}.mp3`;
      getDb().query(
        `INSERT INTO audio_files
          (id,user_id,filename,original_filename,mime_type,size_bytes,duration_ms,created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(
        `live-reference-${index}`,
        "reconcile-user",
        filename,
        filename,
        "audio/mpeg",
        1,
        0,
      );
    }
    const fixture = await createExpiredFileJournal("live-reference", "linked", true);
    const now = Math.floor(Date.now() / 1000);
    getDb().query("UPDATE user_data_imports SET lease_expires_at = ?, updated_at = ? WHERE job_id = ?")
      .run(now + 300, now, "live-reference");
    const index = __test__.buildLiveFileReferenceIndex(getDb());
    expect(index.complete).toBe(true);
    expect(index.scannedReferences).toBe(referenceCount + 1);
    expect(index.scannedRows).toBe(referenceCount + 1);
    await __test__.rollbackCreatedFiles("live-reference", { leaseOwner: "old-owner", leaseGeneration: 0 }, index);
    expect(await Bun.file(fixture.finalPath).exists()).toBe(true);
    expect(__test__.liveFileReferenceExists(fixture.finalPath, index)).toBe(true);
  });
  test("stale owner cannot roll back files after lease takeover", async () => {
    const fixture = await createExpiredFileJournal("stale-owner", "linked");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `UPDATE user_data_imports
          SET state = 'failed', lease_owner = ?, lease_generation = 1, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ?`,
    ).run("new-owner", now + 300, now, "stale-owner");

    const staleJob: ImportJob = {
      jobId: "stale-owner",
      userId: "reconcile-user",
      archiveId: "archive-stale-owner",
      status: "failed",
      archivePath: "",
      startedAt: now - 10,
      finishedAt: now,
      manifest: null,
      summary: {},
      fileSummary: {},
      error: "import failed",
      abort: new AbortController(),
      ticketGateState: "open",
      idempotencyKey: "idempotency-stale-owner",
      archiveDigest: "0".repeat(64),
      leaseOwner: "old-owner",
      leaseGeneration: 0,
      stagingDbPath: null,
      commitStarted: false,
    };
    expect(__test__.cleanupTerminalImportStaging(staleJob, "failed")).toBe(false);
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(true);

    await __test__.rollbackCreatedFiles("stale-owner", { leaseOwner: "old-owner", leaseGeneration: 0 });
    expect(await Bun.file(fixture.finalPath).exists()).toBe(true);
    expect(getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("stale-owner"))
      .toEqual({ install_state: "created" });

    await __test__.rollbackCreatedFiles("stale-owner", { leaseOwner: "new-owner", leaseGeneration: 1 });
    expect(await Bun.file(fixture.finalPath).exists()).toBe(false);
    expect(getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("stale-owner"))
      .toEqual({ install_state: "removed" });
  });
  test("parks a ticket wait without blocking another user's upload", async () => {
    const fixture = await createExpiredFileJournal("awaiting-ticket", "linked");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `UPDATE user_data_imports
          SET state = 'awaiting_ticket', lease_expires_at = ?, updated_at = ?
        WHERE job_id = ?`,
    ).run(now + 300, now, "awaiting-ticket");
    getDb().query(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run("other-user", "Other User", "other@example.com", 0, 0);
    const job: ImportJob = {
      jobId: "awaiting-ticket",
      userId: "reconcile-user",
      archiveId: "archive-awaiting-ticket",
      status: "awaiting_ticket",
      archivePath: fixture.archivePath,
      startedAt: now - 10,
      finishedAt: null,
      manifest: null,
      summary: {},
      fileSummary: {},
      error: null,
      abort: new AbortController(),
      ticketGateState: "open",
      idempotencyKey: "idempotency-awaiting-ticket",
      archiveDigest: "0".repeat(64),
      leaseOwner: "old-owner",
      leaseGeneration: 0,
      stagingDbPath: null,
      commitStarted: false,
    };
    __test__.parkImportForTicket(job);
    expect(getDb().query("SELECT state, lease_owner, lease_expires_at FROM user_data_imports WHERE job_id = ?").get("awaiting-ticket"))
      .toEqual({ state: "awaiting_ticket", lease_owner: null, lease_expires_at: null });
    const reservation = reserveImportUpload("other-user");
    expect(reservation).toBeString();
    if (reservation) releaseImportUpload("other-user", reservation);
  });
  afterEach(() => {
    closeDatabase();
    env.dataDir = originalDataDir;
  });

  test("fails an expired import without deleting an untrusted staging path", async () => {
    const stagingPath = join(workDir, "foreign-staging");
    await mkdir(stagingPath, { recursive: true });
    await writeFile(join(stagingPath, "sentinel"), "keep");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validating', ?, ?, 0, ?, ?)`,
    ).run(
      "reconcile-job",
      "reconcile-user",
      "archive-reconcile",
      "idempotency-reconcile",
      "0".repeat(64),
      "{}",
      stagingPath,
      join(stagingPath, "staging.sqlite"),
      "old-owner",
      now - 1,
      now - 10,
      now - 10,
    );

    await reconcileUserDataImports();
    const row = getDb().query(
      "SELECT state, stable_error_code FROM user_data_imports WHERE job_id = ?",
    ).get("reconcile-job") as { state: string; stable_error_code: string | null };
    expect(row).toEqual({ state: "failed", stable_error_code: "manual_recovery_required" });
    expect(Bun.file(join(stagingPath, "sentinel")).exists()).resolves.toBe(true);
  });

  test("removes a job-owned file after a crash between link and journal result", async () => {
    const fixture = await createExpiredFileJournal("crash-link", "linked");
    await reconcileUserDataImports();
    expect(await Bun.file(fixture.finalPath).exists()).toBe(false);
    expect(
      getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("crash-link"),
    ).toEqual({ install_state: "removed" });
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(false);
    expect(await Bun.file(fixture.archivePath).exists()).toBe(false);
  });

  test("settles installed journals before receipt recovery removes staging", async () => {
    const fixture = await createExpiredFileJournal("receipt-settle", "linked");
    const now = Math.floor(Date.now() / 1000);
    getDb().query("UPDATE user_data_imports SET state = 'committed' WHERE job_id = ?").run("receipt-settle");
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-settle-id",
      "receipt-settle",
      "reconcile-user",
      "idempotency-receipt-settle",
      "0".repeat(64),
      "{}",
      now,
    );
    await reconcileUserDataImports();
    expect(getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("receipt-settle"))
      .toEqual({ install_state: "installed" });
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(false);
    expect(await Bun.file(fixture.archivePath).exists()).toBe(false);
  });

  test("yields while reconciling a large committed journal", async () => {
    const fixture = await createExpiredFileJournal(
      "receipt-large",
      "linked",
      false,
      Buffer.alloc(2 * 1024 * 1024, 0x61),
    );
    const now = Math.floor(Date.now() / 1000);
    getDb().query("UPDATE user_data_imports SET state = 'committed' WHERE job_id = ?").run("receipt-large");
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-large-id",
      "receipt-large",
      "reconcile-user",
      "idempotency-receipt-large",
      "0".repeat(64),
      "{}",
      now,
    );

    let reconciliationSettled = false;
    let heartbeatDuringReconciliation = false;
    const heartbeat = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        heartbeatDuringReconciliation = !reconciliationSettled;
        resolve();
      });
    });
    await reconcileUserDataImports();
    reconciliationSettled = true;
    await heartbeat;
    expect(heartbeatDuringReconciliation).toBe(true);
    expect(getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("receipt-large"))
      .toEqual({ install_state: "installed" });
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(false);
  });
  test("reconciles retained creator proofs for failed jobs", async () => {
    const fixture = await createExpiredFileJournal("failed-retained", "linked");
    getDb().query("UPDATE user_data_imports SET state = 'failed' WHERE job_id = ?").run("failed-retained");
    await reconcileUserDataImports();
    expect(await Bun.file(fixture.finalPath).exists()).toBe(false);
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(false);
    expect(getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("failed-retained"))
      .toEqual({ install_state: "removed" });
    expect(await Bun.file(fixture.archivePath).exists()).toBe(false);
  });
  test("removes the owned archive after cancelled recovery", async () => {
    const fixture = await createExpiredFileJournal("cancelled-retained", "linked");
    getDb().query("UPDATE user_data_imports SET state = 'cancelled' WHERE job_id = ?").run("cancelled-retained");
    await reconcileUserDataImports();
    expect(await Bun.file(fixture.finalPath).exists()).toBe(false);
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(false);
    expect(await Bun.file(fixture.archivePath).exists()).toBe(false);
  });
  test("retries expired cleanup_pending cancellation and converges creator-proof cleanup", async () => {
    const fixture = await createExpiredFileJournal("cleanup-pending-retry", "linked");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `UPDATE user_data_imports
          SET state = 'cleanup_pending', stable_error_code = 'cleanup_pending',
              stable_error = 'import cancellation cleanup is pending',
              lease_expires_at = ?, updated_at = ?, finished_at = NULL
        WHERE job_id = ?`,
    ).run(now - 1, now, "cleanup-pending-retry");

    await reconcileUserDataImports();

    expect(getDb().query(
      "SELECT state, stable_error_code, staging_path, staging_db_path FROM user_data_imports WHERE job_id = ?",
    ).get("cleanup-pending-retry")).toEqual({
      state: "cancelled",
      stable_error_code: "cancelled",
      staging_path: "",
      staging_db_path: "",
    });
    expect(await Bun.file(fixture.finalPath).exists()).toBe(false);
    expect(getDb().query(
      "SELECT install_state FROM user_data_import_files WHERE job_id = ?",
    ).get("cleanup-pending-retry")).toEqual({ install_state: "removed" });
    expect(await Bun.file(fixture.stagingPath).exists()).toBe(false);
    expect(await Bun.file(fixture.archivePath).exists()).toBe(false);
  });

  test("never removes a journaled file that has a live canonical reference", async () => {
    const fixture = await createExpiredFileJournal("live-reference", "linked", true);
    await reconcileUserDataImports();
    expect(await Bun.file(fixture.finalPath).exists()).toBe(true);
    expect(
      getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("live-reference"),
    ).toEqual({ install_state: "created" });
  });

  test("leaves a tampered final file untouched during rollback", async () => {
    const fixture = await createExpiredFileJournal("tampered-file", "tampered");
    await reconcileUserDataImports();
    expect(await Bun.file(fixture.finalPath).exists()).toBe(true);
    expect(new TextDecoder().decode(await Bun.file(fixture.finalPath).arrayBuffer())).toBe("tampered");
    expect(
      getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("tampered-file"),
    ).toEqual({ install_state: "pending" });
  });

  test("does not treat a content-addressed name without its creator token as ownership proof", async () => {
    const fixture = await createExpiredFileJournal("unproven-fallback", "unproven-fallback");
    await reconcileUserDataImports();
    expect(await Bun.file(fixture.finalPath).exists()).toBe(true);
    expect(
      getDb().query("SELECT install_state FROM user_data_import_files WHERE job_id = ?").get("unproven-fallback"),
    ).toEqual({ install_state: "pending" });
  });

  test("rejects a final file whose bytes changed after journal success", async () => {
    const fixture = await createExpiredFileJournal("changed-before-commit", "linked");
    const journal = getDb().query(
      "SELECT staged_identity FROM user_data_import_files WHERE job_id = ?",
    ).get("changed-before-commit") as { staged_identity: string };
    getDb().query(
      "UPDATE user_data_import_files SET observed_final_identity = ?, install_state = 'created' WHERE job_id = ?",
    ).run(journal.staged_identity, "changed-before-commit");
    await writeFile(fixture.finalPath, "creator-prool");

    await expect(__test__.assertInstalledFileJournalIntact("changed-before-commit"))
      .rejects.toThrow("installed file changed before relational commit");
  });

  test("cleans staging after a committed receipt without reopening relational writes", async () => {
    const jobId = "receipt-cleanup";
    const stagingPath = join(workDir, "imports", "reconcile-user", jobId, "staging");
    await mkdir(stagingPath, { recursive: true });
    await writeFile(join(stagingPath, "sentinel"), "retain-until-receipt");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-receipt",
      "idempotency-receipt",
      "1".repeat(64),
      "{}",
      stagingPath,
      join(stagingPath, "staging.sqlite"),
      "old-owner",
      now - 1,
      now - 10,
      now - 10,
    );
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("receipt-id", jobId, "reconcile-user", "idempotency-receipt", "1".repeat(64), "{}", now);
    await reconcileUserDataImports();
    expect(await Bun.file(join(stagingPath, "sentinel")).exists()).toBe(false);
    expect(getDb().query("SELECT state FROM user_data_imports WHERE job_id = ?").get(jobId)).toEqual({ state: "committed" });
  });

  test("returns the original committed summary on an idempotent retry", async () => {
    const jobId = "receipt-retry";
    const now = Math.floor(Date.now() / 1000);
    const committedSummary = {
      tables: {
        chats: { imported: 2, skipped: 1 },
      },
      files: {
        "files/audio/example.mp3": 1,
      },
      secrets: { imported: 1, skipped: 0 },
      vectors: {
        imported: 4,
        skipped: 0,
        sourceRows: 4,
        sourceIdentities: { chat_chunks: "a".repeat(64) },
        vectorIdentities: { chat_chunks: "b".repeat(64) },
        rebuildRequired: false,
        projectionPending: false,
      },
    };
    const retryArchivePath = join(workDir, "retry.lvbak");
    const mismatchArchivePath = join(workDir, "mismatch.lvbak");
    const retryArchiveBytes = Buffer.from("retry archive");
    await writeFile(retryArchivePath, retryArchiveBytes);
    await writeFile(mismatchArchivePath, Buffer.from("different archive"));
    const replayDigest = createHash("sha256").update(retryArchiveBytes).digest("hex");
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-retry",
      "idempotency-retry",
      replayDigest,
      "{}",
      "",
      "",
      "old-owner",
      now,
      now,
      now,
    );
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-retry-id",
      jobId,
      "reconcile-user",
      "idempotency-retry",
      replayDigest,
      JSON.stringify(committedSummary),
      now,
    );
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'validating', ?, ?, 0, ?, ?)`,
    ).run(
      "unrelated-active",
      "reconcile-user",
      "archive-unrelated",
      "idempotency-unrelated",
      "6".repeat(64),
      "active-owner",
      now + 300,
      now,
      now,
    );
    await expect(startImport({
      userId: "reconcile-user",
      archivePath: mismatchArchivePath,
      jobId: "mismatch-request",
      archiveDigest: "3".repeat(64),
      idempotencyKey: "idempotency-retry",
    })).rejects.toThrow("archive identity");
    const duplicate = await startImport({
      userId: "reconcile-user",
      archivePath: retryArchivePath,
      jobId: "retry-request",
      archiveDigest: replayDigest,
      idempotencyKey: "idempotency-retry",
    });
    expect(duplicate.status).toBe("complete");
    expect(duplicate.summary).toEqual({
      chats: { imported: 2, skipped: 1 },
      vectors: committedSummary.vectors,
    });
    expect(duplicate.fileSummary).toEqual(committedSummary.files);
    const recovered = getJob(jobId);
    expect(recovered?.status).toBe("complete");
    expect(recovered?.summary).toEqual(duplicate.summary);
    expect(recovered?.fileSummary).toEqual(duplicate.fileSummary);
    expect(pruneTerminalImportJobs((duplicate.finishedAt || now) + 3_600)).toBeGreaterThanOrEqual(1);
    expect(getJob("retry-request")).toBeUndefined();
    const storedReceipt = getDb().query(
      "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
    ).get(jobId);
    if (
      !storedReceipt
      || typeof storedReceipt !== "object"
      || !("summary_json" in storedReceipt)
      || typeof storedReceipt.summary_json !== "string"
    ) {
      throw new Error("committed receipt summary is missing");
    }
    expect(JSON.parse(storedReceipt.summary_json)).toEqual(committedSummary);
    expect(getDb().query("SELECT COUNT(*) AS count FROM user_data_import_receipts").get()).toEqual({ count: 1 });
  });
  test("removes the owned archive and staging tree on an idempotent retry", async () => {
    const jobId = "receipt-owned-cleanup";
    const retryJobId = "owned-retry";
    const archivePath = join(workDir, "imports", "reconcile-user", retryJobId, "archive.lvbak");
    const stagingPath = join(workDir, "imports", "reconcile-user", retryJobId, "staging");
    await mkdir(stagingPath, { recursive: true });
    const archiveBytes = Buffer.from("duplicate archive");
    await writeFile(archivePath, archiveBytes);
    await writeFile(join(stagingPath, "sentinel"), "duplicate staging");
    const now = Math.floor(Date.now() / 1000);
    const digest = createHash("sha256").update(archiveBytes).digest("hex");
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-owned-cleanup",
      "idempotency-owned-cleanup",
      digest,
      "{}",
      "",
      "",
      "old-owner",
      now,
      now,
      now,
    );
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-owned-cleanup-id",
      jobId,
      "reconcile-user",
      "idempotency-owned-cleanup",
      digest,
      JSON.stringify({ tables: {}, files: {}, secrets: { imported: 0, skipped: 0 } }),
      now,
    );

    const duplicate = await startImport({
      userId: "reconcile-user",
      archivePath,
      jobId: retryJobId,
      archiveDigest: digest,
      idempotencyKey: "idempotency-owned-cleanup",
    });
    expect(duplicate.status).toBe("complete");
    expect(await Bun.file(archivePath).exists()).toBe(false);
    expect(await Bun.file(stagingPath).exists()).toBe(false);
  });

  test("fails an idempotent retry when owned archive cleanup has a non-ENOENT error", async () => {
    const jobId = "receipt-cleanup-error";
    const retryJobId = "cleanup-error";
    const archivePath = join(workDir, "imports", "reconcile-user", retryJobId, "archive.lvbak");
    await mkdir(archivePath, { recursive: true });
    const now = Math.floor(Date.now() / 1000);
    const digest = "5".repeat(64);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-cleanup-error",
      "idempotency-cleanup-error",
      digest,
      "{}",
      "",
      "",
      "old-owner",
      now,
      now,
      now,
    );
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-cleanup-error-id",
      jobId,
      "reconcile-user",
      "idempotency-cleanup-error",
      digest,
      JSON.stringify({ tables: {}, files: {}, secrets: { imported: 0, skipped: 0 } }),
      now,
    );

    await expect(startImport({
      userId: "reconcile-user",
      archivePath,
      jobId: retryJobId,
      archiveDigest: digest,
      idempotencyKey: "idempotency-cleanup-error",
    })).rejects.toThrow();
    expect(await stat(archivePath).then(() => true, () => false)).toBe(true);
  });

  test("retries a pending derived-vector projection after a receipt crash window", async () => {
    const jobId = "receipt-vector-recovery";
    const now = Math.floor(Date.now() / 1000);
    const chatId = "receipt-vector-chat";
    await mkdir(join(workDir, "imports", "reconcile-user", jobId, "staging"), { recursive: true });
    getDb().query("INSERT INTO chats (id, user_id, name, metadata) VALUES (?, ?, ?, '{}')")
      .run(chatId, "reconcile-user", "Projection Chat");
    getDb().query(
      `INSERT INTO chat_chunks
        (id, chat_id, start_message_id, end_message_id, message_ids, content,
         token_count, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-vector-chunk",
      chatId,
      "start-message",
      "end-message",
      "[]",
      "source",
      1,
      1,
      now,
      now,
    );
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-vector-recovery",
      "idempotency-vector-recovery",
      "3".repeat(64),
      "{}",
      join(workDir, "imports", "reconcile-user", jobId, "staging"),
      join(workDir, "imports", "reconcile-user", jobId, "staging", "staging.sqlite"),
      "old-owner",
      now,
      now,
      now,
    );
    const summary = JSON.stringify({
      tables: {},
      vectors: {
        imported: 0,
        skipped: 0,
        sourceRows: 1,
        sourceIdentities: { world_book_entries: "4".repeat(64) },
        vectorIdentities: {},
        rebuildRequired: true,
        projectionPending: true,
      },
    });
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-vector-recovery-id",
      jobId,
      "reconcile-user",
      "idempotency-vector-recovery",
      "3".repeat(64),
      summary,
      now,
    );

    await reconcileUserDataImports();

    const receipt = getDb().query(
      "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
    ).get(jobId) as { summary_json: string };
    const recovered = JSON.parse(receipt.summary_json) as {
      vectors?: { projectionPending?: boolean; queued?: number; rebuildRequired?: boolean };
    };
    expect(recovered.vectors).toMatchObject({
      projectionPending: false,
      queued: 1,
      rebuildRequired: true,
    });
  });
  test("leaves malformed or oversized receipt projection intent pending", async () => {
    const now = Math.floor(Date.now() / 1000);
    const cases = [
      {
        jobId: "receipt-vector-closed",
        summary: JSON.stringify({
          tables: {},
          vectors: {
            imported: 0,
            skipped: 0,
            sourceRows: 0,
            sourceIdentities: {},
            vectorIdentities: {},
            rebuildRequired: true,
            projectionPending: true,
            unexpected: true,
          },
        }),
      },
      {
        jobId: "receipt-vector-oversized",
        summary: `{"tables":{},"vectors":{"projectionPending":true,"rebuildRequired":true,"sourceRows":0,"skipped":0,"imported":0,"sourceIdentities":{},"vectorIdentities":{},"padding":"${"x".repeat(1 * 1024 * 1024)}"}}`,
      },
    ];
    for (const item of cases) {
      const stagingPath = join(workDir, "imports", "reconcile-user", item.jobId, "staging");
      await mkdir(stagingPath, { recursive: true });
      getDb().query(
        `INSERT INTO user_data_imports
          (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
           staging_path,staging_db_path,state,lease_owner,lease_expires_at,
           lease_generation,created_at,updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'committed', ?, ?, 0, ?, ?)`,
      ).run(
        item.jobId,
        "reconcile-user",
        `archive-${item.jobId}`,
        `idempotency-${item.jobId}`,
        "5".repeat(64),
        "{}",
        stagingPath,
        join(stagingPath, "staging.sqlite"),
        "old-owner",
        now,
        now,
        now,
      );
      getDb().query(
        `INSERT INTO user_data_import_receipts
          (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `receipt-${item.jobId}`,
        item.jobId,
        "reconcile-user",
        `idempotency-${item.jobId}`,
        "5".repeat(64),
        item.summary,
        now,
      );
    }

    await reconcileUserDataImports();

    for (const item of cases) {
      expect(getDb().query(
        "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
      ).get(item.jobId)).toEqual({ summary_json: item.summary });
    }
  });
  test("keeps a >500-row projection selected after staging cleanup and restart", async () => {
    const jobId = "receipt-vector-paged";
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO databanks (id,user_id,name,scope,created_at,updated_at)
       VALUES (?, ?, ?, 'global', ?, ?)`,
    ).run("projection-databank", "reconcile-user", "Projection Databank", now, now);
    const insertDocument = getDb().query(
      `INSERT INTO databank_documents
        (id,databank_id,user_id,name,slug,file_path,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let index = 0; index < 501; index++) {
      const suffix = String(index).padStart(3, "0");
      insertDocument.run(
        `projection-doc-${suffix}`,
        "projection-databank",
        "reconcile-user",
        `Projection document ${suffix}`,
        `projection-doc-${suffix}`,
        `/tmp/projection-doc-${suffix}`,
        now,
        now,
      );
    }
    const summary = JSON.stringify({
      tables: {},
      files: {},
      secrets: { imported: 0, skipped: 0 },
      vectors: {
        imported: 0,
        skipped: 0,
        sourceRows: 501,
        sourceIdentities: {},
        vectorIdentities: {},
        rebuildRequired: true,
        projectionPending: true,
      },
    });
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_generation,projection_pending,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'committed', 0, 1, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-vector-paged",
      "idempotency-vector-paged",
      "6".repeat(64),
      now,
      now,
    );
    getDb().query(
      `INSERT INTO user_data_import_receipts
        (receipt_id,job_id,user_id,idempotency_key,archive_digest,summary_json,committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "receipt-vector-paged-id",
      jobId,
      "reconcile-user",
      "idempotency-vector-paged",
      "6".repeat(64),
      summary,
      now,
    );

    await reconcileUserDataImports();
    const first = JSON.parse((getDb().query(
      "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
    ).get(jobId) as { summary_json: string }).summary_json) as {
      vectors: { projectionPending: boolean; rebuildProgress?: { databank_chunks?: { cursor: string | null } } };
    };
    expect(first.vectors.projectionPending).toBe(true);
    expect(first.vectors.rebuildProgress?.databank_chunks?.cursor).toBe("projection-doc-499");
    expect(getDb().query(
      "SELECT projection_pending FROM user_data_imports WHERE job_id = ?",
    ).get(jobId)).toEqual({ projection_pending: 1 });

    await reconcileUserDataImports();
    const second = JSON.parse((getDb().query(
      "SELECT summary_json FROM user_data_import_receipts WHERE job_id = ?",
    ).get(jobId) as { summary_json: string }).summary_json) as {
      vectors: { projectionPending: boolean };
    };
    expect(second.vectors.projectionPending).toBe(false);
    expect(getDb().query(
      "SELECT projection_pending, staging_path FROM user_data_imports WHERE job_id = ?",
    ).get(jobId)).toEqual({ projection_pending: 0, staging_path: "" });
  });
  test("settles owned staging and does not rescan it on the next pass", async () => {
    const jobId = "owned-staging-interrupted";
    const stagingPath = join(workDir, "imports", "reconcile-user", jobId, "staging");
    const archivePath = join(dirname(stagingPath), "archive.lvbak");
    await mkdir(stagingPath, { recursive: true });
    await writeFile(join(stagingPath, "sentinel"), "owned staging");
    await writeFile(archivePath, "owned archive");
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', ?, ?, 'validating', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-owned-staging",
      "idempotency-owned-staging",
      "d".repeat(64),
      stagingPath,
      join(stagingPath, "staging.sqlite"),
      "old-owner",
      now - 1,
      now - 10,
      now - 10,
    );

    const first = await reconcileUserDataImports();
    expect(first.recovered).toBe(1);
    expect(first.complete).toBe(true);
    expect(first.healthy).toBe(true);
    expect(getDb().query(
      "SELECT state, staging_path, staging_db_path FROM user_data_imports WHERE job_id = ?",
    ).get(jobId)).toEqual({ state: "failed", staging_path: "", staging_db_path: "" });
    expect(await Bun.file(stagingPath).exists()).toBe(false);
    expect(await Bun.file(archivePath).exists()).toBe(false);

    const second = await reconcileUserDataImports();
    expect(second.inspected).toBe(0);
    expect(second.complete).toBe(true);
    expect(second.healthy).toBe(true);
  });

  test("bounds import-control rows and reports continuation across passes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const insertUser = getDb().query(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertImport = getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'validating', ?, ?, 0, ?, ?)`,
    );
    const total = MAX_IMPORT_STARTUP_RECONCILIATION_ROWS + 1;
    for (let index = 0; index < total; index++) {
      const suffix = String(index).padStart(3, "0");
      const userId = `bounded-user-${suffix}`;
      const jobId = `bounded-job-${suffix}`;
      insertUser.run(userId, `Bounded User ${suffix}`, `${userId}@example.com`, now, now);
      insertImport.run(
        jobId,
        userId,
        `archive-${jobId}`,
        `idempotency-${jobId}`,
        "a".repeat(64),
        `owner-${jobId}`,
        now - 1,
        now - 1,
        now - 1,
      );
    }

    const first = await reconcileUserDataImports();
    expect(first.inspected).toBe(MAX_IMPORT_STARTUP_RECONCILIATION_ROWS);
    expect(first.complete).toBe(false);
    expect(first.healthy).toBe(false);
    expect(first.recovered).toBe(MAX_IMPORT_STARTUP_RECONCILIATION_ROWS);

    const second = await reconcileUserDataImports();
    expect(second.inspected).toBe(1);
    expect(second.complete).toBe(true);
    expect(second.healthy).toBe(true);
    expect(getDb().query(
      "SELECT COUNT(*) AS count FROM user_data_imports WHERE state NOT IN ('committed', 'failed', 'cancelled')",
    ).get()).toEqual({ count: 0 });
  });

  test("does not inspect settled terminal history without cleanup work", async () => {
    const now = Math.floor(Date.now() / 1000);
    const insertUser = getDb().query(
      `INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, ?, ?)`,
    );
    const insertImport = getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at,finished_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', ?, NULL, NULL, 0, ?, ?, ?)`,
    );
    for (let index = 0; index < MAX_IMPORT_STARTUP_RECONCILIATION_ROWS + 8; index++) {
      const suffix = String(index).padStart(3, "0");
      const userId = `history-user-${suffix}`;
      const jobId = `history-job-${suffix}`;
      const state = index % 2 === 0 ? "failed" : "cancelled";
      insertUser.run(userId, `History User ${suffix}`, `${userId}@example.com`, now, now);
      insertImport.run(
        jobId,
        userId,
        `archive-${jobId}`,
        `idempotency-${jobId}`,
        "b".repeat(64),
        state,
        now - 10,
        now - 10,
        now - 10,
      );
    }
    insertUser.run("parked-history-user", "Parked History User", "parked-history-user@example.com", now, now);
    insertImport.run(
      "parked-history-job",
      "parked-history-user",
      "archive-parked-history",
      "idempotency-parked-history",
      "c".repeat(64),
      "awaiting_ticket",
      now,
      now,
      now,
    );


    const result = await reconcileUserDataImports();
    expect(result.inspected).toBe(0);
    expect(result.recovered).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.complete).toBe(true);
    expect(result.healthy).toBe(true);
  });

  test("reports a deferred journal row and converges on a later pass", async () => {
    const fixture = await createExpiredFileJournal("deferred-journal", "tampered");
    getDb().query("UPDATE user_data_imports SET state = 'failed' WHERE job_id = ?")
      .run("deferred-journal");

    const first = await reconcileUserDataImports();
    expect(first.deferred).toBe(1);
    expect(first.complete).toBe(false);
    expect(first.healthy).toBe(false);
    expect(getDb().query(
      "SELECT install_state, stable_error_code FROM user_data_import_files f JOIN user_data_imports i USING (job_id) WHERE f.job_id = ?",
    ).get("deferred-journal")).toEqual({ install_state: "pending", stable_error_code: "manual_recovery_required" });

    await rm(fixture.finalPath, { force: true });
    const second = await reconcileUserDataImports();
    expect(second.deferred).toBe(0);
    expect(second.failed).toBe(0);
    expect(second.complete).toBe(true);
    expect(second.healthy).toBe(true);
    expect(getDb().query(
      "SELECT install_state, staging_path FROM user_data_import_files f JOIN user_data_imports i USING (job_id) WHERE f.job_id = ?",
    ).get("deferred-journal")).toEqual({ install_state: "removed", staging_path: "" });
  });

  test("waits for an unexpired restart lease before taking over", async () => {
    const jobId = "restart-before-expiry";
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'validating', ?, ?, 0, ?, ?)`,
    ).run(
      jobId,
      "reconcile-user",
      "archive-restart-before-expiry",
      "idempotency-restart-before-expiry",
      "7".repeat(64),
      "live-owner",
      now + 1,
      now,
      now,
    );

    await reconcileUserDataImports();

    const recovered = getDb().query(
      "SELECT state, lease_generation, stable_error_code FROM user_data_imports WHERE job_id = ?",
    ).get(jobId);
    expect(recovered).toEqual({
      state: "failed",
      lease_generation: 1,
      stable_error_code: "process_interrupted",
    });
    // Real-time lease expiry (~1s) brushes the 5s default under full-suite load.
  }, 15_000);
  test("drains staggered expired leases under the bounded startup window", async () => {
    const now = Math.floor(Date.now() / 1000);
    getDb().query(
      "INSERT INTO \"user\" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)",
    ).run("reconcile-user-2", "Reconcile User 2", "reconcile2@example.com", 0, 0);
    const insert = getDb().query(
      `INSERT INTO user_data_imports
        (job_id,user_id,archive_id,idempotency_key,archive_digest,manifest_json,
         staging_path,staging_db_path,state,lease_owner,lease_expires_at,
         lease_generation,created_at,updated_at)
       VALUES (?, ?, ?, ?, ?, '{}', '', '', 'validating', ?, ?, 0, ?, ?)`,
    );
    insert.run(
      "staggered-lease-1",
      "reconcile-user",
      "archive-staggered-1",
      "idempotency-staggered-1",
      "8".repeat(64),
      "owner-1",
      now + 1,
      now,
      now,
    );
    insert.run(
      "staggered-lease-2",
      "reconcile-user-2",
      "archive-staggered-2",
      "idempotency-staggered-2",
      "9".repeat(64),
      "owner-2",
      now + 2,
      now,
      now,
    );

    await reconcileUserDataImports();

    expect(getDb().query(
      "SELECT state, lease_generation, stable_error_code FROM user_data_imports WHERE job_id IN (?, ?) ORDER BY job_id",
    ).all("staggered-lease-1", "staggered-lease-2")).toEqual([
      { state: "failed", lease_generation: 1, stable_error_code: "process_interrupted" },
      { state: "failed", lease_generation: 1, stable_error_code: "process_interrupted" },
    ]);
  }, 15_000);
});
