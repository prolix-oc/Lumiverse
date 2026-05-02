// ── Bun version gate ────────────────────────────────────────────────────────
// CompressionStream (Brotli) and other APIs we depend on require Bun >= 1.3.3.
const [_bunMaj = 0, _bunMin = 0, _bunPat = 0] = Bun.version.split(".").map(Number);
if (_bunMaj < 1 || (_bunMaj === 1 && (_bunMin < 3 || (_bunMin === 3 && _bunPat < 3)))) {
  console.error(`[startup] Bun ${Bun.version} is too old — Lumiverse requires Bun >= 1.3.3.`);
  console.error("[startup] Update Bun: curl -fsSL https://bun.sh/install | bash");
  process.exit(1);
}

// ── Native Dependency Pre-flight ────────────────────────────────────────────
// Must run BEFORE any application code is imported so that environment variables
// take precedence when NAPI-RS resolves bindings via `require()`.
import { configureLanceDbNativeOverride } from "./lancedb-preflight";
await configureLanceDbNativeOverride();

// ── Application Boot ────────────────────────────────────────────────────────
await import("./main");
