import type { TtsVoice } from "./types";

export type TtsParamType = "number" | "integer" | "boolean" | "string" | "select";

export interface TtsParameterSchema {
  type: TtsParamType;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  description: string;
  required?: boolean;
  /** Fixed options for "select" type parameters */
  options?: Array<{ id: string; label: string }>;
  /** UI grouping — parameters with the same group render together (e.g. "advanced") */
  group?: string;
}

export type TtsParameterSchemaMap = Record<string, TtsParameterSchema>;

export interface TtsProviderCapabilities {
  parameters: TtsParameterSchemaMap;
  apiKeyRequired: boolean;
  /** "static" = baked-in voice list, "dynamic" = live API fetch */
  voiceListStyle: "static" | "dynamic";
  staticVoices?: TtsVoice[];
  /** "static" = baked-in model list, "dynamic" = live API fetch */
  modelListStyle: "static" | "dynamic";
  staticModels?: Array<{ id: string; label: string }>;
  supportsStreaming: boolean;
  supportedFormats: string[];
  defaultUrl: string;
  defaultFormat: string;
}
