export interface ComfyUICapabilities {
  checkpoints: string[];
  unets: string[];
  clips: string[];
  dualClips: string[];
  vaes: string[];
  loras: string[];
  upscaleModels: string[];
  detectorModels: string[];
  samplers: string[];
  schedulers: string[];
  installedPacks: {
    impactPack: boolean;
    upscaling: boolean;
    controlnet: boolean;
  };
  modelLoaderType: "checkpoint" | "unet" | "both";
  clipLoaderType: "single" | "dual" | "none";
}

export interface ImageGenRequest {
  prompt: string;
  negativePrompt?: string;
  model: string;
  parameters: Record<string, any>;
  signal?: AbortSignal;
}

export interface ImageGenResponse {
  imageDataUrl: string;
  model: string;
  provider: string;
}

/**
 * Top-level keys a user is NOT allowed to override via rawRequestOverride.
 * Without this guard, a user could swap the model, disable provider safety
 * settings, or smuggle their own auth fields into the outgoing request.
 * Provider-specific extensions can extend this list before invoking applyRawOverride.
 */
export const PROTECTED_RAW_OVERRIDE_KEYS = new Set<string>([
  "model",
  "modelId",
  "model_id",
  "safetySettings",
  "safety_settings",
  "apiKey",
  "api_key",
  "key",
  "authorization",
  "Authorization",
  "headers",
  "endpoint",
  "url",
]);

/**
 * Deep-merge `override` into `target`, returning a new object.
 * Arrays in override replace (not concat) arrays in target.
 * Top-level keys in `protectedKeys` are dropped from the override before merging.
 */
export function applyRawOverride<T extends Record<string, any>>(
  target: T,
  rawJson: string | undefined,
  protectedKeys: Iterable<string> = PROTECTED_RAW_OVERRIDE_KEYS,
): T {
  if (!rawJson || !rawJson.trim()) return target;
  let override: any;
  try {
    override = JSON.parse(rawJson);
  } catch {
    // Invalid JSON — skip silently, user error
    return target;
  }
  if (override && typeof override === "object" && !Array.isArray(override)) {
    const blocked = new Set(protectedKeys);
    for (const key of Object.keys(override)) {
      if (blocked.has(key)) delete override[key];
    }
  }
  return deepMerge(target, override);
}

function deepMerge(target: any, source: any): any {
  if (source === null || source === undefined) return target;
  if (typeof source !== "object" || Array.isArray(source)) return source;
  if (typeof target !== "object" || Array.isArray(target)) return source;

  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      typeof result[key] === "object" &&
      result[key] !== null &&
      !Array.isArray(result[key]) &&
      typeof source[key] === "object" &&
      source[key] !== null &&
      !Array.isArray(source[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}
