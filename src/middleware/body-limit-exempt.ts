const GALLERY_PATH_RE = /^\/api\/v1\/characters\/[^/]+\/gallery(?:\/.*)?$/;
const EXPRESSIONS_ZIP_PATH_RE =
  /^\/api\/v1\/characters\/[^/]+\/expressions\/(?:groups\/[^/]+\/)?upload-zip$/;

export function isLargeUploadBodyLimitExemptPath(path: string): boolean {
  return (
    path.startsWith("/api/v1/migrate/") ||
    path === "/api/v1/characters/import-bulk" ||
    path === "/api/v1/characters/import" ||
    path.startsWith("/api/v1/world-books/import") ||
    path === "/api/v1/images" ||
    path === "/api/v1/images/wallpapers" ||
    path === "/api/v1/theme-assets" ||
    path === "/api/v1/notification-sounds/completion" ||
    GALLERY_PATH_RE.test(path) ||
    EXPRESSIONS_ZIP_PATH_RE.test(path) ||
    path === "/api/v1/stt/transcribe" ||
    path === "/api/v1/tts/save-message-audio" ||
    path === "/api/v1/chats/import" ||
    path === "/api/v1/chats/import-st" ||
    path === "/api/v1/user-data/import" ||
    path === "/api/v1/spindle-uploads" ||
    path.startsWith("/api/v1/spindle-uploads/")
  );
}
