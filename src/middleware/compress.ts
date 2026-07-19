/**
 * Streaming compression middleware — Brotli, Gzip, and Deflate.
 *
 * Replaces hono/compress (which only supports gzip/deflate) with full
 * Brotli support via node:zlib streaming and CompressionStream for gzip/deflate.
 *
 * Brotli quality is set to 4 for runtime compression — a good speed/ratio
 * trade-off that avoids blocking the event loop (Bun defaults to 11, which
 * is far too slow for on-the-fly use).
 */

import { createMiddleware } from "hono/factory";
import { createBrotliCompress, constants, gzip as gzipCallback } from "node:zlib";
import { Readable } from "node:stream";

type Encoding = "br" | "gzip" | "deflate";

/** Content-types that benefit from compression. */
const COMPRESSIBLE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-javascript|ecmascript|graphql|wasm|xhtml\+xml|manifest\+json|ld\+json))/i;

/** Don't bother compressing responses smaller than this (bytes). */
const MIN_SIZE = 1024;
const BUFFERED_ASSET_CACHE_LIMIT = 64;
const bufferedAssetCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/**
 * Bun 1.3.14 can corrupt the HTTP response sink when a client aborts an
 * asynchronously streamed response (oven-sh/bun#32111, fixed by #32120).
 * The crash was observed in Lumiverse on Windows when this middleware wrapped
 * the frontend bundle in a compression stream. On that runtime we buffer gzip
 * before returning the response, preserving transfer performance without
 * exposing Bun's HTTP server to an asynchronously pulled response body.
 */
export function shouldBypassStreamingCompression(
  platform: NodeJS.Platform = process.platform,
  bunVersion: string = Bun.version,
): boolean {
  return platform === "win32" && /^1\.3\.14(?:$|-)/.test(bunVersion);
}

/**
 * Pick the best mutually-supported encoding from Accept-Encoding.
 * Tie-break order when quality values are equal: br > gzip > deflate.
 */
function negotiate(
  header: string,
  allowed?: ReadonlySet<Encoding>,
): Encoding | null {
  let best: Encoding | null = null;
  let bestScore = -1;
  const PRIO: Record<string, number> = { br: 3, gzip: 2, deflate: 1 };

  for (const part of header.split(",")) {
    const [raw, ...params] = part.trim().split(";");
    const name = raw?.trim().toLowerCase();
    if (!name || !(name in PRIO)) continue;
    if (allowed && !allowed.has(name as Encoding)) continue;

    let q = 1;
    for (const p of params) {
      const m = p.trim().match(/^q=([\d.]+)$/);
      if (m) q = parseFloat(m[1]!);
    }
    if (q <= 0) continue;

    // Quality dominates; priority breaks ties
    const score = q * 10 + PRIO[name]!;
    if (score > bestScore) {
      bestScore = score;
      best = name as Encoding;
    }
  }
  return best;
}

function gzipBytes(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    gzipCallback(bytes, { level: 4 }, (error, result) => {
      if (error) reject(error);
      else resolve(Uint8Array.from(result));
    });
  });
}

function cacheBufferedAsset(
  key: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const existing = bufferedAssetCache.get(key);
  if (existing) return existing;

  const compressed = gzipBytes(bytes).catch((error) => {
    bufferedAssetCache.delete(key);
    throw error;
  });
  bufferedAssetCache.set(key, compressed);
  if (bufferedAssetCache.size > BUFFERED_ASSET_CACHE_LIMIT) {
    const oldest = bufferedAssetCache.keys().next().value;
    if (oldest !== undefined) bufferedAssetCache.delete(oldest);
  }
  return compressed;
}

