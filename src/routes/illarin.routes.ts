/**
 * Illarin linked-instance routes (authenticated; mounted at /api/v1/illarin).
 *
 * The loopback callback never touches this app — the browser hits the
 * backend's temporary listener directly, so unlike the LumiHub flow there is
 * no unauthenticated callback route here. The frontend starts a link and
 * observes its status; remote-device token pickup runs in this backend so it
 * survives the settings page closing or running on another machine.
 *
 * Local unlink removes credentials only: until Illarin publishes a remote
 * revocation endpoint, the owner revokes the matching instance (matched by
 * server-issued instance ID and displayed names) in their account settings.
 */

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import * as svc from "../services/illarin-instance.service";
import { buildDeclaration } from "../illarin/declaration";
import { LINK_TIMEOUT_MS, runBrowserLink } from "../illarin/link-browser";
import { createDeviceRequest } from "../illarin/api";
import { DeviceLinkSession, runDeviceLinkUntilTerminal } from "../illarin/link-device";
import { readBackendVersion } from "../illarin/warmup";
import { handleTerminalUnauthorized, refreshAccessToken } from "../illarin/tokens";
import { getDeliveryWorkerStatus, startDeliveryWorker, stopDeliveryWorker } from "../illarin/delivery-worker";
import { clearPermissionError, getPermissionError } from "../illarin/permission-state";
import type { BrowserLinkOutcome } from "../illarin/link-browser";

interface PendingBrowserLink {
  userId: string;
  status: "pending" | "linked" | "failed";
  reason?: string;
  expiresAt: number;
}

// One live linking attempt per user — a new attempt retires the old one so
// abandoned listeners cannot accumulate.
const pendingLinks = new Map<string, PendingBrowserLink>();


interface PendingDeviceLink {
  userId: string;
  baseUrl: string;
  session: DeviceLinkSession;
  instanceName: string;
  applicationName: string;
  declarationJson: string;
  expiresAt: number;
  status: "pending" | "linked" | "denied" | "expired" | "unknown_code" | "failed";
  instanceId?: string;
  completedAt?: number;
  controller: AbortController;
}

