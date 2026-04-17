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

//reasoning "extra" data - Only support accessing "reasoning" and "reasoning_duration" directly, rather than the 
// whole "extra" object, since it's mostly used for internal use, but "reasoning" goes to message content 
export interface UpdateMessageInput {
  content?: string;
  name?: string;
  extra?: Record<string, any>;    
  swipe_patch?: MessageSwipesPatch;
}

export interface MessageSwipesPatch {
  swipes?: string[];
  swipe_id?: number;
  swipe_dates?: number[];
  //Which field to use for sync - 
  // content : The current swipe is overwritten by the current content before writing
  // swipe: The message content is overwritten by swipes[swipe_id] before writing
  // if omitted, use "content"
  content_sync?: "content" | "swipe";
}

//Set any field to "null" to remove it entirely 
export interface MessageReasoningPatch {
  reasoning?: string | null;
  reasoning_duration?: number | null;
}
