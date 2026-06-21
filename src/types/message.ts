export interface MessageAttachment {
  type: "image" | "audio";
  image_id: string;           // FK to images table (used for both image and audio)
  mime_type: string;          // e.g. "image/png", "audio/wav"
  original_filename: string;
  width?: number;             // images only
  height?: number;            // images only
  /** Image-only: bounded WebP data URL for multiplayer peers that cannot fetch the host's image row. */
  relay_preview_url?: string;
  /**
   * Audio-only: the message swipe this audio was generated for. Audio is
   * a per-swipe artifact (regenerating a swipe should not invalidate the
   * audio of another swipe). When set, the player is only visible when
   * `message.swipe_id` matches. Undefined on legacy audio (saved before
   * this field existed) and on images — interpreted as "applies to all
   * swipes" so we don't strand any pre-existing recordings.
   */
  swipe_id?: number;
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
  /** Write `content` to this swipe slot instead of the active swipe, WITHOUT
   *  moving `swipe_id`. Used by the generation pipeline to finalize a swipe the
   *  user may have navigated away from mid-stream. Defaults to the active swipe;
   *  ignored if out of range. */
  contentSwipeId?: number;
  /** Internal-only escape hatch for extension/system rewrites that should not invalidate chat chunks. */
  skipChunkRebuild?: boolean;
  /** Internal-only escape hatch when this update is the generation pipeline
   * finalizing its own staged/continued message. The council deliberation
   * cache was just written for this generation and is still valid for any
   * follow-up regen/swipe — clearing it here would defeat "Retain Results
   * for Regens/Swipes". The fingerprint hash in generate.service already
   * invalidates stale cache on read when chat state actually diverges. */
  skipCouncilCacheInvalidation?: boolean;
}
