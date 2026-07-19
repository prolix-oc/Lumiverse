import { Hono } from "hono";
import * as svc from "../services/tts-connections.service";
import * as qwenSvc from "../services/qwen-tts.service";
import { getTtsProviderList } from "../tts/registry";
import { parsePagination } from "../services/pagination";
import { clampErrorMessage, describeProviderError } from "../utils/provider-errors";

// Side-effect import: registers all TTS providers in the registry
import "../tts/index";

const app = new Hono();

function qwenVoiceMutationStatus(
  message: string,
  fallback: 502 = 502,
): 400 | 404 | 409 | 413 | 502 {
  const normalized = message.toLowerCase();
  if (normalized.includes("not found")) return 404;
  if (normalized.includes("does not use qwen")) return 400;
  if (normalized.includes("no api key")) return 400;
  if (normalized.includes("required")) return 400;
  if (normalized.includes("already exists")) return 409;
  if (normalized.includes("exceeds the 15 mb limit")) return 413;
  if (normalized.includes("does not currently have the base voice-cloning model loaded")) return 409;
  return fallback;
}

/** List all TTS providers with capabilities */
app.get("/providers", (c) => {
  const providers = getTtsProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
  return c.json({ providers });
});

/** List TTS connections (paginated) */
app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  return c.json(svc.listConnections(userId, pagination));
});

/** Create TTS connection */
app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name || !body.provider) {
    return c.json({ error: "name and provider are required" }, 400);
  }
  const conn = await svc.createConnection(userId, body);
  return c.json(conn, 201);
});

app.post("/voices/preview", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.provider) return c.json({ error: "provider is required" }, 400);
  const result = await svc.listConnectionVoicesPreview(userId, body);
  return c.json(result);
});

app.post("/models/preview", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.provider) return c.json({ error: "provider is required" }, 400);
  const result = await svc.listConnectionModelsPreview(userId, body);
  return c.json(result);
});

/** Get TTS connection by ID */
app.get("/:id", (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

/** Update TTS connection */
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.updateConnection(userId, c.req.param("id"), body);
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn);
});

/** Delete TTS connection */
app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  if (!(await svc.deleteConnection(userId, c.req.param("id")))) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ success: true });
});

/** Test TTS connection */
app.post("/:id/test", async (c) => {
  const userId = c.get("userId");
  const result = await svc.testConnection(userId, c.req.param("id"));
  return c.json(result);
});

/** List available models for connection */
app.get("/:id/models", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionModels(userId, c.req.param("id"));
  return c.json(result);
});

/** List available voices for connection */
app.get("/:id/voices", async (c) => {
  const userId = c.get("userId");
  const result = await svc.listConnectionVoices(userId, c.req.param("id"));
  return c.json(result);
});

app.post("/:id/qwen/custom-voices", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const name = formData.get("name");
  const transcript = formData.get("transcript");
  const xVectorOnlyMode = formData.get("x_vector_only_mode");
  const audio = formData.get("audio");

  if (typeof name !== "string" || !name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (!(audio instanceof Blob)) {
    return c.json({ error: "audio is required" }, 400);
  }

  try {
    const result = await qwenSvc.createQwenCustomVoice(userId, c.req.param("id"), {
      name,
      transcript: typeof transcript === "string" ? transcript : undefined,
      sourceFilename: typeof (audio as any)?.name === "string" ? (audio as any).name : undefined,
      audioData: new Uint8Array(await audio.arrayBuffer()),
      xVectorOnlyMode:
        typeof xVectorOnlyMode === "string"
          ? xVectorOnlyMode === "1" || xVectorOnlyMode.toLowerCase() === "true"
          : false,
    });
    return c.json(result, 201);
  } catch (err: any) {
    const msg = clampErrorMessage(describeProviderError(err, "Failed to create Qwen custom voice"));
    const status = qwenVoiceMutationStatus(msg);
    return c.json({ error: msg }, status);
  }
});

app.delete("/:id/qwen/custom-voices/:voiceId", async (c) => {
  const userId = c.get("userId");
  try {
    const result = await qwenSvc.deleteQwenCustomVoice(
      userId,
      c.req.param("id"),
      decodeURIComponent(c.req.param("voiceId")),
    );
    if (!result.success) {
      return c.json({ error: "Custom voice not found" }, 404);
    }
    return c.json(result);
  } catch (err: any) {
    const msg = clampErrorMessage(describeProviderError(err, "Failed to delete Qwen custom voice"));
    const status = qwenVoiceMutationStatus(msg);
    return c.json({ error: msg }, status);
  }
});

/** Set or update API key */
app.put("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.api_key) return c.json({ error: "api_key is required" }, 400);
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.setConnectionApiKey(userId, c.req.param("id"), body.api_key);
  return c.json({ success: true });
});

/** Remove API key */
app.delete("/:id/api-key", async (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  await svc.clearConnectionApiKey(userId, c.req.param("id"));
  return c.json({ success: true });
});

/** Duplicate TTS connection */
app.post("/:id/duplicate", async (c) => {
  const userId = c.get("userId");
  const conn = await svc.duplicateConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(conn, 201);
});

export { app as ttsConnectionsRoutes };
