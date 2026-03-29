import { Hono } from "hono";
import { cors } from "hono/cors";
import { compress } from "hono/compress";
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
import { lumiRoutes } from "./routes/lumi.routes";
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
import { presetProfilesRoutes } from "./routes/preset-profiles.routes";
import { loadoutsRoutes } from "./routes/loadouts.routes";
import { regexScriptsRoutes } from "./routes/regex-scripts.routes";
import { expressionsRoutes } from "./routes/expressions.routes";
import { pushRoutes } from "./routes/push.routes";
import { memoryCortexRoutes } from "./routes/memory-cortex.routes";
import { operatorRoutes } from "./routes/operator.routes";
import { openrouterRoutes } from "./routes/openrouter.routes";
import { wsHandler } from "./ws/handler";
import { issueTicket } from "./ws/tickets";

const app = new Hono();

app.use("*", compress());

// Body size limit — 10 MB default for API routes.
// Import routes (migrate/*, characters/import, characters/import-bulk) are excluded
// here to support charx uploads up to 50 MB; the Bun server-level maxRequestBodySize
// (512 MB in index.ts) covers them.
app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (path.startsWith("/api/v1/migrate/") || path === "/api/v1/characters/import-bulk" || path === "/api/v1/characters/import" || path === "/api/v1/images" || path.endsWith("/expressions/upload-zip")) {
    return next();
  }
  return bodyLimit({
    maxSize: 10 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request body too large" }, 413),
  })(c, next);
});

// Host header validation — prevents DNS rebinding attacks
const allowedHosts = new Set<string>();
for (const origin of env.trustedOrigins) {
  try {
    allowedHosts.add(new URL(origin).host);
  } catch { /* skip malformed */ }
}
// Always allow localhost variants
allowedHosts.add(`localhost:${env.port}`);
allowedHosts.add(`127.0.0.1:${env.port}`);
allowedHosts.add(`[::1]:${env.port}`);

app.use("/api/*", async (c, next) => {
  if (env.trustAnyOrigin) return next();
  const host = c.req.header("host");
  if (host && !allowedHosts.has(host)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return next();
});

app.use(
  "/api/*",
  cors({
    origin: (origin) => {
      if (env.trustAnyOrigin) return origin;
      return env.trustedOriginsSet.has(origin) ? origin : '';
    },
    credentials: true,
  })
);

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
  const code = c.req.query("code") || "";
  return c.html(`<!DOCTYPE html>
<html><head><title>OpenRouter Authorization</title>
<style>body{background:#1c1826;color:rgba(255,255,255,.8);font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;font-size:14px}</style></head>
<body>
<div id="s">Completing authorization...</div>
<script>
var code = ${JSON.stringify(code)};
if (code && window.opener) {
  window.opener.postMessage({ type: 'openrouter_oauth_code', code: code }, '*');
  document.getElementById('s').textContent = 'Authorized! Closing...';
  setTimeout(function(){ window.close(); }, 500);
} else if (!code) {
  document.getElementById('s').textContent = 'No authorization code received.';
} else {
  document.getElementById('s').textContent = 'Could not reach parent window. Copy this code: ' + code;
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
app.route("/api/v1/generate", generateRoutes);
app.route("/api/v1/providers", providersRoutes);
app.route("/api/v1/macros", macrosRoutes);
app.route("/api/v1/spindle", spindleRoutes);
app.route("/api/v1/users", usersRoutes);
app.route("/api/v1/packs", packsRoutes);
app.route("/api/v1/council", councilRoutes);
app.route("/api/v1/lumi", lumiRoutes);
app.route("/api/v1/image-gen", imageGenRoutes);
app.route("/api/v1/image-gen-connections", imageGenConnectionsRoutes);
app.route("/api/v1/characters/:characterId/gallery", characterGalleryRoutes);
app.route("/api/v1/embeddings", embeddingsRoutes);
app.route("/api/v1/tokenizers", tokenizersRoutes);
app.route("/api/v1/system", systemRoutes);
app.route("/api/v1/migrate", migrateRoutes);
app.route("/api/v1/st-migration", stMigrationRoutes);
app.route("/api/v1/preset-profiles", presetProfilesRoutes);
app.route("/api/v1/loadouts", loadoutsRoutes);
app.route("/api/v1/regex-scripts", regexScriptsRoutes);
app.route("/api/v1/characters/:characterId/expressions", expressionsRoutes);
app.route("/api/v1/push", pushRoutes);
app.route("/api/v1/lumihub", lumihubRoutes);
app.route("/api/v1/memory-cortex", memoryCortexRoutes);
app.route("/api/v1/operator", operatorRoutes);

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
