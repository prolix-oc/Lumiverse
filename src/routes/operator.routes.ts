import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { operatorService, OperationConflictError } from "../services/operator.service";
import { InsufficientDiskSpaceError } from "../db/maintenance";

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
    if (err instanceof OperationConflictError) {
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof InsufficientDiskSpaceError) {
      return c.json({ error: err.message }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

// ── Logs ────────────────────────────────────────────────────────────────────

app.get("/logs", (c) => {
  const parsedLimit = parseInt(c.req.query("limit") || "150", 10);
  const limit = Math.min(2000, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : 150));
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
