import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "./middleware/compress";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "hono/bun";
import { websocket } from "hono/bun";
import { env } from "./env";
import { auth } from "./auth";
import { requireAuth } from "./auth/middleware";
import { settingsRoutes } from "./routes/settings.routes";
import { charactersRoutes } from "./routes/characters.routes";
import { personasRoutes } from "./routes/personas.routes";
import { filesRoutes } from "./routes/files.routes";
import { chatsRoutes } from "./routes/chats.routes";
import { worldBooksRoutes } from "./routes/world-books.routes";
import { secretsRoutes } from "./routes/secrets.routes";
import { presetsRoutes } from "./routes/presets.routes";
import { connectionsRoutes } from "./routes/connections.routes";
import { generateRoutes } from "./routes/generate.routes";
import { imagesRoutes } from "./routes/images.routes";
import { providersRoutes } from "./routes/providers.routes";
import { macrosRoutes } from "./routes/macros.routes";
import { spindleRoutes } from "./routes/spindle.routes";
import { usersRoutes } from "./routes/users.routes";
import { packsRoutes } from "./routes/packs.routes";
import { councilRoutes } from "./routes/council.routes";
import { dreamWeaverRoutes } from "./routes/dream-weaver.routes";
import { imageGenRoutes } from "./routes/image-gen.routes";
import { imageGenConnectionsRoutes } from "./routes/image-gen-connections.routes";
import { characterGalleryRoutes } from "./routes/character-gallery.routes";
import { embeddingsRoutes } from "./routes/embeddings.routes";
import { tokenizersRoutes } from "./routes/tokenizers.routes";
import { spindleOAuthRoutes } from "./routes/spindle-oauth.routes";
import { lumihubCallbackRoute, lumihubRoutes } from "./routes/lumihub.routes";
import { systemRoutes } from "./routes/system.routes";
import { migrateRoutes } from "./routes/migrate.routes";
import { stMigrationRoutes } from "./routes/st-migration.routes";
import { googleDriveRoutes } from "./routes/google-drive.routes";
import { dropboxRoutes } from "./routes/dropbox.routes";
import { presetProfilesRoutes } from "./routes/preset-profiles.routes";
import { loadoutsRoutes } from "./routes/loadouts.routes";
import { regexScriptsRoutes } from "./routes/regex-scripts.routes";
import { expressionsRoutes } from "./routes/expressions.routes";
import { pushRoutes } from "./routes/push.routes";
import { memoryCortexRoutes } from "./routes/memory-cortex.routes";
import { operatorRoutes } from "./routes/operator.routes";
import { openrouterRoutes } from "./routes/openrouter.routes";
import { ttsConnectionsRoutes } from "./routes/tts-connections.routes";
import { ttsRoutes } from "./routes/tts.routes";
import { sttRoutes } from "./routes/stt.routes";
import { mcpServersRoutes } from "./routes/mcp-servers.routes";
import { databankRoutes } from "./routes/databank.routes";
import { globalAddonsRoutes } from "./routes/global-addons.routes";
import { webSearchRoutes } from "./routes/web-search.routes";
import { themeAssetsRoutes } from "./routes/theme-assets.routes";
import { bootstrapRoutes } from "./routes/bootstrap.routes";
import { wsHandler } from "./ws/handler";
import { issueTicket } from "./ws/tickets";
import { rateLimit } from "./middleware/rate-limit";
import { isHostAllowed, isOriginAllowed } from "./services/trusted-hosts.service";
import { authLockoutService } from "./services/auth-lockout.service";
import { getClientIp } from "./utils/client-ip";

const app = new Hono();
const SIGN_IN_AUTH_PATTERN = /^\/api\/auth\/sign-in(?:\/|$)/;

function applyLockoutHeaders(response: Response, retryAfterSeconds: number): Response {
  response.headers.set("Retry-After", String(retryAfterSeconds));
  return response;
}

app.use("*", compress());

