import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";
import type { GenerationRequest } from "../types";

/** Cached model metadata from OpenRouter's /models endpoint. */
export interface OpenRouterModelInfo {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
    is_moderated?: boolean;
  };
  architecture?: {
    tokenizer?: string;
    instruct_type?: string;
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  supported_parameters?: string[];
}

/** OpenRouter provider routing configuration (stored in connection metadata.openrouter). */
export interface OpenRouterProviderRouting {
  order?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  ignore?: string[];
  only?: string[];
  quantizations?: string[];
  sort?: string;
}

/** OpenRouter plugin configuration. */
export interface OpenRouterPlugin {
  id: string;
  enabled?: boolean;
  [key: string]: any;
}

/** Shape of metadata.openrouter on connection profiles. */
export interface OpenRouterConnectionSettings {
  provider_routing?: OpenRouterProviderRouting;
  plugins?: OpenRouterPlugin[];
  middle_out_compression?: boolean;
}

// In-memory caches with TTL
let _modelCache: { data: OpenRouterModelInfo[]; fetchedAt: number } | null = null;
let _providerListCache: { data: OpenRouterProviderEntry[]; fetchedAt: number } | null = null;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class OpenRouterProvider extends OpenAICompatibleProvider {
  readonly name = "openrouter";
  readonly displayName = "OpenRouter";
  readonly defaultUrl = "https://openrouter.ai/api/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
      min_p: COMMON_PARAMS.min_p,
      repetition_penalty: COMMON_PARAMS.repetition_penalty,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
  };

  protected extraHeaders(): Record<string, string> {
    return {
      "HTTP-Referer": "https://lumiverse.app",
      "X-Title": "Lumiverse",
      "X-OpenRouter-Categories": "ai-chat,roleplay",
    };
  }

  /**
   * Override buildBody to inject OpenRouter-specific fields from parameters:
   * - provider routing (order, allow_fallbacks, etc.)
   * - plugins (web search, response healing, context compression)
   * These are passed via GenerationRequest.parameters._openrouter which is
   * injected by the generate service from connection metadata.
   */
  protected buildBody(request: GenerationRequest, stream: boolean): any {
    const body = super.buildBody(request, stream);
    const orSettings = request.parameters?._openrouter as OpenRouterConnectionSettings | undefined;

    // Remove internal key so it doesn't reach the API
    delete body._openrouter;

    // Provider routing
    if (orSettings?.provider_routing) {
      const routing = orSettings.provider_routing;
      const providerObj: Record<string, any> = {};
      if (routing.order?.length) providerObj.order = routing.order;
      if (routing.allow_fallbacks !== undefined) providerObj.allow_fallbacks = routing.allow_fallbacks;
      if (routing.require_parameters !== undefined) providerObj.require_parameters = routing.require_parameters;
      if (routing.data_collection) providerObj.data_collection = routing.data_collection;
      if (routing.ignore?.length) providerObj.ignore = routing.ignore;
      if (routing.only?.length) providerObj.only = routing.only;
      if (routing.quantizations?.length) providerObj.quantizations = routing.quantizations;
      if (routing.sort) providerObj.sort = routing.sort;
      if (Object.keys(providerObj).length > 0) body.provider = providerObj;
    }

    // Plugins
    if (orSettings?.plugins?.length) {
      body.plugins = orSettings.plugins;
    }

    return body;
  }

  /**
   * Validate key using OpenRouter's dedicated /key endpoint which returns
   * credit info. Falls back to /models if /key fails.
   */
  async validateKey(apiKey: string, apiUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/key`, {
        headers: this.headers(apiKey),
      });
      if (res.ok) return true;
      // Fall back to models endpoint
      return super.validateKey(apiKey, apiUrl);
    } catch {
      return false;
    }
  }

  /**
   * Fetch models from OpenRouter with rich metadata. Caches results for 5 minutes.
   * Returns sorted model IDs for the standard listModels interface.
   */
  async listModels(apiKey: string, apiUrl: string): Promise<string[]> {
    const models = await this.fetchModelsWithMetadata(apiKey, apiUrl);
    return models.map((m) => m.id).sort();
  }

  /**
   * Fetch full model metadata from OpenRouter. Cached in-memory with TTL.
   * Used by the credits/models info endpoint.
   */
  async fetchModelsWithMetadata(apiKey: string, apiUrl: string): Promise<OpenRouterModelInfo[]> {
    if (_modelCache && Date.now() - _modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
      return _modelCache.data;
    }

    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/models`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return _modelCache?.data || [];
      const data = (await res.json()) as any;
      const models: OpenRouterModelInfo[] = (data.data || []).map((m: any) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing || {},
        top_provider: m.top_provider,
        architecture: m.architecture,
        supported_parameters: m.supported_parameters,
      }));
      _modelCache = { data: models, fetchedAt: Date.now() };
      return models;
    } catch {
      return _modelCache?.data || [];
    }
  }

  /**
   * Fetch user credit/usage info from OpenRouter's /key endpoint.
   */
  async fetchCredits(apiKey: string, apiUrl: string): Promise<OpenRouterCreditsInfo | null> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/key`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return null;
      const raw = (await res.json()) as any;
      // Response is wrapped in { data: { ... } }
      const d = raw.data ?? raw;
      return {
        label: d.label ?? null,
        limit: d.limit ?? null,
        limit_remaining: d.limit_remaining ?? null,
        limit_reset: d.limit_reset ?? null,
        usage: d.usage ?? 0,
        usage_daily: d.usage_daily ?? 0,
        usage_weekly: d.usage_weekly ?? 0,
        usage_monthly: d.usage_monthly ?? 0,
        is_free_tier: d.is_free_tier ?? false,
      };
    } catch {
      return null;
    }
  }

  /**
   * Fetch generation stats for a specific generation ID.
   */
  async fetchGenerationStats(apiKey: string, apiUrl: string, generationId: string): Promise<any | null> {
    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  /**
   * Fetch the list of upstream providers from OpenRouter. Cached in-memory.
   */
  async fetchProviderList(apiKey: string, apiUrl: string): Promise<OpenRouterProviderEntry[]> {
    if (_providerListCache && Date.now() - _providerListCache.fetchedAt < MODEL_CACHE_TTL_MS) {
      return _providerListCache.data;
    }

    try {
      const res = await fetch(`${this.baseUrl(apiUrl)}/providers`, {
        headers: this.headers(apiKey),
      });
      if (!res.ok) return _providerListCache?.data || [];
      const raw = (await res.json()) as any;
      const list: OpenRouterProviderEntry[] = (raw.data || []).map((p: any) => ({
        name: p.name,
        slug: p.slug,
      }));
      _providerListCache = { data: list, fetchedAt: Date.now() };
      return list;
    } catch {
      return _providerListCache?.data || [];
    }
  }
}

export interface OpenRouterProviderEntry {
  name: string;
  slug: string;
}

export interface OpenRouterCreditsInfo {
  label: string | null;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
  is_free_tier: boolean;
}
