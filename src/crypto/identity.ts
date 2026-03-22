/**
 * Lumiverse Identity File
 *
 * A binary identity file that stores the AES-256 encryption key in an opaque
 * format. The file looks like random binary data — the key is XOR-masked with
 * a derived value so it cannot be extracted without knowing the internal format.
 *
 * File layout (104 bytes):
 *   [0..3]    Magic: \x89LMV  (binary signature, like PNG uses \x89PNG)
 *   [4]       Version: 0x01
 *   [5..7]    Reserved (random padding)
 *   [8..39]   Random salt (32 bytes)
 *   [40..71]  Masked key: AES-256 key XOR SHA-256(salt || DERIVATION_TAG)
 *   [72..103] Integrity: HMAC-SHA256(raw_key, salt)
 *
 * To recover the key the backend reverses the XOR mask and verifies the HMAC.
 * Without knowledge of the derivation tag the file is indistinguishable from
 * 104 bytes of random data.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const MAGIC = new Uint8Array([0x89, 0x4c, 0x4d, 0x56]); // \x89LMV
const VERSION = 0x01;
const DERIVATION_TAG = new TextEncoder().encode("lumiverse-identity-derivation");
const FILE_SIZE = 104;

// ─── Low-level helpers (sync, Web Crypto) ────────────────────────────────

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(hash);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    data as BufferSource, // salt is the HMAC key
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, key as BufferSource);
  return new Uint8Array(sig);
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Create a new identity file from a 32-byte raw key.
 * If no key is provided, one is generated randomly.
 */
export async function createIdentityFile(filePath: string, rawKey?: Uint8Array): Promise<Uint8Array> {
  const key = rawKey ?? crypto.getRandomValues(new Uint8Array(32));

  if (key.length !== 32) {
    throw new Error("Identity key must be exactly 32 bytes");
  }

  const salt = crypto.getRandomValues(new Uint8Array(32));
  const reserved = crypto.getRandomValues(new Uint8Array(3));

  // Derive mask: SHA-256(salt || derivation tag)
  const mask = await sha256(concatBytes(salt, DERIVATION_TAG));
  const maskedKey = xorBytes(key, mask);

  // Integrity: HMAC-SHA256(key, salt)
  const integrity = await hmacSha256(key, salt);

  // Assemble file
  const file = new Uint8Array(FILE_SIZE);
  file.set(MAGIC, 0);
  file[4] = VERSION;
  file.set(reserved, 5);
  file.set(salt, 8);
  file.set(maskedKey, 40);
  file.set(integrity, 72);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, file, { mode: 0o600 });

  return key;
}

/**
 * Read and extract the AES-256 key from an identity file.
 * Throws on corruption, wrong version, or integrity failure.
 */
export async function readIdentityFile(filePath: string): Promise<Uint8Array> {
  const file = new Uint8Array(readFileSync(filePath));

  if (file.length !== FILE_SIZE) {
    throw new Error(`Identity file is ${file.length} bytes, expected ${FILE_SIZE}`);
  }

  // Validate magic
  for (let i = 0; i < MAGIC.length; i++) {
    if (file[i] !== MAGIC[i]) {
      throw new Error("Not a Lumiverse identity file (bad magic)");
    }
  }

  // Validate version
  if (file[4] !== VERSION) {
    throw new Error(`Unsupported identity file version: ${file[4]}`);
  }

  const salt = file.slice(8, 40);
  const maskedKey = file.slice(40, 72);
  const storedHmac = file.slice(72, 104);

  // Recover key
  const mask = await sha256(concatBytes(salt, DERIVATION_TAG));
  const key = xorBytes(maskedKey, mask);

  // Verify integrity
  const expectedHmac = await hmacSha256(key, salt);
  if (!constantTimeEqual(storedHmac, expectedHmac)) {
    throw new Error("Identity file integrity check failed — file may be corrupted");
  }

  return key;
}

/**
 * Convert a hex string (e.g. from ENCRYPTION_KEY env var) to raw bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s/g, "");
  if (clean.length !== 64) {
    throw new Error(`Expected 64-char hex string, got ${clean.length}`);
  }
  return new Uint8Array(clean.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
}

/**
 * Convert raw bytes to hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Derive a BetterAuth-compatible secret from the identity key.
 * Deterministic: same identity key always produces the same secret.
 */
export async function deriveAuthSecret(key: Uint8Array): Promise<string> {
  const tag = new TextEncoder().encode("lumiverse-auth-secret-v1");
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, tag as BufferSource);
  return bytesToHex(new Uint8Array(sig));
}

export interface ResolvedIdentity {
  key: Uint8Array;
  /** Hex representation for backwards-compat APIs */
  keyHex: string;
  source: "file" | "env-migrated" | "env-ephemeral" | "generated";
}

/**
 * Resolve the encryption identity using the priority chain:
 *
 * 1. Identity file exists → use it
 * 2. ENCRYPTION_KEY env var set → migrate to identity file, use it
 * 3. Neither → generate new identity file
 *
 * @param identityPath  Full path to the identity file
 * @param envKeyHex     Value of ENCRYPTION_KEY env var (may be empty)
 */
export async function resolveIdentity(identityPath: string, envKeyHex: string): Promise<ResolvedIdentity> {
  // 1. Identity file exists
  if (existsSync(identityPath)) {
    const key = await readIdentityFile(identityPath);
    return { key, keyHex: bytesToHex(key), source: "file" };
  }

  // 2. Env var set — migrate to identity file
  if (envKeyHex) {
    const key = hexToBytes(envKeyHex);
    await createIdentityFile(identityPath, key);
    console.log(`[identity] Migrated ENCRYPTION_KEY to identity file: ${identityPath}`);
    console.log("[identity] You can now remove ENCRYPTION_KEY from your .env file.");
    return { key, keyHex: envKeyHex, source: "env-migrated" };
  }

  // 3. Generate fresh
  const key = await createIdentityFile(identityPath);
  console.log(`[identity] Generated new identity file: ${identityPath}`);
  return { key, keyHex: bytesToHex(key), source: "generated" };
}
