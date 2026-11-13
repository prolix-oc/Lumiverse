import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest } from "../types";
import type { NanoGptConnectionSettings, NanoGptProviderRouting } from "../../types/nanogpt";

/** Send only documented controls. Invalid hard constraints must fail, not disappear. */
export function buildNanoGptRouting(raw: NanoGptProviderRouting): NanoGptProviderRouting {
  const routing: NanoGptProviderRouting = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid NanoGPT provider routing");
  for (const key of ["order", "only", "ignore", "quantizations"] as const) {
    const values = raw[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v.trim())) {
      throw new Error(`Invalid NanoGPT provider.${key}`);
    }
    if (values.length) routing[key] = [...new Set(values.map((v) => v.trim()))];
  }
  for (const key of ["allow_fallbacks", "require_parameters"] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== "boolean") throw new Error(`Invalid NanoGPT provider.${key}`);
    routing[key] = raw[key];
  }
  if (raw.sort !== undefined) {
    if (!["speed", "throughput", "latency", "price", "auto", "none", "default"].includes(raw.sort)) {
      throw new Error("Invalid NanoGPT provider.sort");
    }
    routing.sort = raw.sort;
  }
  const precision = ["int4", "fp4", "fp6", "int8", "fp8", "fp16", "bf16", "fp32"];
  if (routing.quantizations?.some((q) => ![...precision, "unknown"].includes(q))) {
    throw new Error("Invalid NanoGPT provider.quantizations");
  }
  if (raw.min_quantization !== undefined && raw.min_quantization !== "") {
    if (!precision.includes(raw.min_quantization)) throw new Error("Invalid NanoGPT provider.min_quantization");
    routing.min_quantization = raw.min_quantization;
  }
  if (raw.max_price !== undefined) {
    if (!raw.max_price || typeof raw.max_price !== "object" || Array.isArray(raw.max_price)) {
      throw new Error("Invalid NanoGPT provider.max_price");
    }
    const caps: NonNullable<NanoGptProviderRouting["max_price"]> = {};
    for (const key of ["prompt", "completion"] as const) {
      const value = raw.max_price[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw new Error(`Invalid NanoGPT provider.max_price.${key}`);
      }
      caps[key] = value;
    }
    if (Object.keys(caps).length) routing.max_price = caps;
  }
  return routing;
}

export class NanoGPTProvider extends OpenAICompatibleProvider {
  readonly name = "nanogpt";
  readonly displayName = "NanoGPT";
  readonly defaultUrl = "https://nano-gpt.com/api/v1";

  protected buildBody(request: GenerationRequest, stream: boolean): any {
    const body = super.buildBody(request, stream);
    const settings = request.parameters?._nanogpt as NanoGptConnectionSettings | undefined;
    delete body._nanogpt;
    if (settings?.billing_mode === "paygo") body.billing_mode = "paygo";
    const raw = settings?.model_overrides?.[request.model.trim()];
    if (raw) {
      const routing = buildNanoGptRouting(raw);
      if (Object.keys(routing).length) body.provider = routing;
    }
    return body;
  }

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
  };
}
