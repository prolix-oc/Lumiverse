import { Hono } from "hono";
import { authenticateAndroidCredential, verifyAndroidAvatar, androidServerInstanceId } from "../services/android-notifications.service";
import { iosAvatarThumbnail as nativeAvatarThumbnail } from "../services/ios-avatar-thumbnail";
import { getDb } from "../db/connection";
import { issueDesktopNotificationTicket } from "../ws/tickets";
import { rateLimit } from "../middleware/rate-limit";

const app = new Hono();
app.use("*", rateLimit({ bucket: "android-notifications", max: 120, windowMs: 60_000,
  message: "Too many native notification requests. Try again shortly." }));
app.post("/ticket", c => {
  c.header("Cache-Control", "no-store");
  const credential = c.req.header("authorization")?.match(/^Bearer (lva_[A-Za-z0-9_-]{43})$/)?.[1];
  const destination = credential ? authenticateAndroidCredential(credential) : null;
  if (!destination) return c.json({ error: "Invalid Android notification credential" }, 401);
  return c.json({ ticket: issueDesktopNotificationTicket(destination.userId, destination.destinationId), serverInstanceId: androidServerInstanceId() });
});
app.get("/avatar/:destinationId/:characterId", async c => {
  c.header("Cache-Control", "no-store");
  const { destinationId, characterId } = c.req.param();
  if (!verifyAndroidAvatar(destinationId, characterId, c.req.query("expires"), c.req.query("signature")))
    return c.json({ error: "Invalid notification avatar signature" }, 401);
  const row = getDb().query("SELECT user_id FROM android_push_destinations WHERE id = ?").get(destinationId) as { user_id: string } | null;
  if (!row) return c.json({ error: "Not found" }, 404);
  return nativeAvatarThumbnail(row.user_id, characterId);
});
export { app as androidNotificationTransportRoutes };
