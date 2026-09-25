import { safeFetch } from "../utils/safe-fetch";
import { registerDecisionProvider, type DecisionConnectionTarget, type DecisionModelList, type DecisionModelTarget, type DecisionProvider } from "./registry";
import type { DecisionAnswer, DecisionRequest, DecisionResult } from "./types";

export const JEV_PROTOCOLS = ["typesafe", "openrouter", "nanogpt", "vercel", "cloudflare", "venice", "mindshub", "aimlapi", "aicu", "anoman"] as const;
export type JevProtocol = typeof JEV_PROTOCOLS[number];

export const JEV_PRESETS: ReadonlyArray<{ id: JevProtocol; name: string; url: string; model: string }> = [
  { id: "typesafe", name: "TypeSafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
  { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" },
  { id: "nanogpt", name: "NanoGPT", url: "https://nano-gpt.com/api/v1/decisions", model: "typesafe/jev-1.13" },
  { id: "vercel", name: "Vercel AI Gateway", url: "https://ai-gateway.vercel.sh/typesafe/v1/systemone", model: "typesafe-ai/jev" },
  { id: "cloudflare", name: "Cloudflare Workers AI", url: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run", model: "typesafe/jev" },
  { id: "venice", name: "Venice", url: "https://api.venice.ai/api/v1/decisions", model: "jev-latest" },
  { id: "mindshub", name: "MindsHub", url: "https://api.mindshub.ai/v1/decisions", model: "jev-1.13.0" },
  { id: "aimlapi", name: "AI/ML API", url: "https://api.aimlapi.com/v1/decisions", model: "typesafe/jev" },
  { id: "aicu", name: "AICU", url: "https://api.aicu.ai/v1/jev", model: "jev-1.13.0" },
  { id: "anoman", name: "Anoman", url: "https://api.anoman.io/anoman/v1/decisions", model: "jev-1.13.0" },
];

// Only decision-capable IDs belong here. General gateway model catalogs may
// include chat models that cannot answer a DecisionRequest.
export const JEV_MODEL_CATALOG: Readonly<Record<JevProtocol, readonly string[]>> = {
  typesafe: ["jev-1.13.0", "jev-latest", "jev-preview"],
  openrouter: ["typesafe/jev-1.13", "~typesafe/jev-latest"],
  nanogpt: ["typesafe/jev-1.13"],
  vercel: ["typesafe-ai/jev"],
  cloudflare: ["typesafe/jev"],
  venice: ["jev-latest"],
  mindshub: ["jev-1.13.0"],
  aimlapi: ["typesafe/jev"],
  aicu: ["jev-1.13.0"],
  anoman: ["jev-1.13.0"],
};

export function isJevProtocol(value: unknown): value is JevProtocol {
  return typeof value === "string" && (JEV_PROTOCOLS as readonly string[]).includes(value);
}

interface JevGatewayAdapter {
  supportedPrimitives: readonly ("choice" | "score" | "noul")[];
  body(model: string, request: DecisionRequest): unknown;
  unwrap(raw: any): unknown;
}

const standardAdapter: JevGatewayAdapter = {
  supportedPrimitives: ["choice", "score", "noul"],
  body: (model, request) => ({ model, state: request.state, questions: request.questions }),
  unwrap: (raw) => raw,
};

export const JEV_GATEWAY_ADAPTERS: Readonly<Record<JevProtocol, JevGatewayAdapter>> = {
  typesafe: standardAdapter,
  openrouter: standardAdapter,
  nanogpt: standardAdapter,
  vercel: standardAdapter,
  cloudflare: {
    supportedPrimitives: ["choice", "score", "noul"],
    body: (model, request) => ({ model, input: { state: request.state, questions: request.questions } }),
    unwrap: (raw) => raw?.result?.answers ? raw.result : raw,
  },
  venice: standardAdapter,
  mindshub: standardAdapter,
  aimlapi: standardAdapter,
  aicu: standardAdapter,
  anoman: {
    ...standardAdapter,
    unwrap: (raw) => raw?.data,
  },
};

function resolveUrl(target: Pick<DecisionConnectionTarget, "api_url" | "account_id">): string {
  if (target.api_url.includes("{account_id}") && !target.account_id) throw new Error("Cloudflare account ID is required");
  const raw = target.api_url.replace("{account_id}", encodeURIComponent(target.account_id));
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Decision API URL must be HTTPS without embedded credentials");
  return url.toString();
}

export async function listJevModels(target: DecisionModelTarget): Promise<DecisionModelList> {
  if (!isJevProtocol(target.protocol)) throw new Error(`Unsupported Jev API protocol: ${target.protocol}`);
  const models = new Set(JEV_MODEL_CATALOG[target.protocol]);
  if (target.protocol === "typesafe" && target.apiKey && target.api_url) {
    const endpoint = new URL(resolveUrl(target));
    const match = endpoint.pathname.match(/^(.*\/)systemone\/?$/);
    if (match) {
      endpoint.pathname = `${match[1]}models`;
      endpoint.search = "";
      const response = await safeFetch(endpoint.toString(), {
        method: "GET",
        headers: { Authorization: `Bearer ${target.apiKey}` },
        timeoutMs: 15_000,
        maxBytes: 256 * 1024,
        allowedOrigins: [endpoint.origin],
      });
      if (!response.ok) throw new Error(`Decision model list returned HTTP ${response.status}`);
      const payload = await response.json().catch(() => null) as { models?: Array<{ name?: unknown }> } | null;
      if (!Array.isArray(payload?.models)) throw new Error("Gateway returned an invalid decision model list");
      for (const entry of payload.models) {
        if (typeof entry?.name === "string" && /^jev(?:-|$)/i.test(entry.name)) models.add(entry.name);
      }
    }
  }
  const modelList = [...models];
  const model_labels = Object.fromEntries(modelList.map((id) => [id, id === "jev-1.13.0" || id === "typesafe/jev-1.13" ? "Jev 1.13" : id.includes("latest") ? "Jev Latest" : id.includes("preview") ? "Jev Preview" : "Jev"]));
  return { models: modelList, model_labels };
}

function normalizeAnswer(value: unknown, id: string): DecisionAnswer {
  if (!value || typeof value !== "object") throw new Error(`Gateway omitted answer ${id}`);
  const a = value as Record<string, any>;
  if (a.type === "noul" && typeof a.noul === "number" && a.noul >= 0 && a.noul <= 1) return { type: "noul", noul: a.noul };
  if (a.type === "choice" && typeof a.choice === "string" && validProbabilities(a.probabilities) && typeof a.confidence === "number" && a.confidence >= 0 && a.confidence <= 1 && a.choice in a.probabilities) return { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
  if (a.type === "score" && typeof a.score === "number" && Number.isFinite(a.score) && validLegend(a.legend) && validProbabilities(a.probabilities) && typeof a.confidence === "number" && a.confidence >= 0 && a.confidence <= 1) return { type: "score", score: a.score, legend: a.legend, probabilities: a.probabilities, confidence: a.confidence };
  throw new Error(`Gateway returned an invalid ${id} answer`);
}

function validProbabilities(value: unknown): value is Record<string, number> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((probability) => typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1);
}

function validLegend(value: unknown): value is Record<string, string> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.values(value).every((description) => typeof description === "string");
}

export function normalizeJevResponse(raw: unknown, request: DecisionRequest): DecisionResult {
  const envelope = raw as Record<string, any>;
  const data = (envelope?.data?.answers ? envelope.data : envelope?.result?.answers ? envelope.result : envelope) as Record<string, any>;
  if (!data || typeof data.model !== "string" || !data.answers || typeof data.answers !== "object") throw new Error("Gateway returned an invalid decision response");
  const answers: Record<string, DecisionAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = normalizeAnswer(data.answers[id], id);
    if (answers[id].type !== question.type) throw new Error(`Gateway returned the wrong primitive for ${id}`);
  }
  const result: DecisionResult = { model: data.model, answers };
  if (typeof data.usage?.input_tokens === "number" && typeof data.usage?.output_tokens === "number") result.usage = { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens };
  return result;
}

export const jevProvider: DecisionProvider = {
  id: "jev",
  displayName: "Jev 1.13",
  protocols: JEV_PROTOCOLS,
  presets: JEV_PRESETS.map((preset) => ({ ...preset, protocol: preset.id })),
  listModels: listJevModels,
  async evaluate(target, request) {
    if (!isJevProtocol(target.protocol)) throw new Error(`Unsupported Jev API protocol: ${target.protocol}`);
    const adapter = JEV_GATEWAY_ADAPTERS[target.protocol];
    for (const [id, question] of Object.entries(request.questions)) {
      if (!adapter.supportedPrimitives.includes(question.type)) throw new Error(`Gateway ${target.protocol} does not support ${question.type} question ${id}`);
    }
    if (!target.apiKey) throw new Error("Decision connection needs an API key");
    const url = resolveUrl(target);
    const body = adapter.body(target.model, request);
    const response = await safeFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        "Content-Type": "application/json",
        ...(target.protocol === "openrouter" ? {
          "HTTP-Referer": "https://lumiverse.chat",
          "X-Title": "Lumiverse",
        } : {}),
      },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
      maxBytes: 1024 * 1024,
      allowedOrigins: [new URL(url).origin],
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Decision gateway returned HTTP ${response.status}`);
    return normalizeJevResponse(adapter.unwrap(payload), request);
  },
};

registerDecisionProvider(jevProvider);
