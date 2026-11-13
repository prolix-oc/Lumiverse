// --- Chat Import ---

export interface BulkMessageInput {
  is_user: boolean;
  name: string;
  content: string;
  send_date?: number;
  swipes?: string[];
  swipe_dates?: number[];
  swipe_id?: number;
  extra?: Record<string, any>;
}

export interface ChatImportRequest {
  character_name: string;
  character_id?: string;
  persona_map?: Record<string, string>;  // persona name → persona_id; auto-sets extra.persona_id on user messages
  chats: Array<{
    name?: string;
    metadata?: Record<string, any>;
    created_at?: number;
    messages: BulkMessageInput[];
  }>;
}

export interface ChatImportResult {
  results: Array<{
    chat_name: string;
    success: boolean;
    chat_id?: string;
    message_count?: number;
    error?: string;
  }>;
  summary: { total: number; imported: number; failed: number };
}

// --- Persona Import ---

export interface PersonaImportRequest {
  personas: Array<{
    name: string;
    title?: string;
    description?: string;
    folder?: string;
    is_default?: boolean;
    attached_world_book_id?: string;
    metadata?: Record<string, any>;
  }>;
}

export interface PersonaImportResult {
  results: Array<{
    name: string;
    success: boolean;
    persona_id?: string;
    error?: string;
  }>;
  summary: { total: number; imported: number; failed: number };
}

// --- World Book Import ---

export interface WorldBookBulkImportRequest {
  world_books: Array<{
    name?: string;
    description?: string;
    entries: any;
  }>;
}

export interface WorldBookBulkImportResult {
  results: Array<{
    name: string;
    success: boolean;
    world_book_id?: string;
    entry_count?: number;
    error?: string;
  }>;
  summary: { total: number; imported: number; failed: number };
}
