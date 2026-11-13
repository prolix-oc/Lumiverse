import { safeFetch } from "../utils/safe-fetch";

const CHUB_API_BASES = ["https://gateway.chub.ai/api", "https://api.chub.ai/api"];

export async function fetchChubJson(path: string): Promise<Record<string, any>> {
  let lastStatus = 0;
  for (const base of CHUB_API_BASES) {
    const res = await safeFetch(`${base}/${path}`, {
      timeoutMs: 15_000,
      maxBytes: 100 * 1024 * 1024,
      headers: { Accept: "application/json", "User-Agent": "Lumiverse" },
    });
    if (res.ok) return await res.json() as Record<string, any>;
    lastStatus = res.status;
  }
  throw new Error(`Chub API returned ${lastStatus || "no response"}`);
}

export function extractChubGalleryUrls(data: unknown): string[] {
  const nodes = Array.isArray((data as { nodes?: unknown })?.nodes)
    ? (data as { nodes: unknown[] }).nodes
    : [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;

    const candidate =
      typeof (node as { primary_image_path?: unknown }).primary_image_path === "string"
        ? (node as { primary_image_path: string }).primary_image_path
        : typeof (node as { image_path?: unknown }).image_path === "string"
          ? (node as { image_path: string }).image_path
          : typeof (node as { url?: unknown }).url === "string"
            ? (node as { url: string }).url
            : null;

    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    urls.push(candidate);
  }

  return urls;
}

export async function fetchChubGalleryUrls(projectId: unknown): Promise<string[]> {
  if (!projectId) return [];
  try {
    const data = await fetchChubJson(`gallery/project/${projectId}`);
    return extractChubGalleryUrls(data);
  } catch {
    return [];
  }
}

export interface ChubExpressionAsset {
  /** Expression name as the pack author wrote it, e.g. "joy", "embarrassment". */
  label: string;
  url: string;
}

/**
 * Pull a character's expression pack out of the card payload.
 *
 * Chub's UI offers expression packs as a separate authenticated zip download,
 * which made these look unreachable — but the labelled image URLs are already
 * present in the `?full=true` response the importer fetches, and the images
 * themselves are public. Nothing extra is requested and no credentials are
 * involved; this only reads a branch of the payload that was previously passed
 * through untouched.
 */
export function extractChubExpressionAssets(node: unknown): ChubExpressionAsset[] {
  const definition = (node as { definition?: unknown })?.definition;
  const chub = (definition as { extensions?: { chub?: unknown } })?.extensions?.chub;
  // The outer object also carries `version`, `is_default` and a `compressed`
  // field; only the inner label→URL map is needed, so an unfamiliar shape
  // around it costs nothing as long as that map is readable.
  const mappings = (chub as { expressions?: { expressions?: unknown } })?.expressions?.expressions;
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings)) return [];

  const assets: ChubExpressionAsset[] = [];
  const seen = new Set<string>();
  for (const [label, value] of Object.entries(mappings as Record<string, unknown>)) {
    const trimmed = label.trim();
    if (!trimmed || typeof value !== "string") continue;
    const url = value.trim();
    // Only absolute https URLs — a relative or data URI here would be
    // unexpected, and safeFetch would reject it downstream anyway.
    if (!url.toLowerCase().startsWith("https://")) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    assets.push({ label: trimmed, url });
  }
  return assets;
}

const CHUB_HOSTS = new Set(["chub.ai", "www.chub.ai", "characterhub.org", "www.characterhub.org"]);

/**
 * Recover the `creator/character` path a card was imported from.
 *
 * Mirrors the frontend's readChubFullPath so a backfill resolves the same
 * source the Identity tab shows. Cards acquired at different times carry it in
 * different places: the portable `chub.full_path` from the card itself, and the
 * `_lumiverse_chub_slug` the URL importer stamps.
 */
export function readChubFullPath(extensions: unknown): string | null {
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return null;
  const ext = extensions as Record<string, unknown>;
  const chub = ext.chub && typeof ext.chub === "object" ? (ext.chub as Record<string, unknown>) : null;

  const raw =
    typeof chub?.full_path === "string" ? chub.full_path
      : typeof chub?.fullPath === "string" ? chub.fullPath
        : typeof ext._lumiverse_chub_slug === "string" ? ext._lumiverse_chub_slug
          : "";

  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (!CHUB_HOSTS.has(parsed.hostname.toLowerCase())) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const start = segments[0]?.toLowerCase() === "characters" ? 1 : 0;
    const creator = segments[start];
    const character = segments[start + 1];
    return creator && character ? `${decodeURIComponent(creator)}/${decodeURIComponent(character)}` : null;
  }

  const cleaned = trimmed.replace(/^\/+|\/+$/g, "");
  // Guard the path segment count so a stray value cannot widen the API path.
  return cleaned.split("/").filter(Boolean).length === 2 ? cleaned : null;
}
