/**
 * Unit tests for the ported CharacterLibrary algorithms.
 *
 * Fixtures mirror the exact CL behaviors the audit depends on, so a future
 * change to the port fails here instead of silently mispredicting a migration.
 */

import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  buildGalleryFileIndex,
  classifyGalleryAsset,
  clSanitizeFolderName,
  collectCardTextChunks,
  computeEffectiveMediaNames,
  extractFilenameFromUrl,
  extractMediaUrls,
  extractSanitizedUrlName,
  findCharacterMediaUrls,
  galleryFolderName,
  lookupLocalizedMedia,
  mediaUrlHash8,
  qualifiedMediaName,
  sanitizeMediaFilename,
  stSanitizeFilename,
} from "../src/migration/st-gallery-audit/cl-algorithms";
import { MAX_DECOMPRESSED_SIZE, readCardMetadata } from "../src/migration/st-gallery-audit/png-metadata";
import type { FileEntry, FileStat, FileSystem } from "../src/file-connections/types";
import { join, basename, dirname, extname } from "node:path";

describe("folder name sanitization", () => {
  test("CL replaces illegal characters with underscores and trims", () => {
    expect(clSanitizeFolderName("A/B: C")).toBe("A_B_ C");
    expect(clSanitizeFolderName("  spaced  ")).toBe("spaced");
  });

  test("ST deletes illegal characters, strips trailing dots/spaces, and byte-truncates", () => {
    // The two sanitizers disagree; this is the boundary the audit must model.
    expect(stSanitizeFilename("A_B_ C")).toBe("A_B_ C");
    expect(stSanitizeFilename("Foo_Bar")).toBe("Foo_Bar");
    expect(stSanitizeFilename("ends with dot.")).toBe("ends with dot");
    expect(stSanitizeFilename("a/b")).toBe("ab");
    expect(stSanitizeFilename("NUL")).toBe("");
    const long = "é".repeat(200);
    expect(Buffer.byteLength(stSanitizeFilename(long), "utf8")).toBeLessThanOrEqual(255);
  });

  test("galleryFolderName follows CL's unique-folder rules", () => {
    expect(galleryFolderName("Alice", "abcdefghijkl", true)).toBe("Alice_abcdefghijkl");
    expect(galleryFolderName("Alice", null, true)).toBe("Alice");
    expect(galleryFolderName("Alice", "abcdefghijkl", false)).toBe("Alice");
    expect(galleryFolderName("A/B", "abcdefghijkl", true)).toBe("A_B_abcdefghijkl");
  });
});

describe("URL-derived names", () => {
  test("extractSanitizedUrlName drops the query, strips the last extension, caps at 40", () => {
    expect(extractSanitizedUrlName("https://host/a/b/some-image.png?x=1#frag")).toBe("some-image");
    expect(extractSanitizedUrlName("https://host/noext")).toBe("noext");
    const long = `https://host/${"x".repeat(60)}.png`;
    expect(extractSanitizedUrlName(long)).toHaveLength(40);
    expect(extractSanitizedUrlName("https://host/")).toBe("");
  });

  test("CDN variant names prepend the parent segment", () => {
    expect(extractSanitizedUrlName("https://cdn.example.com/12345678/public")).toBe("12345678_public");
    // Parent shorter than 4 chars is not usable.
    expect(extractSanitizedUrlName("https://cdn.example.com/ab/public")).toBe("public");
  });

  test("sanitizeMediaFilename is the bare form with no CDN rule", () => {
    expect(sanitizeMediaFilename("my image.png")).toBe("my_image");
    expect(sanitizeMediaFilename("public")).toBe("public");
  });

  test("extractFilenameFromUrl never returns the query string", () => {
    expect(extractFilenameFromUrl("https://host/a/b.png?q=1")).toBe("b.png");
    expect(extractFilenameFromUrl("not a url/plain.png")).toBe("plain.png");
  });

  test("mediaUrlHash8 is stable FNV-1a", () => {
    expect(mediaUrlHash8("https://example.com/a.png")).toBe(mediaUrlHash8("https://example.com/a.png"));
    expect(mediaUrlHash8("https://example.com/a.png")).toMatch(/^[0-9a-f]{8}$/);
    expect(mediaUrlHash8("a")).not.toBe(mediaUrlHash8("b"));
  });

  test("qualified names embed the URL hash so distinct URLs cannot collide", () => {
    const a = qualifiedMediaName("https://a.example.com/dir/pic.png");
    const b = qualifiedMediaName("https://b.example.com/dir/pic.png");
    expect(a).not.toBe(b);
    expect(a.startsWith(mediaUrlHash8("https://a.example.com/dir/pic.png"))).toBe(true);
    expect(a.length).toBeLessThanOrEqual(40);
  });

  test("computeEffectiveMediaNames promotes only genuinely colliding bare names", () => {
    const names = computeEffectiveMediaNames([
      "https://a.example.com/unique.png",
      "https://a.example.com/dir/pic.png",
      "https://b.example.com/other/pic.png",
    ]);
    expect(names.get("https://a.example.com/unique.png")).toBe("unique");
    expect(names.get("https://a.example.com/dir/pic.png")).toBe(
      qualifiedMediaName("https://a.example.com/dir/pic.png"),
    );
  });
});

