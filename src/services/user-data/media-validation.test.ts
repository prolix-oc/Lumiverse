import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateSafeMediaBytes, validateSafeMediaFile } from "./media-validation";

const PNG_HEADER = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function mp4Header(): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set([0x69, 0x73, 0x6f, 0x6d], 8);
  return bytes;
}

describe("archive media validation", () => {
  test("accepts valid historical PNG and MP4 payloads", () => {
    expect(validateSafeMediaBytes(PNG_HEADER, {
      filename: "cover.png",
      bucket: "images",
      mediaPolicy: "image",
      expectedMimeType: "image/png",
    })).toMatchObject({ contentType: "image/png", kind: "image" });
    expect(validateSafeMediaBytes(mp4Header(), {
      filename: "clip.mp4",
      bucket: "images",
      mediaPolicy: "image_or_video",
      expectedMimeType: "video/mp4",
    })).toMatchObject({ contentType: "video/mp4", kind: "video" });
  });
  test("normalizes MIME parameters and filename extensions before policy checks", () => {
    expect(validateSafeMediaBytes(PNG_HEADER, {
      filename: "COVER.PNG",
      bucket: "images",
      mediaPolicy: "image",
      expectedMimeType: " IMAGE/PNG ; charset=binary ",
    })).toMatchObject({ contentType: "image/png", extension: ".png" });
    expect(validateSafeMediaBytes(new TextEncoder().encode("plain text"), {
      filename: "docs/README.TXT",
      bucket: "databank",
      mediaPolicy: "databank_document",
      expectedMimeType: " TEXT/PLAIN; charset=utf-8 ",
    })).toMatchObject({ contentType: "text/plain", extension: ".txt", kind: "other" });
  });


  test.each([
    ["files/images/evil.html", "text/html", "<!doctype html><script>alert(1)</script>"],
    ["files/images/evil.svg", "image/svg+xml", "<svg><script>alert(1)</script></svg>"],
    ["files/images/evil.png", "image/png", "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"],
  ])("rejects active or polyglot content for %s", (filename, expectedMimeType, payload) => {
    expect(() => validateSafeMediaBytes(new TextEncoder().encode(payload), {
      filename,
      bucket: "images",
      mediaPolicy: "image",
      expectedMimeType,
    })).toThrow();
  });

  test("rejects SVG and HTML artifact metadata even without a media bucket", () => {
    expect(() => validateSafeMediaBytes(new TextEncoder().encode("<svg></svg>"), {
      filename: "chat/asset.svg",
      bucket: "artifacts",
      mediaPolicy: "artifact",
      expectedMimeType: "image/svg+xml",
    })).toThrow(/active content/);
    expect(() => validateSafeMediaBytes(new TextEncoder().encode("<!doctype html>"), {
      filename: "chat/asset.bin",
      bucket: "artifacts",
      mediaPolicy: "artifact",
      expectedMimeType: "application/octet-stream",
    })).toThrow(/active content/);
  });

  test("rejects ordinary images at the 50 MiB cap plus one byte", () => {
    const oversized = new Uint8Array(50 * 1024 * 1024 + 1);
    oversized.set(PNG_HEADER);
    expect(() => validateSafeMediaBytes(oversized, {
      filename: "oversized.png",
      bucket: "images",
      mediaPolicy: "image",
      expectedMimeType: "image/png",
    })).toThrow(/byte ceiling/);
  });
  test("accepts bounded HTML and XML databank documents as data", () => {
    expect(validateSafeMediaBytes(new TextEncoder().encode("<html><script>literal data</script></html>"), {
      filename: "docs/reference.html",
      bucket: "databank",
      mediaPolicy: "databank_document",
      expectedMimeType: "text/html",
    })).toMatchObject({ contentType: "text/html", kind: "other" });
    expect(validateSafeMediaBytes(new TextEncoder().encode("<root><item>literal</item></root>"), {
      filename: "docs/reference.xml",
      bucket: "databank",
      mediaPolicy: "databank_document",
      expectedMimeType: "application/xml",
    })).toMatchObject({ contentType: "application/xml", kind: "other" });
  });

  test("rejects executable extensions and non-text databank payloads", () => {
    expect(() => validateSafeMediaBytes(new TextEncoder().encode("console.log(1)"), {
      filename: "docs/script.js",
      bucket: "databank",
      mediaPolicy: "databank_document",
      expectedMimeType: "application/javascript",
    })).toThrow(/allowlisted/);
    expect(() => validateSafeMediaBytes(Uint8Array.from([0xff, 0xfe]), {
      filename: "docs/reference.xml",
      bucket: "databank",
      mediaPolicy: "databank_document",
      expectedMimeType: "application/xml",
    })).toThrow(/UTF-8/);
  });

  test("enforces the databank document cap", () => {
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    expect(() => validateSafeMediaBytes(oversized, {
      filename: "docs/oversized.txt",
      bucket: "databank",
      mediaPolicy: "databank_document",
      expectedMimeType: "text/plain",
    })).toThrow(/byte ceiling/);
  });
});
