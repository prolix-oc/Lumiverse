// Dream Weaver Types

export interface DreamWeaverSession {
  id: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  dream_text: string;
  tone: string | null;
  constraints: string | null;
  dislikes: string | null;
  persona_id: string | null;
  connection_id: string | null;
  model: string | null;
  draft: string | null;
  status: "draft" | "generating" | "complete" | "error";
  soul_state: "empty" | "generating" | "ready" | "error";
  world_state: "empty" | "ready" | "stale";
  soul_revision: number;
  world_source_revision: number | null;
  character_id: string | null;
  launch_chat_id: string | null;
}

export interface CreateSessionInput {
  dream_text: string;
  tone?: string;
  constraints?: string;
  dislikes?: string;
  persona_id?: string;
  connection_id?: string;
  model?: string;
}

export interface GenerateDraftInput {
  sessionId: string;
}

export interface RewriteSectionInput {
  section: "description" | "personality" | "scenario" | "first_mes" | "voice" | "greeting";
  feedback: string;
  targetId?: string;
}

export interface DW_DRAFT_V1 {
  format: "DW_DRAFT_V1";
  version: 1;
  kind: "character" | "scenario";
  meta: {
    title: string;
    summary: string;
    tags: string[];
    content_rating: "sfw" | "nsfw";
  };
  card: {
    name: string;
    appearance: string;
    appearance_data?: Record<string, string>;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    system_prompt: string;
    post_history_instructions: string;
  };
  voice_guidance: {
    compiled: string;
    rules: {
      baseline: string[];
      rhythm: string[];
      diction: string[];
      quirks: string[];
      hard_nos: string[];
    };
  };
  alternate_fields: {
    description: Array<{ id: string; label: string; content: string }>;
    personality: Array<{ id: string; label: string; content: string }>;
    scenario: Array<{ id: string; label: string; content: string }>;
  };
  greetings: Array<{
    id: string;
    label: string;
    content: string;
  }>;
  lorebooks: any[];
  npc_definitions: any[];
  regex_scripts: any[];
  image_assets?: DreamWeaverLegacyImageAsset[];
  visual_assets?: any[];
}

export interface DreamWeaverLegacyImageAsset {
  id: string;
  type: string;
  label: string;
  prompt: string;
  negative: string;
  imageId?: string | null;
  imageUrl?: string | null;
  locked?: boolean;
}

export type DreamWeaverVisualProvider =
  | "comfyui"
  | "novelai"
  | "nanogpt"
  | "google_gemini"
  | "a1111"
  | "swarmui";

export interface DreamWeaverVisualReference {
  id: string;
  image_id?: string | null;
  image_url?: string | null;
  weight?: number;
  label?: string;
}

export interface DreamWeaverVisualAsset {
  id: string;
  asset_type: "card_portrait";
  label: string;
  prompt: string;
  negative_prompt: string;
  macro_tokens: string[];
  width: number;
  height: number;
  aspect_ratio: string;
  seed: number | null;
  references: DreamWeaverVisualReference[];
  provider: DreamWeaverVisualProvider | null;
  preset_id: string | null;
  provider_state: Record<string, any>;
}

export interface UpdateSessionInput {
  dream_text?: string;
  tone?: string | null;
  constraints?: string | null;
  dislikes?: string | null;
  persona_id?: string | null;
  connection_id?: string | null;
  model?: string | null;
  draft?: DW_DRAFT_V1 | null;
}

export interface NpcEntry {
  name: string;
  description: string;
  voice_notes?: string;
}

export interface LorebookEntry {
  key: string[];
  comment: string;
  content: string;
}

export interface VoiceGuidance {
  compiled: string;
  rules: {
    baseline: string[];
    rhythm: string[];
    diction: string[];
    quirks: string[];
    hard_nos: string[];
  };
}

export interface DraftV2 {
  name: string | null;
  appearance: string | null;
  appearance_data: Record<string, unknown> | null;
  personality: string | null;
  scenario: string | null;
  first_mes: string | null;
  greeting: string | null;
  voice_guidance: VoiceGuidance | null;
  lorebooks: LorebookEntry[];
  npcs: NpcEntry[];
}

export const EMPTY_DRAFT_V2: DraftV2 = {
  name: null,
  appearance: null,
  appearance_data: null,
  personality: null,
  scenario: null,
  first_mes: null,
  greeting: null,
  voice_guidance: null,
  lorebooks: [],
  npcs: [],
};

export type DreamWeaverMessageKind =
  | "user_command"
  | "tool_card"
  | "system_note"
  | "dream_summary";

export type ToolCardStatus =
  | "running"
  | "pending"
  | "accepted"
  | "rejected"
  | "superseded";

export interface DreamWeaverMessage {
  id: string;
  session_id: string;
  user_id: string;
  created_at: number;
  seq: number;
  kind: DreamWeaverMessageKind;
  payload: Record<string, unknown>;
  tool_name: string | null;
  status: ToolCardStatus | null;
  supersedes_id: string | null;
}

export interface DreamSummaryPayload {
  dream_text: string;
  tone: string | null;
  dislikes: string | null;
}

export interface UserCommandPayload {
  raw: string;
  parsed: { tool: string; args: Record<string, unknown> };
}

export interface ToolCardPayload {
  tool: string;
  args: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: { message: string; code?: string } | null;
  nudge_text: string | null;
  duration_ms: number | null;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    tokenizer_name: string;
    model: string;
  } | null;
}

export interface SystemNotePayload {
  text: string;
  level: "info" | "warning";
}
