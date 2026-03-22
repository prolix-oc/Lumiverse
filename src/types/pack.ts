// ---- Pack ----
export interface Pack {
  id: string;
  user_id: string;
  name: string;
  author: string;
  cover_url: string | null;
  version: string;
  is_custom: boolean;
  source_url: string | null;
  extras: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreatePackInput {
  name: string;
  author?: string;
  cover_url?: string;
  version?: string;
  is_custom?: boolean;
  source_url?: string;
  extras?: Record<string, any>;
}

export type UpdatePackInput = Partial<CreatePackInput>;

// ---- Lumia Item ----
export interface LumiaItem {
  id: string;
  pack_id: string;
  name: string;
  avatar_url: string | null;
  author_name: string;
  definition: string;
  personality: string;
  behavior: string;
  gender_identity: 0 | 1 | 2; // 0=unspecified, 1=feminine, 2=masculine
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CreateLumiaItemInput {
  name: string;
  avatar_url?: string;
  author_name?: string;
  definition?: string;
  personality?: string;
  behavior?: string;
  gender_identity?: 0 | 1 | 2;
  version?: string;
  sort_order?: number;
}

export type UpdateLumiaItemInput = Partial<CreateLumiaItemInput>;

// ---- Loom Item ----
export type LoomItemCategory = 'narrative_style' | 'loom_utility' | 'retrofit';

export interface LoomItem {
  id: string;
  pack_id: string;
  name: string;
  content: string;
  category: LoomItemCategory;
  author_name: string;
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CreateLoomItemInput {
  name: string;
  content?: string;
  category?: LoomItemCategory;
  author_name?: string;
  version?: string;
  sort_order?: number;
}

export type UpdateLoomItemInput = Partial<CreateLoomItemInput>;

// ---- Loom Tool ----
export interface LoomTool {
  id: string;
  pack_id: string;
  tool_name: string;
  display_name: string;
  description: string;
  prompt: string;
  input_schema: Record<string, any>;
  result_variable: string;
  store_in_deliberation: boolean;
  author_name: string;
  version: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface CreateLoomToolInput {
  tool_name: string;
  display_name?: string;
  description?: string;
  prompt?: string;
  input_schema?: Record<string, any>;
  result_variable?: string;
  store_in_deliberation?: boolean;
  author_name?: string;
  version?: string;
  sort_order?: number;
}

export type UpdateLoomToolInput = Partial<CreateLoomToolInput>;

// ---- Pack With Items ----
export interface PackWithItems extends Pack {
  lumia_items: LumiaItem[];
  loom_items: LoomItem[];
  loom_tools: LoomTool[];
}

// ---- Import Payload (extension camelCase format) ----
export interface PackImportPayload {
  name?: string;
  author?: string;
  coverUrl?: string;
  version?: string;
  sourceUrl?: string;
  extras?: Record<string, any>;
  lumiaItems?: Array<{
    name: string;
    avatarUrl?: string;
    authorName?: string;
    definition?: string;
    personality?: string;
    behavior?: string;
    genderIdentity?: 0 | 1 | 2;
    version?: string;
    sortOrder?: number;
  }>;
  loomItems?: Array<{
    name: string;
    content?: string;
    category?: LoomItemCategory;
    authorName?: string;
    version?: string;
    sortOrder?: number;
  }>;
  loomTools?: Array<{
    toolName: string;
    displayName?: string;
    description?: string;
    prompt?: string;
    inputSchema?: Record<string, any>;
    resultVariable?: string;
    storeInDeliberation?: boolean;
    authorName?: string;
    version?: string;
    sortOrder?: number;
  }>;
}
