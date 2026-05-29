/**
 * BotBooru (botbooru.com) URL normalization for character / world-book imports.
 *
 * BotBooru exposes public character cards via GET-only download endpoints:
 *   - GET https://botbooru.com/download/png/{id}   → SillyTavern-compatible PNG card
 *   - GET https://botbooru.com/download/json/{id}  → chara_card_v2 JSON
 *
 * Browseable URLs (/character/{id}, /post/{id}) and the two download URLs all
 * carry the same {id}. We normalize any recognized shape down to a single
 * download URL so the existing generic URL importer can handle the fetch.
 * No auth token is required, and the download endpoints 405 on HEAD — but
 * safeFetch is GET-only, so that constraint is satisfied automatically.
 */

const BOTBOORU_HOSTS = new Set(["botbooru.com", "www.botbooru.com"]);

// Ids are simple booru slugs/numbers. Restricting the charset means a
// normalized download URL can never be coerced into a different path.
const BOTBOORU_ID_RE = /^[A-Za-z0-9._~-]+$/;

/** Extract the post/character id from a recognized BotBooru URL, or null. */
export function parseBotBooruId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (!BOTBOORU_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);

  // /character/{id} or /post/{id}
  if (segments.length === 2 && (segments[0] === "character" || segments[0] === "post")) {
    return cleanId(segments[1]);
  }
  // /download/png/{id} or /download/json/{id}
  if (
    segments.length === 3 &&
    segments[0] === "download" &&
    (segments[1] === "png" || segments[1] === "json")
  ) {
    return cleanId(segments[2]);
  }
  return null;
}

function cleanId(raw: string): string | null {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    id = raw;
  }
  return BOTBOORU_ID_RE.test(id) ? id : null;
}

/** Build the canonical GET download URL for a BotBooru id. */
export function botBooruDownloadUrl(id: string, format: "png" | "json"): string {
  return `https://botbooru.com/download/${format}/${encodeURIComponent(id)}`;
}

/**
 * If `url` is a recognized BotBooru URL, rewrite it to the canonical download
 * URL for the requested format. Returns null for non-BotBooru URLs so callers
 * can fall through to their existing handling.
 *
 * - Characters import best from `png` (embeds a SillyTavern card *and* an avatar).
 * - World books import from `json` (the embedded lorebook is extracted downstream).
 */
export function rewriteBotBooruUrl(url: string, format: "png" | "json"): string | null {
  const id = parseBotBooruId(url);
  return id ? botBooruDownloadUrl(id, format) : null;
}
