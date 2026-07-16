import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { compress, shouldBypassStreamingCompression } from "./compress";

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

describe("compression cache variants", () => {
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

describe("Bun streaming-response compatibility", () => {
  test("uses the buffered fallback only on the affected Windows stable runtime", () => {
    expect(shouldBypassStreamingCompression("win32", "1.3.14")).toBe(true);
    expect(shouldBypassStreamingCompression("win32", "1.3.14-debug")).toBe(true);

    expect(shouldBypassStreamingCompression("darwin", "1.3.14")).toBe(false);
    expect(shouldBypassStreamingCompression("linux", "1.3.14")).toBe(false);
    expect(shouldBypassStreamingCompression("win32", "1.3.13")).toBe(false);
    expect(shouldBypassStreamingCompression("win32", "1.3.15")).toBe(false);
    expect(shouldBypassStreamingCompression("win32", "1.4.0")).toBe(false);
  });

  test("returns fixed gzip bytes for affected Windows frontend assets", async () => {
    const fallbackApp = new Hono();
    fallbackApp.use("*", compress({ platform: "win32", bunVersion: "1.3.14" }));
    const source = "const frontendBundle = true;".repeat(128);
    fallbackApp.get("/assets/frontend.js", (c) => c.newResponse(source, 200, {
      "Content-Type": "application/javascript",
      "Content-Length": String(source.length),
      ETag: '"frontend-test"',
    }));

    const response = await fallbackApp.request("http://localhost/assets/frontend.js", {
      headers: { "Accept-Encoding": "br, gzip" },
    });
    const compressed = new Uint8Array(await response.arrayBuffer());

    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("content-length")).toBeNull();
    expect(new TextDecoder().decode(Bun.gunzipSync(compressed))).toBe(source);
  });
});
