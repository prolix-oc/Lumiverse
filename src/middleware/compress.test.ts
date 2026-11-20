import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { compress } from "./compress";

const app = new Hono();
app.use("*", compress());
app.get("/payload", (c) => c.newResponse("x".repeat(2048), 200, {
  "Content-Type": "application/json",
  ETag: 'W/"preset-1"',
  Vary: "Cookie, Accept-Encoding",
}));
app.get("/not-modified", () => new Response(null, {
  status: 304,
  headers: {
    ETag: 'W/"preset-1"',
    Vary: "Cookie, Accept-Encoding",
  },
}));
app.get("/plain", (c) => c.newResponse("x".repeat(2048), 200, { "Content-Type": "text/plain" }));
app.get("/no-transform", (c) => c.newResponse("x".repeat(2048), 200, {
  "Content-Type": "text/plain", "Cache-Control": "public, No-Transform",
}));
app.get("/range", (c) => c.newResponse("x".repeat(2048), 206, {
  "Content-Type": "text/plain", "Content-Range": "bytes 0-2047/4096",
}));
app.get("/events", (c) => c.newResponse("data: ready\n\n", 200, { "Content-Type": "text/event-stream" }));

describe("compression variants", () => {
  for (const [accept, encoding] of [
    ["br;q=0.9, gzip;q=1", "gzip"],
    ["gzip;q=0.99, deflate;q=1", "deflate"],
    ["gzip;q=0.8, br;q=0.8", "br"],
    ["br;q=0, gzip;q=0, *;q=0.5", "deflate"],
    ["br;q=2, gzip;q=0.7", "gzip"],
    ["br;q=0.5, identity;q=1", null],
    ["gzip;q=0, br;q=0, deflate;q=0", null],
  ] as const) {
    test(`respects encoding preferences: ${accept}`, async () => {
      const response = await app.request("http://localhost/plain", { headers: { "Accept-Encoding": accept } });
      expect(response.headers.get("content-encoding")).toBe(encoding);
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
      if (encoding) {
        // Consume the entire stream and verify the compressed representation.
        const bytes = new Uint8Array(await response.arrayBuffer());
        const { brotliDecompressSync, gunzipSync, inflateSync } = await import("node:zlib");
        const decode = encoding === "br" ? brotliDecompressSync : encoding === "gzip" ? gunzipSync : inflateSync;
        expect(decode(bytes).toString()).toBe("x".repeat(2048));
      } else {
        expect(await response.text()).toBe("x".repeat(2048));
      }
    });
  }

  test("varies identity responses and HEAD metadata by Accept-Encoding", async () => {
    for (const method of ["GET", "HEAD"]) {
      const response = await app.request("http://localhost/plain", { method });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("vary")).toBe("Accept-Encoding");
    }
  });

  test("preserves no-transform, byte-range, and event-stream responses", async () => {
    for (const path of ["/no-transform", "/range", "/events"]) {
      const response = await app.request(`http://localhost${path}`, { headers: { "Accept-Encoding": "br, gzip" } });
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("vary")).toBeNull();
      expect(await response.text()).toBe(path === "/events" ? "data: ready\n\n" : "x".repeat(2048));
    }
  });

  test("preserves a weak validator and deduplicated variant dimensions", async () => {
    const response = await app.request("http://localhost/payload", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(response.headers.get("etag")).toBe('W/"preset-1"');
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  });

  test("does not rewrite 304 variant metadata", async () => {
    const response = await app.request("http://localhost/not-modified", {
      headers: { "Accept-Encoding": "gzip" },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("etag")).toBe('W/"preset-1"');
    expect(response.headers.get("vary")).toBe("Cookie, Accept-Encoding");
  });
});
