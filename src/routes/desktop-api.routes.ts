import { Hono, type Context, type Next } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { isInsufficientScopeError } from "better-auth/oauth2";
import type { JWTPayload } from "jose";
import { oauthProviderResourceClient } from "@better-auth/oauth-provider/resource-client";
import { getDb } from "../db/connection";
import { env } from "../env";
import {
  DESKTOP_OAUTH_CLIENT_ID,
  DESKTOP_OAUTH_RESOURCE,
  DESKTOP_STATUS_SCOPE,
  getDesktopOAuthIssuer,
  getDesktopServerInstanceId,
} from "../auth/desktop-oauth";
import { resolveDesktopRequestOrigin } from "../auth/request-origin";
import { isConnectionFromExplicitTrustedProxy } from "../utils/client-ip";
import { desktopCaptureBroker, DesktopCaptureBroker, DesktopCaptureError } from "../spindle/desktop-capture-broker";
import { getPresenceSnapshot, type PresenceSnapshot } from "../services/presence.service";

export interface DesktopPrincipal {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: string;
}

declare module "hono" {
  interface ContextVariableMap {
    desktopPrincipal: DesktopPrincipal;
    desktopIssuer: string;
  }
}

export interface DesktopApiDependencies {
  captureBroker?: DesktopCaptureBroker;
  verify: (request: Request, issuer: string) => Promise<JWTPayload>;
  loadPrincipal: (userId: string) => DesktopPrincipal | null;
  getStatus: () => Promise<unknown>;
  getInstance: (issuer: string) => { id: string; name: string };
  getPresence?: (userId: string) => PresenceSnapshot | null | Promise<PresenceSnapshot | null>;
}

export function canReadDesktopStatus(role: string): boolean {
  return role === "admin" || role === "owner";
}

let verifierActions: ReturnType<typeof oauthProviderResourceClient>["getActions"] extends () => infer T ? T : never;
let desktopJwksUrl = `http://127.0.0.1:${env.port}/api/auth/jwks`;

/** Use an internal plaintext-only JWKS listener when the public listener is HTTPS-only. */
export function setDesktopJwksLoopbackPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid desktop JWKS loopback port: ${port}`);
  }
  desktopJwksUrl = `http://127.0.0.1:${port}/api/auth/jwks`;
}

async function verifyDesktopToken(request: Request, issuer: string): Promise<JWTPayload> {
  if (!verifierActions) {
    const { auth } = await import("../auth");
    verifierActions = oauthProviderResourceClient(auth).getActions();
  }
  return verifierActions.verifyAccessTokenRequest(request, {
    verifyOptions: { audience: DESKTOP_OAUTH_RESOURCE, issuer },
    requiredScopes: [DESKTOP_STATUS_SCOPE],
    // Verify locally through the loopback server rather than depending on the
    // deployment's public DNS supporting hairpin requests.
    jwksUrl: desktopJwksUrl,
  });
}

function loadDesktopPrincipal(userId: string): DesktopPrincipal | null {
  return getDb().query(`
    SELECT id, name, email, username, COALESCE(role, 'user') AS role
    FROM "user" WHERE id = ? LIMIT 1
  `).get(userId) as DesktopPrincipal | null;
}

function instanceIdentity(issuer: string) {
  const name = new URL(issuer).hostname || "Lumiverse";
  return { id: getDesktopServerInstanceId(), name };
}

const defaultDependencies: DesktopApiDependencies = {
  verify: verifyDesktopToken,
  loadPrincipal: loadDesktopPrincipal,
  getStatus: async () => (await import("../services/operator.service")).operatorService.getFullStatus(),
  getInstance: instanceIdentity,
  getPresence: getPresenceSnapshot,
};

