import { env } from "./env";
import { initDatabase } from "./db/connection";
import { runMigrations } from "./db/migrate";
import { startAllExtensions } from "./spindle/lifecycle";
import { initIdentity } from "./crypto/init";
import { eventBus } from "./ws/bus";

// Resolve encryption identity (file > env migration > generate)
await initIdentity();

// Initialize database and run migrations synchronously
const db = initDatabase();
runMigrations(db);

// Dynamic import: auth modules call getDb() at module level, so must load after initDatabase()
const { seedOwner, backfillUserIds } = await import("./auth/seed");
await seedOwner();
backfillUserIds();

// Seed built-in tokenizers after migrations are applied
const { seedTokenizers } = await import("./services/tokenizer-seed");
seedTokenizers();

// Import app after database is ready (auth config needs getDb())
const { default: app, websocket } = await import("./app");

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

// Log trusted origins so it's visible in the runner and easy to verify that LAN IPs were detected and applied automatically.
if (env.trustAnyOrigin) {
  console.log("[Auth] Trusted origins: ALL (TRUST_ANY_ORIGIN enabled)");
} else {
  console.log(`[Auth] Trusted origins:\n${env.trustedOrigins.map((o) => `  • ${o}`).join("\n")}`);
}
