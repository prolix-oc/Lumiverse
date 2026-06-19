import { describe, expect, test } from "bun:test";
import {
  describeTransportError,
  parseProviderErrorBody,
  readBoundedText,
  throwProviderResponseError,
  ProviderRequestError,
} from "./provider-errors";

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
