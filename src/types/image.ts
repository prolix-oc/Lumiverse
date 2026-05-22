export interface Image {
  id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
  url: string;
  specificity: "full" | "sm" | "lg";
  owner_extension_identifier: string | null;
  owner_character_id: string | null;
  owner_chat_id: string | null;
  created_at: number;
}
