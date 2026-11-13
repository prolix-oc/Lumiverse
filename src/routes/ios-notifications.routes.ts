import { Hono } from "hono";
import { iosAvatarThumbnail } from "../services/ios-avatar-thumbnail";
import { getDb } from "../db/connection";
import { rateLimit } from "../middleware/rate-limit";
import { verifyIOSNotificationAvatarPath } from "../services/ios-notification-avatar";

const app = new Hono();
const limiter = rateLimit({ bucket: "ios-notification-avatar", max: 120, windowMs: 60_000,
  message: "Too many notification avatar requests. Try again shortly." });

app.get("/avatar/:destinationId/:characterId", limiter, async c => {
  c.header("Cache-Control", "no-store");
  const { destinationId, characterId } = c.req.param();
  if (!verifyIOSNotificationAvatarPath(destinationId, characterId, c.req.query("expires"), c.req.query("signature")))
    return c.json({ error: "Invalid notification avatar signature" }, 401);
  const destination = getDb().query("SELECT user_id FROM ios_push_destinations WHERE id = ?").get(destinationId) as { user_id: string } | null;
  if (!destination) return c.json({ error: "Not found" }, 404);
  return iosAvatarThumbnail(destination.user_id, characterId);
});

export { app as iosNotificationMediaRoutes };
