import { unlinkSync } from "node:fs";
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
import { isTermuxLikeEnvironment } from "./utils/termux";
import { ensureDataDirectory } from "./utils/data-directory";
import {
  startExtensionUpdateMonitor,
  stopExtensionUpdateMonitor,
} from "./spindle/update-check.service";

// Validate data directory is accessible and writable before any file operations.
// This catches permission issues early (common on Termux/Android) instead of
// letting them surface as cryptic failures in identity/credential file creation.
ensureDataDirectory(env.dataDir);
if (isTermuxLikeEnvironment()) {
  // Keep library temp files on the same filesystem as DATA_DIR so LanceDB's
  // temp/index staging does not hit EXDEV across /tmp, proot, or bind mounts.
  const tempDir = join(env.dataDir, "tmp");
  ensureDataDirectory(tempDir);
  process.env.TMPDIR = tempDir;
  process.env.TMP = tempDir;
  process.env.TEMP = tempDir;
  console.log(`[startup] Temp directory: ${tempDir}`);
  console.log("[startup] Termux LanceDB mode: cross-process write locking enabled");
}

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
if (env.safeThemeMode) {
  console.warn("[startup] Safe theme mode enabled: custom CSS and component overrides are suppressed");
}

// Resolve encryption identity (file > env migration > generate)
await initIdentity();

// Initialize VAPID keys for Web Push (auto-generates on first run)
await initVapidKeys();

// Initialize database and run migrations synchronously
const db = initDatabase();
await runMigrations(db);
// Reconcile every durable authority before routes, providers, or extensions
// can start. Each failure closes Agentic readiness without blocking Response.
// Keep this module dynamic because its service graph exposes getDb() defaults;
// migrations and initDatabase must complete before those modules are evaluated.
const { reconcileStartupState, summarizeIsolateHealth } = await import("./services/startup-recovery.service");
const startupRecovery = await reconcileStartupState(db);
console.log(
  `[startup] Recovery: imports=${startupRecovery.stages.imports.status}, ` +
  `artifacts=${startupRecovery.stages.artifacts.status} inspected=${startupRecovery.artifacts.inspected}, ` +
  `turns=${startupRecovery.stages.turns.status} inspected=${startupRecovery.turns.inspected}, ` +
  `projections=${startupRecovery.stages.projections.status}, runtime epoch=${startupRecovery.runtimeEpoch}`,
);
if (!startupRecovery.readiness.isolateTermination) {
  console.warn(
    `[startup] Agentic preprocessing unavailable (${summarizeIsolateHealth(startupRecovery.isolate)}); ` +
    "Agentic readiness is closed and Response mode remains available",
  );
}

const {
  describeImageProcessingRecovery,
  getImageProcessingRecovery,
} = await import("./services/images.service");
const leftoverThumbnails = getImageProcessingRecovery();
if (leftoverThumbnails.pending > 0) {
  console.warn(
    `[startup] ${describeImageProcessingRecovery(leftoverThumbnails)}. Not auto-started — recover from Operator → Image Processing after changing settings if needed.`,
  );
}

// Move legacy plaintext Pollinations application keys into the per-user
// encrypted secret store before the rest of the application begins serving.
const { migrateLegacyPollinationsAppKeys } = await import("./services/connections.service");
const pollinationsKeysMigrated = await migrateLegacyPollinationsAppKeys();
if (pollinationsKeysMigrated > 0) {
  console.log(`[startup] Migrated ${pollinationsKeysMigrated} Pollinations application key(s) to encrypted storage.`);
}

// Chat-head generation state is intentionally ephemeral. Clear any retained
// in-memory pool state during startup so clients never resurrect stale heads
// after a restart or hot-reload.
const { clearAllPoolEntries, getPoolEntry } = await import("./services/generation-pool.service");
clearAllPoolEntries();

// Wire the edit-and-send dispatcher's liveness probe to the generation pool so
// runtime reconciliation can distinguish genuinely finished generations from
// crashed ones instead of trusting in-memory state alone.
try {
  const { setEditAndSendGenerationActiveCheck } = await import("./services/edit-and-send-dispatcher.service");
  setEditAndSendGenerationActiveCheck((_userId, generationId) => {
    const entry = getPoolEntry(generationId);
    return !!entry && entry.status !== "completed" && entry.status !== "stopped" && entry.status !== "error";
  });
} catch (err) {
  console.error("[startup] edit-and-send generation active check hook failed:", err);
}