// Body size limit — 10 MB default for API routes.
// Import routes (migrate/*, characters/import, characters/import-bulk) are excluded
// here to support charx uploads up to 100 MB; the Bun server-level maxRequestBodySize
// (512 MB in index.ts) covers them.
// Public/unauthenticated POST surfaces (auth, OAuth callbacks, etc.) never
// need a multi-megabyte body. Apply a tight 1 MB cap before the broader 10 MB
// rule below so a client without credentials cannot drive the server-level
// 1 GB limit by hitting an unauthenticated endpoint with a giant payload.
const PUBLIC_POST_PREFIXES = [
  "/api/auth/",
  "/api/spindle-oauth/",
  "/api/v1/lumihub",
  "/api/v1/openrouter/oauth-landing",
];
app.use("/api/*", async (c, next) => {
  const clientId = getClientIp(c);
  const lockout = authLockoutService.getActiveLockout(clientId);
  if (lockout) {
    authLockoutService.logBlockedRequest(clientId, lockout, {
      method: c.req.method,
      path: c.req.path,
      origin: c.req.header("origin") || undefined,
      host: c.req.header("host") || undefined,
    });
    return applyLockoutHeaders(
      c.json(
        authLockoutService.buildPayload(lockout, "Too many authentication failures from this client. Try again later."),
        429,
      ),
      Math.max(1, Math.ceil(lockout.retryAfterMs / 1000)),
    );
  }
  return next();
});

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  const isPublic = PUBLIC_POST_PREFIXES.some((p) => path === p || path.startsWith(p));
  if (!isPublic) return next();
  return bodyLimit({
    maxSize: 1 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  })(c, next);
});

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/v1/migrate/") || path === "/api/v1/characters/import-bulk" || path === "/api/v1/characters/import" || path.startsWith("/api/v1/world-books/import") || path === "/api/v1/images" || path === "/api/v1/theme-assets" || path.endsWith("/expressions/upload-zip") || path === "/api/v1/stt/transcribe" || path === "/api/v1/chats/import" || path === "/api/v1/chats/import-st") {
    return next();
  }
  return bodyLimit({
    maxSize: 10 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  })(c, next);
});

// Host header validation — prevents DNS rebinding attacks.
// The allowlist is sourced from trustedHostsService so it can be updated at
// runtime via the Operator panel without a server restart.
app.use("/api/*", async (c, next) => {
  const clientId = getClientIp(c);
  const origin = c.req.header("origin");
  if (!env.trustAnyOrigin && origin && !isOriginAllowed(origin)) {
    const result = authLockoutService.recordFailure(clientId, "origin", {
      method: c.req.method,
      path: c.req.path,
      origin,
      host: c.req.header("host") || undefined,
    });
    if (result.lockout) {
      return applyLockoutHeaders(
        c.json(
          authLockoutService.buildPayload(result.lockout, "Too many invalid-origin requests. Try again later."),
          429,
        ),
        Math.max(1, Math.ceil(result.lockout.retryAfterMs / 1000)),
      );
    }
    return c.json({ error: "Forbidden" }, 403);
  }

  authLockoutService.recordSuccess(clientId, "origin");

  if (env.trustAnyOrigin) return next();
  const host = c.req.header("host");
  // Reject when Host is missing entirely — a raw HTTP/1.0 request or a crafted
  // TCP connection can omit the Host header, which would otherwise bypass the
  // DNS-rebinding guard.
  if (!isHostAllowed(host)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (env.trustAnyOrigin) return origin;
      return isOriginAllowed(origin) ? origin : '';
    },
    credentials: true,
  })
);

// Rate-limit credential-touching auth endpoints to throttle scrypt-driven DoS
// and brute force. Sign-in/sign-up have the tightest budget; everything else
// under /api/auth/* gets a looser limit so legitimate session refreshes etc.
// don't trip the brake.
const authSensitiveLimiter = rateLimit({
  bucket: "auth-sensitive",
  max: 8,
  windowMs: 5 * 60 * 1000, // 8 attempts per 5 minutes per IP
  message: "Too many authentication attempts. Try again in a few minutes.",
});
const authGeneralLimiter = rateLimit({
  bucket: "auth-general",
  max: 60,
  windowMs: 60 * 1000, // 60 requests per minute per IP for non-credential auth ops
});

const SENSITIVE_AUTH_PATTERN = /\/api\/auth\/(sign-in|sign-up|forget-password|reset-password|change-password|update-password)/;

app.use("/api/auth/*", async (c, next) => {
  if (SENSITIVE_AUTH_PATTERN.test(c.req.path)) {
    return authSensitiveLimiter(c, next);
  }
  return authGeneralLimiter(c, next);
});

