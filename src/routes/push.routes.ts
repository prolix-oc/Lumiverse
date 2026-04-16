import { Hono } from "hono";
import { getVapidPublicKey } from "../crypto/vapid";
import * as pushSvc from "../services/push.service";
import type { CreatePushSubscriptionInput } from "../types/push";
import { validateHost, SSRFError } from "../utils/safe-fetch";

const app = new Hono();

app.get("/vapid-public-key", (c) => {
  return c.json({ publicKey: getVapidPublicKey() });
});

app.get("/subscriptions", (c) => {
  const userId = c.get("userId");
  return c.json(pushSvc.listSubscriptions(userId));
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

app.delete("/subscriptions/:id", (c) => {
  const userId = c.get("userId");
  const deleted = pushSvc.deleteSubscription(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.post("/subscriptions/test", async (c) => {
  const userId = c.get("userId");
  const sent = await pushSvc.sendPushToUser(userId, {
    title: "Lumiverse",
    body: "Push notifications are working!",
    tag: "test",
    data: { url: "/" },
  });
  return c.json({ success: sent > 0, sent });
});

export { app as pushRoutes };
