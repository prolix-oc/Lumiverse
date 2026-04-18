// ── Bun version gate ────────────────────────────────────────────────────────
// CompressionStream (Brotli) and other APIs we depend on require Bun >= 1.3.3.
const [_bunMaj = 0, _bunMin = 0, _bunPat = 0] = Bun.version.split(".").map(Number);
if (_bunMaj < 1 || (_bunMaj === 1 && (_bunMin < 3 || (_bunMin === 3 && _bunPat < 3)))) {
  console.error(`[startup] Bun ${Bun.version} is too old — Lumiverse requires Bun >= 1.3.3.`);
  console.error("[startup] Update Bun: curl -fsSL https://bun.sh/install | bash");
  process.exit(1);
}

import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env";
import { getDatabasePath, initDatabase } from "./db/connection";
import { runMigrations } from "./db/migrate";
import { runStartupDatabaseMaintenance, startDatabaseMonitor, stopDatabaseMonitor } from "./db/maintenance";
import { startAutomaticDatabaseMaintenance, stopAutomaticDatabaseMaintenance } from "./db/maintenance-scheduler";
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
const { seedOwner, backfillUserIds, getFirstUserId } = await import("./auth/seed");
const { operatorService } = await import("./services/operator.service");
await seedOwner();
backfillUserIds();

// Load the operator-configured trusted host allowlist now that the owner is
// known — the Host-header middleware in app.ts reads from this cache.
const { load: loadTrustedHosts } = await import("./services/trusted-hosts.service");
loadTrustedHosts();

runStartupDatabaseMaintenance(db, getDatabasePath(), getFirstUserId());
startDatabaseMonitor(() => db, getDatabasePath());
startAutomaticDatabaseMaintenance(
  () => db,
  () => getFirstUserId(),
  () => getDatabasePath(),
  () => operatorService.busy,
  (name, fn) => operatorService.runOperation(name, fn),
);

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

// LanceDB startup maintenance: compact fragments, migrate old HNSW_PQ → IVF_PQ (fire-and-forget)
import("./services/embeddings.service").then(({ runStartupVectorMaintenance }) =>
  runStartupVectorMaintenance()
).catch(() => {});

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
// idleTimeout: 0 disables Bun's default 30-second idle connection cutoff so that
// long-running generation requests (image gen, heavy LLM calls) are not terminated
// prematurely. Application-level AbortSignal timeouts guard against hung providers.
const server = Bun.serve({
  port: env.port,
  hostname: "::",
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: 1000 * 1024 * 1024, // 1000 MB — matches MAX_CHARX_SIZE in character-card.service.ts
  idleTimeout: 0,
});

// Give the EventBus access to the server for native topic-based publish().
eventBus.setServer(server);

console.log(`Lumiverse Backend listening on ${server.hostname}:${server.port}`);

// Notify runner (if present) that the server is ready
if (process.env.LUMIVERSE_RUNNER_IPC === "1" && typeof process.send === "function") {
  process.send({ type: "ready", payload: { port: env.port, pid: process.pid } });
}

// Auto-connect to LumiHub if linked. Deferred to a timer tick so the HTTP
// server gets a chance to service its first requests before the WebSocket
// connect runs — a hung/unreachable LumiHub can otherwise stall the event
// loop (TLS/DNS wait) long enough for callers to observe "server not
// accepting requests" immediately after startup.
setTimeout(() => {
  import("./lumihub/client").then(({ autoConnect }) => {
    autoConnect().catch((err) => console.error("[LumiHub] Auto-connect failed:", err));
  });
}, 0);

// Auto-connect MCP servers (fire-and-forget, same deferred pattern as LumiHub)
setTimeout(() => {
  import("./services/mcp-client-manager").then(({ getMcpClientManager }) => {
    getMcpClientManager().autoConnectAll().catch((err) =>
      console.error("[MCP] Auto-connect failed:", err)
    );
  });
}, 0);

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

  // 3.5 Disconnect all MCP servers
  try {
    const { getMcpClientManager } = await import("./services/mcp-client-manager");
    await getMcpClientManager().disconnectAll();
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

  // 5b. Tear down the regex sandbox worker pool so we don't leak the worker
  //     threads on shutdown.
  const { shutdownRegexSandbox } = await import("./utils/regex-sandbox");
  shutdownRegexSandbox();

  // 5c. Stop the rate-limit sweep timer.
  const { stopRateLimitSweep } = await import("./middleware/rate-limit");
  stopRateLimitSweep();

  // 5d. Stop the Vertex AI token cache sweep.
  const { stopVertexTokenSweep } = await import("./llm/providers/google-vertex");
  stopVertexTokenSweep();

  // 6. Release cached prepared statements
  const { clearStmtCache } = await import("./services/pagination");
  clearStmtCache();

  // 7. Cleanup operator service
  operatorService.cleanup();

  // 7.5 Stop DB stats monitor
  stopDatabaseMonitor();
  stopAutomaticDatabaseMaintenance();

  // 8. Close database (triggers WAL checkpoint)
  const { closeDatabase } = await import("./db/connection");
  closeDatabase();

  console.log("[Shutdown] Cleanup complete.");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