describe("media URL extraction", () => {
  test("finds markdown, html, audio, css, and bare URLs", () => {
    const text = [
      "![alt](https://a.example.com/one.png)",
      '<img src="https://b.example.com/two.jpg">',
      '<audio src="https://c.example.com/three.mp3"></audio>',
      "background: url('https://d.example.com/four.webp')",
      "bare https://e.example.com/five.gif here",
    ].join("\n");
    const urls = extractMediaUrls(text);
    expect(urls).toContain("https://a.example.com/one.png");
    expect(urls).toContain("https://b.example.com/two.jpg");
    expect(urls).toContain("https://c.example.com/three.mp3");
    expect(urls).toContain("https://d.example.com/four.webp");
    expect(urls).toContain("https://e.example.com/five.gif");
  });

  test("drops a proper-prefix truncated twin", () => {
    const urls = extractMediaUrls("https://host/a/b.png and https://host/a/b.png/more.png");
    expect(urls).toEqual(["https://host/a/b.png/more.png"]);
  });

  test("collectCardTextChunks scans the CL field set, taglines, greetings, and lorebook", () => {
    const card = {
      data: {
        description: "desc",
        personality: "pers",
        first_mes: "hello",
        alternate_greetings: ["alt"],
        creator: "SHOULD NOT APPEAR",
        extensions: { chub: { tagline: "tag" } },
        character_book: { entries: [{ content: "lore" }] },
      },
    };
    const chunks = collectCardTextChunks(card);
    expect(chunks.main).toContain("desc");
    expect(chunks.main).toContain("pers");
    expect(chunks.main).toContain("hello");
    expect(chunks.main).toContain("alt");
    expect(chunks.main).toContain("tag");
    expect(chunks.main).not.toContain("SHOULD NOT APPEAR");
    expect(chunks.lorebook).toEqual(["lore"]);
  });

  test("findCharacterMediaUrls gates lorebook URLs", () => {
    const card = {
      data: {
        description: "![a](https://host/one.png)",
        character_book: { entries: [{ content: "![b](https://host/two.png)" }] },
      },
    };
    const off = findCharacterMediaUrls(card, false);
    expect(off.embedded).toEqual(["https://host/one.png"]);
    expect(off.lorebook).toEqual([]);

    const on = findCharacterMediaUrls(card, true);
    expect(on.embedded).toEqual(["https://host/one.png"]);
    expect(on.lorebook).toEqual(["https://host/two.png"]);
  });
});