export function createDesktopApiRoutes(
  dependencies: DesktopApiDependencies = defaultDependencies,
) {
  const app = new Hono();
  const captureBroker = dependencies.captureBroker ?? desktopCaptureBroker;

  async function requireDesktopToken(c: Context, next: Next) {
    const origin = resolveDesktopRequestOrigin(
      c.req.raw,
      isConnectionFromExplicitTrustedProxy(c),
    );
    const issuer = getDesktopOAuthIssuer(origin);
    let payload: JWTPayload;
    try {
      payload = await dependencies.verify(c.req.raw, issuer);
    } catch (error) {
      c.header("Cache-Control", "no-store");
      if (isInsufficientScopeError(error)) {
        c.header(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="${DESKTOP_STATUS_SCOPE}"`,
        );
        return c.json({ error: "Desktop status scope is required", code: "INSUFFICIENT_SCOPE" }, 403);
      }
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "Invalid or expired desktop access token", code: "INVALID_TOKEN" }, 401);
    }

    // RFC 9068 identifies the authorized OAuth client with `azp`; do not
    // accept a correctly scoped token minted for a different public client.
    if (payload.azp !== DESKTOP_OAUTH_CLIENT_ID || typeof payload.sub !== "string") {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "Invalid desktop access token", code: "INVALID_TOKEN" }, 401);
    }
    const principal = dependencies.loadPrincipal(payload.sub);
    if (!principal) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return c.json({ error: "Desktop account no longer exists", code: "INVALID_TOKEN" }, 401);
    }
    c.set("desktopPrincipal", principal);
    c.set("desktopIssuer", issuer);
    return next();
  }

  app.use("*", requireDesktopToken);
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  async function readCaptureBody(context: Context, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
    const reader = context.req.raw.body?.getReader();
    if (!reader) throw new DesktopCaptureError("INVALID_CAPTURE_REQUEST");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    let chunks = 0;
    let body = "";
    const abort = () => { void reader.cancel().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    context.req.raw.signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted || context.req.raw.signal.aborted) throw new DesktopCaptureError("CAPTURE_CANCELLED");
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        chunks += 1;
        if (bytes > maxBytes || chunks > 8192) throw new DesktopCaptureError("CAPTURE_PAYLOAD_TOO_LARGE", 413);
        body += decoder.decode(next.value, { stream: true });
      }
      body += decoder.decode();
      if (signal?.aborted || context.req.raw.signal.aborted) throw new DesktopCaptureError("CAPTURE_CANCELLED");
      return JSON.parse(body);
    } finally {
      signal?.removeEventListener("abort", abort);
      context.req.raw.signal.removeEventListener("abort", abort);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async function captureResponse(context: Context, operation: () => unknown | Promise<unknown>) {
    try { return context.json(await operation()); }
    catch (error) {
      if (error instanceof DesktopCaptureError) return context.json({ error: error.code, code: error.code }, error.status as ContentfulStatusCode);
      return context.json({ error: "Invalid desktop capture request", code: "INVALID_CAPTURE_REQUEST" }, 400);
    }
  }

  app.post("/capture/devices", (context) => captureResponse(context, async () =>
    captureBroker.register(context.get("desktopPrincipal").id, await readCaptureBody(context, 1024))));

  app.get("/capture/devices/:deviceId/commands", (context) => captureResponse(context, () => ({
    commands: captureBroker.poll(context.get("desktopPrincipal").id, context.req.param("deviceId"), context.req.header("X-Lumiverse-Capture-Lease") ?? ""),
  })));

  app.post("/capture/devices/:deviceId/displays", (context) => captureResponse(context, async () => {
    captureBroker.updateDisplays(context.get("desktopPrincipal").id, context.req.param("deviceId"),
      context.req.header("X-Lumiverse-Capture-Lease") ?? "", await readCaptureBody(context, 8192));
    return { ok: true };
  }));

  app.post("/capture/devices/:deviceId/approval-status", (context) => captureResponse(context, async () => {
    captureBroker.completeInspection(context.get("desktopPrincipal").id, context.req.param("deviceId"),
      context.req.header("X-Lumiverse-Capture-Lease") ?? "", await readCaptureBody(context, 1024));
    return { ok: true };
  }));

  app.post("/capture/devices/:deviceId/responses", (context) => captureResponse(context, async () => {
    await captureBroker.receive(context.get("desktopPrincipal").id, context.req.param("deviceId"),
      context.req.header("X-Lumiverse-Capture-Lease") ?? "", (maxBytes, signal) => readCaptureBody(context, maxBytes, signal));
    return { ok: true };
  }));

  app.delete("/capture/devices/:deviceId", (context) => captureResponse(context, () => {
    captureBroker.unregister(context.get("desktopPrincipal").id, context.req.param("deviceId"), context.req.header("X-Lumiverse-Capture-Lease") ?? "");
    return { ok: true };
  }));

  app.get("/me", (c) => {
    const principal = c.get("desktopPrincipal");
    return c.json({
      instance: dependencies.getInstance(c.get("desktopIssuer")),
      account: {
        id: principal.id,
        name: principal.name,
        username: principal.username,
        role: principal.role,
      },
      capabilities: {
        canReadStatus: canReadDesktopStatus(principal.role),
      },
    });
  });

  app.get("/presence", async (c) => {
    const principal = c.get("desktopPrincipal");
    return c.json({ active: await dependencies.getPresence?.(principal.id) ?? null });
  });

  app.get("/status", async (c) => {
    const principal = c.get("desktopPrincipal");
    if (!canReadDesktopStatus(principal.role)) {
      return c.json({
        error: "Instance status is restricted to administrators and owners",
        code: "ROLE_REQUIRED",
      }, 403);
    }
    return c.json(await dependencies.getStatus());
  });

  return app;
}

export const desktopApiRoutes = createDesktopApiRoutes();
