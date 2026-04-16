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
}

export type UpdateCharacterInput = Partial<CreateCharacterInput>;

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
