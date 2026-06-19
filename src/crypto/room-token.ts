/**
 * Host-issued room access tokens for multiplayer peers.
 *
 * A remote human joining a host's room is NOT a host-local account, so they
 * cannot present a BetterAuth cookie/session. Instead the host mints a signed,
 * short-lived token bound to one room. The token is a compact JWS-style
 * `header.payload.sig` triple, HMAC-SHA256 over a room-token signing key
 * derived from this instance's identity key (the same HMAC construction as
 * `deriveAuthSecret`, but with a distinct domain-separation tag so room tokens
 * are cryptographically independent of the BetterAuth secret).
 *
 * Security properties:
 *  - HS256 only. The `alg` header is IGNORED on verify — the verifying key is
 *    fixed by construction, so `alg:"none"` / RS256 key-confusion attacks are
 *    structurally impossible.
 *  - The signature is verified (constant-time) BEFORE the payload JSON is
 *    parsed — untrusted bytes are never JSON-parsed until authenticated.
 *  - `exp` is enforced and `iat` is bounded (±60s skew) to reject post-dated
 *    tokens. `rid` must match the room being joined.
 *  - Tokens are stateless and cannot be individually revoked before `exp`.
 *    Revocation is handled out-of-band by the per-room ban list (checked on
 *    every join and message), and tokens are deliberately short-lived.
 */

import { Buffer } from "node:buffer";
import { getEncryptionKeyBytes } from "./init";
import { constantTimeEqual } from "./identity";

/** Default lifetime of a room token. Rooms are ephemeral, so keep this short. */
export const ROOM_TOKEN_TTL_SECONDS = 2 * 60 * 60; // 2 hours

/** Hard cap on token length we will even attempt to verify (DoS guard). */
const MAX_TOKEN_LENGTH = 4096;

export interface RoomTokenClaims {
  /** Token schema version. */
  v: 1;
  /** Room id this token grants access to. */
  rid: string;
  /** Stable subject — becomes the participant's `identity_ref`. */
  sub: string;
  /** Role — always "peer" for room tokens (host uses its own account). */
  rol: "peer";
  /** Optional suggested display name (peer may override at join, validated then). */
  name?: string;
  /** Issued-at (unix seconds). */
  iat: number;
  /** Expiry (unix seconds). */
  exp: number;
  /** Unique token id (reserved for future single-use semantics). */
  jti: string;
}

// ─── base64url helpers (no padding) ──────────────────────────────────────────

function b64urlFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}
function b64urlFromString(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}
function bytesFromB64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}
function stringFromB64url(s: string): string {
  return Buffer.from(s, "base64url").toString("utf8");
}

// ─── signing key (derived once, cached) ──────────────────────────────────────

let _keyPromise: Promise<CryptoKey> | null = null;

/**
 * Derive the room-token signing key from the instance identity key:
 *   subkey = HMAC-SHA256(identityKey, "lumiverse-room-token-v1")
 * then import `subkey` as the HMAC-SHA256 signing key. Domain-separated from
 * `deriveAuthSecret` (different tag) so the two secrets never coincide.
 */
function getRoomTokenKey(): Promise<CryptoKey> {
  if (!_keyPromise) {
    _keyPromise = (async () => {
      const identityKey = getEncryptionKeyBytes();
      const baseKey = await crypto.subtle.importKey(
        "raw",
        identityKey as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const tag = new TextEncoder().encode("lumiverse-room-token-v1");
      const subkey = await crypto.subtle.sign("HMAC", baseKey, tag as BufferSource);
      return crypto.subtle.importKey(
        "raw",
        new Uint8Array(subkey) as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
    })();
  }
  return _keyPromise;
}

/** Test/maintenance hook: drop the cached signing key (e.g. after identity rotation). */
export function resetRoomTokenKeyCache(): void {
  _keyPromise = null;
}

// ─── public API ───────────────────────────────────────────────────────────────

export async function mintRoomToken(opts: {
  roomId: string;
  subject: string;
  displayName?: string;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? ROOM_TOKEN_TTL_SECONDS;
  const header = { alg: "HS256", typ: "lmv-room" };
  const payload: RoomTokenClaims = {
    v: 1,
    rid: opts.roomId,
    sub: opts.subject,
    rol: "peer",
    ...(opts.displayName ? { name: opts.displayName } : {}),
    iat: now,
    exp: now + ttl,
    jti: crypto.randomUUID(),
  };

  const signingInput = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
  const key = await getRoomTokenKey();
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput) as BufferSource),
  );
  return `${signingInput}.${b64urlFromBytes(sig)}`;
}

/**
 * Verify a room token. Returns the validated claims, or null if the token is
 * malformed, has a bad signature, is expired/post-dated, or (when
 * `expectedRoomId` is provided) is scoped to a different room.
 */
export async function verifyRoomToken(
  token: unknown,
  expectedRoomId?: string,
): Promise<RoomTokenClaims | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;

  const signingInput = `${h}.${p}`;
  const key = await getRoomTokenKey();
  const expectedSig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput) as BufferSource),
  );

  let providedSig: Uint8Array;
  try {
    providedSig = bytesFromB64url(s);
  } catch {
    return null;
  }
  // Constant-time signature comparison BEFORE we trust/parse the payload.
  if (!constantTimeEqual(providedSig, expectedSig)) return null;

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(stringFromB64url(p)) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (!claims || claims.v !== 1 || claims.rol !== "peer") return null;
  if (typeof claims.rid !== "string" || typeof claims.sub !== "string") return null;
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return null;
  if (claims.name !== undefined && typeof claims.name !== "string") return null;

  const now = Math.floor(Date.now() / 1000);
  if (now >= claims.exp) return null; // expired
  if (claims.iat > now + 60) return null; // post-dated beyond allowed skew
  if (expectedRoomId && claims.rid !== expectedRoomId) return null;

  return claims as unknown as RoomTokenClaims;
}
