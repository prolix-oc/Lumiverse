import { describe, expect, test } from "bun:test";
import {
  describeTransportError,
  parseProviderErrorBody,
  readBoundedText,
  throwProviderResponseError,
  ProviderRequestError,
} from "./provider-errors";
import { PROVIDER_STREAM_LIMITS } from "../llm/stream-utils";

describe("describeTransportError", () => {
  test("explains Bun socket disconnects without exposing verbose fetch guidance", () => {
    const message = describeTransportError(
      new Error(
        "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
      ),
    );

    expect(message).toContain("provider connection closed");
    expect(message).toContain("network dropped the stream");
    expect(message).not.toContain("verbose");
  });

  test("uses Error.cause when fetch failed hides the transport detail", () => {
    const cause = new Error("connect ECONNRESET 127.0.0.1:8080");
    const message = describeTransportError(new Error("fetch failed", { cause }));

    expect(message).toBe("connect ECONNRESET 127.0.0.1:8080");
  });
});

describe("parseProviderErrorBody", () => {
  test("strips HTML and truncates to ~500 chars", () => {
    const html = `<html><head><style>body{color:red}</style></head><body>${"X".repeat(5000)}</body></html>`;
    const parsed = parseProviderErrorBody(html);
    expect(parsed.detail).toBeDefined();
    expect(parsed.detail!.length).toBeLessThanOrEqual(500);
    expect(parsed.detail!).not.toContain("<");
    expect(parsed.detail!.endsWith("...")).toBe(true);
  });

  test("truncates JSON error detail too", () => {
    const giant = "X".repeat(5000);
    const parsed = parseProviderErrorBody(JSON.stringify({ error: { message: giant, code: "rate_limited" } }));
    expect(parsed.code).toBe("rate_limited");
    expect(parsed.detail).toBeDefined();
    expect(parsed.detail!.length).toBeLessThanOrEqual(500);
  });

  test("normalizes a top-level error_id before generic error fallbacks", () => {
    const parsed = parseProviderErrorBody(JSON.stringify({
      error: "Invalid session ID. You may need to refresh the page.",
      error_id: " invalid_session_id ",
    }));

    expect(parsed).toEqual({
      code: "invalid_session_id",
      detail: "Invalid session ID. You may need to refresh the page.",
    });
  });

  test("falls back when a top-level error_id is malformed", () => {
    const parsed = parseProviderErrorBody(JSON.stringify({
      error: "Invalid sub-type.",
      error_id: { unexpected: true },
    }));

    expect(parsed).toEqual({
      code: "Invalid sub-type.",
      detail: "Invalid sub-type.",
    });
  });

  test("bounds a top-level error_id", () => {
    const parsed = parseProviderErrorBody(JSON.stringify({
      error: "Invalid sub-type.",
      error_id: "x".repeat(600),
    }));

    expect(parsed.code).toBe(`${"x".repeat(497)}...`);
    expect(parsed.code).toHaveLength(500);
    expect(parsed.detail).toBe("Invalid sub-type.");
  });

  test("returns empty on empty input", () => {
    expect(parseProviderErrorBody("")).toEqual({});
    expect(parseProviderErrorBody("   ")).toEqual({});
  });
});

describe("readBoundedText", () => {
  test("caps the body at maxBytes and marks truncation", async () => {
    const huge = "A".repeat(100_000);
    const res = new Response(huge, { status: 503 });
    const text = await readBoundedText(res, 1024);
    expect(text.length).toBeLessThan(huge.length);
    expect(text.endsWith("…[truncated]")).toBe(true);
  });

  test("returns the full body when under the cap", async () => {
    const res = new Response("short error", { status: 400 });
    const text = await readBoundedText(res, 1024);
    expect(text).toBe("short error");
  });
  test("keeps an error body at the exact byte cap", async () => {
    const body = "X".repeat(32);
    await expect(readBoundedText(new Response(body), 32)).resolves.toBe(body);
  });

  test("detects cap plus one when the extra byte arrives in a later chunk", async () => {
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("X".repeat(32)));
        controller.enqueue(encoder.encode("Y"));
        controller.close();
      },
    }));
    const text = await readBoundedText(response, 32);
    expect(text).toBe(`${"X".repeat(32)}…[truncated]`);
  });

  test("truncates an error body at cap plus one without accumulating the rest", async () => {
    const body = "X".repeat(33);
    const text = await readBoundedText(new Response(body), 32);
    expect(text.startsWith("X".repeat(32))).toBe(true);
    expect(text.endsWith("…[truncated]")).toBe(true);
  });
  test("clamps a caller error-body limit above the provider response ceiling", async () => {
    const host = PROVIDER_STREAM_LIMITS.maxResponseBytes;
    const response = {
      body: null,
      headers: new Headers({ "content-length": String(host + 1) }),
      text: async () => "unreachable",
    } as unknown as Response;
    await expect(readBoundedText(response, host + 1)).rejects.toMatchObject({
      code: "provider_response_too_large",
      limit: host,
    });
  });

  test("honors the caller abort signal while reading an error body", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start() {
        // Keep the first read pending until the caller aborts.
      },
    }));
    const controller = new AbortController();
    const pending = readBoundedText(response, controller.signal, 1024);
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toThrow("Stopped");
  });

  test("fails closed before reading exact or understated bodyless error text", async () => {
    for (const [contentLength, body] of [["2", "{}"], ["2", "{}{}"]] as const) {
      let reads = 0;
      const response = {
        body: null,
        headers: new Headers({ "content-length": contentLength }),
        text: async () => {
          reads += 1;
          return body;
        },
      } as unknown as Response;
      await expect(readBoundedText(response, 3)).rejects.toBeInstanceOf(Error);
      expect(reads).toBe(0);
    }
  });

  test("honors an already-aborted signal without reading a bodyless error", async () => {
    let reads = 0;
    const controller = new AbortController();
    controller.abort(new DOMException("Stopped", "AbortError"));
    const response = {
      body: null,
      headers: new Headers({ "content-length": "2" }),
      text: async () => {
        reads += 1;
        return "{}";
      },
    } as unknown as Response;
    await expect(readBoundedText(response, controller.signal, 2)).rejects.toThrow("Stopped");
    expect(reads).toBe(0);
  });
});


describe("throwProviderResponseError", () => {
  test("never embeds raw HTML body in the thrown error message", async () => {
    const html = `<html><body>${"X".repeat(80_000)}</body></html>`;
    const res = new Response(html, { status: 503, statusText: "Service Unavailable" });
    let caught: unknown;
    try {
      await throwProviderResponseError("NanoGPT", "stream", res);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProviderRequestError);
    const e = caught as ProviderRequestError;
    expect(e.status).toBe(503);
    expect(e.message.length).toBeLessThan(1000);
    expect(e.message).not.toContain("<html");
    expect(e.message).not.toContain("<body");
  });
});
