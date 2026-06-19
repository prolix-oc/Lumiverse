import { Hono } from "hono";
import * as svc from "../services/image-gen.service";
import * as bindingsSvc from "../services/image-gen-preset-bindings.service";
import { clampErrorMessage, describeProviderError } from "../utils/provider-errors";

const app = new Hono();

app.get("/providers", (c) => {
  return c.json(svc.getImageProviders());
});

app.post("/generate", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.chatId) return c.json({ error: "chatId is required" }, 400);

  try {
    const result = await svc.generateSceneBackground(userId, body.chatId, {
      forceGeneration: !!body.forceGeneration,
      promptMode: body.promptMode,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt,
      promptPresetId: body.promptPresetId,
      outputTarget: body.outputTarget,
      attachToMessageId: body.attachToMessageId,
      skipParse: !!body.skipParse,
      clientJobId: body.clientJobId,
      promptGenerationTimeoutSeconds: body.promptGenerationTimeoutSeconds,
      generationTimeoutSeconds: body.generationTimeoutSeconds,
    });
    return c.json(result);
  } catch (err: any) {
    const msg = clampErrorMessage(describeProviderError(err, "Image generation failed"));
    const status = /required|not found|unsupported|parse|No API key|missing|connection/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
  }
});

app.post("/preview-prompt", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.chatId) return c.json({ error: "chatId is required" }, 400);

  try {
    const result = await svc.previewImagePrompt(userId, body.chatId, {
      promptMode: body.promptMode,
      prompt: body.prompt,
      negativePrompt: body.negativePrompt,
      promptPresetId: body.promptPresetId,
      promptGenerationTimeoutSeconds: body.promptGenerationTimeoutSeconds,
    });
    return c.json(result);
  } catch (err: any) {
    const msg = clampErrorMessage(describeProviderError(err, "Prompt preview failed"));
    const status = /required|not found|unsupported|parse|No API key|missing|connection/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
  }
});

app.post("/caption", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.image || !body?.mimeType) return c.json({ error: "image and mimeType are required" }, 400);

  try {
    const result = await svc.captionImage(userId, {
      image: body.image,
      mimeType: body.mimeType,
      prompt: body.prompt,
      presetId: body.presetId,
      parserConnectionId: body.parserConnectionId,
      parserModel: body.parserModel,
      parserParameters: body.parserParameters,
      timeoutSeconds: body.timeoutSeconds,
    });
    return c.json(result);
  } catch (err: any) {
    const msg = clampErrorMessage(describeProviderError(err, "Image captioning failed"));
    const status = /required|not found|unsupported|parse|No API key|missing|connection/i.test(msg) ? 400 : 502;
    return c.json({ error: msg }, status);
  }
});

// ─── Config import/export ──────────────────────────────────────────────

app.post("/export", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  return c.json(
    svc.exportImageGenConfig(userId, {
      includeSettings: body?.include_settings !== false,
      includePresets: body?.include_presets !== false,
      includeConnections: body?.include_connections !== false,
      includeParameters: body?.include_parameters !== false,
      presetIds: Array.isArray(body?.preset_ids) ? body.preset_ids.map(String) : undefined,
      connectionIds: Array.isArray(body?.connection_ids) ? body.connection_ids.map(String) : undefined,
    }),
  );
});

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  try {
    return c.json(await svc.importImageGenConfig(userId, body), 201);
  } catch (err: any) {
    return c.json({ error: err?.message || "Import failed" }, 400);
  }
});

// ─── Character preset bindings ─────────────────────────────────────────

app.get("/preset-bindings/character/:characterId", (c) => {
  const userId = c.get("userId");
  const binding = bindingsSvc.getCharacterBinding(userId, c.req.param("characterId"));
  if (!binding) return c.json({ error: "No binding for this character" }, 404);
  return c.json(binding);
});

app.put("/preset-bindings/character/:characterId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.preset_id) return c.json({ error: "preset_id is required" }, 400);
  try {
    const binding = bindingsSvc.setCharacterBinding(userId, c.req.param("characterId"), body.preset_id);
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Character not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/preset-bindings/character/:characterId", (c) => {
  const userId = c.get("userId");
  if (!bindingsSvc.deleteCharacterBinding(userId, c.req.param("characterId"))) {
    return c.json({ error: "No binding for this character" }, 404);
  }
  return c.json({ success: true });
});

// ─── Persona preset bindings ───────────────────────────────────────────

app.get("/preset-bindings/persona/:personaId", (c) => {
  const userId = c.get("userId");
  const binding = bindingsSvc.getPersonaBinding(userId, c.req.param("personaId"));
  if (!binding) return c.json({ error: "No binding for this persona" }, 404);
  return c.json(binding);
});

app.put("/preset-bindings/persona/:personaId", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.preset_id) return c.json({ error: "preset_id is required" }, 400);
  try {
    const binding = bindingsSvc.setPersonaBinding(userId, c.req.param("personaId"), body.preset_id);
    return c.json(binding);
  } catch (e: any) {
    if (e.message === "Persona not found") return c.json({ error: e.message }, 404);
    throw e;
  }
});

app.delete("/preset-bindings/persona/:personaId", (c) => {
  const userId = c.get("userId");
  if (!bindingsSvc.deletePersonaBinding(userId, c.req.param("personaId"))) {
    return c.json({ error: "No binding for this persona" }, 404);
  }
  return c.json({ success: true });
});

export { app as imageGenRoutes };
