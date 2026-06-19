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
  gender_identity: 0 | 1 | 2 | 3; // 0=feminine, 1=masculine, 2=neutral, 3=any
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
  gender_identity?: 0 | 1 | 2 | 3;
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
  regex_scripts: import("./regex-script").RegexScript[];
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
    genderIdentity?: 0 | 1 | 2 | 3;
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
  regexScripts?: Array<{
    name: string;
    scriptId?: string;
    findRegex: string;
    replaceString?: string;
    flags?: string;
    placement?: string[];
    target?: string | string[];
    minDepth?: number | null;
    maxDepth?: number | null;
    trimStrings?: string[];
    runOnEdit?: boolean;
    substituteMacros?: string;
    disabled?: boolean;
    sortOrder?: number;
    description?: string;
    metadata?: Record<string, any>;
  }>;
}

// ---- Export Payload (LumiHub-compatible camelCase format) ----
// Shaped to satisfy LumiHub's `lumiaPackSchema` (packName/lumiaName/loomName,
// integer versions, gender identity 0-2) so exported packs can be uploaded and
// shared directly. Lumiverse-only fields (sourceUrl, extras, loomTools,
// regexScripts) ride along via LumiHub's `.passthrough()` — LumiHub drops them,
// but the importer re-reads them for lossless Lumiverse → Lumiverse round-trips.
export interface PackExportPayload {
  packName: string;
  packAuthor: string;
  coverUrl: string | null;
  version: number;
  packExtras: Array<{ type: string; name: string; description: string }>;
  lumiaItems: Array<{
    lumiaName: string;
    lumiaDefinition: string;
    lumiaPersonality: string;
    lumiaBehavior: string;
    avatarUrl: string | null;
    genderIdentity: 0 | 1 | 2;
    authorName: string;
    version: number;
  }>;
  loomItems: Array<{
    loomName: string;
    loomContent: string;
    loomCategory: string;
    authorName: string | null;
    version: number;
  }>;
  // Lumiverse-only passthrough (ignored by LumiHub, used for round-trip fidelity)
  sourceUrl?: string;
  extras?: Record<string, any>;
  loomTools?: PackImportPayload["loomTools"];
  regexScripts?: PackImportPayload["regexScripts"];
}
