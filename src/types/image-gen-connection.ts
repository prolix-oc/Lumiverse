export interface ImageGenConnectionProfile {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  is_default: boolean;
  has_api_key: boolean;
  default_parameters: Record<string, any>;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateImageGenConnectionInput {
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  is_default?: boolean;
  default_parameters?: Record<string, any>;
  metadata?: Record<string, any>;
  /** Transient — stored encrypted in secrets table, never persisted in DB */
  api_key?: string;
}

export type UpdateImageGenConnectionInput = Partial<CreateImageGenConnectionInput>;
