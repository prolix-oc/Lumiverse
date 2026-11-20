import { describe, expect, test } from "bun:test";
import {
  ipMatchesRule,
  parseCidrRule,
  parseIp,
  selectForwardedClientIp,
} from "./client-ip";

describe("parseIp", () => {
  test("parses IPv4", () => {
    const parsed = parseIp("192.168.1.10");
    expect(parsed?.family).toBe(4);
    expect(parsed?.value).toBe((192n << 24n) | (168n << 16n) | (1n << 8n) | 10n);
  });

  test("rejects malformed IPv4", () => {
    expect(parseIp("1.2.3")).toBeNull();
    expect(parseIp("1.2.3.999")).toBeNull();
    expect(parseIp("not-an-ip")).toBeNull();
    expect(parseIp("")).toBeNull();
  });

  test("parses IPv6 with :: compression", () => {
    const parsed = parseIp("2001:db8::1");
    expect(parsed?.family).toBe(6);
    expect(parsed?.value).toBe((0x20010db8n << 96n) | 1n);
  });

  test("normalizes IPv4-mapped IPv6 to family 4", () => {
    const mapped = parseIp("::ffff:10.0.0.1");
    const plain = parseIp("10.0.0.1");
    expect(mapped?.family).toBe(4);
    expect(mapped?.value).toBe(plain?.value);
  });

  test("rejects malformed IPv6", () => {
    expect(parseIp(":::")).toBeNull();
    expect(parseIp("1::2::3")).toBeNull();
    expect(parseIp("12345::")).toBeNull();
    expect(parseIp("1:2:3:4:5:6:7")).toBeNull();
  });
});

describe("parseCidrRule / ipMatchesRule", () => {
  test("bare IP matches only itself", () => {
    const rule = parseCidrRule("203.0.113.7");
    expect(rule).not.toBeNull();
    expect(ipMatchesRule("203.0.113.7", rule!)).toBe(true);
    expect(ipMatchesRule("203.0.113.8", rule!)).toBe(false);
  });

  test("IPv4 CIDR matches inside the range only", () => {
    const rule = parseCidrRule("10.20.0.0/16");
    expect(ipMatchesRule("10.20.255.254", rule!)).toBe(true);
    expect(ipMatchesRule("10.21.0.1", rule!)).toBe(false);
    expect(ipMatchesRule("10.20.0.1", rule!)).toBe(true);
  });

  test("host bits in the rule network are normalized", () => {
    const loose = parseCidrRule("10.20.30.40/16");
    const strict = parseCidrRule("10.20.0.0/16");
    expect(loose?.network).toBe(strict?.network);
  });

  test("IPv6 CIDR matching", () => {
    const rule = parseCidrRule("fd12::/16");
    expect(ipMatchesRule("fd12:3456::abcd", rule!)).toBe(true);
    expect(ipMatchesRule("fd13::1", rule!)).toBe(false);
    // Families never cross-match.
    expect(ipMatchesRule("10.20.3.4", rule!)).toBe(false);
  });

  test("IPv4-mapped IPv6 peers match plain IPv4 rules", () => {
    const rule = parseCidrRule("172.18.0.0/16");
    expect(ipMatchesRule("::ffff:172.18.0.5", rule!)).toBe(true);
    expect(ipMatchesRule("172.18.0.5", rule!)).toBe(true);
    expect(ipMatchesRule("::ffff:172.19.0.5", rule!)).toBe(false);
  });

  test("rejects invalid entries", () => {
    expect(parseCidrRule("10.0.0.0/33")).toBeNull();
    expect(parseCidrRule("10.0.0.0/abc")).toBeNull();
    expect(parseCidrRule("banana")).toBeNull();
  });
});

describe("selectForwardedClientIp", () => {
  test("takes the rightmost entry when nothing in the chain is a known proxy", () => {
    // Single trusted peer appended the real client; the leftmost value was
    // pre-seeded by the client and must be ignored.
    const selected = selectForwardedClientIp(["1.2.3.4", "198.51.100.9"], () => false);
    expect(selected).toBe("198.51.100.9");
  });

  test("walks right-to-left past known proxies", () => {
    const proxies = new Set(["10.0.0.2", "10.0.0.3"]);
    const selected = selectForwardedClientIp(
      ["203.0.113.5", "10.0.0.3", "10.0.0.2"],
      (ip) => proxies.has(ip),
    );
    expect(selected).toBe("203.0.113.5");
  });

  test("spoofed trusted-proxy address on the left is not selected", () => {
    const proxies = new Set(["10.0.0.2"]);
    const selected = selectForwardedClientIp(
      ["10.0.0.2", "198.51.100.9", "10.0.0.2"],
      (ip) => proxies.has(ip),
    );
    expect(selected).toBe("198.51.100.9");
  });

  test("all-trusted chain falls back to the leftmost entry", () => {
    const selected = selectForwardedClientIp(["10.0.0.1", "10.0.0.2"], () => true);
    expect(selected).toBe("10.0.0.1");
  });

  test("empty chain yields null", () => {
    expect(selectForwardedClientIp([], () => false)).toBeNull();
  });
});
