// Decryption-ticket protocol for the optional "include API keys" path of
// user-data export/import.
//
// A ticket is a short-lived, one-use capability. It binds an archive id to
// the exact encrypted-secret key set and carries the source issuer identity.
// Validation precedes secret preparation; the one-use tombstone is committed
// with the re-encrypted rows and canonical receipt, never independently.
//
// At export prepare time the server generates a random 32-byte Secret Master
// Key (SMK), keeps it briefly in memory until the matching archive download
// streams, and hands the user a small JSON ticket file containing the SMK
// in base64 plus a binding to the archive's id and the list of secret keys
// it covers. Each ciphertext authenticates its original key as AES-GCM AAD,
// so renaming an encrypted row can never restore its plaintext.

import { getDb } from "../../db/connection";

export const TICKET_KIND = "lumiverse-decryption-ticket";
export const TICKET_VERSION = 1;
export const TICKET_ALGORITHM = "AES-256-GCM";

/** Length of the SMK in bytes. 256 bits → AES-256. */
export const SMK_BYTES = 32;

/** Tickets are valid long enough to download/import, but never indefinitely. */
export const TICKET_MAX_AGE_SECONDS = 24 * 60 * 60;
/** Permit small clock skew while rejecting tickets from the future. */
export const TICKET_CLOCK_SKEW_SECONDS = 60;

/**
 * A process-level issuer identity is intentionally opaque. It is required in
 * every ticket so a missing/misissued ticket cannot fall through to a
 * synthetic default during verification.
 */
const DEFAULT_ISSUER_INSTANCE =
  (typeof process !== "undefined" && process.env.LUMIVERSE_INSTANCE_ID?.trim()) ||
  crypto.randomUUID();

export interface DecryptionTicket {
  kind: typeof TICKET_KIND;
  version: typeof TICKET_VERSION;
  archiveId: string;
  issuer: "lumiverse";
  issuerInstance: string;
  issuedAt: number;
  algorithm: typeof TICKET_ALGORITHM;
  /** Base64 of the 32-byte AES key. */
  keyB64: string;
  /** sha256(archiveId + algorithm + sortedSecretKeys.join("\n")). */
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

const SECRET_AAD_PREFIX = `${TICKET_KIND}|${TICKET_VERSION}|secret|`;


// ---------------------------------------------------------------------------
// SMK & ticket creation (export side)
// ---------------------------------------------------------------------------

function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function b64decode(s: string, allowEmpty = false): Uint8Array {
  if (
    typeof s !== "string"
    || (!allowEmpty && s.length === 0)
    || s.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)
  ) {
    throw new Error("invalid base64 encoding");
  }
  const decoded = new Uint8Array(Buffer.from(s, "base64"));
  if (b64encode(decoded) !== s) throw new Error("non-canonical base64 encoding");
  return decoded;
}

function secretAad(key: string): Uint8Array {
  return new TextEncoder().encode(`${SECRET_AAD_PREFIX}${key}`);
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
  const issuerInstance = opts.issuerInstance?.trim() || DEFAULT_ISSUER_INSTANCE;
  const smk = crypto.getRandomValues(new Uint8Array(SMK_BYTES));
  const ticket: DecryptionTicket = {
    kind: TICKET_KIND,
    version: TICKET_VERSION,
    archiveId,
    issuer: "lumiverse",
    issuerInstance,
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
  if (typeof key !== "string" || key.length === 0) throw new Error("secret key is empty");
  const cryptoKey = await importAesKey(smk);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: freshBytes(iv) as BufferSource,
      additionalData: freshBytes(secretAad(key)) as BufferSource,
      tagLength: 128,
    },
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
  if (typeof entry.key !== "string" || entry.key.length === 0) {
    throw new Error("secret key is empty");
  }
  const cryptoKey = await importAesKey(smk);
  const iv = b64decode(entry.iv);
  const data = b64decode(entry.ciphertext, true);
  const tag = b64decode(entry.tag);
  if (iv.byteLength !== 12 || tag.byteLength !== 16) {
    throw new Error("secret ciphertext framing is invalid");
  }
  const combined = freshBytes(new Uint8Array(data.length + tag.length));
  combined.set(data, 0);
  combined.set(tag, data.length);
  const plain = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: freshBytes(iv) as BufferSource,
      additionalData: freshBytes(secretAad(entry.key)) as BufferSource,
      tagLength: 128,
    },
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
      | "wrong_issuer"
      | "invalid_issuer_instance"
      | "unsupported_version"
      | "archive_mismatch"
      | "binding_mismatch"
      | "stale"
      | "replayed",
    message: string,
  ) {
    super(message);
    this.name = "TicketError";
  }
}

