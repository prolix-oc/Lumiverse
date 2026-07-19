import { Hono } from "hono";
import { requireOwnerStrict } from "../auth/middleware";
import * as svc from "../services/sso-providers.service";
import { InvalidSsoProviderError } from "../services/sso-providers.service";

const app = new Hono();

app.use("/*", requireOwnerStrict);

function handleError(c: any, err: unknown) {
  if (err instanceof InvalidSsoProviderError) return c.json({ error: err.message }, err.status);
  throw err;
}

app.get("/", (c) => c.json(svc.listSsoProviders()));

app.get("/links", (c) => {
  const userId = c.get("userId");
  return c.json({
    current_user_links: svc.listCurrentUserSsoLinks(userId),
    all_links: svc.listSsoUserLinks(),
    recovery: svc.getSsoRecoveryStatus(),
  });
});

app.delete("/links/:providerId", (c) => {
  const userId = c.get("userId");
  const deleted = svc.unlinkCurrentUserSsoProvider(userId, c.req.param("providerId"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true, recovery: svc.getSsoRecoveryStatus() });
});

app.post("/test-discovery", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(await svc.testDiscovery(body));
  } catch (err) {
    return handleError(c, err);
  }
});

app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    return c.json(svc.createSsoProvider(body), 201);
  } catch (err) {
    return handleError(c, err);
  }
});

app.put("/:id", async (c) => {
  try {
    const body = await c.req.json();
    const updated = svc.updateSsoProvider(c.req.param("id"), body);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  } catch (err) {
    return handleError(c, err);
  }
});

app.delete("/:id", (c) => {
  const deleted = svc.deleteSsoProvider(c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as ssoProvidersRoutes };
