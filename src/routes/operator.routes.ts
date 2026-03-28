import { Hono } from "hono";
import { requireOwner } from "../auth/middleware";
import { operatorService, OperationConflictError } from "../services/operator.service";

const app = new Hono();

// All operator routes require owner role
app.use("*", requireOwner);

// ── Status ──────────────────────────────────────────────────────────────────

app.get("/status", async (c) => {
  const status = await operatorService.getFullStatus();
  return c.json(status);
});

// ── Logs ────────────────────────────────────────────────────────────────────

app.get("/logs", (c) => {
  const limit = Math.min(2000, Math.max(1, parseInt(c.req.query("limit") || "150", 10) || 150));
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
