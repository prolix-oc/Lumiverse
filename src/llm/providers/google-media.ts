import type { ParameterSchemaMap } from "../param-schema";
import type { GenerationParameters } from "../types";

/**
 * Browser and operating-system MIME labels do not always match the labels in
 * Google's Gemini media contract. Keep the bytes unchanged while translating
 * common aliases to the MIME types documented for inlineData.
 */
const GOOGLE_MEDIA_MIME_ALIASES: Readonly<Record<string, string>> = {
  "audio/mpeg": "audio/mp3",
  "audio/x-mp3": "audio/mp3",
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-aiff": "audio/aiff",
  "audio/x-flac": "audio/flac",
  "video/quicktime": "video/mov",
  "video/x-m4v": "video/mp4",
  "video/x-msvideo": "video/avi",
  "video/msvideo": "video/avi",
  "video/x-ms-wmv": "video/wmv",
};

export function normalizeGoogleMediaMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  return GOOGLE_MEDIA_MIME_ALIASES[normalized] ?? normalized;
}

export const GOOGLE_MEDIA_PARAMETERS = {
  media_resolution: {
    type: "string",
    description: "Optional Gemini input media detail: low, medium, high, or unspecified (provider default). Does not resize or compress the attachment.",
  },
} satisfies ParameterSchemaMap;

export const GOOGLE_MEDIA_HANDLED_PARAMS = ["media_resolution", "mediaResolution"] as const;

/** Normalize the request-wide GenerateContent setting; ultra-high is per-part only. */
export function resolveGoogleMediaResolution(params: GenerationParameters): NonNullable<GenerationParameters["media_resolution"]> | undefined {
  const value = params.media_resolution ?? params.mediaResolution ?? params.generationConfig?.mediaResolution;
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Gemini media_resolution must be low, medium, high, or unspecified.");
  const level = value.trim().toUpperCase().replace(/^MEDIA_RESOLUTION_/, "");
  if (!["LOW", "MEDIUM", "HIGH", "UNSPECIFIED"].includes(level)) {
    throw new Error("Gemini media_resolution must be low, medium, high, or unspecified.");
  }
  return `MEDIA_RESOLUTION_${level}` as NonNullable<GenerationParameters["media_resolution"]>;
}
