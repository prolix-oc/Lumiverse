// Decryption-ticket protocol for the optional "include API keys" path of
// user-data export/import.
//
// At export prepare time the server generates a random 32-byte Secret Master
// Key (SMK), keeps it briefly in memory until the matching archive download
// streams, and hands the user a small JSON ticket file containing the SMK
// in base64 plus a binding to the archive's id and the list of secret keys
// it covers. The archive ships the secrets table encrypted with the SMK; the
// ticket ships the key out-of-band.
//
// At import time the user uploads the ticket alongside the archive. The
// importing instance decrypts each secret with the SMK and re-encrypts it
// under its own identity key via the normal `secretsSvc.putSecret` path —
// the plaintext never lands on disk and never leaves the import request.
//
// Tickets never expire (the archive doubles as long-term backup) and reuse
// is advisory: every consumption is recorded in `import_consumed_tickets`
// and surfaced to the importer as a warning, but it never blocks.

import { getDb } from "../../db/connection";

export const TICKET_KIND = "lumiverse-decryption-ticket";
export const TICKET_VERSION = 1;
export const TICKET_ALGORITHM = "AES-256-GCM";

/** Length of the SMK in bytes. 256 bits → AES-256. */
export const SMK_BYTES = 32;

export interface DecryptionTicket {
  kind: typeof TICKET_KIND;
  version: typeof TICKET_VERSION;
  archiveId: string;
  issuer: "lumiverse";
  issuerInstance: string | null;
  issuedAt: number;
  algorithm: typeof TICKET_ALGORITHM;
  /** Base64 of the 32-byte AES key. */
  keyB64: string;
  /** sha256(archiveId + algorithm + sortedSecretKeys.join("\n")) — sanity-check binding. */
  secretsHash: string;
}

export interface EncryptedSecretEntry {
  /** Original key from the source instance's secrets table, e.g. "connection_xxx_api_key". */
  key: string;
  /** Base64 12-byte IV (unique per record). */
  iv: string;
  /** Base64 16-byte AES-GCM tag. */
  tag: string;
  /** Base64 ciphertext (without tag). */
  ciphertext: string;
}

// ---------------------------------------------------------------------------
// SMK & ticket creation (export side)
// ---------------------------------------------------------------------------

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Buffer.from(new Uint8Array(digest)).toString("hex");
}

/** Compute the canonical binding hash for a ticket. */
export async function computeSecretsHash(
  archiveId: string,
  secretKeys: readonly string[],
): Promise<string> {
  const sorted = [...secretKeys].sort();
  const payload = `${archiveId}|${TICKET_ALGORITHM}|${sorted.join("\n")}`;
  return sha256Hex(payload);
}

export interface NewTicket {
  ticket: DecryptionTicket;
  /** Held in memory by the export-prepare cache; never persisted to disk on the source. */
  smk: Uint8Array;
}

export async function createTicket(
  archiveId: string,
  secretKeys: readonly string[],
  opts: { issuerInstance?: string | null } = {},
): Promise<NewTicket> {
  const smk = crypto.getRandomValues(new Uint8Array(SMK_BYTES));
  const ticket: DecryptionTicket = {
    kind: TICKET_KIND,
    version: TICKET_VERSION,
    archiveId,
    issuer: "lumiverse",
    issuerInstance: opts.issuerInstance ?? null,
    issuedAt: Math.floor(Date.now() / 1000),
    algorithm: TICKET_ALGORITHM,
    keyB64: b64encode(smk),
    secretsHash: await computeSecretsHash(archiveId, secretKeys),
  };
  return { ticket, smk };
}

// ---------------------------------------------------------------------------
// AES-GCM helpers (used by both sides)
// ---------------------------------------------------------------------------

