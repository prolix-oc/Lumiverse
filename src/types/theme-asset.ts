export interface ThemeAsset {
  id: string;
  bundle_id: string;
  slug: string;
  storage_type: "image" | "file";
  image_id: string | null;
  file_name: string | null;
  original_filename: string;
  mime_type: string;
  byte_size: number;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}
