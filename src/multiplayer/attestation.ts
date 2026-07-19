/**
 * Identity-Server attestation validator for the DIRECT transport path.
 *
 * When a remote peer dials the host directly, it presents a server-minted
 * `relay-direct` token (signed with the room secret). The host verifies it
 * OFFLINE — no round-trip to the Identity Server — using its own re-derived
 * room secret. A valid token means the Identity Server attested the peer
 * (valid invite + active member), so the resulting credential is `attested`.
 *
 * Registered alongside the Phase-1 HMAC validator: the WS handler tries each in
 * turn, so a local HMAC room token and a remote direct token both work through
 * the same `?roomToken=` connection path.
 */

import { registerRoomAuthValidator, type RoomAuthValidator } from "../services/room-auth";
import { deriveRoomSecret } from "./room-secret";
import { peekMpidClaims, verifyMpidToken } from "./mpid-token";

export const identityServerAttestationValidator: RoomAuthValidator = {
  name: "mpid-attestation",
  async tryValidate(req, expectedRoomId) {
    const token = req.attestation || req.roomToken;
    if (!token) return null;

    const peek = peekMpidClaims(token);
    if (peek?.typ !== "relay-direct" || !peek.rid) return null;
    if (expectedRoomId && peek.rid !== expectedRoomId) return null;

    const secret = await deriveRoomSecret(peek.rid);
    const claims = await verifyMpidToken(token, secret, {
      aud: `mpid-direct:${peek.rid}`,
      typ: "relay-direct",
      rid: peek.rid,
    });
    if (!claims?.mid) return null;

    return {
      roomId: claims.rid,
      subject: claims.mid, // stable member id → participant identity_ref
      attested: true,
      source: "mpid-attestation",
    };
  },
};

export function registerIdentityServerAttestation(): void {
  registerRoomAuthValidator(identityServerAttestationValidator);
}
