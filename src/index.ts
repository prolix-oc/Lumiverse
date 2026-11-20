// ── Transpiler cache pinning ────────────────────────────────────────────────
// Bun mmap's its transpiler cache files. If the cache lives in /tmp and gets
// cleaned by systemd-tmpfiles / tmpwatch while the process is running, the
// stale mmap triggers SIGBUS. Tmux can also freeze the environment so the
// cache path inherits a stale or empty value. Pin it to a deterministic
// project-local directory before any other code runs.
import { resolve as _resolve } from "path";
import { bootstrapBunRuntime } from "./runtime/bun-runtime";
if (!("BUN_RUNTIME_TRANSPILER_CACHE_PATH" in process.env)) {
  process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH = _resolve(
    import.meta.dir,
    "..",
    "data",
    ".bun-transpiler-cache",
  );
}

// ── Bun version gate ────────────────────────────────────────────────────────
// On Windows this can install a side-by-side runtime and re-exec the entrypoint;
// replacing the currently running bun.exe in place is not reliable.
await bootstrapBunRuntime(_resolve(import.meta.dir, ".."));

// ── Native Dependency Pre-flight ────────────────────────────────────────────
// Sharp is needed by every provider. LanceDB runs its own preflight immediately
// before lazily loading native bindings, once the vector provider is known.
import { configureSharpNativeOverride } from "./sharp-preflight";
await configureSharpNativeOverride();

// ── Application Boot ────────────────────────────────────────────────────────
await import("./main");
