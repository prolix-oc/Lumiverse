import { networkInterfaces } from "os";
import { resolve } from "path";

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
  /** @deprecated Only used for legacy migration to owner.credentials. */
  ownerPassword: string;
  authSecret: string;
  trustedOrigins: string[];
  trustedOriginsSet: Set<string>;
  trustAnyOrigin: boolean;
  spindleEphemeralGlobalMaxBytes: number;
  spindleEphemeralExtensionDefaultMaxBytes: number;
  spindleEphemeralExtensionMaxOverrides: Record<string, number>;
  spindleEphemeralReservationTtlMs: number;
  /** Enable one-time SillyTavern migration at startup (Docker). */
  stMigrate: boolean;
  /** Path to SillyTavern data root inside the container. */
  stPath: string;
  /** SillyTavern user directory name. */
  stTargetUser: string;
  /** What to import: 1=chars, 2=world books, 3=personas, 4=chars+chats, 5=everything. */
  stMigrationTarget: number;
  /** Re-trigger migration even if one already completed. */
  stForceNewMigration: boolean;
  /** Optional Pollinations BYOP app key (publishable pk_...) */
  pollinationsAppKey: string;
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
  const rawPort = parseInt(process.env.PORT || "7860", 10);
  // L-26: Validate port is a legitimate TCP port number (1–65535).
  if (!Number.isFinite(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error(`Invalid PORT value "${process.env.PORT}": must be 1–65535`);
  }
  const port = rawPort;

  const encryptionKey = process.env.ENCRYPTION_KEY || "";

  // Resolve to absolute path at startup so file operations are immune to
  // CWD changes — critical on Termux where proot/grun wrappers can shift CWD.
  const dataDir = resolve(process.env.DATA_DIR || "./data");

  const frontendDir = process.env.FRONTEND_DIR || "";

  const ownerUsername = process.env.OWNER_USERNAME || "admin";

  // OWNER_PASSWORD is optional — only used for legacy migration to owner.credentials.
  // New installs use the setup wizard which writes credentials directly.
  const ownerPassword = process.env.OWNER_PASSWORD || "";

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

  // SillyTavern migration (Docker one-time import)
  const stMigrate = process.env.LUMIVERSE_ST_MIGRATE === "true";
  const stPath = process.env.SILLYTAVERN_PATH || "./data/SillyTavern";
  const stTargetUser = process.env.SILLYTAVERN_TARGET_USER || "default-user";
  const stMigrationTarget = Math.min(5, Math.max(1, parseInt(process.env.SILLYTAVERN_MIGRATION_TARGET || "5", 10) || 5));
  const stForceNewMigration = process.env.LUMIVERSE_FORCE_NEW_MIGRATION === "true";
  // L-25: The Pollinations publishable app key was previously hardcoded as a
  // fallback default, which means it would be used by all installations that
  // did not configure POLLINATIONS_APP_KEY.  Remove the hardcoded default so
  // the service simply runs without a key when none is set (Pollinations works
  // without an app key in anonymous mode; a key only enables extra quotas).
  const pollinationsAppKey = process.env.POLLINATIONS_APP_KEY || "";

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
    stMigrate,
    stPath,
    stTargetUser,
    stMigrationTarget,
    stForceNewMigration,
    pollinationsAppKey,
  };
}

export const env = loadEnv();
