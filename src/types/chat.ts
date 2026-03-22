export interface Chat {
  id: string;
  character_id: string;
  name: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateChatInput {
  character_id: string;
  name?: string;
  metadata?: Record<string, any>;
  greeting_index?: number;
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
}

export interface ChatSummary {
  id: string;
  name: string;
  message_count: number;
  created_at: number;
  updated_at: number;
}
