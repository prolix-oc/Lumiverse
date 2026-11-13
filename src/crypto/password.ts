/**
 * Password Hashing (scrypt)
 *
 * Drop-in replacement for better-auth/crypto's hashPassword/verifyPassword.
 * Uses Node.js built-in crypto (available in Bun on all platforms including
 * Termux) instead of the better-auth package which fails to resolve on some
 * environments due to its transitive dependency chain.
 *
 * Hash format: `{salt_hex}:{key_hex}` — identical to better-auth's format,
 * so existing hashes in the database and owner.credentials are compatible.
 *
 * Parameters match better-auth exactly: scrypt N=16384, r=16, p=1, dkLen=64.
 */

import { scrypt, randomBytes, timingSafeEqual } from "crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 16;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

const SCRYPT_OPTIONS = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  maxmem: SCRYPT_MAXMEM,
};

/**
 * scryptSync used to block the event loop for 100–500 ms per call. The
 * callback-based scrypt offloads work to libuv's thread pool, so the main
 * thread keeps serving HTTP and WebSocket traffic during a login.
 */
function scryptAsync(password: string, salt: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFKC"),
      salt,
      SCRYPT_DKLEN,
      SCRYPT_OPTIONS,
      (err, derivedKey) => {
        if (err) reject(err);
        else resolve(derivedKey as Buffer);
      },
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password, salt);
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  const [salt, key] = hash.split(":");
  if (!salt || !key) {
    // Malformed hash — return false instead of throwing so callers can use
    // this to gate an auth check without an extra try/catch. Hash format
    // information is no longer leaked via a RangeError.
    return false;
  }
  let derived: Buffer;
  try {
    derived = await scryptAsync(password, salt);
  } catch {
    return false;
  }
  let stored: Buffer;
  try {
    stored = Buffer.from(key, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws if the buffers differ in length — a malformed
  // stored hash would otherwise leak that detail to the caller.
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(derived, stored);
}