app.use("/api/auth/*", async (c, next) => {
  await next();

  if (c.req.method !== "POST" || !SIGN_IN_AUTH_PATTERN.test(c.req.path)) {
    return;
  }

  const clientId = getClientIp(c);
  if (c.res.status >= 200 && c.res.status < 300) {
    authLockoutService.recordSuccess(clientId, ["login", "unauthorized"]);
    return;
  }

  if (c.res.status !== 401) {
    return;
  }

  const result = authLockoutService.recordFailure(clientId, "login", {
    method: c.req.method,
    path: c.req.path,
    origin: c.req.header("origin") || undefined,
    host: c.req.header("host") || undefined,
  });
  if (!result.lockout) return;

  c.res = applyLockoutHeaders(
    c.json(
      authLockoutService.buildPayload(result.lockout, "Too many failed sign-in attempts. Try again later."),
      429,
    ),
    Math.max(1, Math.ceil(result.lockout.retryAfterMs / 1000)),
  );
});

// Global security headers — applied to every response.
// frame-src / child-src are enforced via the frontend HTML meta tag as well;
// these headers complement it by preventing the app from being embedded in
// external frames and hardening the overall document boundary.
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("Content-Security-Policy", "frame-ancestors 'none';");
});

// BetterAuth handler — BEFORE auth middleware
// Rewrite the request URL to use the actual Host header so BetterAuth
// constructs the correct redirect URLs and cookie domains when accessed via
// a LAN IP instead of localhost
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  const host = c.req.header("host");
  if (host) {
    const url = new URL(c.req.url);
    const rewritten = new URL(url.pathname + url.search, `http://${host}`);
    return auth.handler(new Request(rewritten.toString(), c.req.raw));
  }
  return auth.handler(c.req.raw);
});

// OAuth callback route — unauthenticated, before auth middleware
app.route("/api/spindle-oauth", spindleOAuthRoutes);

// LumiHub callback — unauthenticated (PKCE code proves authorization)
app.route("/api/v1/lumihub", lumihubCallbackRoute);

// OpenRouter OAuth landing — unauthenticated (popup redirect from OpenRouter)
// OpenRouter redirects here with ?code=<auth_code>. We relay the code back
// to the opener window via postMessage so it can call our exchange endpoint.
app.get("/api/v1/openrouter/oauth-landing", async (c) => {
  const rawCode = c.req.query("code") || "";
  const rawOpenerOrigin = c.req.query("opener_origin") || "";
  // Whitelist the OAuth code character set. OpenRouter codes are URL-safe
  // base64-style strings; rejecting anything outside that set blocks the
  // </script> XSS payload entirely. JSON.stringify alone does NOT HTML-encode
  // < or >, so a value like </script><script>alert(1)</script> would otherwise
  // break out of the inline script context.
  const code = /^[A-Za-z0-9._~+/=-]{1,512}$/.test(rawCode) ? rawCode : "";
  let openerOrigin = "";
  try {
    const parsed = new URL(rawOpenerOrigin);
    if (parsed.origin === rawOpenerOrigin && isOriginAllowed(parsed.origin)) {
      openerOrigin = parsed.origin;
    }
  } catch {
    openerOrigin = "";
  }
  // Pass the code to the inline script via a data attribute. dataset reads it
  // from the DOM as a plain string with no HTML/JS interpretation.
  const codeAttr = code
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const openerOriginAttr = openerOrigin
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return c.html(`<!DOCTYPE html>
<html><head><title>OpenRouter Authorization</title>
<style>body{background:#1c1826;color:rgba(255,255,255,.8);font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px}</style></head>
<body>
<div id="s" data-code="${codeAttr}" data-opener-origin="${openerOriginAttr}">Completing authorization...</div>
<script>
var el = document.getElementById('s');
var code = el.dataset.code || '';
var targetOrigin = el.dataset.openerOrigin || window.location.origin;
if (code && window.opener) {
  // Restrict postMessage to the known Lumiverse opener origin.
  window.opener.postMessage({ type: 'openrouter_oauth_code', code: code }, targetOrigin);
  el.textContent = 'Authorized! Closing...';
  setTimeout(function(){ window.close(); }, 500);
} else if (!code) {
  el.textContent = 'No authorization code received.';
} else {
  el.textContent = 'Could not reach parent window. Copy this code: ' + code;
}
</script>
</body></html>`);
});

