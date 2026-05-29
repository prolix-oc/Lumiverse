/**
 * Conditional-request (ETag / If-None-Match) helpers for JSON API endpoints.
 *
 * Lets an endpoint return `304 Not Modified` (empty body) when the client
 * already holds the current representation, so unchanged-but-large payloads
 * aren't re-transferred on every cold load / refresh / new tab. Pair an ETag
 * with `Cache-Control: private, no-cache` so the browser always revalidates
 * (never serves stale) but skips the body transfer when the ETag matches.
 */

/** Cache-Control for per-user JSON that must always revalidate but may 304. */
export const REVALIDATE_PRIVATE = "private, no-cache";

/**
 * RFC 7232 If-None-Match evaluation: true when the client's header lists the
 * current etag (or "*"). Handles comma-separated lists and surrounding spaces.
 */
export function ifNoneMatchSatisfies(
  ifNoneMatch: string | null | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch
    .split(",")
    .map((value) => value.trim())
    .some((value) => value === "*" || value === etag);
}
