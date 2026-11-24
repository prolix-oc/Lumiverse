/**
 * Read-only dry-run audit of a SillyTavern character gallery, in preparation
 * for a direct (filesystem, bundle-free) media migration into Lumiverse.
 *
 * Guarantees:
 *   - never writes to the SillyTavern data directory
 *   - never uploads, copies, or rewrites images, characters, or chats
 *   - never creates a bundle or intermediate archive
 *   - reads card metadata with bounded positioned reads (no pixel decoding)
 *   - stats gallery files for size but never opens them
 *   - streams report rows to disk instead of accumulating them in memory
 *
 * The audit resolves each card's CharacterLibrary gallery folder, indexes the
 * folder's contents, and matches the card's external media URLs against those
 * files using CL's own rules — reported as unique, ambiguous, or missing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LocalFileSystem } from "../../file-connections/providers/local";
import type { FileEntry, FileSystem } from "../../file-connections/types";
import { currentWorkerBudget } from "../../utils/cpu-budget";
import {
  buildGalleryFileIndex,
  classifyGalleryAsset,
  findCharacterMediaUrls,
  galleryFolderName,
  lookupLocalizedMedia,
  stSanitizeFilename,
  type GalleryFileIndex,
} from "./cl-algorithms";
import { indexGalleryIdSuffixes, resolveGalleryFolder } from "./resolve";
import { readCardMetadata } from "./png-metadata";
import {
  createErrorsWriter,
  createUrlsWriter,
  ensureOutDir,
  reportPaths,
  writeAssetsJsonl,
  writeCardsCsv,
  writeSummary,
} from "./reports";
import type {
  AuditErrorRecord,
  AuditOptions,
  AuditSummary,
  CardRecord,
  FolderRecord,
  GalleryFileRecord,
  ResolutionStatus,
  UrlMatchRecord,
} from "./types";

const IMAGE_EXTENSION_RE = /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i;
const MEDIA_EXTENSION_RE = /\.(png|jpg|jpeg|webp|gif|bmp|svg|mp3|wav|ogg|m4a|mp4|webm)$/i;
const GALLERY_PROGRESS_EVERY = 500;

export interface AuditProgressEvent {
  stage: string;
  current: number;
  total: number;
  message?: string;
}

export interface AuditHooks {
  progress?: (event: AuditProgressEvent) => void;
  /** Return true to stop early; the audit finishes the current row and closes its writers. */
  isCancelled?: () => boolean;
  /** Extra report rows produced by the optional chat scan. */
  onChatUrl?: (record: { chatFile: string; characterDir: string; url: string; status: string; rule: string; candidateFolder: string; candidateFilename: string }) => void;
}

