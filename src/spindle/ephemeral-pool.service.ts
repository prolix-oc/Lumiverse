import { env } from "../env";
import * as managerSvc from "./manager.service";
import type { ExtensionInfo } from "lumiverse-spindle-types";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export interface EphemeralPoolConfig {
  globalMaxBytes: number;
  extensionDefaultMaxBytes: number;
  extensionMaxOverrides: Record<string, number>;
  reservationTtlMs: number;
}

interface ReservationRow {
  id: string;
  sizeBytes: number;
  consumedBytes: number;
  createdAt: string;
  expiresAt: string;
  reason?: string;
}

const CONFIG_DIR = join(env.dataDir, "spindle");
const CONFIG_PATH = join(CONFIG_DIR, "ephemeral-pools.json");

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function sanitizeOverrides(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [identifier, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!identifier) continue;
    if (!/^[a-z][a-z0-9_]*$/.test(identifier)) continue;
    const val = parsePositiveInt(raw, -1);
    if (val > 0) out[identifier] = val;
  }
  return out;
}

export function getEphemeralPoolConfig(): EphemeralPoolConfig {
  const base: EphemeralPoolConfig = {
    globalMaxBytes: env.spindleEphemeralGlobalMaxBytes,
    extensionDefaultMaxBytes: env.spindleEphemeralExtensionDefaultMaxBytes,
    extensionMaxOverrides: { ...env.spindleEphemeralExtensionMaxOverrides },
    reservationTtlMs: env.spindleEphemeralReservationTtlMs,
  };

  if (!existsSync(CONFIG_PATH)) return base;

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return {
      globalMaxBytes: parsePositiveInt(raw.globalMaxBytes, base.globalMaxBytes),
      extensionDefaultMaxBytes: parsePositiveInt(
        raw.extensionDefaultMaxBytes,
        base.extensionDefaultMaxBytes
      ),
      extensionMaxOverrides: {
        ...base.extensionMaxOverrides,
        ...sanitizeOverrides(raw.extensionMaxOverrides),
      },
      reservationTtlMs: parsePositiveInt(raw.reservationTtlMs, base.reservationTtlMs),
    };
  } catch {
    return base;
  }
}

export function updateEphemeralPoolConfig(
  patch: Partial<EphemeralPoolConfig>
): EphemeralPoolConfig {
  const current = getEphemeralPoolConfig();
  const next: EphemeralPoolConfig = {
    globalMaxBytes: parsePositiveInt(patch.globalMaxBytes, current.globalMaxBytes),
    extensionDefaultMaxBytes: parsePositiveInt(
      patch.extensionDefaultMaxBytes,
      current.extensionDefaultMaxBytes
    ),
    extensionMaxOverrides:
      patch.extensionMaxOverrides !== undefined
        ? sanitizeOverrides(patch.extensionMaxOverrides)
        : current.extensionMaxOverrides,
    reservationTtlMs: parsePositiveInt(
      patch.reservationTtlMs,
      current.reservationTtlMs
    ),
  };

  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

function getExtensionEphemeralBase(ext: ExtensionInfo): string {
  return resolve(managerSvc.getStoragePathForExtension(ext), ".ephemeral");
}

function getReservations(ext: ExtensionInfo): ReservationRow[] {
  const path = join(getExtensionEphemeralBase(ext), ".reservations.json");
  if (!existsSync(path)) return [];
  try {
    const rows = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(rows)) return [];
    return rows.filter((r) => {
      return (
        r &&
        typeof r.id === "string" &&
        typeof r.sizeBytes === "number" &&
        typeof r.consumedBytes === "number" &&
        typeof r.expiresAt === "string"
      );
    });
  } catch {
    return [];
  }
}

function getExtensionUsage(ext: ExtensionInfo) {
  const base = getExtensionEphemeralBase(ext);
  const indexPath = join(base, ".index.json");
  const reservationsPath = join(base, ".reservations.json");

  let usedBytes = 0;
  let fileCount = 0;

  if (existsSync(base)) {
    const entries = readdirSync(base, { recursive: true });
    for (const entry of entries) {
      const rel = typeof entry === "string" ? entry : entry.toString();
      const full = join(base, rel);
      if (full === indexPath || full === reservationsPath) continue;
      try {
        const st = statSync(full);
        if (!st.isFile()) continue;
        fileCount += 1;
        usedBytes += st.size;
      } catch {
        // ignore unreadable entries
      }
    }
  }

  const now = Date.now();
  const reservations = getReservations(ext)
    .map((r) => {
      const expiresAtMs = Date.parse(r.expiresAt);
      const expired = Number.isNaN(expiresAtMs) || expiresAtMs <= now;
      const remainingBytes = Math.max(0, r.sizeBytes - r.consumedBytes);
      return {
        ...r,
        expired,
        remainingBytes,
      };
    })
    .filter((r) => !r.expired && r.remainingBytes > 0);

  const reservedBytes = reservations.reduce((sum, r) => sum + r.remainingBytes, 0);

  return {
    usedBytes,
    reservedBytes,
    fileCount,
    reservations,
  };
}

export function getEphemeralPoolOverview(options?: { includeReservations?: boolean }) {
  const includeReservations = options?.includeReservations ?? false;
  const cfg = getEphemeralPoolConfig();

  const extensionRows = managerSvc.list().map((ext) => {
    const usage = getExtensionUsage(ext);
    const extensionMaxBytes =
      cfg.extensionMaxOverrides[ext.identifier] ?? cfg.extensionDefaultMaxBytes;

    return {
      extensionId: ext.id,
      identifier: ext.identifier,
      name: ext.name,
      enabled: ext.enabled,
      hasEphemeralPermission: ext.granted_permissions.includes("ephemeral_storage"),
      extensionMaxBytes,
      usedBytes: usage.usedBytes,
      reservedBytes: usage.reservedBytes,
      availableBytes: Math.max(0, extensionMaxBytes - usage.usedBytes - usage.reservedBytes),
      fileCount: usage.fileCount,
      reservations: includeReservations
        ? usage.reservations.map((r) => ({
            id: r.id,
            sizeBytes: r.sizeBytes,
            consumedBytes: r.consumedBytes,
            remainingBytes: r.remainingBytes,
            createdAt: r.createdAt,
            expiresAt: r.expiresAt,
            reason: r.reason,
          }))
        : undefined,
    };
  });

  const globalUsedBytes = extensionRows.reduce((sum, row) => sum + row.usedBytes, 0);
  const globalReservedBytes = extensionRows.reduce((sum, row) => sum + row.reservedBytes, 0);

  return {
    config: cfg,
    global: {
      maxBytes: cfg.globalMaxBytes,
      usedBytes: globalUsedBytes,
      reservedBytes: globalReservedBytes,
      availableBytes: Math.max(0, cfg.globalMaxBytes - globalUsedBytes - globalReservedBytes),
    },
    extensions: extensionRows,
  };
}
