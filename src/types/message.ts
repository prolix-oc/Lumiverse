export interface MessageAttachment {
  type: "image" | "audio";
  image_id: string;           // FK to images table (used for both image and audio)
  mime_type: string;          // e.g. "image/png", "audio/wav"
  original_filename: string;
  width?: number;             // images only
  height?: number;            // images only
}

export interface Message {
  id: string;
  chat_id: string;
  index_in_chat: number;
  is_user: boolean;
  name: string;
  content: string;
  send_date: number;
  swipe_id: number;
  swipes: string[];
  swipe_dates: number[];
  extra: Record<string, any>;
  parent_message_id: string | null;
  branch_id: string | null;
  created_at: number;
}

export interface CreateMessageInput {
  is_user: boolean;
  name: string;
  content: string;
  extra?: Record<string, any>;
  parent_message_id?: string;
  branch_id?: string;
}

export interface UpdateMessageInput {
  content?: string;
  name?: string;
  extra?: Record<string, any>;
  /** Replace the entire swipes array. Must be non-empty. */
  swipes?: string[];
  /** Navigate to a specific swipe slot. Must satisfy `0 <= swipe_id < swipes.length`. */
  swipe_id?: number;
  /** Replace the per-swipe date array. Must have the same length as `swipes`. */
  swipe_dates?: number[];
  /** Internal-only escape hatch for extension/system rewrites that should not invalidate chat chunks. */
  skipChunkRebuild?: boolean;
}
