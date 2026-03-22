import { Hono } from "hono";
import * as svc from "../services/packs.service";
import { parsePagination } from "../services/pagination";
import { safeFetch, SSRFError } from "../utils/safe-fetch";

const app = new Hono();

// --- Static routes FIRST (before /:id to avoid shadowing) ---

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listPacks(userId, pagination));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  return c.json(svc.createPack(userId, body), 201);
});

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const pack = svc.importPack(userId, body);
    return c.json(pack, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

app.post("/import-url", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.url) return c.json({ error: "url is required" }, 400);

  let payload: any;
  try {
    const res = await safeFetch(body.url, { maxBytes: 5 * 1024 * 1024 });
    if (!res.ok) return c.json({ error: `Failed to fetch URL: ${res.status}` }, 400);
    payload = await res.json();
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: "Failed to fetch or parse URL" }, 400);
  }

  try {
    const pack = svc.importPack(userId, payload);
    return c.json(pack, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

app.get("/lucid-cards", async (c) => {
  try {
    const res = await fetch("https://lucid.cards/api/lumia-dlc");
    if (!res.ok) return c.json({ error: "Failed to fetch catalog" }, 502);
    const data = await res.json();
    return c.json(data);
  } catch {
    return c.json({ error: "Failed to reach lucid.cards" }, 502);
  }
});

app.post("/lucid-cards/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.slug) return c.json({ error: "slug is required" }, 400);

  let rawData: any;
  try {
    const res = await fetch(`https://lucid.cards/api/lumia-dlc/${body.slug}`);
    if (!res.ok) return c.json({ error: `Pack not found: ${res.status}` }, 404);
    rawData = await res.json();
  } catch {
    return c.json({ error: "Failed to fetch pack from lucid.cards" }, 502);
  }

  if (rawData.success === false) {
    return c.json({ error: rawData.error || "Pack not found" }, 404);
  }

  const packData = rawData.pack || rawData;

  // Transform from Lucid.cards camelCase format to PackImportPayload
  const payload = {
    name: packData.packName || body.slug,
    author: packData.packAuthor || "",
    coverUrl: packData.coverUrl || undefined,
    version: String(packData.version || 1),
    sourceUrl: `https://lucid.cards/api/lumia-dlc/${body.slug}`,
    extras: packData.packExtras?.length ? { items: packData.packExtras } : {},
    lumiaItems: (packData.lumiaItems || []).map((item: any) => ({
      name: item.lumiaName || item.name || "Unknown",
      avatarUrl: item.avatarUrl || undefined,
      authorName: item.authorName || "",
      definition: item.lumiaDefinition || item.definition || "",
      personality: item.lumiaPersonality || item.personality || "",
      behavior: item.lumiaBehavior || item.behavior || "",
      genderIdentity: item.genderIdentity ?? 0,
      version: String(item.version || 1),
    })),
    loomItems: (packData.loomItems || []).map((item: any) => {
      const cat = (item.loomCategory || item.category || "").toLowerCase();
      const category = cat.includes("utility") || cat.includes("utilities") ? "loom_utility"
        : cat.includes("retrofit") ? "retrofit"
        : "narrative_style";
      return {
        name: item.loomName || item.name || "Unknown",
        content: item.loomContent || item.content || "",
        category,
        authorName: item.authorName || "",
        version: String(item.version || 1),
      };
    }),
    loomTools: (packData.loomTools || []).map((tool: any) => ({
      toolName: tool.toolName || tool.tool_name || "unknown_tool",
      displayName: tool.displayName || tool.display_name || "",
      description: tool.description || "",
      prompt: tool.prompt || "",
      inputSchema: tool.inputSchema || tool.input_schema || {},
      resultVariable: tool.resultVariable || tool.result_variable || "",
      storeInDeliberation: tool.storeInDeliberation ?? tool.store_in_deliberation ?? false,
      authorName: tool.authorName || "",
      version: String(tool.version || 1),
    })),
  };

  try {
    const pack = svc.importPack(userId, payload);
    return c.json(pack, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Import failed" }, 400);
  }
});

// --- Dynamic routes ---

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const pack = svc.getPackWithItems(userId, c.req.param("id"));
  if (!pack) return c.json({ error: "Not found" }, 404);
  return c.json(pack);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const pack = svc.updatePack(userId, c.req.param("id"), body);
  if (!pack) return c.json({ error: "Not found" }, 404);
  return c.json(pack);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  if (!svc.deletePack(userId, c.req.param("id"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/export", (c) => {
  const userId = c.get("userId");
  const payload = svc.exportPack(userId, c.req.param("id"));
  if (!payload) return c.json({ error: "Not found" }, 404);
  return c.json(payload);
});

// --- Lumia Item endpoints ---

app.post("/:id/lumia-items", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const item = svc.createLumiaItem(userId, c.req.param("id"), body);
  if (!item) return c.json({ error: "Pack not found" }, 404);
  return c.json(item, 201);
});

app.put("/:id/lumia-items/:itemId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const item = svc.updateLumiaItem(userId, c.req.param("itemId"), body);
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

app.delete("/:id/lumia-items/:itemId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteLumiaItem(userId, c.req.param("itemId"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// --- Loom Item endpoints ---

app.post("/:id/loom-items", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const item = svc.createLoomItem(userId, c.req.param("id"), body);
  if (!item) return c.json({ error: "Pack not found" }, 404);
  return c.json(item, 201);
});

app.put("/:id/loom-items/:itemId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const item = svc.updateLoomItem(userId, c.req.param("itemId"), body);
  if (!item) return c.json({ error: "Not found" }, 404);
  return c.json(item);
});

app.delete("/:id/loom-items/:itemId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteLoomItem(userId, c.req.param("itemId"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

// --- Loom Tool endpoints ---

app.post("/:id/loom-tools", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.tool_name) return c.json({ error: "tool_name is required" }, 400);
  const tool = svc.createLoomTool(userId, c.req.param("id"), body);
  if (!tool) return c.json({ error: "Pack not found" }, 404);
  return c.json(tool, 201);
});

app.put("/:id/loom-tools/:toolId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const tool = svc.updateLoomTool(userId, c.req.param("toolId"), body);
  if (!tool) return c.json({ error: "Not found" }, 404);
  return c.json(tool);
});

app.delete("/:id/loom-tools/:toolId", (c) => {
  const userId = c.get("userId");
  if (!svc.deleteLoomTool(userId, c.req.param("toolId"))) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

export { app as packsRoutes };
