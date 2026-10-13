import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import {
  buildCaptionFingerprint,
  clearCachedCaption,
  getCachedCaption,
  lookupCachedCaption,
  setCachedCaption,
} from "./image-gen-avatar-caption.service";

function initTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE settings (
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    user_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (key, user_id)
  )`);
}

describe("image-gen avatar caption cache", () => {
  beforeEach(initTestDb);
  afterEach(closeDatabase);

  test("buildCaptionFingerprint is stable for the same inputs", () => {
    const a = buildCaptionFingerprint({
      presetId: "preset-1",
      prompt: "booru tags",
      parserConnectionId: "conn-1",
      parserModel: "vision-model",
      parserParameters: { temperature: 0.2 },
    });
    const b = buildCaptionFingerprint({
      presetId: "preset-1",
      prompt: "booru tags",
      parserConnectionId: "conn-1",
      parserModel: "vision-model",
      parserParameters: { temperature: 0.2 },
    });
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  test("buildCaptionFingerprint changes when prompt or parser changes", () => {
    const base = buildCaptionFingerprint({ prompt: "a", parserModel: "m1" });
    expect(buildCaptionFingerprint({ prompt: "b", parserModel: "m1" })).not.toBe(base);
    expect(buildCaptionFingerprint({ prompt: "a", parserModel: "m2" })).not.toBe(base);
    expect(buildCaptionFingerprint({ presetId: "p1", prompt: "a", parserModel: "m1" })).not.toBe(base);
  });

  test("setCachedCaption round-trips via getCachedCaption", () => {
    const entry = setCachedCaption("user-1", "character", "char-1", {
      image_id: "img-1",
      caption: "1girl, silver hair, blue eyes",
      fingerprint: "abc123",
    });
    expect(entry.caption).toBe("1girl, silver hair, blue eyes");
    expect(entry.image_id).toBe("img-1");
    expect(entry.fingerprint).toBe("abc123");
    expect(entry.updated_at).toBeGreaterThan(0);

    const stored = getCachedCaption("user-1", "character", "char-1");
    expect(stored).toMatchObject({
      image_id: "img-1",
      caption: "1girl, silver hair, blue eyes",
      fingerprint: "abc123",
    });
  });

  test("lookupCachedCaption hits only when image_id and fingerprint match", () => {
    setCachedCaption("user-1", "persona", "persona-1", {
      image_id: "img-a",
      caption: "short brown hair",
      fingerprint: "fp-1",
    });

    expect(lookupCachedCaption("user-1", "persona", "persona-1", "img-a", "fp-1")).toBe("short brown hair");
    expect(lookupCachedCaption("user-1", "persona", "persona-1", "img-b", "fp-1")).toBeNull();
    expect(lookupCachedCaption("user-1", "persona", "persona-1", "img-a", "fp-2")).toBeNull();
  });

  test("entries are isolated per user and subject", () => {
    setCachedCaption("user-1", "character", "shared-id", {
      image_id: "img-1",
      caption: "user1 char",
      fingerprint: "fp",
    });
    setCachedCaption("user-2", "character", "shared-id", {
      image_id: "img-1",
      caption: "user2 char",
      fingerprint: "fp",
    });
    setCachedCaption("user-1", "persona", "shared-id", {
      image_id: "img-1",
      caption: "user1 persona",
      fingerprint: "fp",
    });

    expect(lookupCachedCaption("user-1", "character", "shared-id", "img-1", "fp")).toBe("user1 char");
    expect(lookupCachedCaption("user-2", "character", "shared-id", "img-1", "fp")).toBe("user2 char");
    expect(lookupCachedCaption("user-1", "persona", "shared-id", "img-1", "fp")).toBe("user1 persona");
  });

  test("clearCachedCaption removes the entry", () => {
    setCachedCaption("user-1", "character", "char-1", {
      image_id: "img-1",
      caption: "tags",
      fingerprint: "fp",
    });
    expect(clearCachedCaption("user-1", "character", "char-1")).toBe(true);
    expect(getCachedCaption("user-1", "character", "char-1")).toBeNull();
  });

  test("rejects empty caption fields", () => {
    expect(() =>
      setCachedCaption("user-1", "character", "char-1", {
        image_id: "",
        caption: "x",
        fingerprint: "fp",
      }),
    ).toThrow();
    expect(() =>
      setCachedCaption("user-1", "character", "char-1", {
        image_id: "img",
        caption: "   ",
        fingerprint: "fp",
      }),
    ).toThrow();
  });
});
