/**
 * Storage for Illarin linked instances — one row per user installation.
 *
 * Mirrors the lumihub-link.service pattern: AES-GCM encrypted tokens at rest
 * with a key from the resolved identity material. This table is excluded
 * from export/import (EXCLUDED_TABLES) so credentials never leave the box.
 */

import type { Database } from "bun:sqlite";
import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";
import type { TokenPair } from "../illarin/types";

interface InstanceRow {
  id: string;
  user_id: string;
  illarin_url: string;
  instance_id: string;
  instance_name: string;
  application_name: string;
  scopes_json: string;
  access_token_encrypted: string;
  access_token_iv: string;
  access_token_tag: string;
  access_token_expires_at: string;
  refresh_token_encrypted: string;
  refresh_token_iv: string;
  refresh_token_tag: string;
  last_declaration_json: string | null;
  linked_at: string;
  last_refresh_at: string | null;
}

export interface IllarinInstance {
  userId: string;
  illarinUrl: string;
  instanceId: string;
  instanceName: string;
  applicationName: string;
  scopes: string[];
  accessToken: string;
  /** ISO timestamp as returned by Illarin. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  /** The declaration last sent, parsed. Null when never recorded. */
  lastDeclaration: Record<string, unknown> | null;
  linkedAt: string;
  lastRefreshAt: string | null;
}

export interface SaveInstanceInput {
  userId: string;
  illarinUrl: string;
  pair: TokenPair;
  instanceName: string;
  applicationName: string;
  /** Full requested declaration as sent to /api/v1/connect/* — the version marker. */
  declarationJson: string;
}

let _cachedKey: CryptoKey | null = null;

async function getEncryptionKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey;
  const keyBytes = getEncryptionKeyBytes();
  _cachedKey = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return _cachedKey;
}

/** Drop the cached AES key after identity re-initialization (tests, rotation). */
export function invalidateIllarinKeyCache(): void {
  _cachedKey = null;
}

async function encrypt(plaintext: string): Promise<{ encrypted: string; iv: string; tag: string }> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const bytes = new Uint8Array(ciphertext);
  return {
    encrypted: Buffer.from(bytes.slice(0, -16)).toString("base64"),
    iv: Buffer.from(iv).toString("base64"),
    tag: Buffer.from(bytes.slice(-16)).toString("base64"),
  };
}

async function decrypt(encrypted: string, ivB64: string, tagB64: string): Promise<string> {
  const key = await getEncryptionKey();
  const iv = new Uint8Array(Buffer.from(ivB64, "base64"));
  const data = new Uint8Array(Buffer.from(encrypted, "base64"));
  const tag = new Uint8Array(Buffer.from(tagB64, "base64"));
  const combined = new Uint8Array(data.length + tag.length);
  combined.set(data);
  combined.set(tag, data.length);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(plaintext);
}

/**
 * A rotated refresh token must survive a hard reboot once Illarin has issued
 * it. Temporarily raise this connection from WAL/NORMAL to FULL so the token
 * transaction is flushed at commit, then immediately restore normal tuning.
 * Keep the callback synchronous so no unrelated write can interleave.
 */
function withDurableTokenWrite<T>(write: (db: Database) => T): T {
  const db = getDb();
  const row = db.query("PRAGMA synchronous").get() as { synchronous?: unknown } | null;
  const rawLevel = Number(row?.synchronous);
  const previousLevel = Number.isInteger(rawLevel) && rawLevel >= 0 && rawLevel <= 3 ? rawLevel : 1;
  const needsFullSync = previousLevel < 2;

  if (needsFullSync) db.run("PRAGMA synchronous = FULL");
  try {
    return write(db);
  } finally {
    if (needsFullSync) db.run(`PRAGMA synchronous = ${previousLevel}`);
  }
}

function parseScopes(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string")
      .map((scope) => scope === "asset:receive" ? "work:receive" : scope) : [];
  } catch {
    return [];
  }
}

