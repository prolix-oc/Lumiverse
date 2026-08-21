export interface MigrationScope {
  characters: boolean;
  worldBooks: boolean;
  personas: boolean;
  chats: boolean;
  groupChats: boolean;
  connections: boolean;
  repairExisting?: boolean;
  dryRun?: boolean;
}

export interface MigrationResults {
  characters?: { imported: number; skipped: number; failed: number };
  world_books?: { imported: number; skipped: number; failed: number; total_entries: number };
  personas?: { imported: number; skipped?: number; failed: number; avatars_uploaded: number };
  chats?: { imported: number; skipped?: number; failed: number; total_messages: number };
  group_chats?: { imported: number; failed: number; skipped: number; total_messages: number };
  connections?: { imported: number; repaired: number; skipped: number; failed: number; dry_run: boolean };
}