interface CharacterRecord extends CardRecord {
  /** Card JSON, retained until URL matching finishes; dropped per card afterwards. */
  card: unknown;
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await mapper(items[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/** Read CL's persisted settings so the audit reproduces the install's own behavior. */
export function detectClSettings(
  stDataDir: string,
): { uniqueGalleryFolders: boolean; includeLorebook: boolean } {
  // CL defaults (library.js:626): unique folders OFF, lorebook scanning OFF.
  const defaults = { uniqueGalleryFolders: false, includeLorebook: false };
  try {
    const parsed = JSON.parse(readFileSync(join(stDataDir, "settings.json"), "utf8")) as Record<string, unknown>;
    const extensionSettings = parsed.extension_settings;
    if (!extensionSettings || typeof extensionSettings !== "object") return defaults;
    const cl = (extensionSettings as Record<string, unknown>).SillyTavernCharacterGallery;
    if (!cl || typeof cl !== "object") return defaults;
    const settings = cl as Record<string, unknown>;
    return {
      uniqueGalleryFolders: settings.uniqueGalleryFolders === true,
      includeLorebook: settings.includeLorebook === true,
    };
  } catch {
    return defaults;
  }
}

function emptyFolderRecord(folder: string): FolderRecord {
  return { folder, fileCount: 0, imageCount: 0, totalBytes: 0, extensions: {}, characters: [] };
}

function emptyCardRecord(filename: string): CardRecord {
  return {
    filename,
    characterName: null,
    galleryId: null,
    expectedFolder: "",
    expectedFolderOnDisk: "",
    resolvedFolder: null,
    contestedFolder: null,
    legacy: false,
    status: "unreadable",
    sizeBytes: 0,
    embeddedUrls: [],
    lorebookUrls: [],
    matchedUrls: 0,
  };
}

export async function runGalleryAudit(
  options: AuditOptions,
  hooks: AuditHooks = {},
  fs: FileSystem = new LocalFileSystem(),
): Promise<AuditSummary> {
  const startedAt = Date.now();
  const stages: AuditSummary["stages"] = [];
  const stageStart = (name: string) => {
    const at = Date.now();
    return () => stages.push({ name, durationMs: Date.now() - at });
  };
  const emit = (stage: string, current: number, total: number, message?: string) =>
    hooks.progress?.({ stage, current, total, message });

  const errors: AuditErrorRecord[] = [];
  const recordError = (stage: string, path: string, err: unknown) => {
    errors.push({ stage, path, message: err instanceof Error ? err.message : String(err) });
  };

  ensureOutDir(options.outDir);
  const detected = detectClSettings(options.stDataDir);
  const uniqueGalleryFolders = options.uniqueGalleryFolders ?? detected.uniqueGalleryFolders;
  const includeLorebook = options.includeLorebook ?? detected.includeLorebook;
  const includeChats = options.includeChats ?? false;
  const concurrency = options.concurrency ?? Math.max(1, Math.min(currentWorkerBudget().workerConcurrency, 16));

  const charactersDir = fs.join(options.stDataDir, "characters");
  const imagesDir = fs.join(options.stDataDir, "user", "images");

  // ── Stage 1: discover cards ─────────────────────────────────────────────
  const endDiscover = stageStart("discover cards");
  const charEntries: FileEntry[] = (await fs.exists(charactersDir)) ? await fs.readdir(charactersDir) : [];
  const cardFiles = charEntries
    .filter((entry) => entry.isFile && fs.extname(entry.name).toLowerCase() === ".png")
    .map((entry) => entry.name);
  emit("discovering", cardFiles.length, cardFiles.length);
  endDiscover();

  // ── Stage 2: extract metadata ───────────────────────────────────────────
  const endMetadata = stageStart("extract metadata");
  let processed = 0;
  const cards = await mapWithConcurrency<string, CharacterRecord>(
    cardFiles,
    concurrency,
    async (filename) => {
      const base = emptyCardRecord(filename) as CharacterRecord;
      base.card = null;
      const path = fs.join(charactersDir, filename);
      try {
        const stat = await fs.stat(path).catch(() => null);
        base.sizeBytes = stat?.size ?? 0;
        const metadata = await readCardMetadata(fs, path);
        if (metadata.error) recordError("metadata", path, metadata.error);
        if (metadata.malformed || !metadata.json) {
          base.status = metadata.malformed ? "unreadable" : "no_name";
          return base;
        }
        const card = metadata.json;
        const rawData = card.data;
        const data = (rawData && typeof rawData === "object" && !Array.isArray(rawData)
          ? rawData
          : card) as Record<string, unknown>;
        const rawExtensions = data.extensions;
        const extensions = rawExtensions && typeof rawExtensions === "object" && !Array.isArray(rawExtensions)
          ? (rawExtensions as Record<string, unknown>)
          : {};
        base.card = card;
        base.characterName = typeof data.name === "string" ? data.name : null;
        base.galleryId = typeof extensions.gallery_id === "string" ? extensions.gallery_id : null;
        base.status = base.characterName ? "no_folder" : "no_name";
        base.expectedFolder = galleryFolderName(base.characterName, base.galleryId, uniqueGalleryFolders);
        base.expectedFolderOnDisk = stSanitizeFilename(base.expectedFolder);
        return base;
      } catch (err) {
        recordError("metadata", path, err);
        return base;
      } finally {
        processed++;
        if (processed % GALLERY_PROGRESS_EVERY === 0) emit("metadata", processed, cardFiles.length, filename);
      }
    },
  );
  emit("metadata", cardFiles.length, cardFiles.length);
  endMetadata();

  // ── Stage 3: index gallery folders ──────────────────────────────────────
  const endIndex = stageStart("index gallery");
  const folderEntries: FileEntry[] = (await fs.exists(imagesDir)) ? await fs.readdir(imagesDir) : [];
  const folderNames = folderEntries.filter((entry) => entry.isDirectory).map((entry) => entry.name);
  const folders = new Map<string, FolderRecord>();
  const folderFiles = new Map<string, GalleryFileRecord[]>();
  const byGalleryIdSuffix = indexGalleryIdSuffixes(folderNames);
  for (const name of folderNames) folders.set(name, emptyFolderRecord(name));

  let filesWithContent = 0;
  let indexedFolders = 0;
  for (const folder of folderNames) {
    if (hooks.isCancelled?.()) break;
    const dirPath = fs.join(imagesDir, folder);
    const record = folders.get(folder)!;
    const files: GalleryFileRecord[] = [];
    try {
      const entries = await fs.readdir(dirPath);
      for (const entry of entries) {
        if (!entry.isFile || !MEDIA_EXTENSION_RE.test(entry.name)) continue;
        const stat = await fs.stat(fs.join(dirPath, entry.name)).catch(() => null);
        const extension = fs.extname(entry.name).toLowerCase();
        const sizeBytes = stat?.size ?? 0;
        files.push({ folder, filename: entry.name, extension, sizeBytes });
        record.fileCount++;
        record.totalBytes += sizeBytes;
        record.extensions[extension] = (record.extensions[extension] ?? 0) + 1;
        if (IMAGE_EXTENSION_RE.test(entry.name)) record.imageCount++;
      }
    } catch (err) {
      recordError("gallery-index", dirPath, err);
    }
    // Deterministic iteration order for both reporting and reference prediction.
    files.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    folderFiles.set(folder, files);
    if (files.length > 0) filesWithContent++;
    indexedFolders++;
    if (indexedFolders % GALLERY_PROGRESS_EVERY === 0) emit("gallery-index", indexedFolders, folderNames.length, folder);
  }
  emit("gallery-index", folderNames.length, folderNames.length);
  endIndex();

  // ── Stage 4: resolve folders ────────────────────────────────────────────
  const endResolve = stageStart("resolve folders");
  for (const card of cards) {
    if (card.status === "unreadable" || !card.characterName) continue;
    const { folder, status } = resolveGalleryFolder(
      card.characterName,
      card.galleryId,
      uniqueGalleryFolders,
      (candidate) => folders.has(candidate),
      byGalleryIdSuffix,
    );
    card.resolvedFolder = folder;
    if (!folder) {
      card.status = status === "ambiguous_gid" ? "ambiguous_gid" : "no_folder";
      continue;
    }
    const record = folders.get(folder)!;
    card.legacy = status === "legacy_name_only";
    card.status = status === "gid_suffix_match" || status === "legacy_name_only"
      ? status
      : record.imageCount > 0
        ? "resolved_nonempty"
        : "resolved_empty";
    record.characters.push(card.filename);
  }

  // A folder every image in which could belong to more than one character is
  // contested: report it, and never claim those characters are migration-ready.
  // Also demote a card whose own resolved folder is claimed by another card.
  const contestedFolders = new Set<string>();
  for (const [name, record] of folders) {
    if (record.fileCount > 0 && record.characters.length > 1) contestedFolders.add(name);
  }
  for (const card of cards) {
    if (!card.resolvedFolder || !contestedFolders.has(card.resolvedFolder)) continue;
    card.contestedFolder = card.resolvedFolder;
    card.resolvedFolder = null;
    card.status = "ambiguous_shared";
  }
  emit("resolving", cards.length, cards.length);
  endResolve();

  // ── Stage 5: match localized media ──────────────────────────────────────
  const endMatch = stageStart("match media");
  const urlsWriter = createUrlsWriter(options.outDir);
  const indexCache = new Map<string, GalleryFileIndex>();
  const indexFor = (folder: string): GalleryFileIndex => {
    const cached = indexCache.get(folder);
    if (cached) return cached;
    const built = buildGalleryFileIndex((folderFiles.get(folder) ?? []).map((file) => file.filename));
    indexCache.set(folder, built);
    return built;
  };
  const expectedReferenceFor = (folder: string, filename: string): string => {
    if (!IMAGE_EXTENSION_RE.test(filename)) {
      return "/api/v1/images/<image-id> (non-image asset; id assigned at import)";
    }
    const files = (folderFiles.get(folder) ?? []).filter((file) => IMAGE_EXTENSION_RE.test(file.filename));
    const position = files.findIndex((file) => file.filename === filename) + 1;
    return position > 0 ? `gallery://image-${position}` : "";
  };

  // Two source URLs can share one localized file (same image referenced twice,
  // or CL's alias dedup). Both map to one gallery item, so record which URL
  // first claimed the file rather than emitting the same reference twice.
  const referenceClaimedBy = new Map<string, string>();

  const urlStats = { instances: 0, unique: 0, matchedUnique: 0, ambiguous: 0, missing: 0, byRule: {} as Record<string, number> };
  const uniqueUrls = new Set<string>();
  const charactersWithUrls = new Set<string>();
  const readyCharacters = new Set<string>();
  let matchProgress = 0;

  for (const character of cards) {
    if (hooks.isCancelled?.()) break;
    if (character.card) {
      try {
        const media = findCharacterMediaUrls(character.card, includeLorebook);
        character.embeddedUrls = media.embedded;
        character.lorebookUrls = media.lorebook;
      } catch (err) {
        recordError("media-scan", character.filename, err);
      }
      character.card = null; // release the payload; only URL strings remain
    }

    const embeddedSet = new Set(character.embeddedUrls);
    const all = [...character.embeddedUrls, ...character.lorebookUrls];
    matchProgress++;
    if (all.length === 0) {
      if (matchProgress % GALLERY_PROGRESS_EVERY === 0) emit("matching", matchProgress, cards.length, character.filename);
      continue;
    }
    charactersWithUrls.add(character.filename);
    urlStats.instances += all.length;

    const folder = character.resolvedFolder;
    const index = folder ? indexFor(folder) : null;
    let matchedForCharacter = 0;

    for (const url of all) {
      uniqueUrls.add(url);
      const source: UrlMatchRecord["source"] = embeddedSet.has(url) ? "embedded" : "lorebook";
      let status: UrlMatchRecord["status"] = "missing";
      let rule: UrlMatchRecord["rule"] = "";
      let candidateFilename = "";
      let derivedName = url.split("/").pop() ?? "";

      if (index) {
        const lookup = lookupLocalizedMedia(index, url);
        status = lookup.status;
        rule = lookup.rule ?? "";
        derivedName = lookup.derivedName;
        candidateFilename = lookup.file ?? "";
        if (status === "ambiguous") {
          urlStats.ambiguous++;
          if (lookup.candidates) {
            recordError("ambiguous-url", character.filename, `URL ${url} matches ${lookup.candidates.length} files in "${folder}"`);
          }
        } else if (status === "unique") {
          urlStats.matchedUnique++;
          urlStats.byRule[rule] = (urlStats.byRule[rule] ?? 0) + 1;
          matchedForCharacter++;
        } else {
          urlStats.missing++;
        }
      } else {
        urlStats.missing++;
      }

      const localPath = candidateFilename && folder
        ? `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(candidateFilename)}`
        : "";
      let expectedReference = "";
      if (status === "unique" && candidateFilename && folder) {
        const claimKey = `${character.filename}\u0000${folder}\u0000${candidateFilename}`;
        const claimedBy = referenceClaimedBy.get(claimKey);
        const reference = expectedReferenceFor(folder, candidateFilename);
        if (claimedBy === undefined) {
          referenceClaimedBy.set(claimKey, url);
          expectedReference = reference;
        } else {
          // Same file already claimed by an earlier URL for this character.
          expectedReference = claimedBy === url
            ? reference
            : `same file as previously listed URL (${reference})`;
        }
      }

      urlsWriter.write({
        characterFile: character.filename,
        characterName: character.characterName ?? "",
        source,
        url,
        derivedName,
        candidateFilename,
        candidateFolder: folder ?? character.contestedFolder ?? "",
        status,
        rule,
        localPath,
        expectedReference,
        assetClass: candidateFilename ? classifyGalleryAsset(candidateFilename) : "",
      });
    }

    character.matchedUrls = matchedForCharacter;
    if (matchedForCharacter > 0) readyCharacters.add(character.filename);
    if (matchProgress % GALLERY_PROGRESS_EVERY === 0) emit("matching", matchProgress, cards.length, character.filename);
  }
  emit("matching", cards.length, cards.length);
  await urlsWriter.close();
  urlStats.unique = uniqueUrls.size;
  endMatch();

  // ── Stage 6: optional chat scan ─────────────────────────────────────────
  const chatStats = { scanned: 0, withUrls: 0, instances: 0, matched: 0, missing: 0 };
  if (includeChats) {
    const endChats = stageStart("scan chats");
    // Chat directories are keyed by avatar stem, not gallery folder.
    const folderByStem = new Map<string, string>();
    for (const card of cards) {
      if (card.resolvedFolder) folderByStem.set(card.filename.replace(/\.png$/i, ""), card.resolvedFolder);
    }
    const chatsDir = fs.join(options.stDataDir, "chats");
    const chatEntries: FileEntry[] = (await fs.exists(chatsDir)) ? await fs.readdir(chatsDir) : [];
    const chatFolders = chatEntries.filter((entry) => entry.isDirectory);
    let chatIndex = 0;
    for (const dir of chatFolders) {
      if (hooks.isCancelled?.()) break;
      const folder = folderByStem.get(dir.name) ?? null;
      const index = folder ? indexFor(folder) : null;
      const dirPath = fs.join(chatsDir, dir.name);
      const entries = await fs.readdir(dirPath).catch(() => [] as FileEntry[]);
      for (const entry of entries) {
        if (!entry.isFile || fs.extname(entry.name).toLowerCase() !== ".jsonl") continue;
        chatStats.scanned++;
        const chatPath = fs.join(dirPath, entry.name);
        try {
          const text = await fs.readText(chatPath);
          const found = findCharacterMediaUrls({ data: { first_mes: text } }, false).embedded;
          if (found.length === 0) continue;
          chatStats.withUrls++;
          chatStats.instances += found.length;
          for (const url of found) {
            const lookup = index ? lookupLocalizedMedia(index, url) : null;
            if (lookup?.status === "unique") chatStats.matched++;
            else chatStats.missing++;
            hooks.onChatUrl?.({
              chatFile: chatPath,
              characterDir: dir.name,
              url,
              status: lookup?.status ?? "missing",
              rule: lookup?.rule ?? "",
              candidateFolder: folder ?? "",
              candidateFilename: lookup?.file ?? "",
            });
          }
        } catch (err) {
          recordError("chats", chatPath, err);
        }
      }
      chatIndex++;
      if (chatIndex % GALLERY_PROGRESS_EVERY === 0) emit("chats", chatIndex, chatFolders.length, dir.name);
    }
    emit("chats", chatFolders.length, chatFolders.length);
    endChats();
  }

  // ── Reports ─────────────────────────────────────────────────────────────
  const endReports = stageStart("generate reports");
  let orphanNonEmpty = 0;
  let orphanFiles = 0;
  let orphanBytes = 0;
  let sharedNonEmpty = 0;
  let sharedCharacters = 0;
  const usedFolders = new Set<string>();
  for (const card of cards) if (card.resolvedFolder) usedFolders.add(card.resolvedFolder);
  for (const [name, record] of folders) {
    if (record.fileCount > 0 && !usedFolders.has(name)) {
      orphanNonEmpty++;
      orphanFiles += record.fileCount;
      orphanBytes += record.totalBytes;
    }
    if (record.fileCount > 0 && record.characters.length > 1) {
      sharedNonEmpty++;
      sharedCharacters += record.characters.length;
    }
  }

  const nameCounts = new Map<string, number>();
  const gidCounts = new Map<string, number>();
  for (const card of cards) {
    if (card.characterName) nameCounts.set(card.characterName, (nameCounts.get(card.characterName) ?? 0) + 1);
    if (card.galleryId) gidCounts.set(card.galleryId, (gidCounts.get(card.galleryId) ?? 0) + 1);
  }

  const assetClassCounts: Record<string, number> = {};
  let totalAssets = 0;
  let totalImages = 0;
  let totalBytes = 0;
  for (const files of folderFiles.values()) {
    for (const file of files) {
      totalAssets++;
      totalBytes += file.sizeBytes;
      if (IMAGE_EXTENSION_RE.test(file.filename)) totalImages++;
      const cls = classifyGalleryAsset(file.filename);
      assetClassCounts[cls] = (assetClassCounts[cls] ?? 0) + 1;
    }
  }

  const statusCounts: Record<ResolutionStatus, number> = {
    resolved_nonempty: 0, resolved_empty: 0, legacy_name_only: 0, gid_suffix_match: 0,
    ambiguous_shared: 0, ambiguous_gid: 0, no_folder: 0, no_name: 0, unreadable: 0,
  };
  for (const card of cards) statusCounts[card.status]++;

  const summary: AuditSummary = {
    stDataDir: options.stDataDir,
    outDir: options.outDir,
    generatedAt: new Date().toISOString(),
    uniqueGalleryFolders,
    includeLorebook,
    includeChats,
    cards: {
      total: cards.length,
      parsed: cards.filter((card) => card.status !== "unreadable").length,
      unreadable: statusCounts.unreadable,
      withName: cards.filter((card) => card.characterName !== null).length,
      withGalleryId: cards.filter((card) => card.galleryId !== null).length,
      duplicateNames: [...nameCounts.values()].filter((count) => count > 1).length,
      duplicateGalleryIds: [...gidCounts.values()].filter((count) => count > 1).length,
      uniqueGalleryIds: gidCounts.size,
    },
    folders: {
      onDisk: folderNames.length,
      nonEmpty: filesWithContent,
      resolvedNonEmpty: statusCounts.resolved_nonempty,
      resolvedEmpty: statusCounts.resolved_empty,
      legacyNameOnly: statusCounts.legacy_name_only,
      gidSuffixMatch: statusCounts.gid_suffix_match,
      ambiguousShared: statusCounts.ambiguous_shared,
      ambiguousGid: statusCounts.ambiguous_gid,
      missing: statusCounts.no_folder,
      noName: statusCounts.no_name,
      unreadable: statusCounts.unreadable,
      orphanNonEmpty,
      orphanFiles,
      orphanBytes,
      sharedNonEmpty,
      sharedCharacters,
      totalFiles: totalAssets,
      totalImages,
      totalBytes,
    },
    urls: {
      charactersWithUrls: charactersWithUrls.size,
      instances: urlStats.instances,
      unique: urlStats.unique,
      uniqueMatched: urlStats.matchedUnique,
      ambiguous: urlStats.ambiguous,
      missing: urlStats.missing,
      byRule: urlStats.byRule,
    },
    assets: { total: totalAssets, byClass: assetClassCounts },
    chats: chatStats,
    readyCharacters: readyCharacters.size,
    errors: errors.length,
    durationMs: Date.now() - startedAt,
    stages,
  };

  await writeCardsCsv(reportPaths(options.outDir).cards, cards, folders);
  await writeAssetsJsonl(options.outDir, folders, folderFiles);
  const errorsWriter = createErrorsWriter(options.outDir);
  for (const error of errors) errorsWriter.write(error);
  await errorsWriter.close();
  endReports();

  summary.stages = stages;
  summary.durationMs = Date.now() - startedAt;
  await writeSummary(reportPaths(options.outDir).summary, summary);
  return summary;
}