describe("gallery file index and lookup", () => {
  test("classifies asset prefixes by CL's priority", () => {
    expect(classifyGalleryAsset("localized_media_1793_name.png")).toBe("localized_media");
    expect(classifyGalleryAsset("lorebook_media_1_x.png")).toBe("lorebook_media");
    expect(classifyGalleryAsset("chubgallery_ab12cd34_thumb.png")).toBe("provider_gallery");
    expect(classifyGalleryAsset("plain.png")).toBe("original_name");
  });

  test("resolves a localized file by its sanitized suffix", () => {
    const index = buildGalleryFileIndex([
      "localized_media_1793559843333_wizmain.png",
      "localized_media_1793559843334_FFFFFF.png",
    ]);
    const hit = lookupLocalizedMedia(index, "https://i.ibb.co/S4ZDxQhd/wizmain.png");
    expect(hit.status).toBe("unique");
    expect(hit.file).toBe("localized_media_1793559843333_wizmain.png");
    expect(hit.rule).toBe("sanitized");
  });

  test("reports a shared basename as ambiguous instead of choosing", () => {
    const index = buildGalleryFileIndex(["character1.png", "character2.png"]);
    // Both files share no key; a URL whose stem matches neither misses.
    expect(lookupLocalizedMedia(index, "https://host/other.png").status).toBe("missing");
    // Two localized files with the same suffix is the real collision case.
    const collided = buildGalleryFileIndex([
      "localized_media_1_shared.png",
      "localized_media_2_shared.png",
    ]);
    const hit = lookupLocalizedMedia(collided, "https://host/shared.png");
    expect(hit.status).toBe("ambiguous");
    expect(hit.candidates).toHaveLength(2);
  });

  test("resolves a provider gallery file and a plain original filename", () => {
    const index = buildGalleryFileIndex([
      "chubgallery_deadbeef_original.png",
      "My Image.png",
    ]);
    expect(lookupLocalizedMedia(index, "https://host/x/original.png").rule).toBe("sanitized");
    // CL derives names from URL.pathname, and Node's URL parser escapes spaces
    // to %20 — so a space-containing filename never matches by stem. Recorded so
    // the audit stays faithful to CL instead of "more correct" than CL.
    const encoded = lookupLocalizedMedia(index, "https://host/My%20Image.png");
    expect(encoded.status).toBe("missing");
    expect(encoded.derivedName).toBe("My_20Image");
  });

  test("ignores non-media files", () => {
    const index = buildGalleryFileIndex(["notes.txt", "wget-log"]);
    expect(index.sanitized.size).toBe(0);
    expect(index.filename.size).toBe(0);
  });
});

// ─── PNG metadata reader ────────────────────────────────────────────────────

function textChunk(keyword: string, text: string): Buffer {
  const payload = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from(text, "latin1")]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write("tEXt", 4, "ascii");
  const crc = Buffer.alloc(4);
  return Buffer.concat([header, payload, crc]);
}

function ztxtChunk(keyword: string, text: string): Buffer {
  const deflated = deflateSync(Buffer.from(text, "utf8"));
  const payload = Buffer.concat([
    Buffer.from(keyword, "latin1"), Buffer.from([0]), Buffer.from([0]), deflated,
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write("zTXt", 4, "ascii");
  return Buffer.concat([header, payload, Buffer.alloc(4)]);
}

function idatChunk(size: number): Buffer {
  const payload = Buffer.alloc(size);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length, 0);
  header.write("IDAT", 4, "ascii");
  return Buffer.concat([header, payload, Buffer.alloc(4)]);
}

const IEND = Buffer.concat([
  (() => { const h = Buffer.alloc(8); h.write("IEND", 4, "ascii"); return h; })(),
  Buffer.alloc(4),
]);

function pngWith(...chunks: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks, IEND]);
}

