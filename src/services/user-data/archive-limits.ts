import { MAX_SAVED_THEMES_VALUE_BYTES } from "../settings-validation";

// Account backups stream to disk and can grow with the account. Keep only
// JavaScript's exact-integer ceiling; available storage bounds real imports.
// Share this with Bun so it cannot reject a backup before the route sees it.
export const MAX_ACCOUNT_ARCHIVE_BYTES = Number.MAX_SAFE_INTEGER;

// Settings validation historically counts UTF-16 code units. Allow the worst
// case UTF-8 expansion so every supported savedThemes value remains portable.
export const MAX_SETTING_VALUE_FILE_BYTES = 3 * MAX_SAVED_THEMES_VALUE_BYTES;
