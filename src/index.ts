import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env";
import { initDatabase } from "./db/connection";
import { runMigrations } from "./db/migrate";
import { startAllExtensions } from "./spindle/lifecycle";
import { initIdentity } from "./crypto/init";
import { initVapidKeys } from "./crypto/vapid";
import { eventBus } from "./ws/bus";

// Validate data directory is accessible and writable before any file operations.
// This catches permission issues early (common on Termux/Android) instead of
// letting them surface as cryptic failures in identity/credential file creation.
mkdirSync(env.dataDir, { recursive: true });
try {
  const probe = join(env.dataDir, ".write-probe");
  await Bun.write(probe, "ok");
  try { unlinkSync(probe); } catch {}
} catch (err) {
  console.error(`[startup] Data directory is not writable: ${env.dataDir}`);
  console.error(`[startup] ${err}`);
  console.error("[startup] Ensure the directory exists and the current user has write permissions.");
  process.exit(1);
}
console.log(`[startup] Data directory: ${env.dataDir}`);

// Resolve encryption identity (file > env migration > generate)
await initIdentity();

// Initialize VAPID keys for Web Push (auto-generates on first run)
await initVapidKeys();

// Initialize database and run migrations synchronously
const db = initDatabase();
await runMigrations(db);

// Dynamic import: auth modules call getDb() at module level, so must load after initDatabase()
const { seedOwner, backfillUserIds } = await import("./auth/seed");
await seedOwner();
backfillUserIds();

// One-time SillyTavern migration for Docker environments
if (env.stMigrate) {
  const { runDockerSTMigration } = await import("./migration/docker-st-migrate");
  await runDockerSTMigration();
}

// Seed built-in tokenizers after migrations are applied
const { seedTokenizers } = await import("./services/tokenizer-seed");
seedTokenizers();

// Pre-warm tokenizers for configured connection models (fire-and-forget)
import("./services/tokenizer.service").then(({ prewarm }) => prewarm()).catch(() => {});

// Import app after database is ready (auth config needs getDb())
const { default: app, websocket } = await import("./app");

// Register push notification EventBus listeners
const { initPushListeners } = await import("./services/push.service");
initPushListeners();

// Start extensions after app is imported but before serving —
// ensures extension macros are registered in the global registry
await startAllExtensions().catch((err) => {
  console.error("[Spindle] Failed to start extensions:", err);
});

console.log(`Lumiverse Backend starting on port ${env.port}...`);

// Use explicit Bun.serve() so we get the Server reference for native pub/sub.
const server = Bun.serve({
  port: env.port,
  hostname: "::",
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: 512 * 1024 * 1024, // 512 MB (Bun default is 128 MB)
});

// Give the EventBus access to the server for native topic-based publish().
eventBus.setServer(server);

console.log(`Lumiverse Backend listening on ${server.hostname}:${server.port}`);

// Notify runner (if present) that the server is ready
if (process.env.LUMIVERSE_RUNNER_IPC === "1" && typeof process.send === "function") {
  process.send({ type: "ready", payload: { port: env.port, pid: process.pid } });
}

// Auto-connect to LumiHub if linked
import("./lumihub/client").then(({ autoConnect }) => {
  autoConnect().catch((err) => console.error("[LumiHub] Auto-connect failed:", err));
});

// Log trusted origins so it's visible in the runner and easy to verify that LAN IPs were detected and applied automatically.
if (env.trustAnyOrigin) {
  console.log("[Auth] Trusted origins: ALL (TRUST_ANY_ORIGIN enabled)");
} else {
  console.log(`[Auth] Trusted origins:\n${env.trustedOrigins.map((o) => `  • ${o}`).join("\n")}`);
}

// --- Graceful shutdown ---
let shutdownInProgress = false;

async function gracefulShutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[Shutdown] Received ${signal}, shutting down...`);

  // 1. Stop accepting new connections
  server.stop(true);

  // 2. Abort all active LLM generations
  const { stopAllGenerations, stopGenerationSweep } = await import("./services/generate.service");
  stopAllGenerations();
  stopGenerationSweep();

  // 3. Disconnect LumiHub WebSocket client
  try {
    const { getLumiHubClient } = await import("./lumihub/client");
    getLumiHubClient().disconnect();
  } catch {}

  // 4. Stop all Spindle extension workers
  const { stopAllExtensions } = await import("./spindle/lifecycle");
  await stopAllExtensions().catch((err) =>
    console.error("[Shutdown] Extension stop error:", err)
  );

  // 5. Clear all interval timers
  const { stopTicketSweep } = await import("./ws/tickets");
  const { stopOAuthStateSweep } = await import("./spindle/oauth-state");
  const { stopPkceSweep } = await import("./routes/lumihub.routes");
  const { stopQueryCacheCleanup } = await import("./services/vectorization-queue.service");
  const { stopVersionCheckCleanup } = await import("./services/embeddings.service");
  stopTicketSweep();
  stopOAuthStateSweep();
  stopPkceSweep();
  stopQueryCacheCleanup();
  stopVersionCheckCleanup();

  // 6. Release cached prepared statements
  const { clearStmtCache } = await import("./services/pagination");
  clearStmtCache();

  // 7. Cleanup operator service
  const { operatorService } = await import("./services/operator.service");
  operatorService.cleanup();

  // 8. Close database (triggers WAL checkpoint)
  const { closeDatabase } = await import("./db/connection");
  closeDatabase();

  console.log("[Shutdown] Cleanup complete.");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
