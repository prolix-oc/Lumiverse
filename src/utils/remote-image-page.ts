import { JSDOM } from "jsdom";

const META_IMAGE_KEYS = new Set([
  "og:image",
  "og:image:url",
  "og:image:secure_url",
  "twitter:image",
  "twitter:image:src",
  "image",
]);

const IMAGE_EXTENSION_RE = /\.(?:apng|avif|bmp|gif|jpe?g|jfif|pjp|pjpeg|png|webp)(?:$|[?#])/i;

function toAbsoluteHttpUrl(baseUrl: string, rawUrl: string | null | undefined): string | null {
  const trimmed = rawUrl?.trim();
  if (!trimmed) return null;

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

function scoreCandidate(url: string, pageHost: string): number {
  let score = 0;
  if (IMAGE_EXTENSION_RE.test(url)) score += 4;

  try {
    const parsed = new URL(url);
    if (parsed.hostname === pageHost) score += 1;
    if (parsed.hostname.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${parsed.hostname}`)) score += 1;
  } catch {}

  return score;
}

export function extractRemoteImageUrlFromHtml(pageUrl: string, html: string): string | null {
  const dom = new JSDOM(html, { url: pageUrl });

  try {
    const doc = dom.window.document;
    const pageHost = new URL(pageUrl).hostname;
    const candidates: Array<{ url: string; score: number; order: number }> = [];
    let order = 0;

    for (const meta of doc.querySelectorAll("meta")) {
      const key = (
        meta.getAttribute("property")
        || meta.getAttribute("name")
        || meta.getAttribute("itemprop")
        || ""
      ).trim().toLowerCase();
      if (!META_IMAGE_KEYS.has(key)) continue;

      const candidate = toAbsoluteHttpUrl(pageUrl, meta.getAttribute("content"));
      if (!candidate) continue;
      candidates.push({ url: candidate, score: 10 + scoreCandidate(candidate, pageHost), order: order++ });
    }

    for (const link of doc.querySelectorAll("link")) {
      const rel = (link.getAttribute("rel") || "").trim().toLowerCase();
      if (!rel.split(/\s+/).includes("image_src")) continue;

      const candidate = toAbsoluteHttpUrl(pageUrl, link.getAttribute("href"));
      if (!candidate) continue;
      candidates.push({ url: candidate, score: 8 + scoreCandidate(candidate, pageHost), order: order++ });
    }

    for (const img of doc.querySelectorAll("img[src]")) {
      const candidate = toAbsoluteHttpUrl(pageUrl, img.getAttribute("src"));
      if (!candidate) continue;
      candidates.push({ url: candidate, score: scoreCandidate(candidate, pageHost), order: order++ });
    }

    candidates.sort((a, b) => b.score - a.score || a.order - b.order);
    return candidates[0]?.url || null;
  } finally {
    dom.window.close();
  }
}
