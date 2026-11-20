import { userMediaServingHeaders } from "./user-media-headers";

const AVATAR_RESOLVER_CACHE_CONTROL = "private, no-cache";

function buildAvatarResolverEtag(identity: string | null | undefined): string {
  const normalized = (identity ?? "none").replace(/[^A-Za-z0-9._-]/g, "_");
  return `"avatar-${normalized}"`;
}

function requestMatchesEtag(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;

  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}

export function createAvatarResolverResponse(
  filepath: string,
  avatarIdentity: string | null | undefined,
  ifNoneMatch?: string
): Response {
  const etag = buildAvatarResolverEtag(avatarIdentity);

  if (requestMatchesEtag(ifNoneMatch, etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        "Cache-Control": AVATAR_RESOLVER_CACHE_CONTROL,
        ETag: etag,
      },
    });
  }

  const response = new Response(Bun.file(filepath));
  response.headers.set("Cache-Control", AVATAR_RESOLVER_CACHE_CONTROL);
  response.headers.set("ETag", etag);
  // Avatars are user-controlled bytes: apply the stored-XSS boundary even
  // though this resolver previously served with no security headers at all.
  for (const [key, value] of Object.entries(userMediaServingHeaders(response.headers.get("Content-Type")))) {
    response.headers.set(key, value);
  }
  return response;
}
