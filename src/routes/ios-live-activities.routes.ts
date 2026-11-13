import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimit } from "../middleware/rate-limit";
import { getLiveActivityAPNsInfo } from "../services/apns.service";
import { liveActivitySnapshot, prepareLiveActivity, refreshLiveActivity, revokeLiveActivity, liveActivityAvatarOwner, stopLiveActivityGeneration } from "../services/ios-live-activities.service";
import { iosAvatarThumbnail } from "../services/ios-avatar-thumbnail";

/** Mounted under browser authentication. Credentials are returned only when creating an activity. */
const authenticated = new Hono();
authenticated.use("*", bodyLimit({ maxSize: 8192 }), async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
authenticated.get("/info", c => c.json(getLiveActivityAPNsInfo(c.req.query("bundleId"))));
authenticated.post("/snapshot", async c => {
  try { return c.json(liveActivitySnapshot(c.get("userId"), (await c.req.json()).generationIds)); }
  catch { return c.json({ error: "Invalid activity snapshot request" }, 400); }
});
authenticated.post("/prepare", rateLimit({ bucket: "ios-activity-prepare", max: 60, windowMs: 60_000 }), async c => {
  try {
    const input = await c.req.json();
    const info = getLiveActivityAPNsInfo(typeof input?.bundleId === "string" ? input.bundleId : undefined);
    if (!info.configured) return c.json({ error: info.reason }, 503);
    return c.json(prepareLiveActivity(c.get("userId"), input), 201);
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid activity request" }, 400); }
});

/** No browser session: the bearer credential is scoped to one generation and its activity. */
const transport = new Hono();
transport.use("*", bodyLimit({ maxSize: 4096 }), rateLimit({ bucket: "ios-activity-token", max: 120, windowMs: 60_000 }),
  async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
const credential = (authorization: string | undefined) => authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? "";
transport.get("/registrations/:id/avatar", async c => {
  const owner = liveActivityAvatarOwner(c.req.param("id"), credential(c.req.header("Authorization")));
  return owner ? iosAvatarThumbnail(owner.userId, owner.characterId) : c.body(null, 404);
});
transport.post("/registrations/:id/stop", async c => {
  try {
    const result = await stopLiveActivityGeneration(c.req.param("id"), credential(c.req.header("Authorization")));
    return result ? c.json(result) : c.json({ error: "Activity credential expired or revoked" }, 401);
  } catch { return c.json({ error: "Generation is no longer active" }, 409); }
});
transport.put("/registrations/:id", async c => {
  try {
    const result = refreshLiveActivity(c.req.param("id"), credential(c.req.header("Authorization")), await c.req.json());
    return result ? c.json(result) : c.json({ error: "Activity credential expired or revoked" }, 401);
  } catch { return c.json({ error: "Invalid activity token" }, 400); }
});
transport.delete("/registrations/:id", c => {
  revokeLiveActivity(c.req.param("id"), credential(c.req.header("Authorization")));
  return c.body(null, 204);
});
export { authenticated as iosLiveActivityRoutes, transport as iosLiveActivityTransportRoutes };
