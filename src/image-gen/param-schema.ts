export type ImageParamType = "number" | "integer" | "boolean" | "string" | "select" | "image_array";

export interface ImageParameterSchema {
  type: ImageParamType;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  description: string;
  required?: boolean;
  /** Fixed options for "select" type parameters */
  options?: Array<{ id: string; label: string }>;
  /** UI grouping — parameters with the same group render together (e.g. "advanced", "references") */
  group?: string;
}

export type ImageParameterSchemaMap = Record<string, ImageParameterSchema>;

export interface ImageProviderCapabilities {
  parameters: ImageParameterSchemaMap;
  apiKeyRequired: boolean;
  /** "static" = baked-in model list, "dynamic" = live API fetch, "google" = filter image-capable models */
  modelListStyle: "static" | "dynamic" | "google";
  staticModels?: Array<{ id: string; label: string }>;
  defaultUrl: string;
}