async function rowToInstance(row: InstanceRow): Promise<IllarinInstance> {
  const [accessToken, refreshToken] = await Promise.all([
    decrypt(row.access_token_encrypted, row.access_token_iv, row.access_token_tag),
    decrypt(row.refresh_token_encrypted, row.refresh_token_iv, row.refresh_token_tag),
  ]);
  let lastDeclaration: Record<string, unknown> | null = null;
  if (row.last_declaration_json) {
    try {
      const parsed = JSON.parse(row.last_declaration_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) lastDeclaration = parsed;
    } catch {}
  }
  return {
    userId: row.user_id,
    illarinUrl: row.illarin_url,
    instanceId: row.instance_id,
    instanceName: row.instance_name,
    applicationName: row.application_name,
    scopes: parseScopes(row.scopes_json),
    accessToken,
    accessTokenExpiresAt: row.access_token_expires_at,
    refreshToken,
    lastDeclaration,
    linkedAt: row.linked_at,
    lastRefreshAt: row.last_refresh_at,
  };
}

/** Get a user's linked Illarin instance, or null when not linked. */
export async function getIllarinInstance(userId: string): Promise<IllarinInstance | null> {
  const row = getDb().query("SELECT * FROM illarin_instance WHERE user_id = ? LIMIT 1").get(userId) as InstanceRow | null;
  return row ? rowToInstance(row) : null;
}

/** Get every configured instance for startup warmup. */
export async function listIllarinInstances(): Promise<IllarinInstance[]> {
  const rows = getDb().query("SELECT * FROM illarin_instance WHERE user_id IS NOT NULL").all() as InstanceRow[];
  const settled = await Promise.allSettled(rows.map(rowToInstance));
  const instances: IllarinInstance[] = [];
  let failed = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") instances.push(result.value);
    else failed++;
  }
  if (failed > 0) {
    console.warn(
      `[Illarin] Skipped ${failed} saved connection${failed === 1 ? "" : "s"} because its credentials could not be read.`,
    );
  }
  return instances;
}

/** Persist a completed link, replacing only that user's row. */
export async function saveInstance(input: SaveInstanceInput): Promise<void> {
  // Finish encryption before touching an existing row. A failed relink can
  // therefore never erase the last usable credential pair.
  const [accessEnc, refreshEnc] = await Promise.all([
    encrypt(input.pair.accessToken),
    encrypt(input.pair.refreshToken),
  ]);
  withDurableTokenWrite((db) => {
    db.query(
      `INSERT INTO illarin_instance (
         user_id, illarin_url, instance_id, instance_name, application_name,
         scopes_json, access_token_encrypted, access_token_iv, access_token_tag,
         access_token_expires_at, refresh_token_encrypted, refresh_token_iv,
         refresh_token_tag, last_declaration_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         illarin_url = excluded.illarin_url,
         instance_id = excluded.instance_id,
         instance_name = excluded.instance_name,
         application_name = excluded.application_name,
         scopes_json = excluded.scopes_json,
         access_token_encrypted = excluded.access_token_encrypted,
         access_token_iv = excluded.access_token_iv,
         access_token_tag = excluded.access_token_tag,
         access_token_expires_at = excluded.access_token_expires_at,
         refresh_token_encrypted = excluded.refresh_token_encrypted,
         refresh_token_iv = excluded.refresh_token_iv,
         refresh_token_tag = excluded.refresh_token_tag,
         last_declaration_json = excluded.last_declaration_json,
         linked_at = datetime('now'),
         last_refresh_at = NULL`,
    ).run(
      input.userId,
      input.illarinUrl,
      input.pair.connectedApp.id,
      input.instanceName,
      input.applicationName,
      JSON.stringify(input.pair.connectedApp.permissions),
      accessEnc.encrypted,
      accessEnc.iv,
      accessEnc.tag,
      input.pair.accessTokenExpiresAt,
      refreshEnc.encrypted,
      refreshEnc.iv,
      refreshEnc.tag,
      input.declarationJson,
    );
  });
}

/**
 * Atomically replace both tokens of an installation after a refresh. The
 * single committed UPDATE is what makes "durable before release" hold: the
 * caller resolves only after this has committed.
 */
