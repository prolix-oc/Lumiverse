import type { ParameterSchemaMap } from "../param-schema";
import type { GenerationParameters } from "../types";

// Models that cannot use Google Search grounding. Lite, robotics,
// image-generation, and Gemma/LearnLM models use surfaces without this tool.
const GOOGLE_SEARCH_UNSUPPORTED = [
  /flash-lite/i,
  /gemini-robotics/i,
  /gemma/i,
  /learnlm/i,
  /image-generation|image-preview|image$|-image\b/i,
];

export const GOOGLE_SEARCH_PARAMETERS = {
  googleSearch: {
    type: "boolean",
    default: false,
    description: "Enable Google Search grounding for live web results.",
  },
  // No default: omitting the threshold keeps google_search always on. A
  // threshold deliberately opts into conditional dynamic retrieval instead.
  googleSearchDynamicThreshold: {
    type: "number",
    min: 0,
    max: 1,
    description: "Optional dynamic retrieval threshold (0-1) for Google Search grounding.",
  },
} satisfies ParameterSchemaMap;

export const GOOGLE_SEARCH_HANDLED_PARAMS = [
  "googleSearch",
  "google_search",
  "enable_web_search",
  "googleSearchDynamicThreshold",
] as const;

export function isGoogleSearchUnsupported(model: string): boolean {
  return GOOGLE_SEARCH_UNSUPPORTED.some((pattern) => pattern.test(model || ""));
}

function isGoogleSearchEnabled(params: GenerationParameters): boolean {
  if (params.googleSearch !== undefined) return params.googleSearch === true;
  if (params.google_search !== undefined) return params.google_search === true;
  return params.enable_web_search === true;
}

/** Build the provider-native Google Search tool, or null when it cannot be used. */
export function buildGoogleSearchTool(
  providerName: string,
  model: string,
  params: GenerationParameters,
  hasFunctionDeclarations: boolean,
): Record<string, unknown> | null {
  if (!isGoogleSearchEnabled(params)) return null;

  if (hasFunctionDeclarations) {
    console.warn(
      `[${providerName}] Google Search grounding skipped: it cannot be combined with inline function tools.`,
    );
    return null;
  }

  if (isGoogleSearchUnsupported(model)) {
    console.warn(
      `[${providerName}] Google Search grounding skipped: model ${model} does not support it.`,
    );
    return null;
  }

  const threshold = params.googleSearchDynamicThreshold;
  if (typeof threshold === "number" && threshold >= 0 && threshold <= 1) {
    return {
      googleSearch: {
        dynamicRetrievalConfig: { dynamicThreshold: threshold },
      },
    };
  }

  // The REST shape accepted by both Gemini Developer API (AI Studio) and
  // Vertex AI. With no dynamic config, grounding is always on.
  return { google_search: {} };
}

/** Add grounding to a completed Gemini body without duplicating custom tools. */
export function appendGoogleSearchTool(
  providerName: string,
  body: Record<string, any>,
  googleSearchTool: Record<string, unknown> | null,
): void {
  if (!googleSearchTool) return;
  if (body.tools === undefined) {
    body.tools = [googleSearchTool];
    return;
  }
  if (!Array.isArray(body.tools)) {
    console.warn(`[${providerName}] Google Search grounding skipped: custom tools must be an array.`);
    return;
  }

  const alreadyHasSearch = body.tools.some(
    (tool: any) => tool?.google_search !== undefined || tool?.googleSearch !== undefined,
  );
  if (alreadyHasSearch) return;

  const hasCustomFunctions = body.tools.some(
    (tool: any) => Array.isArray(tool?.functionDeclarations) && tool.functionDeclarations.length > 0,
  );
  if (hasCustomFunctions) {
    console.warn(
      `[${providerName}] Google Search grounding skipped: it cannot be combined with custom function declarations.`,
    );
    return;
  }

  body.tools.push(googleSearchTool);
}
