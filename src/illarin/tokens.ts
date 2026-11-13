/**
 * Credential lifecycle policy for Illarin linked instances.
 *
 * Protocol invariants enforced here:
 * - Only one refresh per installation is ever in flight; concurrent callers
 *   coalesce onto the same in-flight promise.
 * - The replacement pair is durably persisted (single committed UPDATE)
 *   before the new access token is released to any worker.
 * - A refresh 401 or uncertain rotation stops the installation instead of
 *   risking a replay of a spent refresh token.
 */

import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as svc from "../services/illarin-instance.service";
import { IllarinApiError, IllarinUnauthorizedError, IllarinRateLimitError, IllarinUnavailableError, refreshTokens } from "./api";
import type { IllarinRequestOptions } from "./api";

/** Refresh this long before expiry to absorb clock skew. Access tokens last 15 minutes. */
const EXPIRY_SKEW_MS = 90_000;

export type LinkStateReason =
  | "unauthorized"
  | "refresh_uncertain"
  | "unlinked";

const inflightRefreshes = new Map<string, Promise<string | null>>();

function isExpiringSoon(expiresAtIso: string): boolean {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) return true;
  return expiresAtMs - Date.now() < EXPIRY_SKEW_MS;
}

/**
 * Emit link-state change so the UI resets and background workers stop.
 * Local unlink has no remote counterpart yet: the owner revokes the matching
 * instance (by ID + displayed names) in Illarin account settings themselves.
 */
export async function handleTerminalUnauthorized(userId: string, reason: LinkStateReason): Promise<void> {
  svc.deleteInstance(userId);
  eventBus.emit(EventType.ILLARIN_LINK_STATE_CHANGED, { linked: false, reason }, userId);
}

/**
 * Return a valid access token for authenticated Illarin calls, refreshing
 * first when the stored one is inside the skew window. Returns null when the
 * user is not linked or the installation was torn down during refresh.
 * Throws when an uncommitted rate limit or service rejection can be retried.
 */
export async function getValidAccessToken(userId: string, options?: IllarinRequestOptions): Promise<string | null> {
  const record = await svc.getIllarinInstance(userId);
  if (!record) return null;
  if (!isExpiringSoon(record.accessTokenExpiresAt)) return record.accessToken;

  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefresh(userId, options).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

/** Force one serialized rotation after an ordinary access endpoint returns 401. */
export async function refreshAccessToken(userId: string, options?: IllarinRequestOptions): Promise<string | null> {
  const existing = inflightRefreshes.get(userId);
  if (existing) return existing;

  const refreshPromise = doRefresh(userId, options, true).finally(() => inflightRefreshes.delete(userId));
  inflightRefreshes.set(userId, refreshPromise);
  return refreshPromise;
}

export async function withAccessToken<T>(userId: string, call: (accessToken: string) => Promise<T>): Promise<T | null> {
  const accessToken = await getValidAccessToken(userId);
  if (!accessToken) return null;
  try {
    return await call(accessToken);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
  }

  const refreshed = await refreshAccessToken(userId);
  if (!refreshed) return null;
  try {
    return await call(refreshed);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;
    await handleTerminalUnauthorized(userId, "unauthorized");
    return null;
  }
}

async function doRefresh(userId: string, options?: IllarinRequestOptions, force = false): Promise<string | null> {
  // Re-load under serialization: an earlier waiter may have already rotated.
  const record = await svc.getIllarinInstance(userId);
  if (!record) return null;
  if (!force && !isExpiringSoon(record.accessTokenExpiresAt)) return record.accessToken;

  let pair;
  try {
    pair = await refreshTokens(record.illarinUrl, record.refreshToken, options);
  } catch (err) {
    if (err instanceof IllarinUnauthorizedError) {
      await handleTerminalUnauthorized(userId, "unauthorized");
      return null;
    }
    if (err instanceof IllarinApiError && !(err instanceof IllarinRateLimitError) &&
        !(err instanceof IllarinUnavailableError)) {
      await handleTerminalUnauthorized(userId, "refresh_uncertain");
      return null;
    }
    throw err;
  }
  try {
    await svc.replaceTokens(userId, pair);
  } catch (err) {
    await handleTerminalUnauthorized(userId, "refresh_uncertain");
    throw err;
  }
  return pair.accessToken;
}
