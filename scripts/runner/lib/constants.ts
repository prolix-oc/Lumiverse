import { resolve, join } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "../../..");
export const ENTRY = join(PROJECT_ROOT, "src/index.ts");
export const ENV_FILE = join(PROJECT_ROOT, ".env");

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const AVAILABLE_BRANCHES = ["main", "staging"] as const;

// Server shutdown timing. gracefulShutdown() in src/index.ts awaits MCP
// disconnect, extension worker shutdown (5 s each, parallel), and a SQLite
// WAL close — 10 s is a comfortable ceiling. After this window, the runner
// escalates to SIGKILL; otherwise a wedged shutdown hook would pin the
// server process alive and silently stall every branch-switch / update.
export const STOP_SIGTERM_GRACE_MS = 10_000;
/** Back-compat alias. */
export const STOP_FORCE_KILL_MS = STOP_SIGTERM_GRACE_MS;

// Subprocess timeouts (ms). Picked to be generous enough for slow networks
// and large installs while still bounding any single command so a hang
// can't freeze the whole restart flow.
export const TIMEOUT_GIT_FETCH_MS = 60_000;
export const TIMEOUT_GIT_PULL_MS = 2 * 60_000;
export const TIMEOUT_GIT_CHECKOUT_MS = 30_000;
export const TIMEOUT_BUN_CACHE_MS = 30_000;
export const TIMEOUT_BUN_INSTALL_MS = 5 * 60_000;
export const TIMEOUT_BUN_BUILD_MS = 5 * 60_000;
