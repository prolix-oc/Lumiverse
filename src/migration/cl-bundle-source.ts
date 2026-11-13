import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import { ArchiveValidationError } from "../services/user-data/import.service";
import type { ClBundleCharacter, ClBundleManifest, ClMigrationIssue } from "./cl-types";

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_CL_ITEM_BYTES = 128 * 1024 * 1024;

function invalid(message: string): never {
  throw new ArchiveValidationError("not_zip", message);
}

export function safeClArchivePath(path: unknown): string {
  if (typeof path !== "string" || !path || path.length > 4096 || /[\x00-\x1f\\]/.test(path)
    || /^([A-Za-z]:|\/)/.test(path) || path.split("/").some((s) => !s || s === "." || s === "..")) {
    invalid("CharacterLibrary bundle contains an unsafe archive path");
  }
  return path;
}

function segment(value: unknown, label: string): string {
  const path = safeClArchivePath(value);
  if (path.includes("/")) invalid(`${label} must be a single filename or folder name`);
  return path;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100_000 || value.some((s) => typeof s !== "string" || !s)) {
    invalid(`${label} must be an array of nonempty strings`);
  }
  return [...new Set(value)] as string[];
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalid(`${label} must be a string`);
  return value;
}

export function validateClManifest(raw: unknown): ClBundleManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("Invalid CharacterLibrary manifest");
  const m = raw as Record<string, any>;
  if (m.version !== 1) invalid("This migrator supports CharacterLibrary bundle version 1");
  if (m.generator !== "SillyTavern-CharacterLibrary") invalid("Not a CharacterLibrary full bundle");
  if (!Array.isArray(m.characters) || !m.characters.length || m.characters.length > 100_000) {
    invalid("CharacterLibrary manifest must contain 1 to 100000 characters");
  }
  const avatars = new Set<string>();
  const characters = m.characters.map((c: any): ClBundleCharacter => {
    if (!c || typeof c !== "object" || Array.isArray(c)) invalid("Invalid character manifest entry");
    const avatar = segment(c.avatar, "Character avatar");
    if (!/\.png$/i.test(avatar)) invalid("Character avatar must be a PNG filename");
    if (avatars.has(avatar)) invalid("Duplicate character identity in bundle");
    avatars.add(avatar);
    const chatFiles = strings(c.chatFiles ?? [], "chatFiles").map((f) => {
      segment(f, "Chat filename");
      if (!/\.jsonl$/i.test(f)) invalid("Chat files must have a .jsonl extension");
      return f;
    });
    if (c.gallery !== undefined && (!c.gallery || typeof c.gallery !== "object" || Array.isArray(c.gallery))) invalid("Invalid gallery inventory");
    const files = strings(c.gallery?.files ?? [], "Gallery files").map((f) => segment(f, "Gallery filename"));
    const folder = optionalString(c.gallery?.folder, "Gallery folder") ?? "";
    if (folder) segment(folder, "Gallery folder");
    if (files.length && !folder) invalid("Gallery files require a folder identity");
    if (c.fav !== undefined && typeof c.fav !== "boolean") invalid("Favorite state must be boolean");
    return {
      avatar, name: optionalString(c.name, "Character name"),
      create_date: optionalString(c.create_date, "Creation date"), fav: c.fav,
      chat: optionalString(c.chat, "Active chat"), galleryId: optionalString(c.galleryId, "Gallery ID"),
      chatFiles, gallery: { folder, files },
      primaryWorld: optionalString(c.primaryWorld, "Primary world"),
      ...(c.auxWorlds !== undefined ? { auxWorlds: strings(c.auxWorlds, "Additional worlds") } : {}),
      worlds: strings(c.worlds ?? [], "World references"),
    };
  });
  if (m.worlds !== undefined && !Array.isArray(m.worlds)) invalid("Invalid world inventory");
  const names = new Set<string>();
  const worlds = (m.worlds ?? []).map((w: any) => {
    if (!w || typeof w.name !== "string" || !w.name || w.name.length > 4096) invalid("Invalid world file identity");
    if (names.has(w.name)) invalid("Duplicate world identity in bundle");
    names.add(w.name);
    const file = safeClArchivePath(w.file);
    if (!file.startsWith("worlds/") || !file.endsWith(".json")) invalid("World payload must be a JSON file under worlds/");
    return { name: w.name, file };
  });
  return { version: 1, generator: "SillyTavern-CharacterLibrary", exportedAt: optionalString(m.exportedAt, "Export date"), characters, worlds };
}

