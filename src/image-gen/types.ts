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
 * Deep-merge `override` into `target`, returning a new object.
 * Arrays in override replace (not concat) arrays in target.
 */
export function applyRawOverride<T extends Record<string, any>>(target: T, rawJson: string | undefined): T {
  if (!rawJson || !rawJson.trim()) return target;
  let override: any;
  try {
    override = JSON.parse(rawJson);
  } catch {
    // Invalid JSON — skip silently, user error
    return target;
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
