import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../src/db/connection";
import {
  createTicket,
  decryptSecret,
  encryptSecret,
  lookupConsumedTicket,
  stashPrepareEntry,
  consumePrepareEntry,
  PREPARE_CACHE_MAX_PER_USER,
  PREPARE_CACHE_TTL_MS,
  prepareCacheSize,
  verifyTicket,
  TICKET_MAX_AGE_SECONDS,
  type ExportPrepareEntry,
} from "../src/services/user-data/secret-ticket.service";

describe("user-data decryption tickets", () => {
  beforeEach(() => {
    closeDatabase();
    initDatabase(":memory:");
    getDb().run(`
      CREATE TABLE import_consumed_tickets (
        archive_id TEXT PRIMARY KEY,
        consumed_at INTEGER NOT NULL,
        user_id TEXT,
        uses INTEGER NOT NULL DEFAULT 1 CHECK (uses = 1)
      )
    `);
  });

  afterEach(() => closeDatabase());

  test("authenticates the original secret key as AES-GCM associated data", async () => {
    const created = await createTicket("archive-aad", ["source_key"]);
    const encrypted = await encryptSecret(created.smk, "source_key", "plaintext");

    await expect(decryptSecret(created.smk, encrypted)).resolves.toBe("plaintext");
    await expect(
      decryptSecret(created.smk, { ...encrypted, key: "renamed_key" }),
    ).rejects.toThrow();
  });

  test("rejects missing, stale, and misbound ticket fields before use", async () => {
    const created = await createTicket("archive-ticket", ["key"]);
    const valid = await verifyTicket(created.ticket, "archive-ticket", ["key"]);
    expect(valid.ticket.archiveId).toBe("archive-ticket");

    await expect(
      verifyTicket({ ...created.ticket, issuerInstance: "" }, "archive-ticket", ["key"]),
    ).rejects.toMatchObject({ code: "invalid_issuer_instance" });
    await expect(
      verifyTicket(
        { ...created.ticket, issuedAt: Math.floor(Date.now() / 1000) - TICKET_MAX_AGE_SECONDS - 1 },
        "archive-ticket",
        ["key"],
      ),
    ).rejects.toMatchObject({ code: "stale" });
    await expect(
      verifyTicket({ ...created.ticket, secretsHash: "0".repeat(64) }, "archive-ticket", ["key"]),
    ).rejects.toMatchObject({ code: "binding_mismatch" });
  });


  test("rolls back the ticket tombstone with relational apply failure", () => {
    expect(() => {
      getDb().transaction(() => {
        getDb().query(
          `INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses)
           VALUES (?, ?, ?, 1)`,
        ).run("archive-rollback", 1, "owner-a");
        getDb().run("CREATE TABLE rollback_probe (id TEXT PRIMARY KEY)");
        throw new Error("relational apply failed");
      })();
    }).toThrow("relational apply failed");
    expect(lookupConsumedTicket("archive-rollback")).toBeNull();

    getDb().transaction(() => {
      getDb().query(
        `INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses)
         VALUES (?, ?, ?, 1)`,
      ).run("archive-commit", 1, "owner-a");
      getDb().run("CREATE TABLE commit_probe (id TEXT PRIMARY KEY)");
    })();
    expect(lookupConsumedTicket("archive-commit")?.uses).toBe(1);
  });


  test("failed secret decryption leaves the ticket available for retry", async () => {
    const created = await createTicket("archive-decrypt-failure", ["key"]);
    const encrypted = await encryptSecret(created.smk, "key", "plaintext");
    await expect(
      decryptSecret(created.smk, { ...encrypted, ciphertext: `${encrypted.ciphertext.slice(0, -4)}AAAA` }),
    ).rejects.toThrow();
    expect(lookupConsumedTicket("archive-decrypt-failure")).toBeNull();
    await expect(verifyTicket(created.ticket, "archive-decrypt-failure", ["key"])).resolves.toBeTruthy();
  });

  test("bounds pending prepare entries and wipes rejected or expired SMKs", () => {
    const ids = Array.from({ length: PREPARE_CACHE_MAX_PER_USER }, (_, index) => `bounded-${index}`);
    for (const id of ids) {
      expect(stashPrepareEntry(id, {
        userId: "owner-a",
        includeVectors: false,
        includeSecrets: true,
        smk: new Uint8Array([1, 2, 3]),
        secretKeys: ["key"],
        privateDataFingerprint: "fingerprint",
        archiveFilename: `${id}.lvbak`,
        createdAt: Math.floor(Date.now() / 1000),
      })).toBe(true);
    }
    const rejected: ExportPrepareEntry = {
      userId: "owner-a",
      includeVectors: false,
      includeSecrets: true,
      smk: new Uint8Array([9, 9, 9]),
      secretKeys: ["key"],
      privateDataFingerprint: "fingerprint",
      archiveFilename: "rejected.lvbak",
      createdAt: Math.floor(Date.now() / 1000),
    };
    expect(stashPrepareEntry("bounded-rejected", rejected)).toBe(false);
    expect(rejected.smk).toBeNull();
    for (const id of ids) {
      const entry = consumePrepareEntry(id, "owner-a");
      entry?.smk?.fill(0);
    }

    const expired: ExportPrepareEntry = {
      userId: "owner-a",
      includeVectors: false,
      includeSecrets: true,
      smk: new Uint8Array([7, 7, 7]),
      secretKeys: ["key"],
      privateDataFingerprint: "fingerprint",
      archiveFilename: "expired.lvbak",
      createdAt: Math.floor((Date.now() - PREPARE_CACHE_TTL_MS - 1_000) / 1000),
    };
    expect(stashPrepareEntry("bounded-expired", expired)).toBe(false);
    expect(expired.smk).toBeNull();
    expect(prepareCacheSize()).toBe(0);
  });

  test("does not consume another user's export prepare entry", () => {
    const entry: ExportPrepareEntry = {
      userId: "owner-a",
      includeVectors: false,
      includeSecrets: false,
      smk: null,
      secretKeys: [],
      privateDataFingerprint: null,
      archiveFilename: "archive.lvbak",
      createdAt: Math.floor(Date.now() / 1000),
    };
    expect(stashPrepareEntry("archive-cache", entry)).toBe(true);
    expect(consumePrepareEntry("archive-cache", "owner-b")).toBeNull();
    expect(consumePrepareEntry("archive-cache", "owner-a")).toBe(entry);
  });
});
