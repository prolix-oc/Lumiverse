import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimit } from "../middleware/rate-limit";
import { prepareWidgets, revokeWidgets, widgetOwner, widgetSnapshot } from "../services/ios-widgets.service";
import { iosAvatarThumbnail } from "../services/ios-avatar-thumbnail";

const authenticated = new Hono();
authenticated.use("*", bodyLimit({ maxSize: 2048 }), async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
authenticated.post("/registrations", rateLimit({ bucket: "ios-widget-prepare", max: 20, windowMs: 60_000 }), async c => {
  try { return c.json(prepareWidgets(c.get("userId"), (await c.req.json()).deviceId), 201); }
  catch { return c.json({ error: "Invalid widget installation or installation limit reached" }, 400); }
});
authenticated.delete("/registrations/:id", c => { revokeWidgets(c.req.param("id"), c.get("userId")); return c.body(null, 204); });

/** This bearer grants collection metadata/portraits only, never a general API session. */
const transport = new Hono();
transport.use("*", rateLimit({ bucket: "ios-widget-read", max: 240, windowMs: 60_000 }), async (c, next) => {
  c.header("Cache-Control", "no-store"); await next();
});
transport.use("/registrations/:id/*", async (c, next) => {
  const token = c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "";
  const owner = widgetOwner(c.req.param("id")!, token);
  if (!owner) return c.json({ error: "Widget credential expired or revoked" }, 401);
  c.set("userId", owner); await next();
});
transport.get("/registrations/:id/snapshot", c => c.json(widgetSnapshot(c.get("userId"))));
transport.get("/registrations/:id/characters/:characterId/portrait", async c => {
  const snapshot = widgetSnapshot(c.get("userId"));
  return [...snapshot.recent, ...snapshot.favorites].some(item => item.characterId === c.req.param("characterId"))
    ? iosAvatarThumbnail(c.get("userId"), c.req.param("characterId"), true) : c.body(null, 404);
});
transport.delete("/registrations/:id", c => {
  const owner = widgetOwner(c.req.param("id"), c.req.header("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "");
  if (owner) revokeWidgets(c.req.param("id"), owner);
  return c.body(null, 204);
});
export { authenticated as iosWidgetRoutes, transport as iosWidgetTransportRoutes };
