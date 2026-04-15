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

import { scryptSync, randomBytes, timingSafeEqual } from "crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 16;
const SCRYPT_P = 1;
const SCRYPT_DKLEN = 64;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = scryptSync(password.normalize("NFKC"), salt, SCRYPT_DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}): Promise<boolean> {
  // L-18: A malformed hash previously threw, which could surface stack traces
  // to clients.  Return false instead so authentication simply fails cleanly.
  const [salt, key] = (hash || "").split(":");
  if (!salt || !key || Buffer.from(key, "hex").length !== SCRYPT_DKLEN) return false;
  try {
    const derived = scryptSync(password.normalize("NFKC"), salt, SCRYPT_DKLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
    return timingSafeEqual(derived, Buffer.from(key, "hex"));
  } catch {
    return false;
  }
}
