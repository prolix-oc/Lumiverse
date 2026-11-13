/**
 * Report writers for the ST gallery audit.
 *
 * Every writer streams to disk incrementally: the audit produces ~19k asset
 * rows and ~100k URL rows on the reference library, so rows are buffered in
 * small batches instead of accumulated in memory.
 */

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type {
  AuditErrorRecord,
  AuditSummary,
  CardRecord,
  FolderRecord,
  GalleryFileRecord,
  UrlMatchRecord,
} from "./types";

function escapeCsv(value: string | number | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

class BufferedWriter {
  private stream: WriteStream;
  private buffer: string[] = [];
  private bytes = 0;

  constructor(
    readonly path: string,
    private readonly flushBytes = 1 << 20,
  ) {
    this.stream = createWriteStream(path, { flags: "w" });
  }

  write(line: string): void {
    this.buffer.push(line);
    this.bytes += line.length + 1;
    if (this.bytes >= this.flushBytes) this.flush();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    this.stream.write(this.buffer.join("\n") + "\n");
    this.buffer = [];
    this.bytes = 0;
  }

  async close(): Promise<void> {
    this.flush();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    return promise;
  }
}

export interface ReportPaths {
  summary: string;
  cards: string;
  assets: string;
  urls: string;
  errors: string;
}

export function reportPaths(outDir: string): ReportPaths {
  return {
    summary: join(outDir, "gallery-audit-summary.txt"),
    cards: join(outDir, "gallery-audit-cards.csv"),
    assets: join(outDir, "gallery-audit-assets.jsonl"),
    urls: join(outDir, "gallery-audit-urls.csv"),
    errors: join(outDir, "gallery-audit-errors.txt"),
  };
}

export function ensureOutDir(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
}

const CARDS_HEADER = [
  "source_filename",
  "character_name",
  "gallery_id",
  "expected_gallery_folder",
  "expected_folder_on_disk",
  "resolved_gallery_folder",
  "contested_folder",
  "gallery_exists",
  "image_count",
  "total_size_bytes",
  "resolution_status",
  "embedded_url_count",
  "lorebook_url_count",
  "matched_url_count",
];

export async function writeCardsCsv(path: string, cards: CardRecord[], folders: Map<string, FolderRecord>): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  const writer = new BufferedWriter(path);
  writer.write(CARDS_HEADER.join(","));
  for (const card of cards) {
    const folder = card.resolvedFolder ? folders.get(card.resolvedFolder) : undefined;
    writer.write(
      [
        escapeCsv(card.filename),
        escapeCsv(card.characterName ?? ""),
        escapeCsv(card.galleryId ?? ""),
        escapeCsv(card.expectedFolder),
        escapeCsv(card.expectedFolderOnDisk),
        escapeCsv(card.resolvedFolder ?? ""),
        escapeCsv(card.contestedFolder ?? ""),
        folder ? "yes" : "no",
        folder ? folder.imageCount : 0,
        folder ? folder.totalBytes : 0,
        card.status,
        card.embeddedUrls.length,
        card.lorebookUrls.length,
        card.matchedUrls,
      ].join(","),
    );
  }
  await writer.close();
}

function assetsWriter(path: string): BufferedWriter {
  const writer = new BufferedWriter(path);
  return writer;
}

export async function writeAssetsJsonl(
  outDir: string,
  folders: Map<string, FolderRecord>,
  folderFiles: Map<string, GalleryFileRecord[]>,
): Promise<void> {
  const writer = assetsWriter(join(outDir, "gallery-audit-assets.jsonl"));
  for (const [folder, record] of folders) {
    const files = folderFiles.get(folder) ?? [];
    const characters = record.characters;
    for (const file of files) {
      writer.write(
        JSON.stringify({
          source_folder: file.folder,
          filename: file.filename,
          extension: file.extension,
          size_bytes: file.sizeBytes,
          characters,
          classification: classifyForReport(file.filename),
        }),
      );
    }
  }
  await writer.close();
}

