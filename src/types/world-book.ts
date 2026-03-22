export interface WorldBook {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface WorldBookEntry {
  id: string;
  world_book_id: string;
  uid: string;
  key: string[];
  keysecondary: string[];
  content: string;
  comment: string;
  position: number;
  depth: number;
  role: string | null;
  order_value: number;
  selective: boolean;
  constant: boolean;
  disabled: boolean;
  group_name: string;
  group_override: boolean;
  group_weight: number;
  probability: number;
  scan_depth: number | null;
  case_sensitive: boolean;
  match_whole_words: boolean;
  automation_id: string | null;
  use_regex: boolean;
  prevent_recursion: boolean;
  exclude_recursion: boolean;
  delay_until_recursion: boolean;
  priority: number;
  sticky: number;
  cooldown: number;
  delay: number;
  selective_logic: number;
  use_probability: boolean;
  vectorized: boolean;
  extensions: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateWorldBookInput {
  name: string;
  description?: string;
  metadata?: Record<string, any>;
}

export type UpdateWorldBookInput = Partial<CreateWorldBookInput>;

export interface CreateWorldBookEntryInput {
  key?: string[];
  keysecondary?: string[];
  content?: string;
  comment?: string;
  position?: number;
  depth?: number;
  role?: string;
  order_value?: number;
  selective?: boolean;
  constant?: boolean;
  disabled?: boolean;
  group_name?: string;
  group_override?: boolean;
  group_weight?: number;
  probability?: number;
  scan_depth?: number;
  case_sensitive?: boolean;
  match_whole_words?: boolean;
  automation_id?: string;
  use_regex?: boolean;
  prevent_recursion?: boolean;
  exclude_recursion?: boolean;
  delay_until_recursion?: boolean;
  priority?: number;
  sticky?: number;
  cooldown?: number;
  delay?: number;
  selective_logic?: number;
  use_probability?: boolean;
  vectorized?: boolean;
  extensions?: Record<string, any>;
}

export type UpdateWorldBookEntryInput = CreateWorldBookEntryInput;

// --- World Info Assembly Cache ---

export interface WorldInfoCache {
  before: Array<{ content: string; role: "system" | "user" | "assistant" }>;         // position 0
  after: Array<{ content: string; role: "system" | "user" | "assistant" }>;          // position 1
  anBefore: Array<{ content: string; role: "system" | "user" | "assistant" }>;       // position 2
  anAfter: Array<{ content: string; role: "system" | "user" | "assistant" }>;        // position 3
  depth: Array<{ content: string; depth: number; role: "system" | "user" | "assistant" }>; // position 4
  emBefore: Array<{ content: string; role: "system" | "user" | "assistant" }>;       // position 5
  emAfter: Array<{ content: string; role: "system" | "user" | "assistant" }>;        // position 6
}
