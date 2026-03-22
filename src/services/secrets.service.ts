import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";

interface SecretRow {
  key: string;
  encrypted_value: string;
  iv: string;
  tag: string;
  updated_at: number;
}

let _cachedKey: CryptoKey | null = null;

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

export async function putSecret(userId: string, key: string, value: string): Promise<void> {
  const { encrypted, iv, tag } = await encrypt(value);
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO secrets (key, encrypted_value, iv, tag, user_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET encrypted_value = excluded.encrypted_value, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at`
    )
    .run(key, encrypted, iv, tag, userId, now);
}

export async function getSecret(userId: string, key: string): Promise<string | null> {
  const row = getDb().query("SELECT * FROM secrets WHERE key = ? AND user_id = ?").get(key, userId) as SecretRow | null;
  if (!row) return null;
  return decrypt(row.encrypted_value, row.iv, row.tag);
}

export function deleteSecret(userId: string, key: string): boolean {
  return getDb().query("DELETE FROM secrets WHERE key = ? AND user_id = ?").run(key, userId).changes > 0;
}

export async function validateSecret(userId: string, key: string): Promise<boolean> {
  try {
    const value = await getSecret(userId, key);
    return value !== null && value.length > 0;
  } catch {
    return false;
  }
}