function classifyForReport(fileName: string): string {
  if (fileName.startsWith("localized_media_")) return "localized_media";
  if (fileName.startsWith("lorebook_media_")) return "lorebook_media";
  if (/^[a-z]+gallery_[a-f0-9]+_/.test(fileName)) return "provider_gallery";
  return "original_name";
}

const URLS_HEADER = [
  "character",
  "source",
  "source_file",
  "url",
  "candidate_local_filename",
  "candidate_gallery_folder",
  "match_status",
  "match_rule",
  "matching_method",
  "local_path_key",
  "expected_migration_result",
];

const RULE_METHOD: Record<string, string> = {
  qualified: "urlhash8-qualified-name (exact URL)",
  filename: "raw filename stem match",
  sanitized: "sanitized filename match",
  cdn: "CDN-variant-aware name match",
};

export function createUrlsWriter(outDir: string): { write: (row: UrlMatchRecord) => void; close: () => Promise<void> } {
  const writer = assetsWriter(join(outDir, "gallery-audit-urls.csv"));
  writer.write(URLS_HEADER.join(","));
  return {
    write(row: UrlMatchRecord) {
      writer.write(
        [
          escapeCsv(row.characterFile),
          row.source,
          escapeCsv(row.sourceFile ?? ""),
          escapeCsv(row.url),
          escapeCsv(row.candidateFilename),
          escapeCsv(row.candidateFolder),
          row.status,
          row.rule,
          escapeCsv(row.rule ? RULE_METHOD[row.rule] ?? row.rule : ""),
          escapeCsv(row.localPath),
          escapeCsv(row.expectedReference),
        ].join(","),
      );
    },
    close() {
      return writer.close();
    },
  };
}

export function createErrorsWriter(outDir: string): {
  write: (record: AuditErrorRecord) => void;
  close: () => Promise<void>;
} {
  const writer = assetsWriter(join(outDir, "gallery-audit-errors.txt"));
  writer.write(`# SillyTavern gallery audit errors`);
  writer.write(`# stage\tpath\tmessage`);
  return {
    write(record: AuditErrorRecord) {
      writer.write(`${record.stage}\t${record.path}\t${record.message}`);
    },
    close() {
      return writer.close();
    },
  };
}

function pad(label: string, value: string | number, width = 42): string {
  return `  ${label.padEnd(width)}${value}`;
}

