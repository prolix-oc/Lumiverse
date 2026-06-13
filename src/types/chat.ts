export interface Chat {
  id: string;
  /** Null for temporary character-less chats (see metadata.temporary). */
  character_id: string | null;
  name: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateChatInput {
  /** Omit/null only for temporary character-less chats. */
  character_id?: string | null;
  name?: string;
  metadata?: Record<string, any>;
  greeting_index?: number;
}

/**
 * Temporary chats are disposable, character-less, persona-less chats used to
 * try out a connection profile. They are excluded from recent-chat lists and
 * swept (deleted) when the user returns to the landing page.
 */
export function isTemporaryChatMetadata(metadata: Record<string, any> | null | undefined): boolean {
  return metadata?.temporary === true;
}

/**
 * Temporary chats may explicitly opt out of presets (metadata.no_preset) to
 * test a model raw: no preset blocks, no preset sampler parameters, and no
 * fallback to the active or connection-bound preset.
 */
export function isNoPresetChatMetadata(metadata: Record<string, any> | null | undefined): boolean {
  return isTemporaryChatMetadata(metadata) && metadata?.no_preset === true;
}

export interface CreateGroupChatInput {
  character_ids: string[];
  name?: string;
  greeting_character_id?: string;
  greeting_index?: number;
}

export interface UpdateChatInput {
  name?: string;
  metadata?: Record<string, any>;
}

export interface RecentChat {
  id: string;
  character_id: string;
  name: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
  character_name: string;
  character_avatar_path: string | null;
  character_image_id: string | null;
}

export interface GroupedRecentChat {
  character_id: string;
  character_name: string;
  character_avatar_path: string | null;
  character_image_id: string | null;
  latest_chat_id: string;
  latest_chat_name: string;
  updated_at: number;
  chat_count: number;
  is_group: boolean;
  group_character_ids?: string[];
  group_name?: string;
}

export interface ChatSummary {
  id: string;
  name: string;
  message_count: number;
  created_at: number;
  updated_at: number;
  /** Truncated (<=280 chars) content of the most recent message, for list previews. */
  last_message_preview: string;
}
