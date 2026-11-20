import { DatabaseExecutionError, isDatabaseUnavailable } from "../db/execution";
import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { operatorService, OperationConflictError } from "../services/operator.service";
import { InsufficientDiskSpaceError } from "../db/maintenance";
import {
  detectHostnameSuggestions,
  getSnapshot as getTrustedHostsSnapshot,
  InvalidTrustedHostError,
  setTrustedHosts,
} from "../services/trusted-hosts.service";
import {
  getApprovedBrokerOrigins,
  InvalidBrokerOriginError,
  setApprovedBrokerOrigins,
} from "../services/broker-origins.service";
import {
  getSharpSettingsStatus,
  putSharpSettings,
} from "../services/sharp-settings.service";
import {
  discardImageProcessingQueue,
  getImageProcessingQueueSnapshot,
  recoverImageProcessingQueue,
} from "../services/images.service";
import {
  getDnsSettingsStatus,
  putDnsSettings,
} from "../services/dns-settings.service";
import {
  getDiskWarningSettingsStatus,
  putDiskWarningSettings,
} from "../services/disk-warning-settings.service";
import {
  getSmartctlSnapshot,
  getSmartctlStatus,
  installSmartctl,
} from "../services/smartctl.service";
import { InvalidSettingError } from "../services/settings.service";
import {
  parseExtensionSecretKey,
  providerRegistry,
} from "../spindle/provider-registry";
import {
  putSecret,
  deleteSecret,
  listSecretKeys,
  SYSTEM_SECRET_PRINCIPAL,
} from "../services/secrets.service";
import { parsePagination } from "../services/pagination";

const app = new Hono();
const CHECKPOINT_MODES = new Set(["PASSIVE", "FULL", "RESTART", "TRUNCATE"]);

// All operator routes require owner role
app.use("*", requireOwner);

// ── Status ──────────────────────────────────────────────────────────────────

app.get("/status", async (c) => {
  const status = await operatorService.getFullStatus();
  return c.json(status);
});

app.get("/database", async (c) => {
  const userId = c.get("userId");
  return c.json(await operatorService.getDatabaseStatus(userId));
});

app.get("/sharp", (c) => {
  const snapshot = getImageProcessingQueueSnapshot();
  return c.json({
    ...getSharpSettingsStatus(),
    thumbnailQueue: snapshot.queue,
    thumbnailRecovery: snapshot.recovery,
  });
});