async function bufferedGzipResponse(
  response: Response,
  cacheKey?: string,
): Promise<Response> {
  const cached = cacheKey ? bufferedAssetCache.get(cacheKey) : undefined;
  if (cached) {
    try {
      const compressed = await cached;
      const result = new Response(compressed, response);
      result.headers.set("Content-Encoding", "gzip");
      result.headers.delete("Content-Length");
      appendVary(result.headers, "Accept-Encoding");
      return result;
    } catch {
      return response;
    }
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  let compressed: Uint8Array<ArrayBuffer>;
  try {
    compressed = cacheKey
      ? await cacheBufferedAsset(cacheKey, bytes)
      : await gzipBytes(bytes);
  } catch {
    // The original stream has been consumed, so reconstruct the uncompressed
    // response rather than turning a compression failure into a failed request.
    return new Response(bytes, response);
  }

  const result = new Response(compressed, response);
  result.headers.set("Content-Encoding", "gzip");
  result.headers.delete("Content-Length");
  appendVary(result.headers, "Accept-Encoding");
  return result;
}

function appendVary(headers: Headers, field: string): void {
  const existing = headers.get("Vary");
  if (!existing) {
    headers.set("Vary", field);
    return;
  }
  const fields = existing.split(",").map((value) => value.trim());
  if (fields.includes("*") || fields.some((value) => value.toLowerCase() === field.toLowerCase())) return;
  headers.set("Vary", [...fields, field].join(", "));
}

/** Pipe a web ReadableStream through the chosen compressor. */
function compressStream(body: ReadableStream, encoding: Encoding): ReadableStream {
  if (encoding === "br") {
    const nodeIn = Readable.fromWeb(body as any);
    const compressed = nodeIn.pipe(
      createBrotliCompress({
        params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
      })
    );
    return Readable.toWeb(compressed) as unknown as ReadableStream;
  }
  // Gzip and deflate use the native CompressionStream (web standard, streaming)
  return body.pipeThrough(new CompressionStream(encoding));
}

export function compress(runtime?: {
  platform?: NodeJS.Platform;
  bunVersion?: string;
}) {
  return createMiddleware(async (c, next) => {
    await next();

    const res = c.res;

    // Skip: no body, HEAD, already encoded, 204/304
    if (!res.body || c.req.method === "HEAD") return;
    if (res.headers.get("Content-Encoding")) return;
    if (res.status === 204 || res.status === 304) return;

    // Skip non-compressible content types
    const ct = res.headers.get("Content-Type");
    if (!ct || !COMPRESSIBLE.test(ct)) return;

    // Skip small known-size responses (streaming responses have no Content-Length)
    const cl = res.headers.get("Content-Length");
    if (cl && parseInt(cl, 10) < MIN_SIZE) return;

    // Negotiate encoding from client's Accept-Encoding
    const accept = c.req.header("Accept-Encoding");
    if (!accept) return;
    const useBufferedFallback = shouldBypassStreamingCompression(
      runtime?.platform,
      runtime?.bunVersion,
    );
    const encoding = negotiate(
      accept,
      useBufferedFallback ? new Set<Encoding>(["gzip"]) : undefined,
    );
    if (!encoding) return;

    if (useBufferedFallback) {
      const cacheableBundle = c.req.path.startsWith("/assets/") ||
        /^\/api\/v1\/spindle\/[^/]+\/frontend$/.test(c.req.path);
      const cacheKey = cacheableBundle
        ? [
            c.req.path,
            res.headers.get("ETag") ?? "",
            res.headers.get("Last-Modified") ?? "",
            res.headers.get("Content-Length") ?? "",
          ].join("\u0000")
        : undefined;
      c.res = await bufferedGzipResponse(res, cacheKey);
      if (c.res.headers.get("Content-Encoding") === "gzip") {
        c.res.headers.delete("Content-Length");
        appendVary(c.res.headers, "Accept-Encoding");
      }
      return;
    }

    c.res = new Response(compressStream(res.body, encoding), res);
    c.res.headers.set("Content-Encoding", encoding);
    c.res.headers.delete("Content-Length");
    appendVary(c.res.headers, "Accept-Encoding");
  });
}
