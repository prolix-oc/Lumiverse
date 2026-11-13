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
// A cold dependency install can legitimately spend several minutes downloading
// and unpacking platform packages, especially on slower Windows disks. Keep a
// firm ceiling so an actual hang still recovers, but do not abort a healthy
// install halfway through its normal work.
export const TIMEOUT_BUN_INSTALL_MS = 10 * 60_000;
// Termux installs are deliberately cold-cache, copy every package instead of
// hardlinking, and may run through proot syscall emulation. On slower Android
// storage that can legitimately take much longer than the desktop path.
export const TIMEOUT_BUN_INSTALL_TERMUX_MS = 30 * 60_000;
// Windows Vite builds can legitimately take longer than five minutes on cold
// disks or when an antivirus scanner inspects generated assets.
export const TIMEOUT_BUN_BUILD_MS = 10 * 60_000;
// A first Windows build downloads the crates.io index and the entire native
// dependency graph before compiling tauri, wry, and the platform bindings.
// Slow disks, antivirus scanning, or a constrained connection can push that
// well beyond 30 minutes while Cargo is still making steady progress. Keep a
// firm ceiling for a true hang, but allow a cold build enough time to finish.
export const TIMEOUT_DESKTOP_BUILD_MS = 2 * 60 * 60_000;