// Image gen results — unauthenticated, public access for push notifications and embeds
app.get("/api/v1/image-gen/results/:id", async (c) => {
  const { getImageFilePathPublic } = await import("./services/images.service");
  const id = c.req.param("id");
  const size = c.req.query("size") as "sm" | "lg" | undefined;
  const tier = size === "sm" || size === "lg" ? size : undefined;
  const filepath = await getImageFilePathPublic(id, tier);
  if (!filepath) return c.json({ error: "Not found" }, 404);
  const response = new Response(Bun.file(filepath));
  response.headers.set("Cache-Control", "public, max-age=86400");
  return response;
});

// Auth middleware — AFTER auth handler, BEFORE routes
app.use("/api/v1/*", requireAuth);

app.route("/api/v1/settings", settingsRoutes);
app.route("/api/v1/characters", charactersRoutes);
app.route("/api/v1/chats", chatsRoutes);
app.route("/api/v1/personas", personasRoutes);
app.route("/api/v1/world-books", worldBooksRoutes);
app.route("/api/v1/secrets", secretsRoutes);
app.route("/api/v1/presets", presetsRoutes);
app.route("/api/v1/connections", connectionsRoutes);
app.route("/api/v1/openrouter", openrouterRoutes);
app.route("/api/v1/files", filesRoutes);
app.route("/api/v1/images", imagesRoutes);
app.route("/api/v1/theme-assets", themeAssetsRoutes);
app.route("/api/v1/generate", generateRoutes);
app.route("/api/v1/providers", providersRoutes);
app.route("/api/v1/macros", macrosRoutes);
app.route("/api/v1/spindle", spindleRoutes);
app.route("/api/v1/users", usersRoutes);
app.route("/api/v1/packs", packsRoutes);
app.route("/api/v1/council", councilRoutes);
app.route("/api/v1/dream-weaver", dreamWeaverRoutes);
app.route("/api/v1/image-gen", imageGenRoutes);
app.route("/api/v1/image-gen-connections", imageGenConnectionsRoutes);
app.route("/api/v1/characters/:characterId/gallery", characterGalleryRoutes);
app.route("/api/v1/embeddings", embeddingsRoutes);
app.route("/api/v1/tokenizers", tokenizersRoutes);
app.route("/api/v1/system", systemRoutes);
app.route("/api/v1/migrate", migrateRoutes);
app.route("/api/v1/st-migration", stMigrationRoutes);
app.route("/api/v1/google-drive", googleDriveRoutes);
app.route("/api/v1/dropbox", dropboxRoutes);
app.route("/api/v1/preset-profiles", presetProfilesRoutes);
app.route("/api/v1/loadouts", loadoutsRoutes);
app.route("/api/v1/regex-scripts", regexScriptsRoutes);
app.route("/api/v1/characters/:characterId/expressions", expressionsRoutes);
app.route("/api/v1/push", pushRoutes);
app.route("/api/v1/lumihub", lumihubRoutes);
app.route("/api/v1/memory-cortex", memoryCortexRoutes);
app.route("/api/v1/operator", operatorRoutes);
app.route("/api/v1/tts-connections", ttsConnectionsRoutes);
app.route("/api/v1/tts", ttsRoutes);
app.route("/api/v1/stt", sttRoutes);
app.route("/api/v1/mcp-servers", mcpServersRoutes);
app.route("/api/v1/databanks", databankRoutes);
app.route("/api/v1/web-search", webSearchRoutes);
app.route("/api/v1/global-addons", globalAddonsRoutes);
app.route("/api/v1/bootstrap", bootstrapRoutes);

// Issue single-use WS tickets (behind auth middleware)
app.post("/api/v1/ws-ticket", (c) => {
  const userId = c.get("userId");
  const ticket = issueTicket(userId);
  return c.json({ ticket });
});

app.get("/api/ws", wsHandler);

// Serve frontend static files if FRONTEND_DIR is configured
if (env.frontendDir) {
  // Cache headers for frontend static files:
  // - /assets/* have content hashes in filenames → immutable, cache forever
  // - Everything else (index.html, sw.js, manifest.json, SPA fallback) → revalidate every time
  // API routes are unaffected (they set their own headers).
  app.use("*", async (c, next) => {
    await next();
    const path = c.req.path;
    if (path.startsWith("/assets/")) {
      c.res.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else if (!path.startsWith("/api/")) {
      c.res.headers.set("Cache-Control", "no-cache");
    }
  });

  app.use(
    "*",
    serveStatic({ root: env.frontendDir })
  );

  // SPA fallback: serve index.html for any non-API route not matched above
  app.use("*", serveStatic({ root: env.frontendDir, path: "index.html" }));
}

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
export { websocket };
