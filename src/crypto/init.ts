import { join } from "path";
import { env } from "../env";
import { resolveIdentity, deriveAuthSecret, type ResolvedIdentity } from "./identity";

let _identity: ResolvedIdentity | null = null;

/**
 * Resolve the encryption identity at startup.
 * Must be called once before any secrets operations.
 *
 * Also derives AUTH_SECRET from the identity key if not explicitly set,
 * so BetterAuth works without a manual configuration step.
 */
export async function initIdentity(): Promise<void> {
  const identityPath = join(env.dataDir, "lumiverse.identity");

  _identity = await resolveIdentity(identityPath, env.encryptionKey);

  if (_identity.source === "generated") {
    console.log("[identity] New identity file created. Keep data/lumiverse.identity safe — it cannot be regenerated.");
  } else if (_identity.source === "env-migrated") {
    console.log("[identity] Your encryption key has been migrated to data/lumiverse.identity.");
    console.log("[identity] You may remove ENCRYPTION_KEY from your .env file.");
  }

  // Derive AUTH_SECRET from identity key if not explicitly configured
  if (!env.authSecret) {
    const derived = await deriveAuthSecret(_identity.key);
    (env as { authSecret: string }).authSecret = derived;
    console.log("[identity] AUTH_SECRET derived from identity file (not set in .env).");
  }
}

/**
 * Get the resolved encryption key as a hex string.
 * Throws if called before initIdentity().
 */
export function getEncryptionKeyHex(): string {
  if (!_identity) {
    throw new Error("Identity not initialized. Call initIdentity() first.");
  }
  return _identity.keyHex;
}

/**
 * Get the resolved encryption key as raw bytes.
 * Throws if called before initIdentity().
 */
export function getEncryptionKeyBytes(): Uint8Array {
  if (!_identity) {
    throw new Error("Identity not initialized. Call initIdentity() first.");
  }
  return _identity.key;
}

/**
 * Get the full identity resolution info.
 */
export function getIdentity(): ResolvedIdentity {
  if (!_identity) {
    throw new Error("Identity not initialized. Call initIdentity() first.");
  }
  return _identity;
}