/** In-memory FileSystem that records total bytes read. */
class MemoryFs implements FileSystem {
  readonly type = "memory";
  bytesRead = 0;
  constructor(private readonly file: Buffer) {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async exists(): Promise<boolean> { return true; }
  async stat(): Promise<FileStat> { return { isDirectory: false, isFile: true, size: this.file.length }; }
  async readdir(): Promise<FileEntry[]> { return []; }
  async readFile(): Promise<Buffer> { this.bytesRead += this.file.length; return this.file; }
  async readText(): Promise<string> { return this.file.toString("utf8"); }
  async readRange(_path: string, offset: number, length: number): Promise<Buffer> {
    const slice = this.file.subarray(offset, offset + length);
    this.bytesRead += slice.length;
    return slice;
  }
  join(...parts: string[]): string { return join(...parts); }
  dirname(path: string): string { return dirname(path); }
  basename(path: string, ext?: string): string { return basename(path, ext); }
  extname(path: string): string { return extname(path); }
}

function base64Card(name: string): string {
  return Buffer.from(JSON.stringify({ spec: "chara_card_v3", data: { name } }), "utf8").toString("base64");
}

describe("PNG card metadata reader", () => {
  test("reads a tEXt chara chunk and parses the card", async () => {
    const png = pngWith(textChunk("chara", base64Card("Alice")));
    const result = await readCardMetadata(new MemoryFs(png), "card.png");
    expect(result.error).toBeUndefined();
    expect(result.keyword).toBe("chara");
    expect((result.json as { data: { name: string } }).data.name).toBe("Alice");
  });

  test("reads a zTXt chunk", async () => {
    const png = pngWith(ztxtChunk("ccv3", base64Card("Bob")));
    const result = await readCardMetadata(new MemoryFs(png), "card.png");
    expect(result.keyword).toBe("ccv3");
    expect((result.json as { data: { name: string } }).data.name).toBe("Bob");
  });

  test("prefers chara over ccv3, matching the importer", async () => {
    const png = pngWith(
      textChunk("ccv3", base64Card("V3")),
      textChunk("chara", base64Card("V2")),
    );
    const result = await readCardMetadata(new MemoryFs(png), "card.png");
    expect(result.keyword).toBe("chara");
    expect((result.json as { data: { name: string } }).data.name).toBe("V2");
  });

  test("stops reading before the image data (IDAT)", async () => {
    const png = pngWith(textChunk("chara", base64Card("Alice")), idatChunk(8 * 1024 * 1024));
    const fs = new MemoryFs(png);
    const result = await readCardMetadata(fs, "card.png");
    expect(result.keyword).toBe("chara");
    // The reader seeks past the 8 MB IDAT payload instead of reading it:
    // total bytes touched stay tiny relative to the file.
    expect(fs.bytesRead).toBeLessThan(1024);
    expect(fs.bytesRead).toBeLessThan(png.length / 1000);
  });

  test("reports a non-PNG without throwing", async () => {
    const result = await readCardMetadata(new MemoryFs(Buffer.from("not a png")), "card.png");
    expect(result.json).toBeNull();
    expect(result.error).toContain("not a valid PNG");
  });

  test("flags a malformed payload", async () => {
    const png = pngWith(textChunk("chara", "not-valid-base64-json"));
    const result = await readCardMetadata(new MemoryFs(png), "card.png");
    expect(result.malformed).toBe(true);
    expect(result.json).toBeNull();
  });

  test("returns no keyword when no card chunk is present", async () => {
    const png = pngWith(idatChunk(16));
    const result = await readCardMetadata(new MemoryFs(png), "card.png");
    expect(result.keyword).toBeNull();
    expect(result.json).toBeNull();
  });

  test("skips a data chunk larger than the read guard", async () => {
    // A real card in the reference library carries a 69 MB IDAT chunk, which is
    // legitimate pixel data — the reader must seek past it, not reject the file.
    const png = pngWith(textChunk("chara", base64Card("Big")), idatChunk(70 * 1024 * 1024));
    const fs = new MemoryFs(png);
    const result = await readCardMetadata(fs, "card.png");
    expect(result.error).toBeUndefined();
    expect(result.keyword).toBe("chara");
    expect((result.json as { data: { name: string } }).data.name).toBe("Big");
    expect(fs.bytesRead).toBeLessThan(4096);
  });

  test("rejects an implausibly large text chunk", async () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(200 * 1024 * 1024, 0);
    header.write("tEXt", 4, "ascii");
    const png = pngWith(Buffer.concat([header, Buffer.alloc(8)]));
    const result = await readCardMetadata(new MemoryFs(png), "card.png");
    expect(result.error).toContain("implausible tEXt chunk length");
  });

  test("decompression guard is bounded", () => {
    expect(MAX_DECOMPRESSED_SIZE).toBeGreaterThan(1024 * 1024);
    expect(MAX_DECOMPRESSED_SIZE).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
