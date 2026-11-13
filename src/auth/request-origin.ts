import {
  DESKTOP_OAUTH_CONFIGURED_ORIGIN,
  DESKTOP_OAUTH_FALLBACK_ORIGIN,
} from "./desktop-oauth";
import {
  isHostAllowed as isConfiguredHostAllowed,
  isOriginAllowed as isConfiguredOriginAllowed,
} from "../services/trusted-hosts.service";

export interface OriginResolutionOptions {
  trustForwarded: boolean;
  fallbackOrigin: string;
  isHostAllowed: (host: string) => boolean;
  isOriginAllowed: (origin: string) => boolean;
}

function singleHeaderValue(value: string | null): string | null {
  if (!value || value.includes(",") || /[\s/@\\]/.test(value)) return null;
  return value.toLowerCase();
}

/** Resolve an external origin without ever accepting an unapproved host/scheme pair. */
export function resolveApprovedOriginFromRequest(
  request: Request,
  options: OriginResolutionOptions,
): string {
  const requestUrl = new URL(request.url);
  const rawForwardedHost = options.trustForwarded
    ? request.headers.get("x-forwarded-host")
    : null;
  const rawHeaderHost = request.headers.get("host");
  const host = rawForwardedHost !== null
    ? singleHeaderValue(rawForwardedHost)
    : rawHeaderHost !== null
      ? singleHeaderValue(rawHeaderHost)
      : singleHeaderValue(requestUrl.host);
  if (!host || !options.isHostAllowed(host)) return options.fallbackOrigin;

  const rawForwardedProto = options.trustForwarded
    ? request.headers.get("x-forwarded-proto")
    : null;
  const forwardedProto = rawForwardedProto === null
    ? null
    : singleHeaderValue(rawForwardedProto);
  if (rawForwardedProto !== null && forwardedProto === null) {
    return options.fallbackOrigin;
  }
  const protocol = forwardedProto === "http" || forwardedProto === "https"
    ? `${forwardedProto}:`
    : requestUrl.protocol;
  if (protocol !== "http:" && protocol !== "https:") return options.fallbackOrigin;

  const origin = new URL(`${protocol}//${host}`).origin;
  if (options.isOriginAllowed(origin)) return origin;

  // A TLS-terminating proxy may preserve Host while the backend Request URL is
  // HTTP. When that hostname was approved only as an explicit HTTPS origin,
  // prefer the approved scheme. This never downgrades HTTPS and never infers a
  // scheme for an unapproved host.
  if (rawForwardedProto === null && protocol === "http:") {
    const httpsOrigin = new URL(`https://${host}`).origin;
    if (options.isOriginAllowed(httpsOrigin)) return httpsOrigin;
  }
  return options.fallbackOrigin;
}

/**
 * Resolve the issuer-facing origin for a request. AUTH_BASE_URL remains an
 * explicit override; dynamic mode is constrained by the Operator host list.
 */
export function resolveDesktopRequestOrigin(
  request: Request,
  trustForwarded: boolean,
): string {
  if (DESKTOP_OAUTH_CONFIGURED_ORIGIN) return DESKTOP_OAUTH_CONFIGURED_ORIGIN;
  return resolveApprovedOriginFromRequest(request, {
    trustForwarded,
    fallbackOrigin: DESKTOP_OAUTH_FALLBACK_ORIGIN,
    isHostAllowed: isConfiguredHostAllowed,
    isOriginAllowed: isConfiguredOriginAllowed,
  });
}

/** Remove proxy headers after resolving them so downstream code cannot reinterpret them. */
export function requestAtResolvedOrigin(
  request: Request,
  origin: string,
  pathname: string,
): Request {
  const target = new URL(pathname, `${origin}/`);
  const rewritten = new Request(target, request);
  rewritten.headers.delete("host");
  rewritten.headers.delete("forwarded");
  rewritten.headers.delete("x-forwarded-host");
  rewritten.headers.delete("x-forwarded-proto");
  rewritten.headers.delete("x-forwarded-port");
  return rewritten;
}

/**
 * Give session lookups the approved transport without forwarding the API body.
 * Reconstructing a Request from the incoming upload also retains a second,
 * unread body in Bun. That copy grows with the entire archive even when the
 * route streams its own body straight to disk. Session checks need only the
 * origin and headers; the HTTP auth handler above still forwards its body.
 */
export function approvedAuthRequest(request: Request, trustForwarded: boolean): Request {
  const url = new URL(request.url);
  const sessionRequest = new Request(request.url, { headers: request.headers });
  sessionRequest.headers.delete("content-length");
  sessionRequest.headers.delete("transfer-encoding");
  return requestAtResolvedOrigin(sessionRequest, resolveDesktopRequestOrigin(request, trustForwarded), url.pathname + url.search);
}
