/**
 * Host → Identity Server control-plane client. Every call goes through
 * `safeFetch` (SSRF-hardened) and FAILS CLOSED: if the server is unreachable or
 * misconfigured, remote multiplayer is simply unavailable — no existing control
 * is weakened, and a typo'd/hostile MPIDENTITY_URL can't be turned into an SSRF
 * pivot against the host's own LAN.
 */

import { safeFetch, type SafeFetchOptions } from "../utils/safe-fetch";
import { mpidConfig } from "./config";
import { deriveRoomSecret, roomSecretHex } from "./room-secret";
import { mintHostToken } from "./mpid-token";
import { bytesToHex } from "../crypto/identity";

export interface JoinGrant {
  roomId: string;
  memberId: string;
  peerToken: string;
  /** Durable, revocable credential to rejoin later without a new invite code. */
  reconnectToken?: string;
  transport: {
    relay: { url: string; expiresAt: number };
    direct?: { url: string; directToken: string; expiresAt: number };
  };
}

function baseOpts(extra: SafeFetchOptions): SafeFetchOptions {
  return {
    allowLoopback: mpidConfig.allowPrivate,
    allowPrivate: mpidConfig.allowPrivate,
    timeoutMs: 10_000,
    maxBytes: 256 * 1024,
    ...extra,
  };
}

async function hostAuth(roomId: string): Promise<string> {
  const secret = await deriveRoomSecret(roomId);
  return `Bearer ${await mintHostToken(roomId, secret, mpidConfig.url)}`;
}

export async function registerRoom(
  roomId: string,
  opts: {
    displayName?: string;
    reachability?: "relay-only" | "direct";
    advertisedUrl?: string | null;
    maxPeers?: number;
  } = {},
): Promise<boolean> {
  if (!mpidConfig.enabled) return false;
  try {
    const secret = await deriveRoomSecret(roomId);
    const res = await safeFetch(
      `${mpidConfig.url}/rooms`,
      baseOpts({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          roomId,
          roomSecret: roomSecretHex(secret),
          displayName: opts.displayName,
          reachability: opts.reachability ?? "relay-only",
          advertisedUrl: opts.advertisedUrl ?? null,
          maxPeers: opts.maxPeers,
        }),
      }),
    );
    if (res.ok) {
      // Learn the relay's frame cap so hydration is sized to fit it.
      try {
        const body = (await res.json()) as { maxFrameBytes?: number };
        mpidConfig.setMaxFrameBytes(body?.maxFrameBytes);
      } catch {
        /* keep the conservative default */
      }
    }
    return res.ok;
  } catch (err) {
    console.warn("[mp-remote] registerRoom failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

export async function createInvite(roomId: string): Promise<{ code: string; expiresAt: number } | null> {
  if (!mpidConfig.enabled) return null;
  try {
    const res = await safeFetch(
      `${mpidConfig.url}/rooms/${roomId}/invites`,
      baseOpts({ method: "POST", headers: { authorization: await hostAuth(roomId), "content-type": "application/json" }, body: "{}" }),
    );
    if (!res.ok) return null;
    return (await res.json()) as { code: string; expiresAt: number };
  } catch (err) {
    console.warn("[mp-remote] createInvite failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Redeem an invite code on behalf of a local user (peer side). Proxied
 * server-side so the peer's browser never talks to the Identity Server directly
 * (no CORS, SSRF-guarded) and the ephemeral peer id stays server-generated.
 */
export async function redeemInvite(code: string, opts: { displayName?: string } = {}): Promise<JoinGrant | null> {
  if (!mpidConfig.enabled) return null;
  try {
    const peerPub = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const res = await safeFetch(
      `${mpidConfig.url}/join`,
      baseOpts({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, peerPub, displayName: opts.displayName }),
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as JoinGrant;
  } catch (err) {
    console.warn("[mp-remote] redeemInvite failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Peer side: exchange a stored reconnect token for a fresh JoinGrant (no new
 * invite code consumed). The Identity Server re-checks live membership + ban
 * state, so a kicked/banned member — or a closed room — fails closed here.
 */
export async function reconnect(reconnectToken: string): Promise<JoinGrant | null> {
  if (!mpidConfig.enabled) return null;
  try {
    const res = await safeFetch(
      `${mpidConfig.url}/reconnect`,
      baseOpts({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reconnectToken }),
      }),
    );
    if (!res.ok) return null;
    return (await res.json()) as JoinGrant;
  } catch (err) {
    console.warn("[mp-remote] reconnect failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function heartbeat(
  roomId: string,
  reachability?: string,
  advertisedUrl?: string | null,
  maxPeers?: number,
): Promise<boolean> {
  if (!mpidConfig.enabled) return false;
  try {
    const res = await safeFetch(
      `${mpidConfig.url}/rooms/${roomId}/heartbeat`,
      baseOpts({ method: "POST", headers: { authorization: await hostAuth(roomId), "content-type": "application/json" }, body: JSON.stringify({ reachability, advertisedUrl, maxPeers }) }),
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function closeRoom(roomId: string): Promise<boolean> {
  if (!mpidConfig.enabled) return false;
  try {
    const res = await safeFetch(
      `${mpidConfig.url}/rooms/${roomId}/close`,
      baseOpts({ method: "POST", headers: { authorization: await hostAuth(roomId), "content-type": "application/json" }, body: "{}" }),
    );
    return res.ok;
  } catch {
    return false;
  }
}
