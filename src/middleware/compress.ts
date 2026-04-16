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
import { createBrotliCompress, constants } from "node:zlib";
import { Readable } from "node:stream";

type Encoding = "br" | "gzip" | "deflate";

/** Content-types that benefit from compression. */
const COMPRESSIBLE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|x-javascript|ecmascript|graphql|wasm|xhtml\+xml|manifest\+json|ld\+json))/i;

/** Don't bother compressing responses smaller than this (bytes). */
const MIN_SIZE = 1024;

/**
 * Pick the best mutually-supported encoding from Accept-Encoding.
 * Tie-break order when quality values are equal: br > gzip > deflate.
 */
function negotiate(header: string): Encoding | null {
  let best: Encoding | null = null;
  let bestScore = -1;
  const PRIO: Record<string, number> = { br: 3, gzip: 2, deflate: 1 };

  for (const part of header.split(",")) {
    const [raw, ...params] = part.trim().split(";");
    const name = raw?.trim().toLowerCase();
    if (!name || !(name in PRIO)) continue;

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

export function compress() {
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
    const encoding = negotiate(accept);
    if (!encoding) return;

    c.res = new Response(compressStream(res.body, encoding), res);
    c.res.headers.set("Content-Encoding", encoding);
    c.res.headers.delete("Content-Length");
    c.res.headers.append("Vary", "Accept-Encoding");
  });
}
