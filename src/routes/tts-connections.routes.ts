import { Hono } from "hono";
import * as svc from "../services/tts-connections.service";
import * as qwenSvc from "../services/qwen-tts.service";
import { getTtsProviderList } from "../tts/registry";
import { parsePagination } from "../services/pagination";
import { clampErrorMessage, describeProviderError } from "../utils/provider-errors";
import { withReadableApiKeyStatus, withReadableApiKeyStatuses } from "../services/connection-secret-status";

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
  const userId = c.get("userId");
  const providers = getTtsProviderList(userId).map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
  return c.json({ providers });
});

/** List TTS connections (paginated) */
app.get("/", async (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const result = await withReadableApiKeyStatuses(
    userId,
    svc.listConnections(userId, pagination),
    svc.ttsConnectionSecretKey,
  );
  return c.json(result);
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

app.post("/voices/library", async (c) => {
  const body = await c.req.json();
  if (typeof body?.provider !== "string" || !body.provider) return c.json({ error: "provider is required" }, 400);
  if (body.connection_id !== undefined && (typeof body.connection_id !== "string" || !body.connection_id)) {
    return c.json({ error: "connection_id must be a non-empty string" }, 400);
  }
  for (const field of ["api_key", "api_url"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") return c.json({ error: `${field} must be a string` }, 400);
  }
  if (body.page !== undefined && (!Number.isSafeInteger(body.page) || body.page < 0)) {
    return c.json({ error: "page must be a non-negative integer" }, 400);
  }
  if (body.page_size !== undefined && (!Number.isInteger(body.page_size) || body.page_size < 1 || body.page_size > 100)) {
    return c.json({ error: "page_size must be between 1 and 100" }, 400);
  }
  for (const [field, maxLength] of [["search", 200], ["language", 32]] as const) {
    if (body[field] !== undefined && (typeof body[field] !== "string" || body[field].length > maxLength)) {
      return c.json({ error: `${field} must be a string of at most ${maxLength} characters` }, 400);
    }
  }
  if (body.gender !== undefined && !["male", "female", "neutral"].includes(body.gender)) {
    return c.json({ error: "Invalid gender filter" }, 400);
  }
  if (body.sort !== undefined && !["trending", "created_date", "cloned_by_count", "usage_character_count_1y"].includes(body.sort)) {
    return c.json({ error: "Invalid voice library sort" }, 400);
  }
  return c.json(await svc.listConnectionVoiceLibrary(c.get("userId"), body));
});

app.post("/models/preview", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body?.provider) return c.json({ error: "provider is required" }, 400);
  const result = await svc.listConnectionModelsPreview(userId, body);
  return c.json(result);
});

/** Get TTS connection by ID */
app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const conn = svc.getConnection(userId, c.req.param("id"));
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.ttsConnectionSecretKey));
});

/** Update TTS connection */
app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const conn = await svc.updateConnection(userId, c.req.param("id"), body);
  if (!conn) return c.json({ error: "Not found" }, 404);
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.ttsConnectionSecretKey));
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
  return c.json(await withReadableApiKeyStatus(userId, conn, svc.ttsConnectionSecretKey), 201);
});

export { app as ttsConnectionsRoutes };
