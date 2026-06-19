/** Shared message format for the LumiHub <-> Lumiverse WebSocket protocol. */
export interface LumiHubWSMessage {
  type: string;
  id: string;
  payload?: unknown;
  timestamp: number;
  replyTo?: string;
}

export interface InstallCharacterPayload {
  source: "lumihub" | "chub";
  characterId: string;
  characterName: string;
  /** Full CCSv3 card JSON (for lumihub-sourced characters). */
  cardData?: Record<string, any>;
  /** Base64-encoded avatar image. */
  avatarBase64?: string;
  /** MIME type of the avatar (e.g. "image/png"). */
  avatarMime?: string;
  /** Import URL for Chub-sourced characters. */
  importUrl?: string;
  /** When true, extract the embedded character_book as a standalone worldbook and associate it. */
  importEmbeddedWorldbook?: boolean;
  /** Canonical Chub fullPath slug for manifest matching (e.g. "creator/card-name"). */
  chubSlug?: string;
  /** Gallery image URLs to download and store alongside the character. */
  galleryImageUrls?: string[];
}

export interface InstallResultPayload {
  requestId: string;
  success: boolean;
  characterId?: string;
  characterName?: string;
  error?: string;
  errorCode?: "DUPLICATE" | "PARSE_ERROR" | "STORAGE_ERROR" | "UNKNOWN";
}

export interface InstallWorldbookPayload {
  source: "lumihub" | "chub";
  worldbookId: string;
  worldbookName: string;
  /** Inline worldbook data (for lumihub-sourced). */
  worldbookData?: { name: string; description: string; entries: Record<string, any>[] };
  /** Import URL for Chub-sourced lorebooks. */
  importUrl?: string;
}

export interface InstallWorldbookResultPayload {
  requestId: string;
  success: boolean;
  worldbookId?: string;
  worldbookName?: string;
  error?: string;
}

export interface InstallThemePayload {
  source: "lumihub";
  themeId: string;
  themeName: string;
  /** Export shape returned by LumiHub's /themes/:id/export endpoint. */
  themeData: Record<string, any>;
}

export interface InstallThemeResultPayload {
  requestId: string;
  success: boolean;
  themeId?: string;
  themeName?: string;
  error?: string;
}

export interface InstallPresetPayload {
  source: "lumihub";
  presetId: string;
  presetName: string;
  /** Latest published version label (also present at presetData.preset.presetVersion). */
  presetVersion?: string | null;
  /** Uploader username, for the manifest creator field. */
  presetCreator?: string | null;
  /** Canonical `creator/name` manifest slug computed by the hub, echoed back in the manifest. */
  presetSlug?: string | null;
  /** Export shape returned by LumiHub's /presets/:id/export endpoint. */
  presetData: Record<string, any>;
}

export interface InstallPresetResultPayload {
  requestId: string;
  success: boolean;
  presetId?: string;
  presetName?: string;
  error?: string;
}

export interface ManifestSyncPayload {
  entries: Array<{
    slug: string;
    type: "character" | "worldbook" | "theme" | "preset";
    name: string;
    creator: string;
    source: "local" | "chub" | "lumihub";
    /** Installed version label (presets), enabling the hub to detect outdated installs. */
    version?: string;
    installed_at: number;
  }>;
}
