import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getVapidPublicKey } from "../crypto/vapid";
import * as pushSvc from "../services/push.service";
import type { CreatePushSubscriptionInput } from "../types/push";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import { getAPNsInfo } from "../services/apns.service";
import { createAndroidDestination, getAndroidNotificationInfo } from "../services/android-notifications.service";

const app = new Hono();

app.get("/android/info", c => {
  c.header("Cache-Control", "no-store");
  return c.json(getAndroidNotificationInfo());
});
app.post("/android", bodyLimit({ maxSize: 8192 }), async c => {
  c.header("Cache-Control", "no-store");
  try {
    const input = await c.req.json();
    if (input.transport === "fcm" && !getAndroidNotificationInfo().configured)
      return c.json({ error: getAndroidNotificationInfo().reason }, 503);
    return c.json(createAndroidDestination(c.get("userId"), input), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid Android destination" }, 400);
  }
});

app.get("/ios/info", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(getAPNsInfo(c.req.query("bundleId")));
});

app.post("/ios", bodyLimit({ maxSize: 8192 }), async (c) => {
  c.header("Cache-Control", "no-store");
  try {
    const input = await c.req.json();
    const info = getAPNsInfo(typeof input?.bundleId === "string" ? input.bundleId : undefined);
    if (!info.configured) return c.json({ error: info.reason }, 503);
    return c.json(pushSvc.createIOSDestination(c.get("userId"), input), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid iOS push destination" }, 400);
  }
});

app.get("/vapid-public-key", (c) => {
  return c.json({ publicKey: getVapidPublicKey() });
});

app.get("/subscriptions", (c) => {
  const userId = c.get("userId");
  return c.json(pushSvc.listNotificationDestinations(userId));
});

app.get("/desktop/info", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ serverInstanceId: pushSvc.getDesktopNotificationServerInstanceId() });
});

app.post("/desktop", async (c) => {
  c.header("Cache-Control", "no-store");
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    return c.json(pushSvc.createDesktopDestination(userId, body), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid desktop destination" }, 400);
  }
});

app.post("/subscriptions", async (c) => {
  const userId = c.get("userId");
  const body = (await c.req.json()) as CreatePushSubscriptionInput;

  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return c.json({ error: "Missing endpoint or keys" }, 400);
  }

  // Validate the push endpoint: real push services use HTTPS, and must not
  // resolve to private/internal addresses (SSRF protection — the stored
  // endpoint is POSTed to on every GENERATION_ENDED event).
  let parsed: URL;
  try {
    parsed = new URL(body.endpoint);
  } catch {
    return c.json({ error: "endpoint is not a valid URL" }, 400);
  }
  if (parsed.protocol !== "https:") {
    return c.json({ error: "Push endpoint must use HTTPS" }, 400);
  }
  try {
    await validateHost(parsed.hostname);
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    throw err;
  }

  const sub = pushSvc.createSubscription(userId, body);
  return c.json(sub, 201);
});

app.delete("/subscriptions/:id", async (c) => {
  const userId = c.get("userId");
  const deleted = await pushSvc.deleteNotificationDestination(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/subscriptions/test", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({})) as { destinationId?: unknown };
  const destinationId = typeof body.destinationId === "string" ? body.destinationId : undefined;
  const result = await pushSvc.dispatchGenerationEndedPush(userId, {
    content: "Automatic push notifications are working!",
  }, { bypassPresence: true, destinationId });
  return c.json({ success: result.sent > 0, ...result });
});

export { app as pushRoutes };
