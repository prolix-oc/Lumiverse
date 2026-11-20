import { safeFetch } from "../utils/safe-fetch";

const BOTBOORU_ORIGIN = "https://botbooru.com";
const MAX_GALLERY_IMAGES = 50;

/**
 * Extract full-resolution, approved mini-gallery image URLs from BotBooru's
 * public post gallery response. BotBooru returns root-relative URLs, so keep
 * resolution pinned to its own origin instead of accepting arbitrary hosts.
 */
export function extractBotBooruGalleryUrls(data: unknown): string[] {
  const images = Array.isArray((data as { images?: unknown })?.images)
    ? (data as { images: unknown[] }).images
    : [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const image of images) {
    if (!image || typeof image !== "object") continue;
    if ((image as { status?: unknown }).status !== "approved") continue;

    const candidate =
      typeof (image as { download_url?: unknown }).download_url === "string"
        ? (image as { download_url: string }).download_url
        : typeof (image as { url?: unknown }).url === "string"
          ? (image as { url: string }).url
          : null;
    if (!candidate) continue;

    let parsed: URL;
    try {
      parsed = new URL(candidate, BOTBOORU_ORIGIN);
    } catch {
      continue;
    }
    if (parsed.origin !== BOTBOORU_ORIGIN || seen.has(parsed.href)) continue;

    seen.add(parsed.href);
    urls.push(parsed.href);
    if (urls.length >= MAX_GALLERY_IMAGES) break;
  }

  return urls;
}

/** Fetch the public mini-gallery for a BotBooru character/post id. */
export async function fetchBotBooruGalleryUrls(postId: string): Promise<string[]> {
  try {
    const res = await safeFetch(
      `${BOTBOORU_ORIGIN}/api/posts/${encodeURIComponent(postId)}/mini-gallery`,
      {
        timeoutMs: 15_000,
        maxBytes: 1024 * 1024,
        headers: { Accept: "application/json", "User-Agent": "Lumiverse" },
      },
    );
    if (!res.ok) return [];
    return extractBotBooruGalleryUrls(await res.json());
  } catch {
    // Gallery discovery is best-effort and must never fail a card import.
    return [];
  }
}
