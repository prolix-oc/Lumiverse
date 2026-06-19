/**
 * Host-side remote attestation: the offline verification of an Identity-Server
 * "relay-direct" token. The server mints it signed with the room secret the
 * host registered; the host re-derives that secret and verifies WITHOUT any
 * round-trip. This exercises the same wire format both projects implement, so a
 * pass means the cross-project trust chain (derive → register → mint → verify)
 * is sound. Forgeries (wrong secret / wrong room / expired) must be rejected.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { initIdentity } from "../src/crypto/init";
import { deriveRoomSecret } from "../src/multiplayer/room-secret";
import { identityServerAttestationValidator } from "../src/multiplayer/attestation";

beforeAll(async () => {
  await initIdentity();
});

/** Mint a relay-direct token exactly as the Identity Server's tokens.ts does. */
async function mintDirect(roomId: string, memberId: string, secret: Uint8Array, ttl = 120): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "mpid" };
  const payload = {
    typ: "relay-direct",
    aud: `mpid-direct:${roomId}`,
    rid: roomId,
    mid: memberId,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomUUID(),
  };
  const si = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  const k = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(si) as BufferSource));
  return `${si}.${Buffer.from(sig).toString("base64url")}`;
}

describe("identity server attestation (host side)", () => {
  test("accepts a server-minted direct token for the room", async () => {
    const roomId = crypto.randomUUID();
    const secret = await deriveRoomSecret(roomId); // == the secret the host registered
    const token = await mintDirect(roomId, "member-1", secret);

    const cred = await identityServerAttestationValidator.tryValidate({ roomToken: token }, roomId);
    expect(cred).not.toBeNull();
    expect(cred!.attested).toBe(true);
    expect(cred!.subject).toBe("member-1");
    expect(cred!.roomId).toBe(roomId);
    expect(cred!.source).toBe("mpid-attestation");
  });

  test("room-secret derivation is deterministic + room-scoped", async () => {
    const roomId = crypto.randomUUID();
    const a = await deriveRoomSecret(roomId);
    const b = await deriveRoomSecret(roomId);
    const other = await deriveRoomSecret(crypto.randomUUID());
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(other).toString("hex"));
  });

  test("rejects a token signed with the wrong secret", async () => {
    const roomId = crypto.randomUUID();
    const token = await mintDirect(roomId, "m", crypto.getRandomValues(new Uint8Array(32)));
    expect(await identityServerAttestationValidator.tryValidate({ roomToken: token }, roomId)).toBeNull();
  });

  test("rejects a token for a different room", async () => {
    const roomId = crypto.randomUUID();
    const token = await mintDirect(roomId, "m", await deriveRoomSecret(roomId));
    expect(await identityServerAttestationValidator.tryValidate({ roomToken: token }, crypto.randomUUID())).toBeNull();
  });

  test("rejects an expired token", async () => {
    const roomId = crypto.randomUUID();
    const token = await mintDirect(roomId, "m", await deriveRoomSecret(roomId), -5);
    expect(await identityServerAttestationValidator.tryValidate({ roomToken: token }, roomId)).toBeNull();
  });

  test("ignores a Phase-1 HMAC room token (different type)", async () => {
    // A non-direct token must not be accepted by the attestation validator.
    const roomId = crypto.randomUUID();
    const secret = await deriveRoomSecret(roomId);
    // typ:"host" instead of relay-direct
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "HS256", typ: "mpid" };
    const payload = { typ: "host", aud: `mpid-direct:${roomId}`, rid: roomId, iat: now, exp: now + 120, jti: "x" };
    const si = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
    const k = await crypto.subtle.importKey("raw", secret as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(si) as BufferSource));
    const token = `${si}.${Buffer.from(sig).toString("base64url")}`;
    expect(await identityServerAttestationValidator.tryValidate({ roomToken: token }, roomId)).toBeNull();
  });
});
