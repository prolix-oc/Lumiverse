import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimit } from "../middleware/rate-limit";
import { spindleLiveActivitySnapshot, refreshSpindleLiveActivity, dismissSpindleLiveActivity, disableSpindleLiveActivityClient } from "../services/spindle-live-activities.service";

const authenticated = new Hono();
authenticated.use("*", bodyLimit({ maxSize: 8192 }), rateLimit({ bucket: "spindle-activity-snapshot", max: 60, windowMs: 60000 }),
  async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
authenticated.post("/disable", async c => {
  try { disableSpindleLiveActivityClient(c.get("userId"), await c.req.json()); return c.body(null, 204); }
  catch { return c.json({ error: "Invalid activity installation" }, 400); }
});
authenticated.post("/snapshot", async c => {
  try { return c.json(spindleLiveActivitySnapshot(c.get("userId"), await c.req.json())); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid activity request" }, 400); }
});
const transport = new Hono();
transport.use("*", bodyLimit({ maxSize: 2048 }), rateLimit({ bucket: "spindle-activity-token", max: 120, windowMs: 60000 }),
  async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
const credential = (value?: string) => value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "";
transport.put("/:id", async c => {
  try {
    return refreshSpindleLiveActivity(c.req.param("id"), credential(c.req.header("Authorization")), await c.req.json())
      ? c.body(null, 204) : c.json({ error: "Activity credential expired or revoked" }, 401);
  } catch { return c.json({ error: "Invalid activity token" }, 400); }
});
transport.delete("/:id", c => {
  dismissSpindleLiveActivity(c.req.param("id"), credential(c.req.header("Authorization")));
  return c.body(null, 204);
});
export { authenticated as spindleLiveActivityRoutes, transport as spindleLiveActivityTransportRoutes };
