import { Hono } from "hono";
import { buildBootstrapPayload, buildLandingBootstrapPayload } from "../services/bootstrap.service";

const app = new Hono();

/**
 * GET /api/v1/bootstrap/landing
 *
 * Minimal first-paint payload for the landing page. This intentionally avoids
 * the full startup fan-out so theme, wallpaper, layout, and recent chats can
 * render without waiting on unrelated panels or extension metadata.
 */
app.get("/landing", (c) => {
  const userId = c.get("userId");
  const result = buildLandingBootstrapPayload(userId);
  return c.json(result);
});

/**
 * GET /api/v1/bootstrap
 *
 * Single-shot aggregator for the data `useAppInit` normally fetches as a
 * parallel fan-out right after sign-in:
 *   - LLM / TTS / image-gen connections + their provider lists
 *   - packs, personas, regex scripts
 *   - council settings + resolved tool list
 *   - spindle extension list + tool registrations
 *
 * Returns a single JSON payload plus an `errors` map surfacing per-section
 * failures so the frontend can selectively refetch what didn't arrive.
 *
 * This saves ~6-10 HTTP round trips at app cold start. Every underlying
 * service call either reads from a cached prepared statement, an in-memory
 * provider registry, or the already-warm spindle manager, so the server
 * cost is effectively one request's worth of work.
 */
app.get("/", async (c) => {
  const userId = c.get("userId");
  const session = c.get("session");
  const role = session?.user?.role || "user";

  const result = await buildBootstrapPayload(userId, role);
  if (c.req.raw.signal.aborted) return new Response(null, { status: 204 });
  return c.json(result);
});

export { app as bootstrapRoutes };
