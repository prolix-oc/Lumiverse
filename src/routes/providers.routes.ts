import { Hono } from "hono";
import { getProviderList } from "../llm/registry";

const app = new Hono();

app.get("/", (c) => {
  const providers = getProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    default_url: p.defaultUrl,
    capabilities: p.capabilities,
  }));
  return c.json({ providers });
});

export { app as providersRoutes };
