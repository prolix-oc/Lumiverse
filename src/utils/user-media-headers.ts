/**
 * Hardening headers for every route that serves user-uploaded bytes.
 *
 * Threat: a user uploads active content (SVG with embedded <script>, HTML)
 * and shares the serving URL. When a victim navigates directly, the file
 * executes in the app's origin — stored XSS with full session access.
 * `X-Content-Type-Options: nosniff` alone does NOT prevent this: an SVG
 * served as image/svg+xml runs its scripts on direct navigation.
 *
 * Defense (layered):
 *  1. A resource-level CSP with `sandbox` (no allow-scripts) makes any
 *     directly-navigated document script-free and opaque-origin. Embedded
 *     usage (<img>, <video>, CSS backgrounds) is unaffected — resource-level
 *     CSP does not constrain those contexts, and SVG-as-<img> never executes
 *     scripts anyway.
 *  2. Known-active types (HTML/XHTML) are demoted to an inert octet-stream
 *     download; they have no legitimate inline-rendering use here.
 */

/** Media types that may be served with their real Content-Type. */
const SAFE_INLINE_MEDIA_RE =
  /^(?:image\/(?:avif|bmp|gif|jpeg|jpg|png|apng|webp|svg\+xml)|video\/|audio\/)/;

/** Types that must never render inline — forced to an inert download. */
const ACTIVE_CONTENT_RE = /^(?:text\/html|application\/xhtml\+xml)\b/i;

export interface UserMediaServingHeaders extends Record<string, string> {}

export function classifyUserMediaContentType(
  contentType: string | null | undefined,
): "safe" | "active" | "unknown" {
  const base = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!base || base === "application/octet-stream") return "unknown";
  if (ACTIVE_CONTENT_RE.test(base)) return "active";
  return SAFE_INLINE_MEDIA_RE.test(base) ? "safe" : "unknown";
}

/**
 * Extra headers to merge into a response that serves user-uploaded bytes.
 * Callers keep control of Cache-Control / Content-Length / ranges; this only
 * adds the XSS boundary.
 */
export function userMediaServingHeaders(
  contentType: string | null | undefined,
): UserMediaServingHeaders {
  const kind = classifyUserMediaContentType(contentType);
  const headers: UserMediaServingHeaders = {
    "X-Content-Type-Options": "nosniff",
    // `sandbox` without allow-scripts: direct navigation gets no JS, no
    // same-origin access, no form/navigation powers. Inline SVG styling still
    // renders via style-src 'unsafe-inline'.
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'; font-src 'self'; sandbox",
  };
  if (kind === "active") {
    headers["Content-Type"] = "application/octet-stream";
    headers["Content-Disposition"] = "attachment";
  }
  return headers;
}
