import type { LlmProvider } from "../provider";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import { getTextContent, type GenerationRequest, type GenerationResponse, type StreamChunk, type ToolCallResult, type LlmMessage, type LlmMessagePart } from "../types";

// ── Service account JWT → OAuth2 access token ──────────────────────────────

export interface ServiceAccountCredentials {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri: string;
}

interface CachedToken {
  accessToken: string;
  /** Epoch seconds when the token expires */
  expiresAt: number;
}

const TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_REFRESH_MARGIN = 300; // refresh 5 min before expiry

/** Per-connection token cache keyed by client_email. */
const tokenCache = new Map<string, CachedToken>();

function base64urlEncode(input: string | ArrayBuffer): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : new Uint8Array(input);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPKCS8Key(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const binaryDer = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    binaryDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function createSignedJwt(sa: ServiceAccountCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid: sa.private_key_id };
  const payload = {
    iss: sa.client_email,
    scope: TOKEN_SCOPE,
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPKCS8Key(sa.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64urlEncode(signature)}`;
}

export async function getAccessToken(sa: ServiceAccountCredentials): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = tokenCache.get(sa.client_email);
  if (cached && now < cached.expiresAt - TOKEN_REFRESH_MARGIN) {
    return cached.accessToken;
  }

  const jwt = await createSignedJwt(sa);
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${jwt}`,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vertex AI token exchange failed (${res.status}): ${err}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  const token: CachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in,
  };
  tokenCache.set(sa.client_email, token);
  return token.accessToken;
}

/** Parse the service account JSON stored as the "API key" secret. */
export function parseServiceAccount(apiKey: string): ServiceAccountCredentials {
  try {
    const sa = JSON.parse(apiKey);
    if (!sa.private_key || !sa.client_email || !sa.project_id) {
      throw new Error("Missing required fields (private_key, client_email, project_id)");
    }
    return sa as ServiceAccountCredentials;
  } catch (e: any) {
    throw new Error(`Invalid service account JSON: ${e.message}`);
  }
}

/**
 * Resolve the API hostname for a given Vertex AI location.
 *
 * Per Google's @google/genai SDK (`_api_client.ts`):
 *   - `global`  → `https://aiplatform.googleapis.com/` (un-prefixed)
 *   - regional  → `https://{location}-aiplatform.googleapis.com/`
 *
 * There is no `global-aiplatform.googleapis.com` host — that was an
 * incorrect guess. All Vertex operations (generate, stream, list publishers)
 * use the same host pattern.
 */
export function vertexHostForLocation(location: string): string {
  if (!location || location === "global") return "https://aiplatform.googleapis.com";
  return `https://${location}-aiplatform.googleapis.com`;
}

/**
 * List Vertex AI locations available to the service account's project.
 * Uses the global endpoint since the caller doesn't have a region yet.
 */