// One active device attempt per user, keyed by userId.
const pendingDeviceLinks = new Map<string, PendingDeviceLink>();
function sweepPendingLinks(): void {
  const now = Date.now();
  for (const [id, link] of pendingLinks) {
    if (now > link.expiresAt && link.status === "pending") link.status = "failed";
    if (link.status !== "pending" && now > link.expiresAt + 60_000) pendingLinks.delete(id);
  }
  for (const [userId, device] of pendingDeviceLinks) {
    if (device.status === "pending" && now > device.expiresAt) {
      device.controller.abort();
      device.status = "expired";
      device.completedAt = now;
    }
    if (device.status !== "pending" && now > (device.completedAt ?? device.expiresAt) + 60_000) {
      pendingDeviceLinks.delete(userId);
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = setInterval(() => sweepPendingLinks(), 30_000);

export function stopIllarinSweeps(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  for (const device of pendingDeviceLinks.values()) device.controller.abort();
  pendingDeviceLinks.clear();
}

function cancelDeviceLink(userId: string): void {
  const pending = pendingDeviceLinks.get(userId);
  if (!pending) return;
  pending.controller.abort();
  pendingDeviceLinks.delete(userId);
}

function activeLinkFor(userId: string): PendingBrowserLink | undefined {
  for (const link of pendingLinks.values()) {
    if (link.userId === userId) return link;
  }
  return undefined;
}

export const illarinRoutes = new Hono();

/** Start a same-device browser link. */
illarinRoutes.post("/link/browser", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null) as { illarin_url?: unknown; instance_name?: unknown } | null;

  const baseUrl = typeof body?.illarin_url === "string" ? body.illarin_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl) return c.json({ error: "illarin_url is required" }, 400);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return c.json({ error: "illarin_url is not a valid URL" }, 400);
  }
  if (parsedUrl.protocol !== "https:") {
    return c.json({ error: "illarin_url must use https" }, 400);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return c.json({ error: "illarin_url must not contain credentials, a query, or a fragment" }, 400);
  }
  try {
    await validateHost(parsedUrl.hostname);
  } catch (err) {
    if (err instanceof SSRFError) return c.json({ error: err.message }, 400);
    throw err;
  }

  // Retire any previous attempt for this user before starting another.
  for (const [id, link] of pendingLinks) {
    if (link.userId === userId) pendingLinks.delete(id);
  }

  const instanceName = typeof body?.instance_name === "string" && body.instance_name.trim()
    ? body.instance_name.trim()
    : "My Lumiverse";

  let declaration;
  try {
    declaration = buildDeclaration({
      instanceName,
      applicationVersion: await readBackendVersion(),
      scopes: ["work:receive", "library:sync"],
      installsExtensions: svc.canInstallExtensions(userId),
    });
  } catch (err) {
    return c.json({ error: err instanceof RangeError ? err.message : "invalid declaration" }, 400);
  }

  const linkId = randomUUID();
  const session: PendingBrowserLink = {
    userId,
    status: "pending",
    expiresAt: Date.now() + LINK_TIMEOUT_MS + 10_000,
  };
  pendingLinks.set(linkId, session);

  // The browser that initiated the request owns opening the authorization
  // page. This works on mobile localhost installs where desktop launchers
  // such as xdg-open are unavailable, and lets the frontend reserve a tab
  // synchronously before its user-activation window expires.
  const authorizationReady = Promise.withResolvers<{ authorizationUrl: string; userCode: string }>();
  const linkTask = runBrowserLink({
    baseUrl,
    declaration,
    openAuthorization: authorizationReady.resolve,
  });

  void linkTask
    .then(async (outcome: BrowserLinkOutcome) => {
      if (outcome.kind === "linked") {
        await svc.saveInstance({
          userId,
          illarinUrl: baseUrl,
          pair: outcome.tokens,
          instanceName,
          applicationName: declaration.appName,
          declarationJson: JSON.stringify(declaration),
        });
        startDeliveryWorker(userId);
        session.status = "linked";
      } else {
        session.status = "failed";
        session.reason = outcome.kind === "invalid_callback" ? outcome.reason : outcome.kind;
      }
    })
    .catch((err) => {
      console.warn("[Illarin] Browser link failed:", err instanceof Error ? err.message : err);
      session.status = "failed";
      session.reason = "link_failed";
    });

  let authorization: { authorizationUrl: string; userCode: string };
  try {
    authorization = await Promise.race([
      authorizationReady.promise,
      linkTask.then(() => {
        throw new Error("Browser link ended before authorization was ready");
      }),
    ]);
  } catch {
    return c.json({ error: "Failed to start browser linking" }, 502);
  }

  // The URL contains a one-use request secret and must never be cached.
  c.header("Cache-Control", "no-store");
  return c.json({
    link_id: linkId,
    authorize_url: authorization.authorizationUrl,
    user_code: authorization.userCode,
    expires_at: new Date(session.expiresAt).toISOString(),
  });
});

/** Connection status plus the state of any in-progress linking attempt. */
illarinRoutes.get("/status", async (c) => {
  const userId = c.get("userId");
  const instance = await svc.getIllarinInstance(userId);
  const missingReceivePermission = instance !== null && !instance.scopes.includes("work:receive");

  const active = activeLinkFor(userId);
  return c.json({
    linked: instance !== null,
    illarin_url: instance?.illarinUrl,
    instance_name: instance?.instanceName,
    instance_id: instance?.instanceId,
    scopes: instance?.scopes ?? [],
    permission_error: getPermissionError(userId) ?? (missingReceivePermission ? "work:receive" : null),
    pickup: instance === null ? null : getDeliveryWorkerStatus(userId) ?? {
      state: missingReceivePermission ? "missing_permission" : "stopped",
      lastCollectAt: null,
      lastInstallAt: null,
      lastError: missingReceivePermission ? "work:receive is not granted" : "Pickup worker has not started",
      lastErrorAt: null,
    },
    linked_at: instance?.linkedAt,
    last_refresh_at: instance?.lastRefreshAt,
    declaration_version: typeof instance?.lastDeclaration?.appVersion === "string"
      ? instance.lastDeclaration.appVersion
      : typeof instance?.lastDeclaration?.applicationVersion === "string"
        ? instance.lastDeclaration.applicationVersion
      : null,
    pending_link: active
      ? { status: active.status, reason: active.reason ?? null }
      : null,
  });
});

/** Unlink locally; the owner revokes remotely via Illarin account settings. */
illarinRoutes.post("/unlink", async (c) => {
  const userId = c.get("userId");
  for (const [id, link] of pendingLinks) {
    if (link.userId === userId) pendingLinks.delete(id);
  }
  cancelDeviceLink(userId);
  stopDeliveryWorker(userId);
  clearPermissionError(userId);
  await handleTerminalUnauthorized(userId, "unlinked");
  return c.json({
    success: true,
    hint: "Also revoke this instance in your Illarin account settings to remove it there.",
  });
});

