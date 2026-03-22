export interface CharacterGalleryItem {
  id: string;
  image_id: string;
  caption: string;
  sort_order: number;
  created_at: number;
  // Joined from images table (needed for mosaic layout):
  width: number | null;
  height: number | null;
  mime_type: string;
}