/**
 * Validate every ticket field and its exact archive binding. This function
 * intentionally does not consult or mutate the consumed-ticket ledger:
 * callers validate and prepare bounded secret values first, then insert the
 * tombstone inside the same synchronous transaction as canonical apply.
 */
export async function verifyTicket(
  raw: unknown,
  expectedArchiveId: string,
  archiveSecretKeys: readonly string[],
): Promise<{ ticket: DecryptionTicket; smk: Uint8Array }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TicketError("malformed", "ticket is not a JSON object");
  }
  const t = raw as Record<string, unknown>;
  if (t.kind !== TICKET_KIND) {
    throw new TicketError(
      "wrong_kind",
      `ticket kind is ${JSON.stringify(t.kind)}, expected ${JSON.stringify(TICKET_KIND)}`,
    );
  }
  if (t.issuer !== "lumiverse") {
    throw new TicketError("wrong_issuer", "ticket issuer is not Lumiverse");
  }
  if (typeof t.issuerInstance !== "string" || t.issuerInstance.trim().length === 0 || t.issuerInstance.length > 256) {
    throw new TicketError("invalid_issuer_instance", "ticket issuerInstance is missing or invalid");
  }
  if (t.version !== TICKET_VERSION) {
    throw new TicketError(
      "unsupported_version",
      `ticket version ${String(t.version)} is unsupported (expected ${TICKET_VERSION})`,
    );
  }
  if (t.algorithm !== TICKET_ALGORITHM) {
    throw new TicketError("malformed", `unsupported algorithm: ${String(t.algorithm)}`);
  }
  if (typeof t.archiveId !== "string" || t.archiveId.length === 0) {
    throw new TicketError("malformed", "ticket archiveId is missing");
  }
  if (typeof expectedArchiveId !== "string" || expectedArchiveId.length === 0 || t.archiveId !== expectedArchiveId) {
    throw new TicketError(
      "archive_mismatch",
      `ticket archiveId ${String(t.archiveId)} does not match archive manifest ${expectedArchiveId}`,
    );
  }
  if (typeof t.issuedAt !== "number" || !Number.isSafeInteger(t.issuedAt)) {
    throw new TicketError("malformed", "ticket issuedAt is not a Unix timestamp");
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    t.issuedAt > now + TICKET_CLOCK_SKEW_SECONDS
    || now - t.issuedAt > TICKET_MAX_AGE_SECONDS
  ) {
    throw new TicketError("stale", "ticket is expired or issued in the future");
  }
  if (typeof t.keyB64 !== "string") {
    throw new TicketError("malformed", "ticket keyB64 is missing");
  }
  let smk: Uint8Array;
  try {
    smk = b64decode(t.keyB64);
  } catch (error) {
    throw new TicketError("malformed", `ticket key encoding is invalid: ${String(error)}`);
  }
  if (smk.byteLength !== SMK_BYTES) {
    throw new TicketError("malformed", `ticket key is ${smk.byteLength} bytes, expected ${SMK_BYTES}`);
  }
  if (
    archiveSecretKeys.some((key) => typeof key !== "string" || key.length === 0)
    || new Set(archiveSecretKeys).size !== archiveSecretKeys.length
  ) {
    throw new TicketError("binding_mismatch", "archive encrypted-secret key index is not exact");
  }
  if (typeof t.secretsHash !== "string" || !/^[0-9a-f]{64}$/.test(t.secretsHash)) {
    throw new TicketError("binding_mismatch", "ticket secretsHash is missing or malformed");
  }
  const recomputed = await computeSecretsHash(expectedArchiveId, archiveSecretKeys);
  if (t.secretsHash !== recomputed) {
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
      issuerInstance: t.issuerInstance,
      issuedAt: t.issuedAt,
      algorithm: TICKET_ALGORITHM,
      keyB64: t.keyB64,
      secretsHash: t.secretsHash,
    },
    smk,
  };
}

// ---------------------------------------------------------------------------
// Consumed-ticket ledger (insert-only one-use capability)
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



// Export-side prepare cache
//
// Holds the SMK + export options between `POST /export/prepare` and the
// matching `GET /export/archive/:archiveId` call. A cache entry is removed
// only after the requesting owner is checked. Aborted/failed streams can
// restore the exact entry so a user can retry the export.
// ---------------------------------------------------------------------------

export interface ExportPrepareEntry {
  userId: string;
  includeVectors: boolean;
  includeSecrets: boolean;
  smk: Uint8Array | null;
  secretKeys: readonly string[];
  /** Exact private-data and encrypted-secret inventory captured at prepare. */
  privateDataFingerprint: string | null;
  /**
   * Filename pinned at prepare time. The archive endpoint reuses this so
   * the archive and its paired ticket file share the exact same HHMMSS
   * suffix even if the download lands a few seconds after prepare.
   */
  archiveFilename: string;
  /** Wall-clock seconds the entry was created; entries expire after the cache TTL. */
  createdAt: number;
}

