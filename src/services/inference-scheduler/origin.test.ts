import { describe, expect, test } from "bun:test";

import { isLocalEndpointOrigin, normalizeEndpointOrigin } from "./origin";

describe("inference scheduler origin normalization", () => {
  test("strips paths and normalizes casing and default ports", () => {
    expect(normalizeEndpointOrigin("http://LOCALHOST:8080/v1/chat/completions?x=1")).toBe("http://localhost:8080");
    expect(normalizeEndpointOrigin("https://Example.COM/v1/embeddings")).toBe("https://example.com");
    expect(normalizeEndpointOrigin("127.0.0.1:5001/v1")).toBe("http://127.0.0.1:5001");
  });

  test("rejects non-HTTP and unparseable endpoints", () => {
    expect(normalizeEndpointOrigin("")).toBeNull();
    expect(normalizeEndpointOrigin("   ")).toBeNull();
    expect(normalizeEndpointOrigin(null)).toBeNull();
    expect(normalizeEndpointOrigin("file:///tmp/socket")).toBeNull();
    expect(normalizeEndpointOrigin("http://")).toBeNull();
  });

  test("detects loopback, private, and mDNS endpoints as local", () => {
    for (const origin of [
      "http://localhost:8080",
      "http://127.0.0.1:5001",
      "http://127.9.9.9",
      "http://[::1]:8000",
      "http://192.168.1.20:1234",
      "http://10.0.0.4:11434",
      "http://workstation.local:8188",
      "http://host.docker.internal:8080",
    ]) {
      expect(isLocalEndpointOrigin(origin)).toBe(true);
    }
  });

  test("treats public hosts as remote, including when private networking is disabled", () => {
    expect(isLocalEndpointOrigin("https://api.openai.com")).toBe(false);
    expect(isLocalEndpointOrigin("http://192.168.1.20:1234", false)).toBe(false);
    expect(isLocalEndpointOrigin("http://localhost:8080", false)).toBe(true);
  });
});
