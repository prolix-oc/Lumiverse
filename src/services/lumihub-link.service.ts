import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";

interface LinkRow {
  id: string;
  user_id: string;
  lumihub_url: string;
  ws_url: string;
  instance_name: string;
  link_token_encrypted: string;
  link_token_iv: string;
  link_token_tag: string;
  instance_id: string;
  linked_at: string;
  last_connected_at: string | null;
  share_usage_stats: number;
}

export interface LinkConfig {
  id: string;
  userId: string;
  lumihubUrl: string;
  wsUrl: string;
  instanceName: string;
  linkToken: string;
  instanceId: string;
  linkedAt: string;
  lastConnectedAt: string | null;
  shareUsageStats: boolean;
}

let _cachedKey: CryptoKey | null = null;

async function getEncryptionKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey;
  const keyBytes = getEncryptionKeyBytes();
  _cachedKey = await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return _cachedKey;
}

/**
 * Drop the cached AES key so the next encrypt/decrypt re-imports from the
 * (potentially rotated) identity material. Call this from the identity-key
 * rotation flow and from any test-suite teardown that reinitializes the
 * encryption key.
 */
export function invalidateLumiHubKeyCache(): void {
  _cachedKey = null;
}

async function encrypt(plaintext: string): Promise<{ encrypted: string; iv: string; tag: string }> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
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
  const combined = new Uint8Array(encryptedData.length + tag.length);
  combined.set(encryptedData);
  combined.set(tag, encryptedData.length);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return new TextDecoder().decode(decrypted);
}

function rowToConfig(row: LinkRow, linkToken: string): LinkConfig {
  return {
    id: row.id,
    userId: row.user_id,
    lumihubUrl: row.lumihub_url,
    wsUrl: row.ws_url,
    instanceName: row.instance_name,
    linkToken,
    instanceId: row.instance_id,
    linkedAt: row.linked_at,
    lastConnectedAt: row.last_connected_at,
    shareUsageStats: row.share_usage_stats === 1,
  };
}

/** Get a user's LumiHub link configuration, or null if they have not linked. */
export async function getLinkConfig(userId: string): Promise<LinkConfig | null> {
  const row = getDb().query("SELECT * FROM lumihub_link WHERE user_id = ? LIMIT 1").get(userId) as LinkRow | null;
  if (!row) return null;

  const linkToken = await decrypt(row.link_token_encrypted, row.link_token_iv, row.link_token_tag);
  return rowToConfig(row, linkToken);
}

/** Get every configured link for startup reconnection. */
export async function listLinkConfigs(): Promise<LinkConfig[]> {
  const rows = getDb().query("SELECT * FROM lumihub_link WHERE user_id IS NOT NULL").all() as LinkRow[];
  return Promise.all(rows.map(async (row) => {
    const token = await decrypt(row.link_token_encrypted, row.link_token_iv, row.link_token_tag);
    return rowToConfig(row, token);
  }));
}

/** Save a user's LumiHub link configuration (replaces only that user's link). */
export async function saveLinkConfig(
  userId: string,
  lumihubUrl: string,
  wsUrl: string,
  linkToken: string,
  instanceId: string,
  instanceName: string
): Promise<void> {
  getDb().query("DELETE FROM lumihub_link WHERE user_id = ?").run(userId);

  const { encrypted, iv, tag } = await encrypt(linkToken);
  getDb()
    .query(
      `INSERT INTO lumihub_link (user_id, lumihub_url, ws_url, instance_name, link_token_encrypted, link_token_iv, link_token_tag, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, lumihubUrl, wsUrl, instanceName, encrypted, iv, tag, instanceId);
}

/** Delete one user's LumiHub link configuration. */
export function deleteLinkConfig(userId: string): void {
  getDb().query("DELETE FROM lumihub_link WHERE user_id = ?").run(userId);
}

/** Check if a LumiHub link is configured for a user. */
export function isLinked(userId: string): boolean {
  const row = getDb().query("SELECT id FROM lumihub_link WHERE user_id = ? LIMIT 1").get(userId);
  return row !== null;
}

/** Update the last_connected_at timestamp. */
export function updateLastConnected(userId: string): void {
  getDb().query("UPDATE lumihub_link SET last_connected_at = datetime('now') WHERE user_id = ?").run(userId);
}

/** Whether the user has opted in to sharing anonymous usage counters. */
export function isStatsSharingEnabled(userId: string): boolean {
  const row = getDb().query("SELECT share_usage_stats FROM lumihub_link WHERE user_id = ? LIMIT 1").get(userId) as
    | { share_usage_stats: number }
    | null;
  return row?.share_usage_stats === 1;
}

/** Enable/disable sharing anonymous usage counters with the linked hub. */
export function setStatsSharing(userId: string, enabled: boolean): void {
  getDb().query("UPDATE lumihub_link SET share_usage_stats = ? WHERE user_id = ?").run(enabled ? 1 : 0, userId);
}

/** Generate a PKCE code_verifier and code_challenge (S256). */
export async function generatePKCE(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  // Generate 32 random bytes as base64url code_verifier (43 chars)
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = Buffer.from(verifierBytes).toString("base64url");

  // S256: SHA-256 hash of code_verifier, base64url-encoded
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = Buffer.from(hashBuffer).toString("base64url");

  return { codeVerifier, codeChallenge };
}