export function formatSummary(summary: AuditSummary): string {
  const lines: string[] = [];
  const rule = "─".repeat(64);
  lines.push("SillyTavern → Lumiverse gallery audit (read-only dry run)");
  lines.push(rule);
  lines.push(`Generated: ${summary.generatedAt}`);
  lines.push(`ST data dir: ${summary.stDataDir}`);
  lines.push(`Report dir: ${summary.outDir}`);
  lines.push(`uniqueGalleryFolders: ${summary.uniqueGalleryFolders}   includeLorebook: ${summary.includeLorebook}   includeChats: ${summary.includeChats}`);
  lines.push("");

  lines.push("Characters");
  lines.push(rule);
  lines.push(pad("PNG cards discovered", summary.cards.total));
  lines.push(pad("Parsed successfully", summary.cards.parsed));
  lines.push(pad("Unreadable", summary.cards.unreadable));
  lines.push(pad("With an embedded name", summary.cards.withName));
  lines.push(pad("With a gallery_id", summary.cards.withGalleryId));
  lines.push(pad("Unique gallery_ids", summary.cards.uniqueGalleryIds));
  lines.push(pad("Duplicate gallery_ids", summary.cards.duplicateGalleryIds));
  lines.push(pad("Duplicate character names", summary.cards.duplicateNames));
  lines.push("");

  lines.push("Gallery folders");
  lines.push(rule);
  lines.push(pad("Folders on disk", summary.folders.onDisk));
  lines.push(pad("Non-empty folders", summary.folders.nonEmpty));
  lines.push(pad("Resolved, non-empty", summary.folders.resolvedNonEmpty));
  lines.push(pad("Resolved, empty", summary.folders.resolvedEmpty));
  lines.push(pad("Legacy name-only folder", summary.folders.legacyNameOnly));
  lines.push(pad("Matched by gallery_id suffix", summary.folders.gidSuffixMatch));
  lines.push(pad("Shared/contested folder (ambiguous)", summary.folders.ambiguousShared));
  lines.push(pad("Ambiguous gallery_id folder", summary.folders.ambiguousGid));
  lines.push(pad("No folder for character", summary.folders.missing));
  lines.push(pad("Card has no usable name", summary.folders.noName));
  lines.push(pad("Unreadable card", summary.folders.unreadable));
  lines.push(pad("Orphaned non-empty folders", summary.folders.orphanNonEmpty));
  lines.push(pad("  orphan files / bytes", `${summary.folders.orphanFiles} / ${summary.folders.orphanBytes}`));
  lines.push(pad("Shared non-empty folders", summary.folders.sharedNonEmpty));
  lines.push(pad("  characters involved", summary.folders.sharedCharacters));
  lines.push(pad("Total gallery files", summary.folders.totalFiles));
  lines.push(pad("Total gallery images", summary.folders.totalImages));
  lines.push(pad("Total gallery bytes", summary.folders.totalBytes));
  lines.push("");

  lines.push("External media URLs");
  lines.push(rule);
  lines.push(pad("Characters carrying URLs", summary.urls.charactersWithUrls));
  lines.push(pad("URL instances", summary.urls.instances));
  lines.push(pad("Unique URLs", summary.urls.unique));
  lines.push(pad("Unique URLs with a local file", summary.urls.uniqueMatched));
  lines.push(pad("Ambiguous matches", summary.urls.ambiguous));
  lines.push(pad("Missing matches", summary.urls.missing));
  for (const [name, count] of Object.entries(summary.urls.byRule)) {
    lines.push(pad(`  rule: ${name}`, count));
  }
  lines.push("");

  lines.push("Gallery assets");
  lines.push(rule);
  lines.push(pad("Total assets", summary.assets.total));
  for (const [name, count] of Object.entries(summary.assets.byClass)) {
    lines.push(pad(`  ${name}`, count));
  }
  lines.push("");

  if (summary.includeChats) {
    lines.push("Chats");
    lines.push(rule);
    lines.push(pad("Chat files scanned", summary.chats.scanned));
    lines.push(pad("Chats with media URLs", summary.chats.withUrls));
    lines.push(pad("URL instances", summary.chats.instances));
    lines.push(pad("Matched", summary.chats.matched));
    lines.push(pad("Missing", summary.chats.missing));
    lines.push("");
  }

  lines.push("Outcome");
  lines.push(rule);
  lines.push(pad("Characters ready for migration", summary.readyCharacters));
  lines.push(pad("Errors / warnings", summary.errors));
  lines.push(pad("Total duration", `${(summary.durationMs / 1000).toFixed(1)}s`));
  lines.push("");
  lines.push("Stages");
  lines.push(rule);
  for (const stage of summary.stages) {
    lines.push(pad(stage.name, `${(stage.durationMs / 1000).toFixed(1)}s`));
  }
  lines.push("");
  lines.push("Notes");
  lines.push(rule);
  lines.push("  - No files were uploaded, copied, or modified. SillyTavern and Lumiverse");
  lines.push("    were read only; no bundle or intermediate archive was produced.");
  lines.push("  - Gallery images are stat()ed for size but never opened or decoded.");
  lines.push("  - expected_migration_result assumes gallery files are added per character in");
  lines.push("    ascending-filename order, minting gallery://image-<k> in that sequence.");
  lines.push("    The direct importer must use that ordering for the prediction to hold.");
  lines.push("");
  return lines.join("\n");
}

export async function writeSummary(path: string, summary: AuditSummary): Promise<void> {
  mkdirSync(join(path, ".."), { recursive: true });
  const writer = new BufferedWriter(path);
  for (const line of formatSummary(summary).split("\n")) writer.write(line);
  await writer.close();
}