try {
  const { recoverEditAndSendOutbox } = await import("./services/edit-and-send-dispatcher.service");
  const recovered = await recoverEditAndSendOutbox();
  if (recovered > 0) {
    console.log(`[startup] Recovered ${recovered} edit-and-send outbox item(s)`);
  }
} catch (err) {
  console.error("[startup] edit-and-send outbox recovery failed:", err);
}

try {
  const { providerRegistry } = await import("./spindle/provider-registry");
  const { getSecret } = await import("./services/secrets.service");
  providerRegistry.configure({ getSecret });
} catch (err) {
  console.error("[startup] provider registry secret hook failed:", err);
}

// Dynamic import: auth modules call getDb() at module level, so must load after initDatabase()
const { seedOwner, backfillUserIds, backfillDefaultPresets, getFirstUserId } = await import("./auth/seed");
const { operatorService } = await import("./services/operator.service");
await seedOwner();
backfillUserIds();
const presetBackfill = backfillDefaultPresets();
if (presetBackfill.seeded > 0 || presetBackfill.upgradedLegacy > 0 || presetBackfill.activated > 0) {
  console.log(
    `[Auth] Default preset backfill: seeded ${presetBackfill.seeded}, upgraded ${presetBackfill.upgradedLegacy}, activated ${presetBackfill.activated}`,
  );
}

console.log(
  `[startup] Runner IPC: ${operatorService.ipcAvailable ? "connected" : `unavailable (${operatorService.ipcReason})`}`
);

// Load the operator-configured trusted host allowlist now that the owner is
// known — the Host-header middleware in app.ts reads from this cache.
const {
  load: loadTrustedHosts,
  getSnapshot: getTrustedHostsSnapshot,
  detectHostnameSuggestions,
} = await import("./services/trusted-hosts.service");
loadTrustedHosts();

// Load the operator-approved broker origin allowlist and push it into the
// provider registry so extension broker URLs are validated at registration.
// The initial configure above runs before the owner is seeded, so origins
// must be attached here once getFirstUserId() can resolve the setting.
const {
  load: loadApprovedBrokerOrigins,
  getApprovedBrokerOrigins,
} = await import("./services/broker-origins.service");
loadApprovedBrokerOrigins();
try {
  const { providerRegistry } = await import("./spindle/provider-registry");
  const { getSecret } = await import("./services/secrets.service");
  providerRegistry.configure({
    getSecret,
    approvedBrokerOrigins: getApprovedBrokerOrigins(),
  });
} catch (err) {
  console.error("[startup] provider registry broker origin hook failed:", err);
}
if (getApprovedBrokerOrigins().length === 0) {
  console.log("[startup] Broker origin allowlist empty — broker URLs may target any http(s) origin");
}

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

// Apply operator-configured sharp runtime settings before image work starts.
const { initSharpSettings } = await import("./services/sharp-settings.service");
initSharpSettings();

// Load DNS settings so safe-fetch can pick up the DoH fallback toggle
// before the first outbound request that needs validation.
const { initDnsSettings } = await import("./services/dns-settings.service");
initDnsSettings();

// Load owner-scoped disk warning thresholds before the monitor starts so
// operator changes apply live without a server restart.
const { initDiskWarningSettings } = await import("./services/disk-warning-settings.service");
initDiskWarningSettings();

// Start background vectorization maintenance only after the database is ready.
const { startVectorizationQueueMaintenance } = await import("./services/vectorization-queue.service");
startVectorizationQueueMaintenance();

const { startDiskMonitor } = await import("./services/disk-monitor.service");
startDiskMonitor();

// SMART monitoring is optional: unavailable binaries and inaccessible host
// devices never prevent startup. When explicitly enabled, root/container
// deployments can also install smartmontools through a fixed package plan.
const { initSmartctl } = await import("./services/smartctl.service");
initSmartctl();

// Pre-warm tokenizers for active/default connection models (fire-and-forget)
import("./services/tokenizer.service").then(({ prewarm }) => prewarm()).catch(() => {});

// Import app after database is ready (auth config needs getDb())
const { default: app, websocket } = await import("./app");

// Bun 1.4 surfaces native low-memory notifications. Release reconstructable
// caches before the OS resorts to terminating this long-running server.
const { installMemoryPressureHandler } = await import("./services/memory-pressure.service");
installMemoryPressureHandler();

// Register push notification EventBus listeners
const { initPushListeners } = await import("./services/push.service");
initPushListeners();

