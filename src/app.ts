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
import { characterGalleryRoutes } from "./routes/character-gallery.routes";
import { embeddingsRoutes } from "./routes/embeddings.routes";
import { tokenizersRoutes } from "./routes/tokenizers.routes";
import { spindleOAuthRoutes } from "./routes/spindle-oauth.routes";
import { systemRoutes } from "./routes/system.routes";
import { migrateRoutes } from "./routes/migrate.routes";
import { presetProfilesRoutes } from "./routes/preset-profiles.routes";
import { regexScriptsRoutes } from "./routes/regex-scripts.routes";
import { expressionsRoutes } from "./routes/expressions.routes";
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
app.route("/api/v1/characters/:characterId/gallery", characterGalleryRoutes);
app.route("/api/v1/embeddings", embeddingsRoutes);
app.route("/api/v1/tokenizers", tokenizersRoutes);
app.route("/api/v1/system", systemRoutes);
app.route("/api/v1/migrate", migrateRoutes);
app.route("/api/v1/preset-profiles", presetProfilesRoutes);
app.route("/api/v1/regex-scripts", regexScriptsRoutes);
app.route("/api/v1/characters/:characterId/expressions", expressionsRoutes);

// Issue single-use WS tickets (behind auth middleware)
app.post("/api/v1/ws-ticket", (c) => {
  const userId = c.get("userId");
  const ticket = issueTicket(userId);
  return c.json({ ticket });
});

app.get("/api/ws", wsHandler);

// Serve frontend static files if FRONTEND_DIR is configured
if (env.frontendDir) {
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
