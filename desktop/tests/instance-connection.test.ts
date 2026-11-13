import { describe, expect, test } from "bun:test";
import { normalizeInstanceConnection, normalizeRemoteOrigin, savedConnectionPreferences } from "../src/instance-connection";

describe("remote instance origins", () => {
  test("canonicalizes a secure URL to its origin", () => {
    expect(normalizeRemoteOrigin(" https://example.com/some/page?x=1 ")).toBe("https://example.com");
  });

  test("allows insecure HTTP only for loopback development", () => {
    expect(normalizeRemoteOrigin("http://localhost:7860/app")).toBe("http://localhost:7860");
    expect(() => normalizeRemoteOrigin("http://192.168.1.2:7860")).toThrow("must use HTTPS");
  });

  test("rejects embedded credentials", () => {
    expect(() => normalizeRemoteOrigin("https://user:secret@example.com")).toThrow("must not contain");
  });
});

describe("saved connection migration", () => {
  test("a fresh profile requires an explicit connection choice", () => {
    expect(savedConnectionPreferences(undefined, undefined)).toEqual({
      connection: { mode: "local" }, configured: false, remote: null,
    });
  });

  test("existing remote and legacy sessions are already configured", () => {
    const remote = { mode: "remote", origin: "https://example.com", instanceId: "existing", displayName: "My server" };
    expect(savedConnectionPreferences(remote, null)).toEqual({ connection: remote, configured: true, remote });
    expect(savedConnectionPreferences(undefined, null, "https://example.com/chat")).toEqual({
      connection: { mode: "remote", origin: "https://example.com" },
      configured: true, remote: { mode: "remote", origin: "https://example.com" },
    });
  });

  test("using local preserves the remote address and server identity", () => {
    const remote = { mode: "remote", origin: "https://example.com", instanceId: "existing", displayName: "My server" };
    expect(savedConnectionPreferences({ mode: "local" }, remote)).toEqual({
      connection: { mode: "local" }, configured: true, remote,
    });
  });

  test("invalid persisted remote URLs require a new connection choice", () => {
    expect(savedConnectionPreferences({ mode: "remote", origin: "javascript:alert(1)" }, undefined)).toEqual({
      connection: { mode: "local" }, configured: false, remote: null,
    });
  });

  test("migrates the former custom URL setting", () => {
    expect(normalizeInstanceConnection(undefined, "https://example.com/chat")).toEqual({
      mode: "remote",
      origin: "https://example.com",
    });
  });

  test("falls back safely when persisted data is invalid", () => {
    expect(normalizeInstanceConnection({ mode: "remote", origin: "javascript:alert(1)" })).toEqual({ mode: "local" });
  });
});
