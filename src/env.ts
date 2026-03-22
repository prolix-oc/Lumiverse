import { networkInterfaces } from "os";

/** Returns all non-internal IPv4 addresses on the machine's LAN interfaces. */
function getLanIPs(): string[] {
  const ips: string[] = [];
  try {
    for (const iface of Object.values(networkInterfaces())) {
      if (!iface) continue;
      for (const addr of iface) {
        if (addr.family === "IPv4" && !addr.internal) ips.push(addr.address);
      }
    }
  } catch { /* ignore — non-critical */ }
  return ips;
}

export interface EnvConfig {
  port: number;
  /** @deprecated Use resolveEncryptionKey() instead. Kept for migration only. */
  encryptionKey: string;
  dataDir: string;
  frontendDir: string;
  ownerUsername: string;
  ownerPassword: string;
  authSecret: string;
  trustedOrigins: string[];
  trustedOriginsSet: Set<string>;
  trustAnyOrigin: boolean;
  spindleEphemeralGlobalMaxBytes: number;
  spindleEphemeralExtensionDefaultMaxBytes: number;
  spindleEphemeralExtensionMaxOverrides: Record<string, number>;
  spindleEphemeralReservationTtlMs: number;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseEphemeralOverrides(raw?: string): Record<string, number> {
  if (!raw) return {};
  const out: Record<string, number> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [identifier, maxRaw] = trimmed.split(":").map((s) => s.trim());
    if (!identifier || !maxRaw) continue;
    const max = parseInt(maxRaw, 10);
    if (!Number.isFinite(max) || max <= 0) continue;
    out[identifier] = max;
  }
  return out;
}

export function loadEnv(): EnvConfig {
  const port = parseInt(process.env.PORT || "7860", 10);

  const encryptionKey = process.env.ENCRYPTION_KEY || "";

  const dataDir = process.env.DATA_DIR || "./data";

  const frontendDir = process.env.FRONTEND_DIR || "";

  const ownerUsername = process.env.OWNER_USERNAME || "admin";

  const ownerPassword = process.env.OWNER_PASSWORD || "";
  if (!ownerPassword) {
    console.error("OWNER_PASSWORD is required. Set it in your .env file.");
    process.exit(1);
  }
  if (ownerPassword.length < 8) {
    console.error("OWNER_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  // AUTH_SECRET is optional — if not set, it will be derived from the identity
  // key during initIdentity(). An explicit value takes precedence.
  const authSecret = process.env.AUTH_SECRET || "";

  const trustAnyOrigin = process.env.TRUST_ANY_ORIGIN === "true";
  const trustedOrigins = process.env.TRUSTED_ORIGINS
    ? process.env.TRUSTED_ORIGINS.split(",").map((o) => o.trim())
    : [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
        // Auto-include all LAN IPs so host-IP access works out of the box
        // without requiring TRUST_ANY_ORIGIN. The T key in the runner still
        // enables fully-open mode for external / mobile access.
        ...getLanIPs().map((ip) => `http://${ip}:${port}`),
      ];
  const trustedOriginsSet = new Set(trustedOrigins);

  const spindleEphemeralGlobalMaxBytes = parsePositiveIntEnv(
    "SPINDLE_EPHEMERAL_GLOBAL_MAX_BYTES",
    500 * 1024 * 1024
  );
  const spindleEphemeralExtensionDefaultMaxBytes = parsePositiveIntEnv(
    "SPINDLE_EPHEMERAL_EXTENSION_DEFAULT_MAX_BYTES",
    50 * 1024 * 1024
  );
  const spindleEphemeralReservationTtlMs = parsePositiveIntEnv(
    "SPINDLE_EPHEMERAL_RESERVATION_TTL_MS",
    10 * 60 * 1000
  );
  const spindleEphemeralExtensionMaxOverrides = parseEphemeralOverrides(
    process.env.SPINDLE_EPHEMERAL_EXTENSION_MAX_OVERRIDES
  );

  return {
    port,
    encryptionKey,
    dataDir,
    frontendDir,
    ownerUsername,
    ownerPassword,
    authSecret,
    trustedOrigins,
    trustedOriginsSet,
    trustAnyOrigin,
    spindleEphemeralGlobalMaxBytes,
    spindleEphemeralExtensionDefaultMaxBytes,
    spindleEphemeralExtensionMaxOverrides,
    spindleEphemeralReservationTtlMs,
  };
}

export const env = loadEnv();
