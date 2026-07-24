import { getProvider } from "./registry";

const ZAI_GENERAL_API_URL = "https://api.z.ai/api/paas/v4";
const ZAI_CODING_PLAN_API_URL = "https://api.z.ai/api/coding/paas/v4";

export interface EffectiveApiUrlProfile {
  readonly provider: string;
  readonly api_url?: string | null;
  readonly metadata?: Readonly<Record<string, any>> | null;
}

function resolveZaiApiUrl(rawUrl: string, useCodingPlanEndpoint: boolean): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return useCodingPlanEndpoint ? ZAI_CODING_PLAN_API_URL : ZAI_GENERAL_API_URL;

  try {
    const url = new URL(trimmed);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    if (pathname === "/v1" || pathname === "/api/paas/v4" || pathname === "/api/coding/paas/v4") {
      url.pathname = useCodingPlanEndpoint ? "/api/coding/paas/v4" : "/api/paas/v4";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // Preserve custom raw URLs we can't safely normalize.
  }

  return trimmed;
}

/** Resolve the effective API URL from connection metadata and registered provider defaults. */
export function resolveEffectiveApiUrl(profile: EffectiveApiUrlProfile): string {
  const url = (profile.api_url || "").trim();
  if (profile.provider === "nanogpt" && profile.metadata?.use_subscription_api) {
    if (!url) return "https://nano-gpt.com/api/subscription/v1";
    return url.replace("/api/v1", "/api/subscription/v1");
  }
  if (profile.provider === "zai") {
    return resolveZaiApiUrl(url, profile.metadata?.use_coding_plan_endpoint === true);
  }
  if (profile.provider === "google_vertex") {
    const region = profile.metadata?.vertex_region;
    // Per Google's @google/genai SDK: `global` routes through the
    // un-prefixed host, regional routes through `{region}-aiplatform`.
    if (!region || region === "global") return "https://aiplatform.googleapis.com";
    return `https://${region}-aiplatform.googleapis.com`;
  }
  if (profile.provider === "bedrock") {
    // An explicit api_url wins so power users can pin a GovCloud or VPC
    // PrivateLink host; otherwise derive from region + endpoint toggle.
    if (url) return url;
    const region = (profile.metadata?.region || "us-east-1").trim() || "us-east-1";
    // mantle (default, recommended) vs runtime (cross-region inference profiles).
    return profile.metadata?.bedrock_endpoint === "runtime"
      ? `https://bedrock-runtime.${region}.amazonaws.com/v1`
      : `https://bedrock-mantle.${region}.api.aws/v1`;
  }
  return url || getProvider(profile.provider)?.defaultUrl.trim() || "";
}
