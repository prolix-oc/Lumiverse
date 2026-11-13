export interface MigrationScope {
  characters: boolean;
  worldBooks: boolean;
  personas: boolean;
  chats: boolean;
  groupChats: boolean;
  connections: boolean;
  /** Copy CharacterLibrary's per-character gallery folders and localize media. */
  gallery: boolean;
  repairExisting?: boolean;
  dryRun?: boolean;
}

export interface MigrationResults {
  characters?: { imported: number; skipped: number; failed: number };
  world_books?: { imported: number; skipped: number; failed: number; total_entries: number };
  personas?: { imported: number; skipped?: number; failed: number; avatars_uploaded: number };
  chats?: { imported: number; skipped?: number; failed: number; total_messages: number };
  group_chats?: { imported: number; failed: number; skipped: number; total_messages: number };
  gallery?: {
    imported: number;
    skipped: number;
    failed: number;
    characters_with_gallery: number;
    rewrites: number;
    contested_characters: number;
  };
  connections?: { imported: number; repaired: number; skipped: number; failed: number; dry_run: boolean };
}
