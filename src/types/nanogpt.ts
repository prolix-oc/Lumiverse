export interface NanoGptProviderRouting {
  order?: string[];
  only?: string[];
  ignore?: string[];
  sort?: "speed" | "throughput" | "latency" | "price" | "auto" | "none" | "default";
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  quantizations?: string[];
  min_quantization?: string;
  max_price?: { prompt?: number; completion?: number };
}

/** Connection-local settings; NanoGPT's saved web preferences require a cookie. */
export interface NanoGptConnectionSettings {
  billing_mode?: "paygo";
  model_overrides?: Record<string, NanoGptProviderRouting>;
}

export interface NanoGptTokenPricing {
  inputPer1kTokens?: number;
  outputPer1kTokens?: number;
}

export interface NanoGptModelProvider {
  provider: string;
  displayName?: string;
  available: boolean;
  pricing?: NanoGptTokenPricing;
  effectivePricing?: { effective_price?: NanoGptTokenPricing };
  quantization?: string;
}

export interface NanoGptModelProviders {
  canonicalId: string;
  displayName: string;
  supportsProviderSelection: boolean;
  defaultPrice?: NanoGptTokenPricing;
  providers: NanoGptModelProvider[];
}

export interface NanoGptBalance {
  usd_balance: number | null;
  nano_balance: number | null;
}

export interface NanoGptPaygoUsage {
  from: string;
  to: string;
  asOf: string | null;
  usage_daily: number;
  usage_monthly: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}