// Register background image-generation fallback listeners
const { initImageGenAutoListeners } = await import("./services/image-gen-auto.service");
initImageGenAutoListeners();

// Start extensions after app is imported but before serving —
// ensures extension macros are registered in the global registry
await startAllExtensions().catch((err) => {
  console.error("[Spindle] Failed to start extensions:", err);
});

console.log(`Lumiverse Backend starting on port ${env.port}...`);

// Use explicit Bun.serve() so we get the Server reference for native pub/sub.
// idleTimeout: 255 (Bun's maximum) guards against slowloris-style attacks where
// a malicious client holds a TCP connection open indefinitely without exchanging
// data. Active streaming responses (LLM token streaming, image gen) continuously
// send data and reset the idle timer, so they are unaffected. The previous value
// of 0 (disabled) left the server exposed to connection exhaustion.
const server = Bun.serve({
  port: env.port,
  hostname: "::",
  fetch: app.fetch,
  websocket,
  // Sized for the user-data import endpoint (full-account archives). Other
  // upload routes self-cap at the service layer (character imports stay at
  // MAX_CHARX_SIZE ≈ 1000 MB, image/avatar uploads at a few MB, etc.), so
  // raising the global ceiling here only widens the door for routes we
  // explicitly opt-in for via the bodyLimit exclusion list above.
  maxRequestBodySize: 5 * 1024 * 1024 * 1024, // 5 GB — matches MAX_COMPRESSED_BYTES in user-data import.
  idleTimeout: 255,
});

// Give the EventBus access to the server for native topic-based publish().
eventBus.setServer(server);


// Initialize multiplayer rooms: registers the chat/generation fan-out listener
// (re-broadcasts to room topics), the prompt-assembly persona provider, and
// re-arms any freeform deadline timers dropped by the restart.
const { initMultiplayer } = await import("./services/multiplayer.service");
initMultiplayer();

// Register the Identity Server attestation validator so remote peers can join
// directly with a server-minted token (no-op until MPIDENTITY_URL is set).
const { registerIdentityServerAttestation } = await import("./multiplayer/attestation");
registerIdentityServerAttestation();

console.log(`Lumiverse Backend listening on ${server.hostname}:${server.port}`);
startExtensionUpdateMonitor();

// Notify runner (if present) that the server is ready
if (process.env.LUMIVERSE_RUNNER_IPC === "1" && typeof process.send === "function") {
  process.send({ type: "ready", payload: { port: env.port, pid: process.pid } });
}