app.put("/sharp", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  try {
    return c.json(putSharpSettings(userId, body ?? {}));
  } catch (err) {
    if (err instanceof InvalidSettingError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

app.post("/sharp/queue/recover", (c) => {
  recoverImageProcessingQueue();
  return c.json(getImageProcessingQueueSnapshot());
});

app.post("/sharp/queue/discard", (c) => {
  discardImageProcessingQueue();
  return c.json(getImageProcessingQueueSnapshot());
});

app.get("/dns", (c) => {
  return c.json(getDnsSettingsStatus());
});

app.put("/dns", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  try {
    return c.json(putDnsSettings(userId, body ?? {}));
  } catch (err) {
    if (err instanceof InvalidSettingError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

app.get("/disk-warning", (c) => {
  return c.json(getDiskWarningSettingsStatus());
});

app.put("/disk-warning", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  try {
    return c.json(putDiskWarningSettings(userId, body ?? {}));
  } catch (err) {
    if (err instanceof InvalidSettingError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

// ── SMART disk health ──────────────────────────────────────────────────────

app.get("/smartctl", async (c) => {
  const force = c.req.query("refresh") === "1";
  const [status, snapshot] = await Promise.all([
    getSmartctlStatus(),
    getSmartctlSnapshot({ force }),
  ]);
  return c.json({ ...status, snapshot });
});

/**
 * Attempts a fixed package-manager install only if this server already has
 * the required OS privilege. It never runs sudo or solicits credentials over
 * HTTP; the response includes the detected installation plan when elevation
 * must happen in a local terminal instead.
 */
app.post("/smartctl/install", async (c) => {
  const result = await installSmartctl();
  if (!result.installed && result.error) {
    const status = result.status.availability === "available" ? 200 : 409;
    return c.json(result, status);
  }
  return c.json(result);
});

app.post("/database/maintenance", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const checkpointMode = typeof body?.checkpointMode === "string"
    ? body.checkpointMode.toUpperCase()
    : "TRUNCATE";

  if (body?.checkpointMode != null && !CHECKPOINT_MODES.has(checkpointMode)) {
    return c.json({ error: "checkpointMode must be one of PASSIVE, FULL, RESTART, TRUNCATE" }, 400);
  }

  try {
    const result = await operatorService.maintainDatabase(userId, {
      optimize: body?.optimize !== false,
      analyze: body?.analyze === true,
      vacuum: body?.vacuum === true,
      refreshTuning: body?.refreshTuning !== false,
      checkpointMode,
    });
    return c.json(result);
  } catch (err) {
    if (isDatabaseUnavailable(err)) throw err;
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof InsufficientDiskSpaceError || (err instanceof DatabaseExecutionError && err.code === "INSUFFICIENT_DISK_SPACE")) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

// ── Trusted hosts ───────────────────────────────────────────────────────────

/**
 * Operator provisioning for system-scope Spindle extension brokers. Secrets
 * are stored under the reserved SYSTEM_SECRET_PRINCIPAL so system-scoped
 * brokers can resolve them host-side. Keys must be namespaced to a single
 * installation: `extension:<installationId>:<name>`.
 */
app.get("/spindle-secrets", (c) => {
  const keys = listSecretKeys(SYSTEM_SECRET_PRINCIPAL)
    .filter((key) => parseExtensionSecretKey(key) != null);
  return c.json({
    keys: keys.map((key) => {
      const parsed = parseExtensionSecretKey(key)!;
      return { key, installationId: parsed.installationId, name: parsed.name };
    }),
  });
});

app.put("/spindle-secrets/:key", async (c) => {
  const key = c.req.param("key");
  if (!parseExtensionSecretKey(key)) {
    return c.json(
      { error: "key must be namespaced as extension:<installationId>:<name>" },
      400,
    );
  }
  const body = await c.req.json().catch(() => null);
  if (typeof body?.value !== "string" || body.value.length === 0) {
    return c.json({ error: "value is required and must be a non-empty string" }, 400);
  }
  await putSecret(SYSTEM_SECRET_PRINCIPAL, key, body.value);
  return c.json({ success: true });
});

app.delete("/spindle-secrets/:key", (c) => {
  const key = c.req.param("key");
  if (!parseExtensionSecretKey(key)) {
    return c.json(
      { error: "key must be namespaced as extension:<installationId>:<name>" },
      400,
    );
  }
  const deleted = deleteSecret(SYSTEM_SECRET_PRINCIPAL, key);
  return c.json({ success: true, deleted });
});

app.get("/trusted-hosts", async (c) => {
  const snapshot = getTrustedHostsSnapshot();
  const fresh = c.req.query("fresh") === "1";
  const suggestions = await detectHostnameSuggestions({ forceRefresh: fresh, baseline: snapshot.baseline });
  return c.json({ ...snapshot, ...suggestions });
});

app.put("/trusted-hosts", async (c) => {
  const body = await c.req.json().catch(() => null);
  const hosts = Array.isArray(body?.hosts) ? body.hosts : null;
  if (!hosts) {
    return c.json({ error: "Payload must be { hosts: string[] }" }, 400);
  }
  try {
    const configured = setTrustedHosts(hosts);
    return c.json({ configured, baseline: getTrustedHostsSnapshot().baseline });
  } catch (err) {
    if (err instanceof InvalidTrustedHostError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

// ── Approved broker origins ────────────────────────────────────────────────

/**
 * Operator allowlist for Spindle extension broker URLs. An empty list is
 * permissive — registration accepts any http(s) origin.
 */
app.get("/broker-origins", (c) => {
  return c.json({ configured: getApprovedBrokerOrigins() });
});

app.put("/broker-origins", async (c) => {
  const body = await c.req.json().catch(() => null);
  const origins = Array.isArray(body?.origins) ? body.origins : null;
  if (!origins) {
    return c.json({ error: "Payload must be { origins: string[] }" }, 400);
  }
  try {
    // Applied here rather than inside setApprovedBrokerOrigins so the service
    // stays a pure persistence layer; the operator route is the seam that
    // pushes the live allowlist into the running singleton registry so
    // enforcement is immediate without a WorkerHost rebuild or restart.
    const configured = setApprovedBrokerOrigins(origins);
    providerRegistry.configure({ approvedBrokerOrigins: configured });
    return c.json({ configured });
  } catch (err) {
    if (err instanceof InvalidBrokerOriginError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

// ── Logs ────────────────────────────────────────────────────────────────────

app.get("/logs", (c) => {
  const requestedLimit = parsePagination(c.req.query("limit"), undefined, 150).limit;
  const limit = Math.min(requestedLimit, 2000);
  const entries = operatorService.getLogs(limit);
  return c.json({ entries });
});

app.post("/logs/subscribe", (c) => {
  const userId = c.get("userId");
  operatorService.subscribeLogs(userId);
  return c.json({ subscribed: true });
});

app.delete("/logs/subscribe", (c) => {
  const userId = c.get("userId");
  operatorService.unsubscribeLogs(userId);
  return c.json({ subscribed: false });
});

// ── IPC-backed operations ───────────────────────────────────────────────────

function requireIPC(c: any): Response | null {
  if (!operatorService.ipcAvailable) {
    return c.json(
      { error: "Runner IPC not available. Start with ./start.sh or bun run runner." },
      503
    );
  }
  return null;
}

app.post("/update/check", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.checkUpdates();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/update/apply", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.applyUpdate();
    return c.json(result);
  } catch (err) {
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/branch", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  const body = await c.req.json();
  if (!body?.target || typeof body.target !== "string") {
    return c.json({ error: "target branch is required" }, 400);
  }

  try {
    const result = await operatorService.switchBranch(body.target);
    return c.json(result);
  } catch (err) {
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/remote", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  const body = await c.req.json();
  if (typeof body?.enable !== "boolean") {
    return c.json({ error: "enable (boolean) is required" }, 400);
  }

  try {
    const result = await operatorService.toggleRemote(body.enable);
    return c.json(result);
  } catch (err) {
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/restart", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.restart();
    return c.json(result);
  } catch (err) {
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/cache/clear", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.clearCache();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/rebuild", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.rebuildFrontend();
    return c.json(result);
  } catch (err) {
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/deps", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.ensureDependencies();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

app.post("/shutdown", async (c) => {
  const ipcErr = requireIPC(c);
  if (ipcErr) return ipcErr;

  try {
    const result = await operatorService.shutdown();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 502);
  }
});

export { app as operatorRoutes };
