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
function negotiate(
  header: string,
): Encoding | null {
  const qualities = new Map<string, number>();
  for (const part of header.split(",")) {
    const [raw, ...params] = part.trim().split(";");
    const name = raw?.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const p of params) {
      if (!/^q\s*=/i.test(p.trim())) continue;
      const m = p.trim().match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
      q = m ? Number(m[1]) : 0;
    }
    qualities.set(name, q);
  }

  let best: Encoding | null = null;
  let bestQuality = qualities.get("identity") ?? 0;
  // Iterate in preference order, replacing only for a strictly higher q.
  for (const name of ["br", "gzip", "deflate"] as const) {
    const q = qualities.get(name) ?? qualities.get("*") ?? 0;
    if (q <= bestQuality) continue;
    bestQuality = q;
    best = name;
  }
  return best;
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

export function compress() {
  return createMiddleware(async (c, next) => {
    await next();

    const res = c.res;

    // Preserve encoded and partial representations, including byte ranges.
    if (res.headers.get("Content-Encoding")) return;
    if (res.status === 204 || res.status === 206 || res.status === 304) return;
    if (res.headers.has("Content-Range")) return;
    if (res.headers.get("Cache-Control")?.split(",").some((directive) => directive.trim().toLowerCase() === "no-transform")) return;

    // Skip non-compressible content types
    const ct = res.headers.get("Content-Type");
    if (!ct || !COMPRESSIBLE.test(ct)) return;

    // Skip small known-size responses (streaming responses have no Content-Length)
    const cl = res.headers.get("Content-Length");
    if (cl && parseInt(cl, 10) < MIN_SIZE) return;

    // Identity responses are variants too: a shared cache must not reuse an
    // uncompressed response for clients with different encoding preferences.
    appendVary(res.headers, "Accept-Encoding");
    if (!res.body || c.req.method === "HEAD") return;

    // Negotiate encoding from client's Accept-Encoding
    const accept = c.req.header("Accept-Encoding");
    if (!accept) return;
    const encoding = negotiate(accept);
    if (!encoding) return;

    c.res = new Response(compressStream(res.body, encoding), res);
    c.res.headers.set("Content-Encoding", encoding);
    c.res.headers.delete("Content-Length");
  });
}
