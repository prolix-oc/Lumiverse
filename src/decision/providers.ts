import type { DecisionModelDTO, DecisionProviderDTO, DecisionResult, DecisionEvaluationInput } from "./contract";
import { DecisionValidationError, isRecord, validateDecisionResult } from "./validation";
import { fetchProviderJson, describeProviderError, clampErrorMessage, ProviderRequestError } from "../utils/provider-errors";
import { redactRequestValue } from "../utils/redact-request";

const PROVIDERS: DecisionProviderDTO[] = [
  { id: "openrouter", name: "OpenRouter", capabilities: { apiKeyRequired: true, defaultUrl: "https://openrouter.ai/api/v1", suggestedModel: "~typesafe/jev-latest", modelListStyle: "dynamic" } },
  { id: "typesafe", name: "TypeSafe", capabilities: { apiKeyRequired: true, defaultUrl: "https://api.typesafe.ai/v1", suggestedModel: "jev-latest", modelListStyle: "dynamic" } },
];
export function listProviders(): DecisionProviderDTO[] { return structuredClone(PROVIDERS); }
export function getProvider(id: string): DecisionProviderDTO {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new DecisionValidationError(`Unknown Decision provider: ${id}`);
  return provider;
}
export function resolveDecisionApiUrl(profile: { provider: string; api_url?: string }): string {
  const provider = getProvider(profile.provider);
  let url: URL;
  try { url = new URL(profile.api_url?.trim() || provider.capabilities.defaultUrl); }
  catch { throw new DecisionValidationError("API URL must be an absolute HTTP or HTTPS base URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new DecisionValidationError("API URL must have no credentials, query, or fragment");
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
  return url.toString().replace(/\/+$/, "");
}
export function decisionEvaluationUrl(profile: { provider: string; api_url?: string }): string {
  const url = new URL(resolveDecisionApiUrl(profile));
  url.pathname = profile.provider === "openrouter"
    ? `${url.pathname.slice(0, -3)}/alpha/decisions`
    : `${url.pathname}/systemone`;
  return url.toString();
}
export function isUnsupportedDecisionModel(provider: string, model: string): boolean {
  // OpenRouter's decision catalog includes Tev1, which uses chat completions.
  return provider === "openrouter" && /^togethercomputer\/tev1-/i.test(model);
}
export function redactDecisionError(error: unknown, apiKey = ""): string {
  return clampErrorMessage(String(redactRequestValue(describeProviderError(error), apiKey ? [apiKey] : [])));
}
export async function fetchDecisionModels(profile: { provider: string; api_url?: string }, apiKey: string, signal?: AbortSignal): Promise<DecisionModelDTO[]> {
  const provider = getProvider(profile.provider);
  const url = new URL(`${resolveDecisionApiUrl(profile)}/models`);
  if (profile.provider === "openrouter") url.searchParams.set("output_modalities", "decisions");
  const data = await fetchProviderJson<unknown>(provider.name, "model listing", url, {
    headers: { Authorization: `Bearer ${apiKey}` }, redirect: "error",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
  });
  const raw = isRecord(data) ? (profile.provider === "typesafe" ? data.models : data.data) : undefined;
  if (!Array.isArray(raw)) throw new Error("Provider returned an invalid model catalog");
  const models = new Map<string, DecisionModelDTO>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = profile.provider === "typesafe" ? item.name : item.id;
    if (typeof id !== "string" || !id.trim()) continue;
    const architecture = isRecord(item.architecture) ? item.architecture : {};
    if (profile.provider === "openrouter" && Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes("decisions")) continue;
    const supported = profile.provider === "typesafe" || /^~?typesafe\/jev-|^(cloudflare\/clef|perplexity\/pplx-decider|upstage\/solar-decide|inception\/mercury-decide|liquid\/d1|openai\/gpt-6-luna-decisions)/.test(id);
    models.set(id, {
      id, label: profile.provider === "openrouter" && typeof item.name === "string" ? item.name : id,
      ...(typeof item.description === "string" ? { description: item.description } : {}),
      ...(profile.provider === "typesafe" ? { input_modalities: ["text"] } : Array.isArray(architecture.input_modalities) ? { input_modalities: architecture.input_modalities.filter((v): v is string => typeof v === "string") } : {}),
      ...(Array.isArray(architecture.output_modalities) ? { output_modalities: architecture.output_modalities.filter((v): v is string => typeof v === "string") } : {}),
      ...(typeof item.context_length === "number" ? { context_length: item.context_length } : {}),
      ...(isRecord(item.pricing) ? { pricing: Object.fromEntries(Object.entries(item.pricing).filter((entry): entry is [string, string] => typeof entry[1] === "string")) } : {}),
      protocol: isUnsupportedDecisionModel(profile.provider, id) ? "unsupported" : supported ? "supported" : "unverified",
    });
  }
  return [...models.values()].sort((a, b) => a.label.localeCompare(b.label));
}
export function validateDecisionParameters(provider: string, parameters: unknown): Record<string, unknown> {
  if (!isRecord(parameters)) throw new DecisionValidationError("default_parameters must be an object");
  const keys = Object.keys(parameters);
  if (!keys.length) return {};
  // Only an explicit routing configuration is supported initially.
  if (provider !== "openrouter" || keys.some((key) => key !== "provider") || !isRecord(parameters.provider)) throw new DecisionValidationError("Decision defaults only support OpenRouter provider routing");
  const routing = parameters.provider;
  const arrayKeys = ["order", "only", "ignore"];
  const booleanKeys = ["allow_fallbacks", "require_parameters", "zdr"];
  for (const [key, value] of Object.entries(routing)) {
    if (arrayKeys.includes(key) && Array.isArray(value) && value.every((v) => typeof v === "string" && v.trim())) continue;
    if (booleanKeys.includes(key) && typeof value === "boolean") continue;
    if (key === "data_collection" && (value === "allow" || value === "deny")) continue;
    if (key === "sort" && ["price", "throughput", "latency"].includes(String(value))) continue;
    throw new DecisionValidationError(`Unsupported Decision routing option: ${key}`);
  }
  return { provider: routing };
}
export async function evaluateProviderDecision(profile: { provider: string; api_url?: string; model: string; default_parameters: Record<string, unknown> }, apiKey: string, input: DecisionEvaluationInput, signal?: AbortSignal): Promise<DecisionResult> {
  const provider = getProvider(profile.provider);
  const model = input.model?.trim() || profile.model.trim();
  if (!model) throw new DecisionValidationError("Select a Decision model for this connection");
  if (isUnsupportedDecisionModel(profile.provider, model)) throw new DecisionValidationError("This model uses chat completions and does not support the Decision API");
  const body = { ...validateDecisionParameters(profile.provider, profile.default_parameters), model, state: input.state, questions: input.questions };
  const value = await fetchProviderJson<unknown>(provider.name, "decision evaluation", decisionEvaluationUrl(profile), {
    method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...(profile.provider === "openrouter" ? { "HTTP-Referer": "https://lumiverse.chat", "X-Title": "Lumiverse" } : {}) },
    body: JSON.stringify(body), redirect: "error", signal,
  });
  try { validateDecisionResult(value, input.questions); }
  catch (error) { throw new ProviderRequestError({ provider: provider.name, operation: "decision evaluation", detail: error instanceof Error ? error.message : "Invalid Decision response", retryable: false }); }
  // Return only the public envelope; never relay arbitrary provider body fields.
  return { model: value.model, answers: value.answers, ...(value.usage !== undefined ? { usage: value.usage } : {}), ...(value.id !== undefined ? { id: value.id } : {}), ...(value.provider !== undefined ? { provider: value.provider } : {}) };
}
