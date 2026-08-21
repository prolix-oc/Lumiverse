import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { requireOwner } from "../auth/middleware";
import * as adminSvc from "../services/tokenizer-admin.service";
import * as tokenizerSvc from "../services/tokenizer.service";
import * as resolveSvc from "../services/tokenizer-resolve.service";
import * as hfSvc from "../services/huggingface.service";

const app = new Hono();
const publicTokenizerBodyLimit = bodyLimit({
  maxSize: 256 * 1024,
  onError: (c) => c.json({ error: "Request body too large" }, 413),
});

// ---- Tokenizer Configs ----

app.get("/", requireOwner, (c) => {
  return c.json(adminSvc.listConfigs());
});

app.post("/", requireOwner, async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.type) return c.json({ error: "name and type are required" }, 400);
  try {
    const config = adminSvc.createConfig(body);
    return c.json(config, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.put("/:id", requireOwner, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  const result = adminSvc.updateConfig(id, body);
  if (!result) return c.json({ error: "Not found" }, 404);
  return c.json(result);
});

app.delete("/:id", requireOwner, async (c) => {
  const id = c.req.param("id")!;
  try {
    const deleted = adminSvc.deleteConfig(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 403);
  }
});

app.post("/test", requireOwner, async (c) => {
  const body = await c.req.json();
  if (!body.tokenizer_id || !body.text) return c.json({ error: "tokenizer_id and text are required" }, 400);
  try {
    const count = await tokenizerSvc.countWithTokenizer(body.tokenizer_id, body.text);
    const config = tokenizerSvc.getConfig(body.tokenizer_id);
    return c.json({
      tokenizer_id: body.tokenizer_id,
      tokenizer_name: config?.name || "Unknown",
      token_count: count,
      char_count: body.text.length,
      chars_per_token: count > 0 ? +(body.text.length / count).toFixed(2) : 0,
    });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.post("/count", publicTokenizerBodyLimit, async (c) => {
  const body = await c.req.json();
  if (!body.model_id || !body.text) return c.json({ error: "model_id and text are required" }, 400);
  const count = await tokenizerSvc.countForModel(body.model_id, body.text);
  return c.json({
    token_count: count,
    char_count: body.text.length,
  });
});

app.post("/count-batch", publicTokenizerBodyLimit, async (c) => {
  const body = await c.req.json();
  if (!body.model_id || !Array.isArray(body.texts)) {
    return c.json({ error: "model_id and texts are required" }, 400);
  }
  if (body.texts.length > tokenizerSvc.MAX_COUNT_BATCH_TEXTS) {
    return c.json({ error: `Batch exceeds the ${tokenizerSvc.MAX_COUNT_BATCH_TEXTS}-item cap` }, 413);
  }
  if (body.texts.some((text: unknown) => typeof text !== "string")) {
    return c.json({ error: "texts must contain only strings" }, 400);
  }

  const results: Array<{ token_count: number | null; char_count: number }> = [];
  for (let index = 0; index < body.texts.length; index += 1) {
    const text = body.texts[index] as string;
    results.push({
      token_count: await tokenizerSvc.countForModel(body.model_id, text),
      char_count: text.length,
    });
    if ((index + 1) % tokenizerSvc.COUNT_BATCH_YIELD_EVERY === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return c.json({ results });
});

// Resolve a pasted HuggingFace model URL / slug into a verified, installable
// tokenizer suggestion (or a reason it can't be used). Always 200 on a valid
// request so the UI can render the unavailable/unsupported reason cleanly.
app.post("/resolve", requireOwner, async (c) => {
  const body = await c.req.json();
  if (!body.url || typeof body.url !== "string") return c.json({ error: "url is required" }, 400);
  const result = await resolveSvc.resolveTokenizer(body.url);
  return c.json(result);
});

// HuggingFace access token (owner-only, write-only — never echoes the token).
app.get("/hf-token", requireOwner, async (c) => {
  return c.json({ configured: await hfSvc.hasHfToken() });
});

app.put("/hf-token", requireOwner, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = typeof body.token === "string" ? body.token : null;
  try {
    return c.json(await hfSvc.setHfToken(token));
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Install a resolved tokenizer (config + optional model-match rule) atomically.
app.post("/install", requireOwner, async (c) => {
  const body = await c.req.json();
  if (!body.name || !body.type) return c.json({ error: "name and type are required" }, 400);
  try {
    const result = adminSvc.installResolved(body);
    return c.json(result, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// ---- Model Patterns ----

app.get("/patterns", requireOwner, (c) => {
  return c.json(adminSvc.listPatterns());
});

app.post("/patterns", requireOwner, async (c) => {
  const body = await c.req.json();
  if (!body.tokenizer_id || !body.pattern) return c.json({ error: "tokenizer_id and pattern are required" }, 400);
  try {
    const pattern = adminSvc.createPattern(body);
    return c.json(pattern, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.put("/patterns/:id", requireOwner, async (c) => {
  const id = c.req.param("id")!;
  const body = await c.req.json();
  try {
    const result = adminSvc.updatePattern(id, body);
    if (!result) return c.json({ error: "Not found" }, 404);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

app.delete("/patterns/:id", requireOwner, async (c) => {
  const id = c.req.param("id")!;
  try {
    const deleted = adminSvc.deletePattern(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 403);
  }
});

app.post("/patterns/test", publicTokenizerBodyLimit, async (c) => {
  const body = await c.req.json();
  if (!body.model_id) return c.json({ error: "model_id is required" }, 400);
  const tokenizerId = tokenizerSvc.getTokenizerIdForModel(body.model_id);
  if (!tokenizerId) return c.json({ matched: false, tokenizer_id: null, tokenizer_name: null });
  const config = tokenizerSvc.getConfig(tokenizerId);
  return c.json({
    matched: true,
    tokenizer_id: tokenizerId,
    tokenizer_name: config?.name || null,
  });
});

export { app as tokenizersRoutes };
