export interface PersonaAddon {
  id: string;
  label: string;
  content: string;
  enabled: boolean;
  sort_order: number;
  /** Optional persona-specific avatar selected while this add-on is active. */
  avatar_image_id?: string;
  /** Optional cropped variant of avatar_image_id, preferred for avatar rendering. */
  avatar_crop_image_id?: string;
}

/**
 * A reference to a reusable global add-on as attached to one persona. Avatar
 * overrides intentionally live here, rather than on the shared add-on, so the
 * same global text can represent a different look on each persona.
 */
export interface AttachedGlobalPersonaAddon {
  id: string;
  enabled: boolean;
  avatar_image_id?: string;
  avatar_crop_image_id?: string;
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  description: string;
  subjective_pronoun: string;
  objective_pronoun: string;
  possessive_pronoun: string;
  avatar_path: string | null;
  image_id: string | null;
  attached_world_book_id: string | null;
  folder: string;
  is_default: boolean;
  is_narrator: boolean;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreatePersonaInput {
  name: string;
  title?: string;
  description?: string;
  subjective_pronoun?: string;
  objective_pronoun?: string;
  possessive_pronoun?: string;
  folder?: string;
  is_default?: boolean;
  is_narrator?: boolean;
  attached_world_book_id?: string | null;
  metadata?: Record<string, any>;
}

export type UpdatePersonaInput = Partial<CreatePersonaInput>;

export interface GlobalAddon {
  id: string;
  label: string;
  content: string;
  sort_order: number;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateGlobalAddonInput {
  label: string;
  content?: string;
  sort_order?: number;
  metadata?: Record<string, any>;
}

export type UpdateGlobalAddonInput = Partial<CreateGlobalAddonInput>;