export async function listVertexLocations(apiKey: string): Promise<string[]> {
  const sa = parseServiceAccount(apiKey);
  const accessToken = await getAccessToken(sa);
  const allLocations: string[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams();
    if (pageToken) params.set("pageToken", pageToken);
    const url = `https://aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations${params.toString() ? `?${params}` : ""}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to list Vertex AI locations (${res.status}): ${err}`);
    }
    const data = (await res.json()) as any;
    const locations: any[] = data.locations || [];
    for (const loc of locations) {
      const id: string = loc.locationId || loc.name?.split("/").pop() || "";
      if (id) allLocations.push(id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return allLocations.sort();
}

// ── Provider implementation ────────────────────────────────────────────────

export class GoogleVertexProvider implements LlmProvider {
  readonly name = "google_vertex";
  readonly displayName = "Google Vertex AI";
  readonly defaultUrl = "https://aiplatform.googleapis.com";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true, // We use the "API key" slot to store the service account JSON
    modelListStyle: "none", // Vertex model list requires project/location — handled in listModels()
  };

  /** Build the Vertex AI base URL for model operations (generate, stream, etc.). */
  private endpointBase(projectId: string, location: string): string {
    const host = vertexHostForLocation(location);
    return `${host}/v1/projects/${projectId}/locations/${location}/publishers/google/models`;
  }

  /** Strip resource-name prefixes so only the bare model ID hits the URL path. */
  private sanitizeModelId(model: string): string {
    return model
      .replace(/^publishers\/google\/models\//, "")
      .replace(/^projects\/[^/]+\/locations\/[^/]+\/publishers\/google\/models\//, "")
      .replace(/^models\//, "");
  }

  /** Extract project_id and location from the resolved API URL. */
  private resolveProjectConfig(apiKey: string, apiUrl: string): { sa: ServiceAccountCredentials; projectId: string; location: string } {
    const sa = parseServiceAccount(apiKey);
    // Location is encoded in the URL by resolveEffectiveApiUrl (from metadata.vertex_region).
    // Regional: https://{location}-aiplatform.googleapis.com  →  extract location
    // Global:   https://aiplatform.googleapis.com             →  "global" (default)
    let location = "global";
    const parsedUrl = apiUrl || this.defaultUrl;
    const regionalMatch = parsedUrl.match(/^https?:\/\/([a-z0-9-]+)-aiplatform\.googleapis\.com/);
    if (regionalMatch) {
      location = regionalMatch[1];
    }

    return { sa, projectId: sa.project_id, location };
  }

  async generate(apiKey: string, apiUrl: string, request: GenerationRequest): Promise<GenerationResponse> {
    const { sa, projectId, location } = this.resolveProjectConfig(apiKey, apiUrl);
    const accessToken = await getAccessToken(sa);
    const base = this.endpointBase(projectId, location);
    const model = this.sanitizeModelId(request.model);
    const url = `${base}/${model}:generateContent`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Vertex AI error ${res.status}: ${err}`);
    }

    const data = (await res.json()) as any;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    let content = "";
    let reasoning = "";
    const fnCalls: ToolCallResult[] = [];
    for (const p of parts) {
      if (p.thought) {
        reasoning += p.text || "";
      } else if (p.functionCall) {
        fnCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, call_id: crypto.randomUUID() });
      } else {
        content += p.text || "";
      }
    }

    const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;

    return {
      content,
      reasoning: reasoning || undefined,
      finish_reason: toolCalls ? "tool_calls" : (candidate?.finishReason || "STOP"),
      tool_calls: toolCalls,
      usage: data.usageMetadata
        ? {
            prompt_tokens: data.usageMetadata.promptTokenCount || 0,
            completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
            total_tokens: data.usageMetadata.totalTokenCount || 0,
          }
        : undefined,
    };
  }

  async *generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest,
  ): AsyncGenerator<StreamChunk, void, unknown> {
    const { sa, projectId, location } = this.resolveProjectConfig(apiKey, apiUrl);
    const accessToken = await getAccessToken(sa);
    const base = this.endpointBase(projectId, location);
    const model = this.sanitizeModelId(request.model);
    const url = `${base}/${model}:streamGenerateContent?alt=sse`;
    const body = this.buildBody(request);

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Vertex AI error ${res.status}: ${err}`);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;

          try {
            const data = JSON.parse(trimmed.slice(6));
            const candidate = data.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            const finishReason = candidate?.finishReason;

            let text = "";
            let reasoning = "";
            const fnCalls: ToolCallResult[] = [];
            for (const p of parts) {
              if (p.thought) {
                reasoning += p.text || "";
              } else if (p.functionCall) {
                fnCalls.push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, call_id: crypto.randomUUID() });
              } else {
                text += p.text || "";
              }
            }

            const usage = data.usageMetadata
              ? {
                  prompt_tokens: data.usageMetadata.promptTokenCount || 0,
                  completion_tokens: data.usageMetadata.candidatesTokenCount || 0,
                  total_tokens: data.usageMetadata.totalTokenCount || 0,
                }
              : undefined;

            const toolCalls = fnCalls.length > 0 ? fnCalls : undefined;

            if (text || reasoning || toolCalls) {
              yield {
                token: text,
                reasoning: reasoning || undefined,
                finish_reason: toolCalls ? "tool_calls" : (finishReason === "STOP" ? "stop" : undefined),
                tool_calls: toolCalls,
                usage,
              };
            } else if (finishReason || usage) {
              yield { token: "", finish_reason: finishReason === "STOP" ? "stop" : (finishReason || undefined), usage };
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const { sa, location } = this.resolveProjectConfig(apiKey, apiUrl);
      const accessToken = await getAccessToken(sa);
      const host = vertexHostForLocation(location);
      // See listModels() for URL rationale. The publisher-list endpoint is
      // un-prefixed (no project/location in the path) and lives at v1beta1.
      const url = `${host}/v1beta1/publishers/google/models?pageSize=1`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        const err = await res.text();
        console.error(`[Vertex AI] validateKey failed (${res.status}): ${err}`);
      }
      return res.ok;
    } catch (e) {
      console.error("[Vertex AI] validateKey error:", e);
      return false;
    }
  }

  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    try {
      const { sa, location } = this.resolveProjectConfig(apiKey, apiUrl);
      const accessToken = await getAccessToken(sa);
      const host = vertexHostForLocation(location);
      const allModels: string[] = [];
      let pageToken: string | undefined;

      do {
        const params = new URLSearchParams();
        if (pageToken) params.set("pageToken", pageToken);
        // List base (publisher) models. Per Google's @google/genai SDK
        // (`_api_client.ts` → `shouldPrependVertexProjectPath`):
        //   "For base models Vertex does not accept a project/location
        //    prefix (for tuned models the prefix is required)."
        // So the URL is un-prefixed and sits at v1beta1 (the SDK's default
        // version for Vertex; the v1 surface does not expose this list).
        //   →  {host}/v1beta1/publishers/google/models
        const url = `${host}/v1beta1/publishers/google/models${params.toString() ? `?${params}` : ""}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) {
          const err = await res.text();
          console.error(`[Vertex AI] listModels failed (${res.status}): ${err}`);
          break;
        }
        const data = (await res.json()) as any;
        // Response may use `publisherModels`, `models`, or `tunedModels`
        // depending on the surface — mirrors tExtractModels() in the SDK.
        const models: any[] = data.publisherModels || data.models || data.tunedModels || [];
        for (const m of models) {
          // Names are "publishers/google/models/{id}".
          const name: string = m.name || "";
          const shortName = name.replace(/^publishers\/google\/models\//, "");
          const id = shortName || name;
          if (id) allModels.push(id);
        }
        pageToken = data.nextPageToken;
      } while (pageToken);

      return allModels.sort();
    } catch (e) {
      console.error("[Vertex AI] listModels error:", e);
      return [];
    }
  }

  // ── Body building (mirrors GoogleProvider.buildBody) ──────────────────

  private formatParts(m: LlmMessage): any[] {
    if (typeof m.content === "string") return [{ text: m.content }];
    return m.content.map((part: LlmMessagePart) => {
      switch (part.type) {
        case "text":
          return { text: part.text };
        case "image":
        case "audio":
          return { inlineData: { mimeType: part.mime_type, data: part.data } };
        default:
          return { text: "" };
      }
    });
  }

  private static readonly INTERNAL_PARAMS = new Set(["max_context_length", "_include_usage", "_streaming"]);

  private static readonly HANDLED_PARAMS = new Set([
    "temperature", "max_tokens", "top_p", "top_k", "stop", "thinkingConfig",
    "responseMimeType", "responseSchema", "responseJsonSchema",
  ]);

  private buildBody(request: GenerationRequest): any {
    const params = request.parameters || {};

    const systemMessages = request.messages.filter((m) => m.role === "system");
    const otherMessages = request.messages.filter((m) => m.role !== "system");

    const body: any = {
      contents: otherMessages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: this.formatParts(m),
      })),
    };

    if (systemMessages.length > 0) {
      body.systemInstruction = {
        parts: [{ text: systemMessages.map((m) => getTextContent(m)).join("\n\n") }],
      };
    }

    const generationConfig: any = {};
    if (params.temperature !== undefined) generationConfig.temperature = params.temperature;
    if (params.max_tokens !== undefined) generationConfig.maxOutputTokens = params.max_tokens;
    if (params.top_p !== undefined) generationConfig.topP = params.top_p;
    if (params.top_k !== undefined) generationConfig.topK = params.top_k;
    if (params.stop) generationConfig.stopSequences = params.stop;

    if (params.thinkingConfig) {
      generationConfig.thinkingConfig = params.thinkingConfig;
    }

    if (params.responseMimeType !== undefined) {
      generationConfig.responseMimeType = params.responseMimeType;
    }
    const responseSchema = params.responseSchema ?? params.responseJsonSchema;
    if (responseSchema !== undefined) {
      generationConfig.responseSchema = responseSchema;
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    // Passthrough extra params
    for (const key of Object.keys(params)) {
      if (body[key] !== undefined) continue;
      if (GoogleVertexProvider.HANDLED_PARAMS.has(key)) continue;
      if (GoogleVertexProvider.INTERNAL_PARAMS.has(key)) continue;
      body[key] = params[key];
    }

    // Default safety settings: disable all content filters unless the user
    // has already provided their own safetySettings via passthrough.
    // Vertex AI uses "OFF" (not "BLOCK_NONE" which is the AI Studio value).
    if (!body.safetySettings) {
      body.safetySettings = [
        { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
      ];
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = [{
        functionDeclarations: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      }];
    }

    return body;
  }
}
