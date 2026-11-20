/** Host additions pending publication in lumiverse-spindle-types. */

/** One image in a character's gallery, as returned by `spindle.characters.getGallery()`. */
export interface CharacterGalleryItemDTO {
  id: string;
  image_id: string;
  /** Portable `gallery://` source for Markdown image embeds. */
  reference: string;
  caption: string;
  sort_order: number;
  created_at: number;
  width: number | null;
  height: number | null;
  mime_type: string;
}

/** One model offered by an LLM connection profile, as returned by `spindle.connections.getModels()`. */
export interface ConnectionModelDTO {
  id: string;
  label: string;
}

export type CharacterGalleryWorkerMessage = {
  type: "characters_get_gallery";
  requestId: string;
  characterId: string;
  userId?: string;
};

export type ConnectionModelsWorkerMessage = {
  type: "connections_models";
  requestId: string;
  connectionId: string;
  userId?: string;
};
