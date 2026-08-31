import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";

interface SecretRow {
  key: string;
  encrypted_value: string;
  iv: string;
  tag: string;
  updated_at: number;
}

function canonicalSecretJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value) ?? "null";
  if (typeof value === "number") return Number.isFinite(value) ? (JSON.stringify(value) ?? "null") : "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalSecretJson(entry)).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSecretJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(String(value)) ?? "null";
}

function secretRevision(key: string, row: SecretRow | null): string {
  const encryptedIdentity = row
    ? (() => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(canonicalSecretJson({
        encrypted_value: row.encrypted_value,
        iv: row.iv,
        tag: row.tag,
      }));
      return hasher.digest("hex");
    })()
    : null;
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(canonicalSecretJson({
    secret_ref: key,
    present: !!row,
    updated_at: row?.updated_at ?? null,
    encrypted_identity: encryptedIdentity,
  }));
  return hasher.digest("hex");
}

/**
 * Reserved principal for system-scope Spindle extension brokers. Real user
 * ids are UUIDs, so this principal is unreachable through normal login.
 * Operators provision system broker secrets under it explicitly via the
 * operator secrets route; system-scoped brokers resolve their credentials
 * from these rows host-side at request time.
 */
export const SYSTEM_SECRET_PRINCIPAL = "__system__";

/**
 * Reserved email of the system principal row. First-user resolution queries
 * (owner seeding, migrations, default presets) exclude this address so the
 * synthetic row can never be mistaken for a real account.
 */
export const SYSTEM_SECRET_PRINCIPAL_EMAIL = "system@lumiverse.local";

let _cachedKey: CryptoKey | null = null;
const warnedUnreadableSecrets = new Set<string>();

export class SecretDecryptionError extends Error {
  readonly code = "SECRET_DECRYPTION_FAILED";

  constructor(secretKey: string, cause?: unknown) {
    super(
      `Stored credential "${secretKey}" cannot be decrypted. Restore the matching identity file or replace the credential in Settings.`,
      { cause },
    );
    this.name = "SecretDecryptionError";
  }
}

export function isSecretDecryptionFailure(err: unknown): boolean {
  return err instanceof DOMException && (err.name === "OperationError" || err.name === "DataError");
}

export function isSecretDecryptionError(err: unknown): err is SecretDecryptionError {
  return err instanceof SecretDecryptionError
    || (err instanceof Error && (err as Error & { code?: unknown }).code === "SECRET_DECRYPTION_FAILED");
}

function normalizeSecretReadError(err: unknown, secretKey: string): unknown {
  return isSecretDecryptionFailure(err) ? new SecretDecryptionError(secretKey, err) : err;
}

async function getEncryptionKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey;

  const keyBytes = getEncryptionKeyBytes();
  _cachedKey = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return _cachedKey;
}

async function encrypt(plaintext: string): Promise<{ encrypted: string; iv: string; tag: string }> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  // AES-GCM appends the 16-byte auth tag to the ciphertext
  const ciphertextBytes = new Uint8Array(ciphertext);
  const encryptedData = ciphertextBytes.slice(0, -16);
  const tag = ciphertextBytes.slice(-16);

  return {
    encrypted: Buffer.from(encryptedData).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    tag: Buffer.from(tag).toString("base64"),
  };
}

async function decrypt(encrypted: string, ivB64: string, tagB64: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = new Uint8Array(Buffer.from(ivB64, "base64"));
  const encryptedData = new Uint8Array(Buffer.from(encrypted, "base64"));
  const tag = new Uint8Array(Buffer.from(tagB64, "base64"));

  // Reconstruct ciphertext + tag for AES-GCM
  const combined = new Uint8Array(encryptedData.length + tag.length);
  combined.set(encryptedData);
  combined.set(tag, encryptedData.length);

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(decrypted);
}

export function listSecretKeys(userId: string): string[] {
  const rows = getDb().query("SELECT key FROM secrets WHERE user_id = ? ORDER BY key").all(userId) as any[];
  return rows.map((r) => r.key);
}

/**
 * The reserved system principal is not a login account, so it must be
 * materialized once before secrets can reference it via the
 * secrets.user_id -> user(id) foreign key.
 */