export async function replaceTokens(userId: string, pair: TokenPair): Promise<void> {
  const [accessEnc, refreshEnc] = await Promise.all([
    encrypt(pair.accessToken),
    encrypt(pair.refreshToken),
  ]);
  withDurableTokenWrite((db) => {
    db.query(
      `UPDATE illarin_instance SET
         access_token_encrypted = ?, access_token_iv = ?, access_token_tag = ?,
         access_token_expires_at = ?,
         refresh_token_encrypted = ?, refresh_token_iv = ?, refresh_token_tag = ?,
         scopes_json = ?,
         last_refresh_at = datetime('now')
       WHERE user_id = ?`,
    )
    .run(
      accessEnc.encrypted,
      accessEnc.iv,
      accessEnc.tag,
      pair.accessTokenExpiresAt,
      refreshEnc.encrypted,
      refreshEnc.iv,
      refreshEnc.tag,
      JSON.stringify(pair.connectedApp.permissions),
      userId,
    );
  });
}

/** Record the declaration last accepted by Illarin (version-drift marker). */
export function updateLastDeclaration(userId: string, declarationJson: string): void {
  getDb().query("UPDATE illarin_instance SET last_declaration_json = ? WHERE user_id = ?").run(declarationJson, userId);
}

export function canInstallExtensions(userId: string): boolean {
  const row = getDb().query('SELECT role FROM "user" WHERE id = ?').get(userId) as { role: string | null } | null;
  return row?.role === "owner" || row?.role === "admin";
}

/** Remove one user's Illarin credentials entirely. */
export function deleteInstance(userId: string): void {
  getDb().query("DELETE FROM illarin_instance WHERE user_id = ?").run(userId);
}

/** Delivery ids installed locally but not yet acknowledged to Illarin. */
export function pendingDeliveryAcknowledgements(userId: string, instanceId: string): string[] {
  const rows = getDb().query(
    `SELECT delivery_id FROM illarin_delivery_receipt
     WHERE user_id = ? AND instance_id = ? AND acknowledged_at IS NULL
     ORDER BY installed_at ASC LIMIT 32`,
  ).all(userId, instanceId) as Array<{ delivery_id: string }>;
  return rows.map((row) => row.delivery_id);
}

export function hasDeliveryReceipt(userId: string, instanceId: string, deliveryId: string): boolean {
  return Boolean(getDb().query(
    `SELECT 1 FROM illarin_delivery_receipt
     WHERE user_id = ? AND instance_id = ? AND delivery_id = ? LIMIT 1`,
  ).get(userId, instanceId, deliveryId));
}

/** Record only after every required artifact has been stored successfully. */
export function recordDeliveryInstalled(
  userId: string,
  instanceId: string,
  deliveryId: string,
  workId: string,
  versionNumber: number,
): void {
  getDb().query(
    `INSERT OR IGNORE INTO illarin_delivery_receipt
       (user_id, instance_id, delivery_id, asset_id, content_generation)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, instanceId, deliveryId, workId, versionNumber);
}

/** A repeated delivery is acknowledged again without being reinstalled. */
export function queueDeliveryAcknowledgement(userId: string, instanceId: string, deliveryId: string): void {
  getDb().query(
    `UPDATE illarin_delivery_receipt SET acknowledged_at = NULL
     WHERE user_id = ? AND instance_id = ? AND delivery_id = ?`,
  ).run(userId, instanceId, deliveryId);
}

/** The collect response commits every acknowledgement carried in its request. */
export function markDeliveriesAcknowledged(
  userId: string,
  instanceId: string,
  deliveryIds: readonly string[],
): void {
  if (deliveryIds.length === 0) return;
  const placeholders = deliveryIds.map(() => "?").join(", ");
  getDb().query(
    `UPDATE illarin_delivery_receipt SET acknowledged_at = datetime('now')
     WHERE user_id = ? AND instance_id = ? AND delivery_id IN (${placeholders})`,
  ).run(userId, instanceId, ...deliveryIds);
}
