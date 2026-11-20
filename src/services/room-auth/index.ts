/**
 * Room authentication registry.
 *
 * A remote multiplayer peer authenticates to a room WS connection via a
 * credential that is NOT a host-local account. This registry decouples the WS
 * handler from *how* that credential is validated: the handler only ever calls
 * `validateRoomCredential()`, and validators are registered in priority order.
 *
 * Phase 1 ships exactly one validator — `hmacRoomTokenValidator` — which
 * verifies a host-minted HMAC room token. In Phase 2 an
 * `IdentityServerAttestationValidator` registers alongside it (returning
 * `attested: true`), so policy can later require attestation for sensitive
 * actions without touching the handler.
 */

import { verifyRoomToken } from "../../crypto/room-token";

export interface RoomCredential {
  /** Room the credential grants access to. */
  roomId: string;
  /** Stable peer identity → participant `identity_ref`. */
  subject: string;
  /** Optional suggested display name carried by the credential. */
  displayName?: string;
  /**
   * True only when an external attestation source (the Identity Server)
   * vouched for this peer. A bare HMAC room token is `false` — it proves
   * possession of a valid invite, not attestation of a genuine client.
   */
  attested: boolean;
  /** Name of the validator that accepted the credential (for logging/policy). */
  source: string;
}

export interface RoomAuthRequest {
  /** Host-minted HMAC room token (Phase 1). */
  roomToken?: string;
  /** External attestation blob from the Identity Server (Phase 2). */
  attestation?: string;
}

export interface RoomAuthValidator {
  name: string;
  /**
   * Attempt to validate the request. Return a credential on success, or null
   * to defer to the next validator. `expectedRoomId`, when provided, must match
   * the credential's room.
   */
  tryValidate(req: RoomAuthRequest, expectedRoomId?: string): Promise<RoomCredential | null>;
}

const validators: RoomAuthValidator[] = [];

export function registerRoomAuthValidator(validator: RoomAuthValidator): void {
  // De-dupe by name so a hot-reload / double-import can't stack validators.
  const existing = validators.findIndex((v) => v.name === validator.name);
  if (existing >= 0) validators[existing] = validator;
  else validators.push(validator);
}

/** Try each registered validator in order; first non-null credential wins. */
export async function validateRoomCredential(
  req: RoomAuthRequest,
  expectedRoomId?: string,
): Promise<RoomCredential | null> {
  for (const validator of validators) {
    try {
      const credential = await validator.tryValidate(req, expectedRoomId);
      if (credential) return credential;
    } catch (err) {
      console.error(`[room-auth] validator "${validator.name}" threw:`, err);
    }
  }
  return null;
}

// ─── Phase 1 validator: host-minted HMAC room token ──────────────────────────

export const hmacRoomTokenValidator: RoomAuthValidator = {
  name: "hmac-room-token",
  async tryValidate(req, expectedRoomId) {
    if (!req.roomToken) return null;
    const claims = await verifyRoomToken(req.roomToken, expectedRoomId);
    if (!claims) return null;
    return {
      roomId: claims.rid,
      subject: claims.sub,
      displayName: claims.name,
      attested: false,
      source: "hmac-room-token",
    };
  },
};

registerRoomAuthValidator(hmacRoomTokenValidator);
