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

  test("keeps bare Tailscale hostnames on the backend port", () => {
    _setTrustedHostsForTests(["machine.tailnet.ts.net"]);

    expect(normalizeHost("machine.tailnet.ts.net")).toBe(`machine.tailnet.ts.net:${env.port}`);
    expect(isHostAllowed(`machine.tailnet.ts.net:${env.port}`)).toBe(true);
    expect(isOriginAllowed(`https://machine.tailnet.ts.net:${env.port}`)).toBe(true);
    expect(isOriginAllowed("https://machine.tailnet.ts.net")).toBe(false);
  });
});
