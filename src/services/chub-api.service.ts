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
