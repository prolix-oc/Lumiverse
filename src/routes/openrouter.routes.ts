import { Hono } from "hono";
import * as svc from "../services/openrouter.service";
import * as connSvc from "../services/connections.service";

const app = new Hono();

// ── PKCE OAuth Flow ──────────────────────────────────────────────────────────

/**
 * Initiate the PKCE OAuth flow. Returns the authorization URL and a session
 * token used to correlate the callback. The code_verifier is stored server-side
 * and never exposed to the client.
 *
 * Query: ?callback_url=<url>&connection_id=<id> (existing profile)
 *    OR: ?callback_url=<url>&connection_name=<name> (auto-create on success)
 */
app.get("/auth", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.query("connection_id");
  const connectionName = c.req.query("connection_name");
  const callbackUrl = c.req.query("callback_url");

  if (!connectionId && !connectionName) return c.json({ error: "connection_id or connection_name is required" }, 400);
  if (!callbackUrl) return c.json({ error: "callback_url is required" }, 400);

  // H-07: Validate callback_url is a legitimate http(s) URL so the OAuth
  // callback cannot be redirected to a javascript: or data: URI (XSS), or to
  // an internal address (SSRF).
  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    return c.json({ error: "callback_url is not a valid URL" }, 400);
  }
  if (parsedCallback.protocol !== "https:" && parsedCallback.protocol !== "http:") {
    return c.json({ error: "callback_url must use http or https" }, 400);
  }

  if (connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn) return c.json({ error: "Connection not found" }, 404);
    if (conn.provider !== "openrouter") return c.json({ error: "Connection is not an OpenRouter profile" }, 400);
  }

  const result = await svc.initiateOAuthAsync(callbackUrl, { connectionId, connectionName });
  return c.json(result);
});

/**
 * Complete the PKCE OAuth flow. Exchange the authorization code for an API key,
 * then store it as the connection's API key.
 *
 * Body: { session_token, code }
 */
app.post("/auth/callback", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const { session_token, code } = body;

  if (!session_token || !code) return c.json({ error: "session_token and code are required" }, 400);

  try {
    const result = await svc.completeOAuth(userId, session_token, code);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message || "OAuth exchange failed" }, 400);
  }
});

// ── Credits & Usage ──────────────────────────────────────────────────────────

/**
 * Get the user's OpenRouter credit balance and usage stats.
 */
app.get("/credits/:connectionId", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");
  const result = await svc.fetchCredits(userId, connectionId);
  if (!result) return c.json({ error: "Failed to fetch credits" }, 502);
  return c.json(result);
});

// ── Model Metadata ───────────────────────────────────────────────────────────

/**
 * Get rich model metadata from OpenRouter (context length, pricing, capabilities).
 * Cached server-side for 5 minutes.
 */
app.get("/models/:connectionId", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");
  const search = c.req.query("search");
  const supportedParam = c.req.query("supported_parameter");

  const result = await svc.fetchModelsWithMetadata(userId, connectionId);
  if (!result) return c.json({ error: "Failed to fetch models" }, 502);

  let models = result;

  // Filter by search term
  if (search) {
    const q = search.toLowerCase();
    models = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
  }

  // Filter by supported parameter (e.g. "tools")
  if (supportedParam) {
    models = models.filter((m) => m.supported_parameters?.includes(supportedParam));
  }

  return c.json({ models, total: models.length });
});

// ── Generation Stats ─────────────────────────────────────────────────────────

/**
 * Get generation stats from OpenRouter for a specific generation ID.
 */
app.get("/generation/:connectionId/:generationId", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");
  const generationId = c.req.param("generationId");
  const result = await svc.fetchGenerationStats(userId, connectionId, generationId);
  if (!result) return c.json({ error: "Failed to fetch generation stats" }, 502);
  return c.json(result);
});

// ── Upstream Providers ────────────────────────────────────────────────────────

/**
 * Get the list of upstream providers available on OpenRouter.
 * Used for the prefer/ignore provider selection dropdowns.
 */
app.get("/providers/:connectionId", async (c) => {
  const userId = c.get("userId");
  const connectionId = c.req.param("connectionId");
  const result = await svc.fetchProviderList(userId, connectionId);
  if (!result) return c.json({ error: "Failed to fetch providers" }, 502);
  return c.json({ providers: result });
});

export { app as openrouterRoutes };
