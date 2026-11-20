import { Hono } from "hono";
import * as history from "../services/request-history.service";

const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  // Even a privileged session impersonating a user must not read their prompts.
  if (c.get("session")?.session.impersonatedBy) {
    return c.json({ error: "Request history is unavailable during account impersonation" }, 403);
  }
  await next();
});
app.get("/", (c) => c.json(history.getRequestHistory(c.get("userId"))));
app.put("/tracking", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
  return c.json(history.setRequestHistoryTracking(c.get("userId"), body.enabled));
});
app.delete("/", (c) => c.json(history.clearRequestHistory(c.get("userId"))));
app.get("/:id", (c) => {
  const entry = history.getRequestHistoryEntry(c.get("userId"), c.req.param("id"));
  if (!entry) return c.json({ error: "Request is no longer available" }, 404);
  return c.json(entry);
});
export { app as requestHistoryRoutes };