const PREPARE_CACHE = new Map<string, ExportPrepareEntry>();
/** Hard per-account bound: a client can have only a small number of pending exports. */
export const PREPARE_CACHE_MAX_PER_USER = 8;
/** Hard process-wide bound: never retain unbounded export options or SMKs. */
export const PREPARE_CACHE_MAX_ENTRIES = 64;
/** Pending exports expire even when the housekeeping timer has not run yet. */
export const PREPARE_CACHE_TTL_MS = 30 * 60 * 1000;
const PREPARE_ORPHAN_SWEEP_MS = PREPARE_CACHE_TTL_MS;
let _sweepTimer: ReturnType<typeof setInterval> | null = null;

function clearPrepareEntry(entry: ExportPrepareEntry): void {
  try {
    entry.smk?.fill(0);
  } catch {
    // A detached/invalid buffer is already unusable; still drop our reference.
  }
  entry.smk = null;
}

function isPrepareEntryExpired(entry: ExportPrepareEntry, now = Date.now()): boolean {
  return !Number.isSafeInteger(entry.createdAt)
    || now - entry.createdAt * 1000 >= PREPARE_CACHE_TTL_MS;
}

function purgeExpiredPrepareEntries(now = Date.now()): void {
  for (const [id, entry] of PREPARE_CACHE) {
    if (isPrepareEntryExpired(entry, now)) {
      PREPARE_CACHE.delete(id);
      clearPrepareEntry(entry);
    }
  }
}

function countPrepareEntriesForUser(userId: string): number {
  let count = 0;
  for (const entry of PREPARE_CACHE.values()) {
    if (entry.userId === userId) count++;
  }
  return count;
}

function ensureSweepTimer(): void {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => purgeExpiredPrepareEntries(), PREPARE_ORPHAN_SWEEP_MS);
  if (typeof (_sweepTimer as { unref?: () => void }).unref === "function") {
    (_sweepTimer as { unref: () => void }).unref();
  }
}

/**
 * Stash a prepared export only if both bounded cache admissions succeed.
 * Callers must treat false as a hard capacity failure and must not return a
 * ticket to the client for an entry that was not retained.
 */
export function stashPrepareEntry(archiveId: string, entry: ExportPrepareEntry): boolean {
  purgeExpiredPrepareEntries();
  if (isPrepareEntryExpired(entry)) {
    clearPrepareEntry(entry);
    return false;
  }
  const replacement = PREPARE_CACHE.get(archiveId);
  if (replacement && replacement !== entry && replacement.userId !== entry.userId) {
    clearPrepareEntry(entry);
    return false;
  }
  if (replacement && replacement !== entry) {
    PREPARE_CACHE.delete(archiveId);
    clearPrepareEntry(replacement);
  }
  if (
    !replacement
    && (
      PREPARE_CACHE.size >= PREPARE_CACHE_MAX_ENTRIES
      || countPrepareEntriesForUser(entry.userId) >= PREPARE_CACHE_MAX_PER_USER
    )
  ) {
    clearPrepareEntry(entry);
    return false;
  }
  PREPARE_CACHE.set(archiveId, entry);
  ensureSweepTimer();
  return true;
}

export function consumePrepareEntry(
  archiveId: string,
  userId: string,
): ExportPrepareEntry | null {
  purgeExpiredPrepareEntries();
  const entry = PREPARE_CACHE.get(archiveId);
  if (!entry || entry.userId !== userId) return null;
  PREPARE_CACHE.delete(archiveId);
  return entry;
}

/**
 * Restore an owner-checked prepare entry after an aborted/failed stream.
 * Never overwrite a replacement entry or accept a different owner. Any
 * rejected restoration clears the SMK instead of leaving it stranded.
 */
export function restorePrepareEntry(
  archiveId: string,
  userId: string,
  entry: ExportPrepareEntry,
): boolean {
  purgeExpiredPrepareEntries();
  if (
    isPrepareEntryExpired(entry)
    || entry.userId !== userId
    || PREPARE_CACHE.has(archiveId)
    || PREPARE_CACHE.size >= PREPARE_CACHE_MAX_ENTRIES
    || countPrepareEntriesForUser(userId) >= PREPARE_CACHE_MAX_PER_USER
  ) {
    clearPrepareEntry(entry);
    return false;
  }
  PREPARE_CACHE.set(archiveId, entry);
  ensureSweepTimer();
  return true;
}

/** For tests / debugging only. */
export function prepareCacheSize(): number {
  purgeExpiredPrepareEntries();
  return PREPARE_CACHE.size;
}
