import type { ImageProviderCapabilities } from "./param-schema";
import type { ImageGenRequest, ImageGenResponse } from "./types";

export interface ImageProvider {
  readonly name: string;
  readonly displayName: string;
  readonly capabilities: ImageProviderCapabilities;

  generate(apiKey: string, apiUrl: string, request: ImageGenRequest): Promise<ImageGenResponse>;

  generateStream?(
    apiKey: string,
    apiUrl: string,
    request: ImageGenRequest,
  ): AsyncGenerator<
    { step?: number; totalSteps?: number; preview?: string; nodeId?: string },
    ImageGenResponse,
    unknown
  >;

  validateKey(apiKey: string, apiUrl: string): Promise<boolean>;

  listModels(apiKey: string, apiUrl: string): Promise<Array<{ id: string; label: string }>>;

  /**
   * Fetch models for a specific subtype (e.g. "vae", "text_encoders").
   * Providers that don't support this may leave it unimplemented.
   */
  listModelsBySubtype?(
    apiKey: string,
    apiUrl: string,
    subtype: string,
  ): Promise<Array<{ id: string; label: string }>>;
}
