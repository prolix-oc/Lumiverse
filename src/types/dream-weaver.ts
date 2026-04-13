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
  draft?: DW_DRAFT_V1 | null;
}