function ensureSystemPrincipalRow(): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Resolve on the reserved id/email explicitly instead of INSERT OR IGNORE:
  // a silent skip (e.g. an unrelated account already holding the reserved
  // email) would leave secrets writes failing on the foreign key with no
  // explanation. Fail loudly instead.
  const existing = db
    .query('SELECT id FROM "user" WHERE id = ? OR email = ?')
    .get(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL) as { id: string } | null;

  if (!existing) {
    // Real timestamps: createdAt = 0 would sort the synthetic row before every
    // real user in ORDER BY createdAt ASC consumers (owner seeding, ST
    // migration, default presets).
    db.query(
      `INSERT INTO "user" (id, name, email, emailVerified, role, createdAt, updatedAt)
       VALUES (?, 'System', ?, 1, 'system', ?, ?)`,
    ).run(SYSTEM_SECRET_PRINCIPAL, SYSTEM_SECRET_PRINCIPAL_EMAIL, now, now);
    return;
  }

  if (existing.id !== SYSTEM_SECRET_PRINCIPAL) {
    throw new Error(
      `Reserved system principal email "${SYSTEM_SECRET_PRINCIPAL_EMAIL}" is held by account "${existing.id}". ` +
        "Rename or delete that account before provisioning system broker secrets.",
    );
  }

  // Repair legacy rows created with createdAt = 0 so first-user ordering
  // consumers never see the synthetic row as the oldest account.
  db.query(
    `UPDATE "user"
     SET createdAt = CASE WHEN createdAt IS NULL OR createdAt = 0 THEN ? ELSE createdAt END,
         updatedAt = ?
     WHERE id = ?`,
  ).run(now, now, SYSTEM_SECRET_PRINCIPAL);
}

export interface PreparedSecretWrite {
  encrypted: string;
  iv: string;
  tag: string;
  updatedAt: number;
}

/** Encrypt a secret before entering a synchronous SQLite transaction. */
export async function prepareSecretWrite(value: string): Promise<PreparedSecretWrite> {
  const { encrypted, iv, tag } = await encrypt(value);
  return { encrypted, iv, tag, updatedAt: Math.floor(Date.now() / 1000) };
}

/** Persist a prepared secret on the caller's current SQLite transaction. */
export function putPreparedSecret(userId: string, key: string, prepared: PreparedSecretWrite): void {
  if (userId === SYSTEM_SECRET_PRINCIPAL) ensureSystemPrincipalRow();
  getDb()
    .query(
      `INSERT INTO secrets (key, encrypted_value, iv, tag, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET encrypted_value = excluded.encrypted_value, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`,
    )
    .run(key, prepared.encrypted, prepared.iv, prepared.tag, userId, prepared.updatedAt);
}

export async function putSecret(userId: string, key: string, value: string): Promise<void> {
  putPreparedSecret(userId, key, await prepareSecretWrite(value));
}

export async function getSecret(userId: string, key: string): Promise<string | null> {
  const row = getDb().query("SELECT * FROM secrets WHERE key = ? AND user_id = ?").get(key, userId) as SecretRow | null;
  if (!row) return null;
  try {
    return await decrypt(row.encrypted_value, row.iv, row.tag);
  } catch (err) {
    throw normalizeSecretReadError(err, key);
  }
}
/**
 * Load one encrypted credential at the revision frozen during runtime
 * admission. The row and revision are read together; callers never fall back
 * to a fresh read after this fence.
 */
export async function getSecretAtRevision(
  userId: string,
  key: string,
  expectedRevision: string,
): Promise<string | null> {
  const row = getDb().query("SELECT * FROM secrets WHERE key = ? AND user_id = ?").get(key, userId) as SecretRow | null;
  const actualRevision = secretRevision(key, row);
  if (actualRevision !== expectedRevision) {
    throw new Error("credential_revision_mismatch");
  }
  if (!row) return null;
  try {
    return await decrypt(row.encrypted_value, row.iv, row.tag);
  } catch (err) {
    throw normalizeSecretReadError(err, key);
  }
}

async function recoverUnreadableSecretForStatus(
  userId: string,
  key: string,
  read: () => Promise<string | null>,
): Promise<string | null> {
  const warningKey = `${userId}:${key}`;
  try {
    const value = await read();
    warnedUnreadableSecrets.delete(warningKey);
    return value;
  } catch (err) {
    const normalized = normalizeSecretReadError(err, key);
    if (!isSecretDecryptionError(normalized)) throw normalized;
    if (!warnedUnreadableSecrets.has(warningKey)) {
      warnedUnreadableSecrets.add(warningKey);
      console.warn(`[secrets] ${normalized.message} Treating it as missing until it is replaced.`);
    }
    return null;
  }
}

/**
 * Read a credential for a presence/status response. An unreadable encrypted row
 * is reported as missing so its settings UI remains available for recovery.
 * Database and other non-crypto failures still propagate.
 */
export function getSecretForStatus(userId: string, key: string): Promise<string | null> {
  return recoverUnreadableSecretForStatus(userId, key, () => getSecret(userId, key));
}

export function deleteSecret(userId: string, key: string): boolean {
  return getDb().query("DELETE FROM secrets WHERE key = ? AND user_id = ?").run(key, userId).changes > 0;
}

export async function validateSecret(userId: string, key: string): Promise<boolean> {
  const value = await getSecretForStatus(userId, key);
  return value !== null && value.length > 0;
}

export const __test__ = {
  normalizeSecretReadError,
  recoverUnreadableSecretForStatus,
};