illarinRoutes.post("/permissions/refresh", async (c) => {
  const userId = c.get("userId");
  if (!await svc.getIllarinInstance(userId)) return c.json({ error: "Not connected" }, 404);
  try {
    if (!await refreshAccessToken(userId)) return c.json({ error: "Connection expired" }, 401);
    const instance = await svc.getIllarinInstance(userId);
    clearPermissionError(userId);
    if (instance) startDeliveryWorker(userId);
    return c.json({ scopes: instance?.scopes ?? [] });
  } catch {
    return c.json({ error: "Could not refresh permissions; try again later" }, 502);
  }
});


/** Start the headless device fallback: manual code entry, no prefilled URL. */
illarinRoutes.post("/link/device", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null) as { illarin_url?: unknown; instance_name?: unknown } | null;

  const baseUrl = typeof body?.illarin_url === "string" ? body.illarin_url.trim().replace(/\/+$/, "") : "";
  if (!baseUrl) return c.json({ error: "illarin_url is required" }, 400);

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return c.json({ error: "illarin_url is not a valid URL" }, 400);
  }
  if (parsedUrl.protocol !== "https:") {
    return c.json({ error: "illarin_url must use https" }, 400);
  }
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) {
    return c.json({ error: "illarin_url must not contain credentials, a query, or a fragment" }, 400);
  }
  try {
    await validateHost(parsedUrl.hostname);
  } catch (err) {
    if (err instanceof SSRFError) return c.json({ error: err.message }, 400);
    throw err;
  }

  cancelDeviceLink(userId);

  const instanceName = typeof body?.instance_name === "string" && body.instance_name.trim()
    ? body.instance_name.trim()
    : "My Lumiverse";

  let declaration;
  try {
    declaration = buildDeclaration({
      instanceName,
      applicationVersion: await readBackendVersion(),
      scopes: ["work:receive", "library:sync"],
      installsExtensions: svc.canInstallExtensions(userId),
    });
  } catch (err) {
    return c.json({ error: err instanceof RangeError ? err.message : "invalid declaration" }, 400);
  }

  let request;
  try {
    request = await createDeviceRequest(baseUrl, declaration);
  } catch (err) {
    console.warn("[Illarin] Device request failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Failed to start device linking" }, 502);
  }

  const declarationJson = JSON.stringify(declaration);
  const session = new DeviceLinkSession(request, baseUrl, {
    onLinked: async (tokens) => {
      await svc.saveInstance({
        userId,
        illarinUrl: baseUrl,
        pair: tokens,
        instanceName,
        applicationName: declaration.appName,
        declarationJson,
      });
      startDeliveryWorker(userId);
    },
  });
  const expiresAt = Date.parse(request.expiresAt);
  const pending: PendingDeviceLink = {
    userId,
    baseUrl,
    session,
    instanceName,
    applicationName: declaration.appName,
    declarationJson,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000,
    status: "pending",
    controller: new AbortController(),
  };
  pendingDeviceLinks.set(userId, pending);

  // The installation, rather than the settings browser, owns grant pickup.
  // This remains active when the UI closes and follows every interval/backoff
  // decision made by DeviceLinkSession.
  void runDeviceLinkUntilTerminal(session, { signal: pending.controller.signal })
    .then((result) => {
      if (!result || pendingDeviceLinks.get(userId) !== pending) return;
      pending.status = result.status;
      pending.completedAt = Date.now();
      if (result.status === "linked") pending.instanceId = result.tokens.connectedApp.id;
    })
    .catch((err) => {
      if (pendingDeviceLinks.get(userId) !== pending || pending.controller.signal.aborted) return;
      console.warn("[Illarin] Device link pickup failed:", err instanceof Error ? err.message : err);
      pending.status = "failed";
      pending.completedAt = Date.now();
    });

  // The private deviceCode stays server-side by design.
  return c.json({
    user_code: request.userCode,
    verification_url: request.verificationUrl,
    expires_at: request.expiresAt,
  });
});

/** Observe the backend-owned remote-device pickup state. */
illarinRoutes.get("/link/device/status", async (c) => {
  const userId = c.get("userId");
  const pending = pendingDeviceLinks.get(userId);
  if (!pending) return c.json({ status: "none" });

  if (pending.status === "linked") {
    return c.json({ status: "linked", instance_id: pending.instanceId });
  }
  return c.json({ status: pending.status });
});
