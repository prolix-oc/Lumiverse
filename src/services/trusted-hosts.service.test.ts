import { beforeEach, describe, expect, test } from "bun:test";
import { env } from "../env";
import {
  _resetForTests,
  _setTrustedHostsForTests,
  isHostAllowed,
  isOriginAllowed,
  normalizeHost,
} from "./trusted-hosts.service";

describe("trusted host origin normalization", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("preserves explicitly configured Tailscale HTTPS origins", () => {
    _setTrustedHostsForTests(["https://machine.tailnet.ts.net"]);

    expect(normalizeHost("https://machine.tailnet.ts.net")).toBe("https://machine.tailnet.ts.net");
    expect(isHostAllowed("machine.tailnet.ts.net")).toBe(true);
    expect(isOriginAllowed("https://machine.tailnet.ts.net")).toBe(true);
    expect(isOriginAllowed(`https://machine.tailnet.ts.net:${env.port}`)).toBe(false);
    expect(isOriginAllowed("http://machine.tailnet.ts.net")).toBe(false);
  });

  test("preserves explicitly configured reverse-proxy HTTPS origins without backend ports", () => {
    _setTrustedHostsForTests(["https://lumiverse.example.com"]);

    expect(normalizeHost("https://lumiverse.example.com")).toBe("https://lumiverse.example.com");
    expect(isHostAllowed("lumiverse.example.com")).toBe(true);
    expect(isOriginAllowed("https://lumiverse.example.com")).toBe(true);
    expect(isOriginAllowed(`https://lumiverse.example.com:${env.port}`)).toBe(false);
    expect(isOriginAllowed("http://lumiverse.example.com")).toBe(false);
  });

  test("preserves explicit reverse-proxy origins with non-default ports", () => {
    _setTrustedHostsForTests(["https://lumiverse.example.com:8443"]);

    expect(normalizeHost("https://lumiverse.example.com:8443")).toBe("https://lumiverse.example.com:8443");
    expect(isHostAllowed("lumiverse.example.com:8443")).toBe(true);
    expect(isOriginAllowed("https://lumiverse.example.com:8443")).toBe(true);
    expect(isOriginAllowed("https://lumiverse.example.com")).toBe(false);
  });

  test("keeps bare Tailscale hostnames on the backend port", () => {
    _setTrustedHostsForTests(["machine.tailnet.ts.net"]);

    expect(normalizeHost("machine.tailnet.ts.net")).toBe(`machine.tailnet.ts.net:${env.port}`);
    expect(isHostAllowed(`machine.tailnet.ts.net:${env.port}`)).toBe(true);
    expect(isOriginAllowed(`https://machine.tailnet.ts.net:${env.port}`)).toBe(true);
    expect(isOriginAllowed("https://machine.tailnet.ts.net")).toBe(false);
  });
});
