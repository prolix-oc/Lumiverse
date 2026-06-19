export interface Character {
  id: string;
  name: string;
  avatar_path: string | null;
  image_id: string | null;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  tags: string[];
  alternate_greetings: string[];
  extensions: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateCharacterInput {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  tags?: string[];
  alternate_greetings?: string[];
  extensions?: Record<string, any>;
  created_at?: number;
}

export type UpdateCharacterInput = Partial<CreateCharacterInput>;

/** Sentinel id for the synthetic character backing character-less chats. */
export const ASSISTANT_CHARACTER_ID = "__assistant__";

/**
 * Synthetic stand-in for temporary character-less chats so prompt assembly,
 * macros, and attribution run unchanged. Never persisted; the sentinel id
 * matches no DB row, so character-bound lookups (world books, databanks,
 * preset bindings) naturally resolve to nothing.
 */
export function makeAssistantCharacter(): Character {
  return {
    id: ASSISTANT_CHARACTER_ID,
    name: "Assistant",
    avatar_path: null,
    image_id: null,
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    creator: "",
    creator_notes: "",
    system_prompt: "",
    post_history_instructions: "",
    tags: [],
    alternate_greetings: [],
    extensions: {},
    created_at: 0,
    updated_at: 0,
  };
}

/**
 * Returns the effective name used for prompt/macro resolution.
 * Uses `extensions.alternate_character_name` if set, otherwise falls back to the true name.
 */
export function getEffectiveCharacterName(character: Character): string {
  return (character.extensions?.alternate_character_name as string)?.trim() || character.name;
}

export interface CharacterSummary {
  id: string;
  name: string;
  creator: string;
  tags: string[];
  image_id: string | null;
  created_at: number;
  updated_at: number;
  has_alternate_greetings: boolean;
}
