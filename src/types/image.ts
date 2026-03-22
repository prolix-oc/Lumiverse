export interface Image {
  id: string;
  filename: string;
  original_filename: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  has_thumbnail: boolean;
  created_at: number;
}
