import { describe, expect, test } from "bun:test";
import { resolveServerBrowserUrl } from "./env-config";

describe("resolveServerBrowserUrl", () => {
  test("uses the ordinary loopback URL without direct TLS", () => {
    expect(resolveServerBrowserUrl(7860, false, "https://public.example.test"))
      .toBe("http://localhost:7860");
  });

  test("uses AUTH_BASE_URL as the browser-safe SAN origin with direct TLS", () => {
    expect(resolveServerBrowserUrl(7860, true, "https://chat.example.test"))
      .toBe("https://chat.example.test");
  });

  test("does not invent a localhost HTTPS origin that the certificate may not cover", () => {
    expect(resolveServerBrowserUrl(7860, true)).toBeNull();
    expect(resolveServerBrowserUrl(7860, true, "http://chat.example.test")).toBeNull();
    expect(resolveServerBrowserUrl(7860, true, "https://chat.example.test/path")).toBeNull();
  });
});

