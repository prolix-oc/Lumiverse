const GALLERY_PATH_RE = /^\/api\/v1\/characters\/[^/]+\/gallery(?:\/.*)?$/;
const CHARACTER_CARD_REPLACE_PATH_RE = /^\/api\/v1\/characters\/[^/]+\/replace-card$/;
const EXPRESSIONS_ZIP_PATH_RE =
  /^\/api\/v1\/characters\/[^/]+\/expressions\/(?:groups\/[^/]+\/)?upload-zip$/;
const QWEN_CUSTOM_VOICE_UPLOAD_RE =
  /^\/api\/v1\/tts-connections\/[^/]+\/qwen\/custom-voices$/;
const CHARACTER_IMPORT_JOB_FILE_RE =
  /^\/api\/v1\/characters\/import-jobs\/[^/]+\/files\/\d+$/;
const PRESET_UPDATE_PATH_RE = /^\/api\/v1\/presets\/[^/]+$/;

export function isLargeUploadBodyLimitExemptPath(path: string, method?: string): boolean {
  const normalizedMethod = method?.toUpperCase();
  return (
    (normalizedMethod === "POST" && path === "/api/v1/presets") ||
    (normalizedMethod === "PUT" && PRESET_UPDATE_PATH_RE.test(path)) ||
    // OAuth + active capture lease + broker limits bound these base64 uploads.
    (normalizedMethod === "POST" && /^\/api\/desktop\/v1\/capture\/devices\/[^/]+\/responses$/.test(path)) ||
    path.startsWith("/api/v1/migrate/") ||
    path === "/api/v1/characters/import-bulk" ||
    path === "/api/v1/characters/import" ||
    CHARACTER_IMPORT_JOB_FILE_RE.test(path) ||
    CHARACTER_CARD_REPLACE_PATH_RE.test(path) ||
    path.startsWith("/api/v1/world-books/import") ||
    path === "/api/v1/images" ||
    path === "/api/v1/images/wallpapers" ||
    path === "/api/v1/audio" ||
    path === "/api/v1/theme-assets" ||
    path === "/api/v1/settings/saved-themes" ||
    path === "/api/v1/notification-sounds/completion" ||
    GALLERY_PATH_RE.test(path) ||
    EXPRESSIONS_ZIP_PATH_RE.test(path) ||
    QWEN_CUSTOM_VOICE_UPLOAD_RE.test(path) ||
    path === "/api/v1/stt/transcribe" ||
    path === "/api/v1/tts/save-message-audio" ||
    path === "/api/v1/chats/import" ||
    path === "/api/v1/chats/import-st" ||
    path === "/api/v1/st-migration/backup" ||
    (path === "/api/v1/cl-migration/bundles" && normalizedMethod === "PUT") ||
    path === "/api/v1/user-data/import" ||
    path === "/api/v1/spindle-uploads" ||
    path.startsWith("/api/v1/spindle-uploads/")
  );
}
