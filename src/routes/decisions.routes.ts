import { Hono } from "hono";
import { evaluate } from "../services/decision-connections.service";

const app = new Hono();

app.post("/evaluate", async (c) => {
  try {
    return c.json(await evaluate(c.get("userId"), await c.req.json()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Decision evaluation failed";
    const status = message === "Decision connection not found" ? 404 : /Gateway returned|Decision gateway returned/.test(message) ? 502 : 400;
    return c.json({ error: message }, status);
  }
});

export const decisionsRoutes = app;