async function importAesKey(smk: Uint8Array): Promise<CryptoKey> {
  // Copy into a freshly-allocated ArrayBuffer so TS sees a concrete
  // ArrayBuffer (not ArrayBufferLike / SharedArrayBuffer).
  const buf = new ArrayBuffer(smk.byteLength);
  new Uint8Array(buf).set(smk);
  return crypto.subtle.importKey("raw", buf, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Allocate a Uint8Array backed by a concrete ArrayBuffer (not SharedArrayBuffer). */
function freshBytes(input: Uint8Array): Uint8Array {
  const buf = new ArrayBuffer(input.byteLength);
  const out = new Uint8Array(buf);
  out.set(input);
  return out;
}

export async function encryptSecret(
  smk: Uint8Array,
  key: string,
  plaintext: string,
): Promise<EncryptedSecretEntry> {
  const cryptoKey = await importAesKey(smk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: freshBytes(iv) as BufferSource },
    cryptoKey,
    freshBytes(new TextEncoder().encode(plaintext)) as BufferSource,
  );
  const bytes = new Uint8Array(ct);
  // AES-GCM appends the 16-byte tag to the ciphertext.
  const data = bytes.slice(0, -16);
  const tag = bytes.slice(-16);
  return {
    key,
    iv: b64encode(iv),
    tag: b64encode(tag),
    ciphertext: b64encode(data),
  };
}

export async function decryptSecret(
  smk: Uint8Array,
  entry: EncryptedSecretEntry,
): Promise<string> {
  const cryptoKey = await importAesKey(smk);
  const iv = b64decode(entry.iv);
  const data = b64decode(entry.ciphertext);
  const tag = b64decode(entry.tag);
  const combined = freshBytes(new Uint8Array(data.length + tag.length));
  combined.set(data, 0);
  combined.set(tag, data.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: freshBytes(iv) as BufferSource },
    cryptoKey,
    combined as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

// ---------------------------------------------------------------------------
// Ticket parsing & validation (import side)
// ---------------------------------------------------------------------------

export class TicketError extends Error {
  constructor(
    public code:
      | "malformed"
      | "wrong_kind"
      | "unsupported_version"
      | "archive_mismatch"
      | "binding_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

/**
 * Validate a ticket against an archive's manifest and the actual list of
 * secret keys we found inside the archive. Does NOT consult the consumed
 * tickets table — that's the caller's job (so the caller can decide to
 * advise vs. block).
 */
export async function verifyTicket(
  raw: unknown,
  expectedArchiveId: string,
  archiveSecretKeys: readonly string[],
): Promise<{ ticket: DecryptionTicket; smk: Uint8Array }> {
  if (!raw || typeof raw !== "object") {
    throw new TicketError("malformed", "ticket is not a JSON object");
  }
  const t = raw as Record<string, any>;
  if (t.kind !== TICKET_KIND) {
    throw new TicketError(
      "wrong_kind",
      `ticket kind is ${JSON.stringify(t.kind)}, expected ${JSON.stringify(TICKET_KIND)}`,
    );
  }
  if (Number(t.version) !== TICKET_VERSION) {
    throw new TicketError(
      "unsupported_version",
      `ticket version ${t.version} is unsupported (expected ${TICKET_VERSION})`,
    );
  }
  if (t.algorithm !== TICKET_ALGORITHM) {
    throw new TicketError("malformed", `unsupported algorithm: ${t.algorithm}`);
  }
  if (typeof t.archiveId !== "string" || !t.archiveId) {
    throw new TicketError("malformed", "ticket archiveId is missing");
  }
  if (typeof t.keyB64 !== "string") {
    throw new TicketError("malformed", "ticket keyB64 is missing");
  }
  if (t.archiveId !== expectedArchiveId) {
    throw new TicketError(
      "archive_mismatch",
      `ticket archiveId ${t.archiveId} does not match archive manifest ${expectedArchiveId}`,
    );
  }
  const smk = b64decode(t.keyB64);
  if (smk.byteLength !== SMK_BYTES) {
    throw new TicketError("malformed", `ticket key is ${smk.byteLength} bytes, expected ${SMK_BYTES}`);
  }
  // Binding hash: recompute over the archive's own secret-key list and
  // compare. A mismatch means the archive's secrets list was tampered with
  // (or the ticket was issued for a different revision of this archive).
  const recomputed = await computeSecretsHash(expectedArchiveId, archiveSecretKeys);
  if (typeof t.secretsHash === "string" && t.secretsHash !== recomputed) {
    throw new TicketError(
      "binding_mismatch",
      "ticket secretsHash does not match the archive's encrypted-secrets manifest",
    );
  }
  return {
    ticket: {
      kind: TICKET_KIND,
      version: TICKET_VERSION,
      archiveId: t.archiveId,
      issuer: "lumiverse",
      issuerInstance: typeof t.issuerInstance === "string" ? t.issuerInstance : null,
      issuedAt: Number(t.issuedAt) || 0,
      algorithm: TICKET_ALGORITHM,
      keyB64: t.keyB64,
      secretsHash: typeof t.secretsHash === "string" ? t.secretsHash : recomputed,
    },
    smk,
  };
}

// ---------------------------------------------------------------------------
// Consumed-ticket ledger (advisory reuse detection)
// ---------------------------------------------------------------------------

export interface ConsumedTicketRecord {
  archiveId: string;
  consumedAt: number;
  userId: string | null;
  uses: number;
}

export function lookupConsumedTicket(archiveId: string): ConsumedTicketRecord | null {
  const row = getDb()
    .query(
      "SELECT archive_id, consumed_at, user_id, uses FROM import_consumed_tickets WHERE archive_id = ?",
    )
    .get(archiveId) as
    | { archive_id: string; consumed_at: number; user_id: string | null; uses: number }
    | null;
  if (!row) return null;
  return {
    archiveId: row.archive_id,
    consumedAt: row.consumed_at,
    userId: row.user_id,
    uses: row.uses,
  };
}

/**
 * Record a ticket consumption. Atomic insert-or-bump: first use creates the
 * row, subsequent uses increment the `uses` counter and refresh `consumed_at`.
 */
export function recordConsumedTicket(archiveId: string, userId: string): ConsumedTicketRecord {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.run(
    `INSERT INTO import_consumed_tickets (archive_id, consumed_at, user_id, uses)
       VALUES (?, ?, ?, 1)
     ON CONFLICT(archive_id) DO UPDATE
        SET consumed_at = excluded.consumed_at,
            user_id    = excluded.user_id,
            uses       = import_consumed_tickets.uses + 1`,
    [archiveId, now, userId],
  );
  return lookupConsumedTicket(archiveId)!;
}

// ---------------------------------------------------------------------------
// Export-side prepare cache
//
// Holds the SMK + export options between `POST /export/prepare` and the
// matching `GET /export/archive/:archiveId` call. There is no security TTL
// — the cache is purely operational so an abandoned prepare doesn't leak
// memory. Entries are evicted as soon as the archive endpoint consumes
// them; orphans are swept by a periodic timer.
// ---------------------------------------------------------------------------

export interface ExportPrepareEntry {
  userId: string;
  includeVectors: boolean;
  includeSecrets: boolean;
  smk: Uint8Array | null;
  secretKeys: readonly string[];
  /**
   * Filename pinned at prepare time. The archive endpoint reuses this so
   * the archive and its paired ticket file share the exact same HHMMSS
   * suffix even if the download lands a few seconds after prepare.
   */
  archiveFilename: string;
  /** Wall-clock seconds the entry was created (for orphan sweeps only). */
  createdAt: number;
}

const PREPARE_CACHE = new Map<string, ExportPrepareEntry>();
const PREPARE_ORPHAN_SWEEP_MS = 30 * 60 * 1000; // 30 min — purely housekeeping
let _sweepTimer: ReturnType<typeof setInterval> | null = null;

function ensureSweepTimer(): void {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of PREPARE_CACHE) {
      if (now - entry.createdAt * 1000 > PREPARE_ORPHAN_SWEEP_MS) {
        PREPARE_CACHE.delete(id);
      }
    }
  }, PREPARE_ORPHAN_SWEEP_MS);
  if (typeof (_sweepTimer as { unref?: () => void }).unref === "function") {
    (_sweepTimer as { unref: () => void }).unref();
  }
}

export function stashPrepareEntry(archiveId: string, entry: ExportPrepareEntry): void {
  PREPARE_CACHE.set(archiveId, entry);
  ensureSweepTimer();
}

export function consumePrepareEntry(archiveId: string): ExportPrepareEntry | null {
  const entry = PREPARE_CACHE.get(archiveId);
  if (!entry) return null;
  PREPARE_CACHE.delete(archiveId);
  return entry;
}

/** For tests / debugging only. */
export function prepareCacheSize(): number {
  return PREPARE_CACHE.size;
}