// LanceDB compaction and index replacement can monopolize Bun's runtime even
// when called through an async API. Do not run that native work automatically
// in the serving process: it can make the already-listening frontend appear
// hung. Run it in a child after readiness instead; ordinary index repair still
// happens on demand where it is scoped to the affected vector request.
const lancedbStartupMaintenanceEnabled = !["0", "false", "no", "off"].includes(
  (process.env.LUMIVERSE_LANCEDB_STARTUP_MAINTENANCE ?? "").trim().toLowerCase(),
);
if (lancedbStartupMaintenanceEnabled) {
  setTimeout(() => {
    console.info("[startup] Starting deferred LanceDB maintenance child...");
    import("./services/lancedb-maintenance-supervisor").then(({ runLanceDbMaintenanceInChild }) =>
      runLanceDbMaintenanceInChild({ mode: "startup" })
    ).catch((err) => {
      console.warn("[embeddings] Deferred startup maintenance failed:", err);
    });
  }, 5_000);
} else {
  console.info("[startup] Automatic LanceDB startup maintenance is disabled; use an Operator maintenance window to run compaction.");
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

// Warm Illarin credentials and push a declaration update when the backend
// version changed since Illarin last accepted one. Deferred like LumiHub.
setTimeout(() => {
  import("./illarin/warmup").then(({ warmUpInstances }) => {
    void warmUpInstances()
      .catch((err) => console.error("[Illarin] Warmup failed:", err))
      .then(async () => {
        try {
          const { startAllDeliveryWorkers } = await import("./illarin/delivery-worker");
          await startAllDeliveryWorkers();
        } catch (err) {
          console.error("[Illarin] Delivery workers failed to start:", err);
        }
      });
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

setTimeout(() => {
  import("./services/characters.service").then(({ resumePendingCharacterDeletions }) => {
    resumePendingCharacterDeletions().catch((err) =>
      console.warn("[characters] deletion resume failed:", err instanceof Error ? err.message : err)
    );
  });
}, 5_000);

// Pre-warm trusted-host suggestions after the server starts listening so the
// Operator tab usually hits a warm cache without slowing down boot.
setTimeout(() => {
  const snapshot = getTrustedHostsSnapshot();
  detectHostnameSuggestions({ forceRefresh: true, baseline: snapshot.baseline }).catch((err) => {
    console.warn("[trusted-hosts] Startup warm failed:", err instanceof Error ? err.message : err);
  });
}, 0);

// Log trusted origins so it's visible in the runner and easy to verify that LAN IPs were detected and applied automatically.
if (env.trustAnyOrigin) {
  console.log("[Auth] Trusted origins: ALL (TRUST_ANY_ORIGIN enabled)");
} else {
  const snapshot = getTrustedHostsSnapshot();
  const baselineLines = snapshot.baseline.map((e) => `  • ${e.host} (${e.source})`);
  const configuredLines = snapshot.configured.map((h) => `  • ${h} (configured)`);
  console.log(`[Auth] Trusted origins:\n${[...baselineLines, ...configuredLines].join("\n")}`);
}

// --- Graceful shutdown ---
let shutdownInProgress = false;

async function gracefulShutdown(signal: string) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`[Shutdown] Received ${signal}, shutting down...`);

  // 1. Stop accepting new connections
  server.stop(true);

  // 2. Durably cancel active LLM generations before aborting live work.
  const { stopAllGenerations, stopGenerationSweep } = await import("./services/generate.service");
  await stopAllGenerations();
  stopGenerationSweep();

  // 3. Disconnect LumiHub WebSocket client
  try {
    const { disconnectAllLumiHubClients } = await import("./lumihub/client");
    disconnectAllLumiHubClients();
  } catch {}

  // 3.5 Disconnect all MCP servers
  try {
    const { getMcpClientManager } = await import("./services/mcp-client-manager");
    await getMcpClientManager().disconnectAll();
  } catch {}

  // 4. Stop all Spindle extension workers
  const { stopAllExtensions } = await import("./spindle/lifecycle");
  stopExtensionUpdateMonitor();
  await stopAllExtensions().catch((err) =>
    console.error("[Shutdown] Extension stop error:", err)
  );

  // 5. Clear all interval timers
  const { stopTicketSweep } = await import("./ws/tickets");
  const { stopOAuthStateSweep } = await import("./spindle/oauth-state");
  const { stopPkceSweep } = await import("./routes/lumihub.routes");
  const { stopIllarinSweeps } = await import("./routes/illarin.routes");
  const { stopAllDeliveryWorkers } = await import("./illarin/delivery-worker");
  const { stopChatChunkVectorizationWorker, stopQueryCacheCleanup, stopWorldBookVectorizationSweep } = await import("./services/vectorization-queue.service");
  const { stopVersionCheckCleanup } = await import("./services/embeddings.service");
  stopTicketSweep();
  stopOAuthStateSweep();
  stopPkceSweep();
  stopIllarinSweeps();
  stopAllDeliveryWorkers();
  await stopChatChunkVectorizationWorker();
  stopQueryCacheCleanup();
  stopWorldBookVectorizationSweep();
  stopVersionCheckCleanup();

  // 5b. Tear down every isolate pool and its subprocess descendants. Each
  // pool is attempted even if another pool reports an exit error.
  const { shutdownIsolatePools } = await import("./services/startup-recovery.service");
  await shutdownIsolatePools();

  // 5c. Stop the rate-limit sweep timer.
  const { stopRateLimitSweep } = await import("./middleware/rate-limit");
  stopRateLimitSweep();

  // 5d. Stop the WS stale-client sweep timer.
  eventBus.stopSweep();

  // 5e. Stop the Vertex AI token cache sweep.
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
  const { stopDiskMonitor } = await import("./services/disk-monitor.service");
  stopDiskMonitor();
  const { stopSmartctlMonitor } = await import("./services/smartctl.service");
  stopSmartctlMonitor();

  // 8. Close database (triggers WAL checkpoint)
  const { stopLanceDbMaintenanceSupervisor } = await import("./services/lancedb-maintenance-supervisor");
  await stopLanceDbMaintenanceSupervisor();
  const { closeDatabaseAsync } = await import("./db/connection");
  await closeDatabaseAsync();

  console.log("[Shutdown] Cleanup complete.");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
