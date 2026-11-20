export interface ConnectionProfile {
  id: string;
  name: string;
  provider: string;
  api_url: string;
  model: string;
  preset_id: string | null;
  is_default: boolean;
  has_api_key: boolean;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateConnectionProfileInput {
  name: string;
  provider: string;
  api_url?: string;
  model?: string;
  preset_id?: string;
  is_default?: boolean;
  metadata?: Record<string, any>;
  /** Transient — stored to secrets table, never returned in responses. */
  api_key?: string;
}

export type UpdateConnectionProfileInput = Partial<CreateConnectionProfileInput>;
