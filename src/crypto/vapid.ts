import { mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "../env";

interface VapidKeys {
  /** JWK private key (for PushForge / server-side signing) */
  privateJWK: JsonWebKey;
  /** Base64url-encoded public key (for frontend PushManager.subscribe) */
  publicKey: string;
}

let _keys: VapidKeys | null = null;

/**
 * Initialize VAPID keys for Web Push.
 * Uses Web Crypto to generate an ECDSA P-256 key pair.
 * Stores at data/vapid.keys as JSON (JWK private + base64url public).
 * Must be called once at startup before any push operations.
 */
export async function initVapidKeys(): Promise<void> {
  const keysPath = join(env.dataDir, "vapid.keys");

  const keysFile = Bun.file(keysPath);
  if (await keysFile.exists()) {
    try {
      const raw = await keysFile.text();
      const parsed = JSON.parse(raw);

      // Support new format (privateJWK + publicKey)
      if (parsed.privateJWK && parsed.publicKey) {
        _keys = parsed as VapidKeys;
        console.log("[vapid] Loaded VAPID keys from", keysPath);
        return;
      }

      // Old web-push format detected — regenerate
      console.log("[vapid] Old key format detected, regenerating...");
    } catch (err) {
      console.error("[vapid] Failed to read VAPID keys, regenerating:", err);
    }
  }

  // Generate new ECDSA P-256 key pair using Web Crypto
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  // Export private key as JWK (PushForge needs this)
  const privateJWK = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  // Export public key as raw bytes, then base64url-encode for frontend
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const publicKey = arrayBufferToBase64Url(publicKeyRaw);

  _keys = { privateJWK, publicKey };

  mkdirSync(dirname(keysPath), { recursive: true });
  await Bun.write(keysPath, JSON.stringify(_keys, null, 2));

  // Set restrictive permissions where the filesystem supports it
  try {
    chmodSync(keysPath, 0o600);
  } catch {
    // Non-fatal: filesystem doesn't support Unix permissions
  }

  console.log("[vapid] Generated new VAPID keys:", keysPath);
}

/**
 * Get the VAPID public key (base64url-encoded, for frontend PushManager.subscribe).
 */
export function getVapidPublicKey(): string {
  if (!_keys) throw new Error("VAPID keys not initialized. Call initVapidKeys() first.");
  return _keys.publicKey;
}

/**
 * Get the VAPID private key as JWK (for PushForge buildPushHTTPRequest).
 */
export function getVapidPrivateJWK(): JsonWebKey {
  if (!_keys) throw new Error("VAPID keys not initialized. Call initVapidKeys() first.");
  return _keys.privateJWK;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