export async function readClManifest(root: string): Promise<ClBundleManifest> {
  const path = join(root, "manifest.json");
  if (statSync(path).size > MAX_MANIFEST_BYTES) invalid("CharacterLibrary manifest exceeds 16 MB");
  let raw: unknown;
  try { raw = JSON.parse(await Bun.file(path).text()); } catch { invalid("Invalid JSON in CharacterLibrary manifest"); }
  return validateClManifest(raw);
}

export function clChatPath(c: ClBundleCharacter, file: string): string {
  return `chats/${c.avatar.replace(/\.png$/i, "")}/${file}`;
}

export function clGalleryPath(c: ClBundleCharacter, file: string): string {
  return `gallery/${c.gallery.folder}/${file}`;
}

export function clBundlePaths(manifest: ClBundleManifest): Set<string> {
  const paths = new Set<string>();
  for (const c of manifest.characters) {
    paths.add(`cards/${c.avatar}`);
    for (const file of c.chatFiles) paths.add(clChatPath(c, file));
    for (const file of c.gallery.files) paths.add(clGalleryPath(c, file));
  }
  for (const w of manifest.worlds) paths.add(w.file);
  return paths;
}

export function clInventoryIssues(manifest: ClBundleManifest, root: string): ClMigrationIssue[] {
  const issues: ClMigrationIssue[] = [{
    severity: "warning", code: "v1_inventory", source: "manifest.json",
    message: "Bundle v1 does not inventory expressions, external script files, or regex permission. Originals are retained; full runtime parity cannot be verified.",
  }, {
    severity: "warning", code: "media_localization", source: "gallery",
    message: "Local ST image paths in character/chat text can be restored. Historical remote-URL localization and lorebook media require richer source mappings; original URLs are preserved.",
  }];
  if (manifest.characters.some((c) => c.auxWorlds === undefined)) issues.push({
    severity: "warning", code: "unknown_aux_worlds", source: "manifest.json",
    message: "Some characters have no additional-lorebook inventory; omitted links are unknown, not verified empty.",
  });
  for (const path of clBundlePaths(manifest)) {
    try {
      const stat = statSync(join(root, path));
      if (!stat.isFile()) throw new Error();
      if (stat.size > MAX_CL_ITEM_BYTES) issues.push({ severity: "error", code: "item_too_large", source: path, message: "Item exceeds the 128 MB per-item processing limit; original bytes remain in the retained archive." });
    } catch {
      issues.push({ severity: "error", code: "missing_file", source: path, message: "A manifest-referenced file is missing from the archive." });
    }
  }
  const knownWorlds = new Set(manifest.worlds.map((w) => w.name));
  for (const c of manifest.characters) {
    for (const name of new Set([c.primaryWorld, ...(c.auxWorlds ?? []), ...(c.worlds ?? [])].filter(Boolean) as string[])) {
      if (!knownWorlds.has(name)) issues.push({ severity: "warning", code: "missing_world", source: c.avatar, message: `Referenced world "${name}" is not bundled; it will not be matched to an unrelated same-name book.` });
    }
  }
  return issues;
}

export async function clFileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function readClItem(root: string, path: string): Promise<Uint8Array> {
  const file = Bun.file(join(root, safeClArchivePath(path)));
  if (file.size > MAX_CL_ITEM_BYTES) throw new Error("Item exceeds the 128 MB processing limit");
  return new Uint8Array(await file.arrayBuffer());
}
