// ── Transpiler cache pinning ────────────────────────────────────────────────
// Bun mmap's its transpiler cache files. If the cache lives in /tmp and gets
// cleaned by systemd-tmpfiles / tmpwatch while the process is running, the
// stale mmap triggers SIGBUS. Tmux can also freeze the environment so the
// cache path inherits a stale or empty value. Pin it to a deterministic
// project-local directory before any other code runs.
import { resolve as _resolve } from "path";
if (!("BUN_RUNTIME_TRANSPILER_CACHE_PATH" in process.env)) {
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = _resolve(
    import.meta.dir,
    "..",
    "data",
    ".bun-transpiler-cache",
  );
}

// ── Bun version gate ────────────────────────────────────────────────────────
// Bun 1.3.10-1.3.12 can panic on occupied Windows IPC named pipes during
// runner/extension restarts; 1.3.13 contains the upstream fix.
const [_bunMaj = 0, _bunMin = 0, _bunPat = 0] = Bun.version
  .split(".")
  .map((part) => Number.parseInt(part, 10) || 0);
if (_bunMaj < 1 || (_bunMaj === 1 && (_bunMin < 3 || (_bunMin === 3 && _bunPat < 13)))) {
  console.error(`[startup] Bun ${Bun.version} is too old — Lumiverse requires Bun >= 1.3.13.`);
  console.error(`[startup] Update with ${process.platform === "win32" ? ".\\start.ps1" : "./start.sh"}.`);
  process.exit(1);
}

// ── Native Dependency Pre-flight ────────────────────────────────────────────
// Must run BEFORE any application code is imported so that environment variables
// take precedence when NAPI-RS resolves bindings via `require()`.
import { configureLanceDbNativeOverride } from "./lancedb-preflight";
await configureLanceDbNativeOverride();

// ── Application Boot ────────────────────────────────────────────────────────
await import("./main");
