import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  _resetForTests,
  _setApprovedBrokerOriginsForTests,
  APPROVED_BROKER_ORIGINS_SETTING_KEY,
  getApprovedBrokerOrigins,
  InvalidBrokerOriginError,
  load,
  normalizeOrigin,
  setApprovedBrokerOrigins,
} from "./broker-origins.service";
import { getSetting } from "./settings.service";

const USER_ID = "broker-origins-owner";

describe("approved broker origin normalization", () => {
  beforeEach(() => {
    _resetForTests();
  });

  test("preserves explicit ports and lowercases the origin", () => {
    expect(normalizeOrigin("https://Broker.Example.COM:8443")).toBe("https://broker.example.com:8443");
    expect(normalizeOrigin("http://localhost:7860/")).toBe("http://localhost:7860");
    // Default-port elision matches URL.origin exactly, so it stays
    // byte-compatible with assertBrokerSpec's parsed.origin comparison.
    expect(normalizeOrigin("https://broker.test:443")).toBe("https://broker.test");
    expect(normalizeOrigin("https://broker.test/path/ignored")).toBe("https://broker.test");
  });

  test("rejects bare hostnames and non-http(s) schemes", () => {
    expect(() => normalizeOrigin("broker.example.com")).toThrow(InvalidBrokerOriginError);
    expect(() => normalizeOrigin("ftp://broker.test")).toThrow(/scheme|http or https/);
    expect(() => normalizeOrigin("file:///etc/passwd")).toThrow(InvalidBrokerOriginError);
    expect(() => normalizeOrigin("wss://broker.test")).toThrow(InvalidBrokerOriginError);
  });

  test("rejects credentials and wildcards", () => {
    expect(() => normalizeOrigin("https://user:pass@broker.test")).toThrow(/credentials/i);
    expect(() => normalizeOrigin("https://user@broker.test")).toThrow(/credentials/i);
    expect(() => normalizeOrigin("https://*.test")).toThrow(/wildcards?/i);
    expect(() => normalizeOrigin("https://broker.test/*")).toThrow(/wildcards?/i);
  });

  test("setApprovedBrokerOrigins dedupes case-insensitively", () => {
    _resetForTests();
    _setApprovedBrokerOriginsForTests([
      "https://Approved.Test",
      "https://approved.test",
      "http://other.test",
    ]);
    expect(getApprovedBrokerOrigins()).toEqual(["https://approved.test", "http://other.test"]);
  });

  test("empty allowlist is permissive (returns empty list)", () => {
    _resetForTests();
    expect(getApprovedBrokerOrigins()).toEqual([]);
  });
});

describe("approved broker origins persistence", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    const baseline = await Bun.file(new URL("../db/baseline.sql", import.meta.url)).text();
    getDb().run(baseline);
    getDb()
      .query(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
      )
      .run(USER_ID, "Owner", "owner@example.com");
    _resetForTests();
  });

  afterEach(closeDatabase);

  test("set persists to owner settings and load() restores it", async () => {
    const configured = setApprovedBrokerOrigins(["https://broker.test:8443", "http://local.test"]);
    expect(configured).toEqual(["https://broker.test:8443", "http://local.test"]);

    const persisted = getSetting(USER_ID, APPROVED_BROKER_ORIGINS_SETTING_KEY);
    expect(persisted?.value).toEqual(["https://broker.test:8443", "http://local.test"]);

    // Simulate restart: drop in-memory state and reload from settings.
    _resetForTests();
    load();
    expect(getApprovedBrokerOrigins()).toEqual(["https://broker.test:8443", "http://local.test"]);
  });

  test("clearing the list persists an empty (permissive) allowlist", () => {
    setApprovedBrokerOrigins(["https://broker.test"]);
    setApprovedBrokerOrigins([]);
    _resetForTests();
    load();
    expect(getApprovedBrokerOrigins()).toEqual([]);
  });

  test("invalid entries reject with 400-class error before persisting", () => {
    expect(() => setApprovedBrokerOrigins(["not-a-url"])).toThrow(InvalidBrokerOriginError);
    expect(() => setApprovedBrokerOrigins("https://broker.test")).toThrow(/Payload must be/);
    expect(() => setApprovedBrokerOrigins(Array.from({ length: 33 }, (_, i) => `https://h${i}.test`)))
      .toThrow(/max 32/i);

    // Nothing was persisted by the failed calls.
    _resetForTests();
    load();
    expect(getApprovedBrokerOrigins()).toEqual([]);
  });

  test("malformed persisted entries are skipped on load without crashing", () => {
    setApprovedBrokerOrigins(["https://good.test"]);
    // Overwrite the persisted row with a legacy/corrupted payload that
    // contains malformed entries alongside a valid one.
    getDb()
      .query(
        "UPDATE settings SET value = ? WHERE key = ? AND user_id = ?",
      )
      .run(JSON.stringify(["junk", "https://alsogood.test", ["nested"]]), APPROVED_BROKER_ORIGINS_SETTING_KEY, USER_ID);

    _resetForTests();
    load();
    expect(getApprovedBrokerOrigins()).toEqual(["https://alsogood.test"]);
  });
});
