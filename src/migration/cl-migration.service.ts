import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env";
import { getDb } from "../db/connection";
import { extractSelectedZipEntries, persistUploadedArchive } from "../services/user-data/import.service";
import { extractCardFromPng, extractPngTextChunk } from "../services/character-card.service";
import { createCharacter, getCharacter, updateCharacter } from "../services/characters.service";
import { importWorldBookBulk, deleteWorldBook } from "../services/world-books.service";
import { uploadImages, getImage, waitForDeferredImageProcessing } from "../services/images.service";
import { addToGallery, getGalleryItem } from "../services/character-gallery.service";
import { importRegexScripts, getRegexScriptsByCharacterId } from "../services/regex-scripts.service";
import { bulkInsertMessages, createChatRaw } from "../services/chats.service";
import { getSetting, putSetting } from "../services/settings.service";
import { setCharacterWorldBookIds } from "../utils/character-world-books";
import { currentWorkerBudget } from "../utils/cpu-budget";
import { yieldToEventLoop } from "../llm/stream-utils";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { isMigrationRunning } from "./st-migration.service";
import { parseDateString, parseStGroupChatJsonl } from "./st-reader";
import { clBundlePaths, clChatPath, clFileSha256, clGalleryPath, clInventoryIssues, readClItem, readClManifest, safeClArchivePath } from "./cl-bundle-source";
import type { ClBundleCharacter, ClMigrationIssue, ClMigrationItemResult, ClMigrationJob, ClMigrationOptions, ClMigrationPreview, ClMigrationReport } from "./cl-types";

export class ClMigrationError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

interface JobRow {
  id: string; user_id: string; source_id: string; archive_sha256: string; filename: string;
  status: ClMigrationJob["status"]; preview: string; progress: string; report: string | null;
}
type Kind = ClMigrationItemResult["kind"];
const activeJobs = new Map<string, Promise<void>>();
const activeUploads = new Set<string>();
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function rootFor(userId: string, jobId: string): string { return join(env.dataDir, "imports", userId, jobId); }
export function clMigrationArchivePath(userId: string, jobId: string): string | null {
  if (!getClMigrationJob(userId, jobId)) return null;
  const path = join(rootFor(userId, jobId), "archive.lvbak");
  return existsSync(path) ? path : null;
}

