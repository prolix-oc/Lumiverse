export interface PersonaAddon {
  id: string;
  label: string;
  content: string;
  enabled: boolean;
  sort_order: number;
}

export interface Persona {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar_path: string | null;
  image_id: string | null;
  attached_world_book_id: string | null;
  folder: string;
  is_default: boolean;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreatePersonaInput {
  name: string;
  title?: string;
  description?: string;
  folder?: string;
  is_default?: boolean;
  attached_world_book_id?: string;
  metadata?: Record<string, any>;
}

export type UpdatePersonaInput = Partial<CreatePersonaInput>;
