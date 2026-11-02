import { describe, expect, test } from "bun:test";
import { sanitizeEntry } from "./sanitize";

const IMAGE_ID = "123e4567-e89b-12d3-a456-426614174000";

describe("user-data settings value paths", () => {
  test("accepts a separate JSON payload with a UUID filename", () => {
    expect(sanitizeEntry(`settings-values/${IMAGE_ID}.json`)).toMatchObject({
      kind: "setting-value", inner: `${IMAGE_ID}.json`,
    });
  });

  test.each([
    "../outside.json", "nested/value.json", "savedThemes.json", `${IMAGE_ID}.ndjson`,
    `${IMAGE_ID}.json/extra`, `${IMAGE_ID}.json\0`,
  ])("rejects unsafe or unsupported settings value path %s", (filename) => {
    expect(() => sanitizeEntry(`settings-values/${filename}`)).toThrow();
  });
});

describe("user-data image archive paths", () => {
  test.each([
    IMAGE_ID,
    `${IMAGE_ID}.webp`,
    `${IMAGE_ID}.bak`,
    "ed383b1a-55d7-4959-a9b3-5ed69d5d16d4.bak_20260808_pre_calligraphy",
    `${IMAGE_ID}.png.bak_20260808_pre_calligraphy`,
    `${IMAGE_ID}.webp.bak`,
  ])("preserves the referenced image filename %s", (filename) => {
    expect(sanitizeEntry(`files/images/${filename}`)).toMatchObject({
      kind: "files", bucket: "images", inner: filename,
    });
  });

  test.each([
    `${IMAGE_ID}.bak_../../outside`,
    `${IMAGE_ID}.bak_..\\outside`,
    `${IMAGE_ID}.bak_/nested`,
    `${IMAGE_ID}.bak_`,
    `${IMAGE_ID}.bak_${"x".repeat(129)}`,
    `${IMAGE_ID}.bak_label:stream`,
    `${IMAGE_ID}.bak_label\0`,
    `${IMAGE_ID}.bak_label\n`,
    `${IMAGE_ID}.bak_label `,
    `${IMAGE_ID}_arbitrary`,
    "not-a-uuid.bak_20260808_pre_calligraphy",
  ])("rejects unsafe or unsupported image filename %s", (filename) => {
    expect(() => sanitizeEntry(`files/images/${filename}`)).toThrow();
  });
});

describe("user-data thumbnail archive paths", () => {
  test("accepts WebP and AVIF v2 thumbnails", () => {
    for (const codec of ["webp", "avif"] as const) {
      expect(sanitizeEntry(`files/thumbnails/${IMAGE_ID}_thumb_sm_v2.${codec}`)).toMatchObject({
        kind: "files",
        bucket: "thumbnails",
        inner: `${IMAGE_ID}_thumb_sm_v2.${codec}`,
      });
    }
  });

  test("continues to reject unapproved thumbnail extensions", () => {
    expect(() => sanitizeEntry(`files/thumbnails/${IMAGE_ID}_thumb_lg_v2.png`)).toThrow(
      "files/thumbnails entry must be a UUID_thumb file",
    );
  });
});