export function getClMigrationJob(userId: string, jobId: string): ClMigrationJob | null {
  const row = getDb().query("SELECT * FROM cl_migration_jobs WHERE id = ? AND user_id = ?").get(jobId, userId) as JobRow | null;
  if (!row) return null;
  if (row.status === "running" && !activeJobs.has(jobId)) {
    row.status = "interrupted";
    getDb().query("UPDATE cl_migration_jobs SET status = 'interrupted', updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), jobId, userId);
  }
  return { ...JSON.parse(row.preview), status: row.status, progress: JSON.parse(row.progress), report: row.report ? JSON.parse(row.report) : null };
}

export function listClMigrationJobs(userId: string): ClMigrationJob[] {
  const rows = getDb().query("SELECT id FROM cl_migration_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50").all(userId) as Array<{ id: string }>;
  return rows.map((r) => getClMigrationJob(userId, r.id)!);
}

export async function stageClMigrationBundle(options: {
  userId: string; body: ReadableStream<Uint8Array>; declaredSize: number | null; filename?: string; sourceId?: string;
}): Promise<ClMigrationPreview> {
  if (activeUploads.has(options.userId)) throw new ClMigrationError(409, "busy", "A bundle upload is already being processed for this account");
  if (options.sourceId !== undefined && !/^[A-Za-z0-9._:-]{1,200}$/.test(options.sourceId)) {
    throw new ClMigrationError(400, "invalid_source", "sourceId must contain 1 to 200 letters, numbers, dots, underscores, colons, or hyphens");
  }
  const jobId = crypto.randomUUID();
  const root = rootFor(options.userId, jobId);
  activeUploads.add(options.userId);
  try {
    const saved = await persistUploadedArchive(options.userId, options.body, options.declaredSize, jobId);
    const dataRoot = join(root, "bundle");
    mkdirSync(dataRoot, { recursive: true });
    const select = (name: string) => {
      safeClArchivePath(name.endsWith("/") ? name.slice(0, -1) : name);
      return name === "manifest.json" ? name : null;
    };
    const extraction = await extractSelectedZipEntries({ archivePath: saved.path, destinationDir: dataRoot, selectEntry: select, maxDecompressedBytes: 16 * 1024 * 1024 });
    if (!extraction.selectedEntries) throw new ClMigrationError(422, "invalid_bundle", "manifest.json is missing; export a CharacterLibrary full bundle");
    const manifest = await readClManifest(dataRoot);
    const paths = clBundlePaths(manifest);
    await extractSelectedZipEntries({
      archivePath: saved.path, destinationDir: dataRoot,
      allowIdenticalDuplicate: (name) => name.startsWith("gallery/"),
      selectEntry(name) {
        safeClArchivePath(name.endsWith("/") ? name.slice(0, -1) : name);
        return paths.has(name) ? name : null;
      },
    });
    const archiveSha256 = await clFileSha256(saved.path);
    const preview: ClMigrationPreview = {
      jobId, filename: (options.filename || "cl-bundle.zip").replace(/[\x00-\x1f]/g, "").slice(0, 255),
      archiveSha256, sourceId: options.sourceId ?? `cl-v1:${archiveSha256}`,
      counts: {
        characters: manifest.characters.length, worlds: manifest.worlds.length,
        chats: manifest.characters.reduce((n, c) => n + c.chatFiles.length, 0),
        galleryFiles: new Set(manifest.characters.flatMap((c) => c.gallery.files.map((f) => clGalleryPath(c, f)))).size,
      },
      issues: clInventoryIssues(manifest, dataRoot),
    };
    const now = Date.now();
    getDb().query(`INSERT INTO cl_migration_jobs
      (id, user_id, source_id, archive_sha256, filename, status, preview, progress, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'ready', ?, ?, ?, ?)`)
      .run(jobId, options.userId, preview.sourceId, archiveSha256, preview.filename, JSON.stringify(preview), JSON.stringify({ phase: "ready", current: 0, total: 0 }), now, now);
    return preview;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally { activeUploads.delete(options.userId); }
}

export function deleteClMigrationJob(userId: string, jobId: string): boolean {
  const job = getClMigrationJob(userId, jobId);
  if (!job) return false;
  if (activeJobs.has(jobId)) throw new ClMigrationError(409, "busy", "Cannot delete a running migration");
  rmSync(rootFor(userId, jobId), { recursive: true, force: true });
  getDb().query("DELETE FROM cl_migration_jobs WHERE id = ? AND user_id = ?").run(jobId, userId);
  return true;
}

function ownedDestination(userId: string, kind: Kind, id: string): boolean {
  const tables: Record<Kind, string> = { character: "characters", avatar: "images", asset: "images", world: "world_books", embedded_world: "world_books", gallery: "character_gallery", regex: "regex_scripts", chat: "chats", favorite: "characters" };
  const row = getDb().query(`SELECT id FROM ${tables[kind]} WHERE id = ? AND user_id = ?${(kind === "character" || kind === "favorite") ? " AND deleting = 0" : ""}`).get(id, userId);
  if (!row) return false;
  if (kind === "avatar" || kind === "asset") {
    const image = getImage(userId, id);
    return !!image && existsSync(join(env.dataDir, "images", image.filename));
  }
  return true;
}

function findItem(userId: string, sourceId: string, kind: Kind, source: string, hash: string): string | null {
  const row = getDb().query("SELECT sha256, destination_id FROM cl_migration_items WHERE user_id = ? AND source_id = ? AND kind = ? AND source_key = ?")
    .get(userId, sourceId, kind, source) as { sha256: string; destination_id: string } | null;
  if (!row) return null;
  if (row.sha256 !== hash) throw new Error("Source content changed for an already imported identity; use a different sourceId to import a separate copy");
  return ownedDestination(userId, kind, row.destination_id) ? row.destination_id : null;
}

function saveItem(userId: string, sourceId: string, kind: Kind, source: string, hash: string, id: string): void {
  getDb().query(`INSERT INTO cl_migration_items (user_id, source_id, kind, source_key, sha256, destination_id, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, source_id, kind, source_key)
    DO UPDATE SET sha256 = excluded.sha256, destination_id = excluded.destination_id, completed_at = excluded.completed_at`)
    .run(userId, sourceId, kind, source, hash, id, Date.now());
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4" };

/** Direct-service receiver, shared by the HTTP/CLI entrypoint and fixture tests. */
export async function executeClMigration(userId: string, jobId: string, options: ClMigrationOptions = {}): Promise<ClMigrationReport> {
  const job = getClMigrationJob(userId, jobId);
  if (!job) throw new ClMigrationError(404, "not_found", "Migration not found");
  const sourceId = job.sourceId;
  const root = join(rootFor(userId, jobId), "bundle");
  const report: ClMigrationReport = { jobId, sourceId, status: "running", items: [], issues: [...job.issues], totals: { imported: 0, reused: 0, failed: 0, preserved: 0 } };
  const add = (kind: Kind, source: string, status: ClMigrationItemResult["status"], destinationId?: string, note?: string) => {
    report.items.push({ kind, source, status, ...(destinationId ? { destinationId } : {}), ...(note ? { message: note } : {}) });
    report.totals[status]++;
  };
  const warn = (code: string, source: string, text: string) => report.issues.push({ severity: "warning", code, source, message: text });
  const phase = (name: string, current: number, total: number) => {
    getDb().query("UPDATE cl_migration_jobs SET progress = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(JSON.stringify({ phase: name, current, total }), Date.now(), jobId, userId);
  };
  const sync = (kind: Kind, source: string, hash: string, create: () => string, valid?: (id: string) => boolean) => {
    const candidate = findItem(userId, sourceId, kind, source, hash);
    const existing = candidate && (!valid || valid(candidate)) ? candidate : null;
    if (existing) { add(kind, source, "reused", existing); return existing; }
    const id = getDb().transaction(() => { const id = create(); saveItem(userId, sourceId, kind, source, hash, id); return id; })();
    add(kind, source, "imported", id);
    return id;
  };
  const images = async (entries: Array<{ source: string; bytes: Uint8Array; kind: "asset" | "avatar"; owner?: string }>) => {
    const ready: Array<typeof entries[number] & { hash: string }> = [];
    const map = new Map<string, string>();
    for (const e of entries) {
      try {
        const hash = digest(e.bytes);
        const old = findItem(userId, sourceId, e.kind, e.source, hash);
        if (old && (e.kind !== "avatar" || getImage(userId, old)?.owner_character_id === e.owner)) { map.set(e.source, old); add(e.kind, e.source, "reused", old); } else ready.push({ ...e, hash });
      } catch (error) { add(e.kind, e.source, "failed", undefined, message(error)); }
    }
    const results = await uploadImages(userId, ready.map((e) => ({
      data: e.bytes, filename: e.source.split("/").pop()!, mime_type: MIME[e.source.split(".").pop()!.toLowerCase()] ?? "application/octet-stream", owner_character_id: e.owner,
    })), { concurrency: Math.min(currentWorkerBudget().workerConcurrency, 4), deferProcessing: true });
    getDb().transaction(() => {
      for (let i = 0; i < ready.length; i++) {
        const e = ready[i]!; const result = results[i];
        if (!result?.image) { add(e.kind, e.source, "failed", undefined, result?.error ?? "Asset upload failed"); continue; }
        saveItem(userId, sourceId, e.kind, e.source, e.hash, result.image.id);
        map.set(e.source, result.image.id); add(e.kind, e.source, "imported", result.image.id);
      }
    })();
    return map;
  };
  getDb().query("UPDATE cl_migration_jobs SET status = 'running', updated_at = ? WHERE id = ? AND user_id = ?").run(Date.now(), jobId, userId);
  try {
    const manifest = await readClManifest(root);
    const characters = new Map<string, string>();
    const primaryRefs = new Map<string, string>();
    const stemIds = new Map<string, string>();
    const textMappings = new Map<string, Map<string, string>>();
    const sourceScripts = new Map<string, unknown>();
    const assetHashes = new Map<string, string>();
    for (let i = 0; i < manifest.characters.length; i++) {
      const c = manifest.characters[i]!; const path = `cards/${c.avatar}`;
      phase("characters", i + 1, manifest.characters.length);
      try {
        const bytes = await readClItem(root, path);
        const input = await extractCardFromPng(bytes);
        try {
          const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
          const v2 = extractPngTextChunk(buffer, "chara"), v3 = extractPngTextChunk(buffer, "ccv3");
          if (v2 && v3 && v2 !== v3) warn("png_payloads_differ", path, "PNG contains different chara and ccv3 payloads. The existing card parser uses chara; both originals remain in the retained ZIP.");
        } catch { warn("secondary_png_payload", path, "An additional PNG payload could not be read. The selected card imported; original metadata remains in the retained ZIP."); }
        const primary = c.primaryWorld ?? (typeof input.extensions?.world === "string" ? input.extensions.world : "");
        primaryRefs.set(c.avatar, primary);
        sourceScripts.set(c.avatar, input.extensions?.lumiverse_modules?.regex_scripts ?? input.extensions?.regex_scripts);
        const extensions = { ...(input.extensions ?? {}) };
        // Source IDs are raw evidence, not live destination bindings.
        for (const key of ["world_book_ids", "world_book_id", "expressions", "expression_groups", "risu_asset_map", "original_image_id", "avatar_crop_image_id", "alternate_avatars", "avatar_bindings", "greeting_backgrounds"]) delete extensions[key];
        extensions._lumiverse_character_library = { sourceId, avatar: c.avatar, sourceJobId: jobId };
        extensions._lumiverse_source_filename = `cl:${sourceId}/${c.avatar}`;
        const date = c.create_date ? parseDateString(c.create_date) : null;
        const id = sync("character", path, digest(bytes), () => createCharacter(userId, { ...input, extensions, library_scope: "mine", ...(date ? { created_at: date } : {}) }, { emitEvent: false }).id);
        characters.set(c.avatar, id); stemIds.set(c.avatar.replace(/\.png$/i, ""), id);
        const avatarIds = await images([{ source: path, bytes, kind: "avatar", owner: id }]);
        const imageId = avatarIds.get(path);
        if (imageId) {
          const character = getCharacter(userId, id)!;
          // A retry repairs missing avatars, while preserving an avatar the user changed.
          if (!character.image_id || character.image_id === imageId || !ownedDestination(userId, "avatar", character.image_id)) {
            getDb().query("UPDATE characters SET image_id = ?, avatar_path = ? WHERE id = ? AND user_id = ?").run(imageId, getImage(userId, imageId)!.filename, id, userId);
          }
        }
        try {
          if (input.extensions?.character_book?.entries) {
            const book = input.extensions.character_book;
            const key = `${path}#character_book`; const hash = digest(JSON.stringify(book));
            const existing = findItem(userId, sourceId, "embedded_world", key, hash);
            if (existing) add("embedded_world", key, "reused", existing);
            else {
              const imported = await importBook(userId, book, { emitEvent: false, metadata: { source: "character", source_character_id: id, auto_managed_by_character: true, character_library: { sourceId, sourceKey: key, active: false } } });
              saveItem(userId, sourceId, "embedded_world", key, hash, imported.worldBook.id);
              add("embedded_world", key, "imported", imported.worldBook.id);
            }
            warn("embedded_snapshot", c.avatar, "Embedded lorebook snapshot is preserved as a character-managed book. Only explicit external source links are activated, avoiding duplicate lore.");
          }
        } catch (error) { add("embedded_world", `${path}#character_book`, "failed", undefined, message(error)); }
      } catch (error) { add("character", path, "failed", undefined, message(error)); }
      await yieldToEventLoop();
    }

    const worlds = new Map<string, string>();
    for (let i = 0; i < manifest.worlds.length; i++) {
      const w = manifest.worlds[i]!; phase("worlds", i + 1, manifest.worlds.length);
      try {
        const bytes = await readClItem(root, w.file); const hash = digest(bytes);
        const existing = findItem(userId, sourceId, "world", w.name, hash);
        if (existing) { worlds.set(w.name, existing); add("world", w.name, "reused", existing); continue; }
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.entries || typeof payload.entries !== "object") throw new Error("World file must contain an entries array or object");
        const result = await importBook(userId, { ...payload, name: payload.name || w.name }, { emitEvent: false, metadata: { source: "character_library", character_library: { sourceId, sourceKey: w.name, file: w.file } } });
        saveItem(userId, sourceId, "world", w.name, hash, result.worldBook.id);
        worlds.set(w.name, result.worldBook.id); add("world", w.name, "imported", result.worldBook.id);
      } catch (error) { add("world", w.name, "failed", undefined, message(error)); }
      await yieldToEventLoop();
    }
    for (const c of manifest.characters) {
      const id = characters.get(c.avatar); if (!id) continue;
      const character = getCharacter(userId, id)!;
      const refs = [...new Set([primaryRefs.get(c.avatar), ...(c.auxWorlds ?? [])].filter(Boolean) as string[])];
      const ids = refs.map((ref) => worlds.get(ref)).filter(Boolean) as string[];
      for (const ref of refs) if (!worlds.has(ref)) warn("unresolved_world", c.avatar, `World "${ref}" could not be linked.`);
      // Merge rather than replacing a user's post-import links on retry.
      const oldIds = Array.isArray(character.extensions.world_book_ids) ? character.extensions.world_book_ids.filter((v: unknown) => typeof v === "string") : [];
      if (ids.length) updateCharacter(userId, id, { extensions: setCharacterWorldBookIds(character.extensions, [...new Set([...oldIds, ...ids])]) }, { emitEvent: false, preserveUpdatedAt: true });
    }

    const assetPaths = new Set(manifest.characters.flatMap((c) => c.gallery.files.map((f) => clGalleryPath(c, f))));
    const assets = new Map<string, string>();
    let pending: Array<{ source: string; bytes: Uint8Array; kind: "asset" }> = []; let pendingBytes = 0; let assetCount = 0;
    const flush = async () => { if (!pending.length) return; for (const [k, v] of await images(pending)) assets.set(k, v); pending = []; pendingBytes = 0; await yieldToEventLoop(); };
    for (const path of assetPaths) {
      phase("gallery", ++assetCount, assetPaths.size);
      try {
        const bytes = await readClItem(root, path);
        assetHashes.set(path, digest(bytes));
        if (pending.length >= 8 || pendingBytes + bytes.byteLength > 32 * 1024 * 1024) await flush();
        pending.push({ source: path, bytes, kind: "asset" }); pendingBytes += bytes.byteLength;
      } catch (error) { add("asset", path, "failed", undefined, message(error)); }
    }
    await flush();
    for (const c of manifest.characters) {
      const characterId = characters.get(c.avatar); if (!characterId) continue;
      const mappings = new Map<string, string>(); textMappings.set(c.avatar, mappings);
      for (const [index, file] of c.gallery.files.entries()) {
        const path = clGalleryPath(c, file); const assetId = assets.get(path); if (!assetId) continue;
        try {
          const key = `${c.avatar}/${path}`;
          const galleryId = sync("gallery", key, assetHashes.get(path)!, () => {
            const item = addToGallery(userId, characterId, assetId, file);
            getDb().query("UPDATE character_gallery SET sort_order = ? WHERE id = ? AND user_id = ?").run(index, item.id, userId);
            return item.id;
          },
            (id) => !!getDb().query("SELECT id FROM character_gallery WHERE id = ? AND user_id = ? AND character_id = ? AND image_id = ?").get(id, userId, characterId, assetId));
          const image = getImage(userId, assetId)!;
          const reference = image.mime_type.startsWith("image/") ? getGalleryItem(userId, galleryId)!.reference : `/api/v1/images/${assetId}`;
          const local = `/user/images/${encodeURIComponent(c.gallery.folder)}/${encodeURIComponent(file)}`;
          mappings.set(local, reference);
          mappings.set(`/user/images/${c.gallery.folder}/${file}`, reference);
        } catch (error) { add("gallery", `${c.avatar}/${path}`, "failed", undefined, message(error)); }
      }
      const character = getCharacter(userId, characterId)!;
      const replace = (text: string) => replaceLocalPaths(text, mappings);
      const fields = ["description", "personality", "scenario", "first_mes", "mes_example", "creator_notes", "system_prompt", "post_history_instructions"] as const;
      const patch: Record<string, any> = {};
      for (const field of fields) if (replace(character[field]) !== character[field]) patch[field] = replace(character[field]);
      if (character.alternate_greetings.some((s) => replace(s) !== s)) patch.alternate_greetings = character.alternate_greetings.map(replace);
      if (Object.keys(patch).length) updateCharacter(userId, characterId, patch, { emitEvent: false, preserveUpdatedAt: true });
    }

    for (let i = 0; i < manifest.characters.length; i++) {
      const c = manifest.characters[i]!; const id = characters.get(c.avatar); if (!id) continue;
      phase("regex", i + 1, manifest.characters.length);
      const rawScripts = sourceScripts.get(c.avatar);
      if (rawScripts === undefined) continue;
      if (!Array.isArray(rawScripts)) { add("regex", c.avatar, "failed", undefined, "Card regex inventory is not an array"); continue; }
      for (let index = 0; index < rawScripts.length; index++) {
        const raw = rawScripts[index]; const key = `${c.avatar}/regex/${index}`;
        try {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid regex script");
          const unsupported = Array.isArray(raw.placement) && raw.placement.some((p: unknown) => typeof p === "number" && ![1, 2, 5, 6].includes(p));
          const disabled = !!raw.disabled || !options.enableRegex || unsupported;
          if (unsupported) warn("regex_placement", key, "Unsupported ST placement; script preserved and imported disabled rather than applying it in a different context.");
          sync("regex", key, digest(JSON.stringify(raw)), () => {
            const result = importRegexScripts(userId, { character_id: id, scripts: [{
              ...raw, script_id: "", sort_order: typeof raw.sort_order === "number" ? raw.sort_order : index, scope: "character", scope_id: id, character_id: id, pack_id: null, preset_id: null, owner_extension_identifier: null,
              replaceString: raw.replaceString !== undefined ? replaceLocalPaths(raw.replaceString, textMappings.get(c.avatar)!) : undefined,
              replace_string: raw.replace_string !== undefined ? replaceLocalPaths(raw.replace_string, textMappings.get(c.avatar)!) : undefined,
              disabled, metadata: { ...(raw.metadata ?? {}), ...(typeof raw.script_id === "string" && raw.script_id.trim() ? { imported_script_id: raw.script_id.trim() } : {}), source: "character_library", cl_source_key: key, cl_source_id: sourceId },
            }] });
            if (result.imported !== 1 || result.errors.length) throw new Error(result.errors.join("; ") || "Regex could not be imported");
            const rows = getRegexScriptsByCharacterId(userId, id).filter((r) => r.metadata.cl_source_key === key && r.metadata.cl_source_id === sourceId);
            if (rows.length !== 1) throw new Error("Regex destination mapping is ambiguous");
            return rows[0]!.id;
          }, (scriptId) => !!getDb().query("SELECT id FROM regex_scripts WHERE id = ? AND user_id = ? AND character_id = ?").get(scriptId, userId, id));
        } catch (error) { add("regex", key, "failed", undefined, message(error)); }
      }
      if (!options.enableRegex && rawScripts.length) warn("regex_permission_unknown", c.avatar, "Bundle v1 omits regex permission. Imported scripts are disabled; enable them in Lumiverse or opt in before the initial import.");
      await yieldToEventLoop();
    }

    let chatCount = 0; const totalChats = manifest.characters.reduce((n, c) => n + c.chatFiles.length, 0);
    for (const c of manifest.characters) {
      const id = characters.get(c.avatar); if (!id) continue;
      for (const file of c.chatFiles) {
        const path = clChatPath(c, file); phase("chats", ++chatCount, totalChats);
        try {
          const bytes = await readClItem(root, path); const text = new TextDecoder().decode(bytes);
          const records = text.split("\n").filter((s) => s.trim()).map((s) => JSON.parse(s));
          if (!records.length || records.some((r) => !r || typeof r !== "object" || Array.isArray(r))) throw new Error("Chat contains an invalid JSONL record");
          const hasHeader = records[0].chat_metadata !== undefined || records[0].user_name !== undefined;
          const parsed = parseStGroupChatJsonl(text, file.replace(/\.jsonl$/i, ""), new Map(), stemIds);
          const expected = records.length - (hasHeader ? 1 : 0);
          if (expected && (!parsed || parsed.messages.length !== expected)) throw new Error("Chat contains message records that cannot be represented without loss");
          const metadata = hasHeader && records[0].chat_metadata && typeof records[0].chat_metadata === "object" && !Array.isArray(records[0].chat_metadata) ? { ...records[0].chat_metadata } : {};
          const world = metadata.world_info;
          for (const key of ["group", "character_ids", "chat_world_book_ids", "active_avatar_id", "group_active_avatar_ids", "persona_id"]) delete metadata[key];
          if (typeof world === "string" && world) {
            if (worlds.has(world)) metadata.chat_world_book_ids = [worlds.get(world)];
            else warn("unresolved_chat_world", path, `Chat-bound world "${world}" is unavailable.`);
          }
          metadata.source = "character_library";
          metadata._lumiverse_character_library = { sourceId, sourceKey: path, sourceJobId: jobId };
          const chatId = sync("chat", path, digest(bytes), () => {
            const chat = createChatRaw(userId, { character_id: id, name: parsed?.name ?? file.replace(/\.jsonl$/i, ""), created_at: parsed?.createdAt, metadata });
            const mappings = textMappings.get(c.avatar)!;
            bulkInsertMessages(chat.id, (parsed?.messages ?? []).map((m) => ({ ...m, content: replaceLocalPaths(m.content, mappings), swipes: m.swipes?.map((s) => replaceLocalPaths(s, mappings)) })), userId);
            return chat.id;
          }, (chatId) => !!getDb().query("SELECT id FROM chats WHERE id = ? AND user_id = ? AND character_id = ?").get(chatId, userId, id));
          if (c.chat && c.chat.replace(/\.jsonl$/i, "") === file.replace(/\.jsonl$/i, "")) {
            const character = getCharacter(userId, id)!;
            updateCharacter(userId, id, { extensions: { ...character.extensions, _lumiverse_cl_active_chat_id: chatId } }, { emitEvent: false, preserveUpdatedAt: true });
          }
        } catch (error) { add("chat", path, "failed", undefined, message(error)); }
        await yieldToEventLoop();
      }
    }
    for (const c of manifest.characters) {
      const id = characters.get(c.avatar); if (!c.fav || !id) continue;
      try {
        sync("favorite", c.avatar, digest("true"), () => {
          const old = getSetting(userId, "favorites")?.value;
          putSetting(userId, "favorites", [...new Set([...(Array.isArray(old) ? old : []), id])]);
          return id;
        }, (characterId) => characterId === id);
      } catch (error) { add("favorite", c.avatar, "failed", undefined, message(error)); }
    }
    report.status = report.totals.failed || report.issues.some((i) => i.severity === "error") ? "partial" : "completed";
  } catch (error) {
    report.status = "failed";
    report.issues.push({ severity: "error", code: "execution_failed", source: "bundle", message: message(error) });
  } finally {
    await waitForDeferredImageProcessing();
    getDb().query("UPDATE cl_migration_jobs SET status = ?, report = ?, progress = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(report.status, JSON.stringify(report), JSON.stringify({ phase: "finished", current: report.items.length, total: report.items.length }), Date.now(), jobId, userId);
    eventBus.emit(EventType.CHARACTER_LIBRARY_CHANGED, { reason: "character_library_migration", imported: report.totals.imported }, userId);
    eventBus.emit(EventType.WORLD_BOOK_LIBRARY_CHANGED, { reason: "character_library_migration" }, userId);
  }
  return report;
}

async function importBook(userId: string, payload: any, options: Parameters<typeof importWorldBookBulk>[2]) {
  const provenance = options?.metadata?.character_library as Record<string, unknown>;
  // Chunked imports yield between commits. An interrupted, unreceipted book is
  // rebuilt; completed books and concurrent user-created books are preserved.
  const abandoned = getDb().query(`SELECT w.id FROM world_books w WHERE w.user_id = ?
    AND json_extract(w.metadata, '$.character_library.sourceId') = ?
    AND json_extract(w.metadata, '$.character_library.sourceKey') = ?
    AND json_extract(w.metadata, '$.character_library.attemptId') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM cl_migration_items i WHERE i.user_id = w.user_id AND i.destination_id = w.id)`)
    .all(userId, provenance.sourceId as string, provenance.sourceKey as string) as Array<{ id: string }>;
  for (const row of abandoned) await deleteWorldBook(userId, row.id);
  const attemptId = crypto.randomUUID();
  try {
    return await importWorldBookBulk(userId, payload, { ...options, metadata: { ...options?.metadata, character_library: { ...provenance, attemptId } } });
  } catch (error) {
    const rows = getDb().query("SELECT id FROM world_books WHERE user_id = ? AND json_extract(metadata, '$.character_library.attemptId') = ?")
      .all(userId, attemptId) as Array<{ id: string }>;
    for (const row of rows) await deleteWorldBook(userId, row.id);
    throw error;
  }
}

function replaceLocalPaths(text: string, mappings: Map<string, string>): string {
  let result = text;
  // Longest first prevents a short filename from consuming another path's prefix.
  for (const [path, reference] of [...mappings].sort((a, b) => b[0].length - a[0].length)) {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Do not consume a filename prefix or a same-looking path at another host.
    result = result.replace(new RegExp(`(?<![\\w:/.-])${escaped}(?![\\w%./-])`, "g"), () => reference);
  }
  return result;
}

export function startClMigration(userId: string, jobId: string, options: ClMigrationOptions = {}): ClMigrationJob {
  const job = getClMigrationJob(userId, jobId);
  if (!job) throw new ClMigrationError(404, "not_found", "Migration not found");
  if (activeJobs.has(jobId)) return job;
  if (activeJobs.size || isMigrationRunning()) throw new ClMigrationError(409, "busy", "Another bulk migration is running; retry after it finishes");
  // Defer work until the promise is registered, so status cannot mistake this for an interrupted job.
  const work = Promise.resolve().then(async () => { await executeClMigration(userId, jobId, options); }).finally(() => activeJobs.delete(jobId));
  activeJobs.set(jobId, work);
  void work.catch((error) => console.error("[cl-migration]", message(error)));
  return { ...job, status: "running" };
}

/** Also useful for graceful shutdown and isolated integration tests. */
export async function waitForClMigrations(): Promise<void> { await Promise.allSettled([...activeJobs.values()]); }
