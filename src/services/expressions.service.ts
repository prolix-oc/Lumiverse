import { unzipSync } from "fflate";
import { getCharacter, updateCharacter, type UpdateCharacterOptions } from "./characters.service";
import { uploadImage, uploadImages } from "./images.service";
import type { Character } from "../types/character";

// Cap on the total bytes produced by expression ZIP decompression. fflate's
// unzipSync has no built-in output cap, so a small compressed file with a
// multi-GB decompressed payload would otherwise OOM the process (zip bomb).
// Mirrors the guard in character-card.service.ts; expression images are tiny,
// so a 100 MB budget is far above legitimate use.
const MAX_EXPRESSIONS_DECOMPRESSED_SIZE = 100 * 1024 * 1024;

/**
 * unzipSync filter that aborts extraction once the archive's declared
 * decompressed size crosses the cap. Throws inside the filter so fflate stops
 * before allocating the bomb's output buffer.
 */
function makeDecompressionCapFilter(): NonNullable<Parameters<typeof unzipSync>[1]>["filter"] {
  let plannedBytes = 0;
  return (entry) => {
    const ext = entry.name.lastIndexOf(".");
    const wanted = ext >= 0 && IMAGE_EXTENSIONS.has(entry.name.slice(ext).toLowerCase());
    if (!wanted) return false;
    plannedBytes += entry.originalSize ?? 0;
    if (plannedBytes > MAX_EXPRESSIONS_DECOMPRESSED_SIZE) {
      throw new Error(
        `Expression ZIP decompresses to more than ${MAX_EXPRESSIONS_DECOMPRESSED_SIZE / 1024 / 1024} MB`,
      );
    }
    return true;
  };
}

export interface ExpressionConfig {
  enabled: boolean;
  /** Local chat presentation preference; absent on legacy characters. */
  useAsAvatar?: boolean;
  defaultExpression: string;
  mappings: Record<string, string>; // label → image_id
}

const EMPTY_CONFIG: ExpressionConfig = {
  enabled: false,
  useAsAvatar: false,
  defaultExpression: "",
  mappings: {},
};

function getExtensions(character: Character): Record<string, any> {
  return character.extensions ?? {};
}

export function getExpressionConfig(userId: string, characterId: string): ExpressionConfig | null {
  const character = getCharacter(userId, characterId);
  if (!character) return null;
  const raw = getExtensions(character).expressions;
  if (!raw) return { ...EMPTY_CONFIG };
  return {
    enabled: !!raw.enabled,
    useAsAvatar: raw.useAsAvatar === true,
    defaultExpression: raw.defaultExpression ?? "",
    mappings: raw.mappings ?? {},
  };
}

function saveConfig(
  userId: string,
  characterId: string,
  config: ExpressionConfig,
  options: UpdateCharacterOptions = {},
): ExpressionConfig {
  const character = getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  const extensions = { ...getExtensions(character), expressions: config };
  updateCharacter(userId, characterId, { extensions }, options);
  return config;
}

export function putExpressionConfig(userId: string, characterId: string, config: ExpressionConfig): ExpressionConfig {
  return saveConfig(userId, characterId, {
    enabled: !!config.enabled,
    useAsAvatar: config.useAsAvatar === undefined
      ? (getExpressionConfig(userId, characterId)?.useAsAvatar ?? false)
      : config.useAsAvatar === true,
    defaultExpression: config.defaultExpression ?? "",
    mappings: config.mappings ?? {},
  });
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function getFileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function getBaseName(name: string): string {
  // Strip directories (handle both / and \ separators from ZIP)
  const lastSlash = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const basename = lastSlash >= 0 ? name.slice(lastSlash + 1) : name;
  const dot = basename.lastIndexOf(".");
  return dot >= 0 ? basename.slice(0, dot) : basename;
}

export async function importFromZip(
  userId: string,
  characterId: string,
  zipBuffer: Buffer
): Promise<ExpressionConfig> {
  const unzipped = unzipSync(new Uint8Array(zipBuffer), {
    filter: makeDecompressionCapFilter(),
  });

  const existing = getExpressionConfig(userId, characterId) ?? { ...EMPTY_CONFIG };
  const newMappings: Record<string, string> = { ...existing.mappings };

  const mimeMap: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };

  for (const [entryName, data] of Object.entries(unzipped)) {
    if (!data || data.length === 0) continue;
    const ext = getFileExtension(entryName);
    if (!IMAGE_EXTENSIONS.has(ext)) continue;

    const label = getBaseName(entryName).toLowerCase().replace(/[^a-z0-9_\- ]/g, "").trim();
    if (!label) continue;

    const filename = entryName.split("/").pop() || `${label}${ext}`;
    const file = new File([new Uint8Array(data).buffer as ArrayBuffer], filename, {
      type: mimeMap[ext] || "application/octet-stream",
    });

    const image = await uploadImage(userId, file, { owner_character_id: characterId });
    newMappings[label] = image.id;
  }

  const config: ExpressionConfig = {
    useAsAvatar: existing.useAsAvatar ?? false,
    enabled: existing.enabled || Object.keys(newMappings).length > 0,
    defaultExpression: existing.defaultExpression || Object.keys(newMappings)[0] || "",
    mappings: newMappings,
  };

  return saveConfig(userId, characterId, config);
}

export function mapFromGallery(
  userId: string,
  characterId: string,
  mappings: Record<string, string>
): ExpressionConfig {
  const existing = getExpressionConfig(userId, characterId) ?? { ...EMPTY_CONFIG };
  const merged: Record<string, string> = { ...existing.mappings, ...mappings };

  const config: ExpressionConfig = {
    useAsAvatar: existing.useAsAvatar ?? false,
    enabled: existing.enabled || Object.keys(merged).length > 0,
    defaultExpression: existing.defaultExpression || Object.keys(merged)[0] || "",
    mappings: merged,
  };

  return saveConfig(userId, characterId, config);
}

export function removeExpression(userId: string, characterId: string, label: string): ExpressionConfig {
  const existing = getExpressionConfig(userId, characterId) ?? { ...EMPTY_CONFIG };
  const { [label]: _, ...rest } = existing.mappings;

  const config: ExpressionConfig = {
    useAsAvatar: existing.useAsAvatar ?? false,
    enabled: existing.enabled,
    defaultExpression: existing.defaultExpression === label
      ? (Object.keys(rest)[0] || "")
      : existing.defaultExpression,
    mappings: rest,
  };

  return saveConfig(userId, characterId, config);
}

export async function importFromAssets(
  userId: string,
  characterId: string,
  assets: Array<{ label: string; file: File }>
): Promise<ExpressionConfig> {
  const existing = getExpressionConfig(userId, characterId) ?? { ...EMPTY_CONFIG };
  const newMappings: Record<string, string> = { ...existing.mappings };

  for (const { label, file } of assets) {
    const image = await uploadImage(userId, file, { owner_character_id: characterId });
    newMappings[label] = image.id;
  }

  const config: ExpressionConfig = {
    useAsAvatar: existing.useAsAvatar ?? false,
    enabled: Object.keys(newMappings).length > 0,
    defaultExpression: existing.defaultExpression
      || ("default" in newMappings ? "default" : Object.keys(newMappings)[0] || ""),
    mappings: newMappings,
  };

  return saveConfig(userId, characterId, config);
}

export interface ExpressionImageData {
  label: string;
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface ExpressionImageDataImportResult {
  config: ExpressionConfig;
  importedLabels: string[];
  failed: number;
}

/**
 * Persist one bounded batch of already-downloaded expression images.
 *
 * `uploadImages` writes the originals in a batch and puts every eligible image
 * on the standard deferred metadata/thumbnail queue. In particular, this must
 * not call Sharp directly: remote expression packs can contain hundreds of
 * images, and request-local thumbnail fan-out can exhaust small hosts.
 */
export async function importFromImageData(
  userId: string,
  characterId: string,
  assets: readonly ExpressionImageData[],
  options: UpdateCharacterOptions = {},
): Promise<ExpressionImageDataImportResult> {
  const existing = getExpressionConfig(userId, characterId) ?? { ...EMPTY_CONFIG };
  if (assets.length === 0) {
    return { config: existing, importedLabels: [], failed: 0 };
  }

  const results = await uploadImages(
    userId,
    assets.map((asset) => ({
      data: asset.data,
      filename: asset.filename,
      mime_type: asset.mimeType,
      owner_character_id: characterId,
    })),
    {
      // Disk writes are cheap, but keeping this below the download batch size
      // avoids multiplying live references to large remote response buffers.
      concurrency: 2,
      deferProcessing: true,
    },
  );

  const newMappings: Record<string, string> = { ...existing.mappings };
  const importedLabels: string[] = [];
  let failed = 0;
  for (let i = 0; i < assets.length; i++) {
    const image = results[i]?.image;
    if (!image) {
      failed++;
      continue;
    }
    newMappings[assets[i]!.label] = image.id;
    importedLabels.push(assets[i]!.label);
  }

  if (importedLabels.length === 0) {
    return { config: existing, importedLabels, failed };
  }

  const config: ExpressionConfig = {
    useAsAvatar: existing.useAsAvatar ?? false,
    enabled: existing.enabled || Object.keys(newMappings).length > 0,
    defaultExpression: existing.defaultExpression
      || ("default" in newMappings ? "default" : Object.keys(newMappings)[0] || ""),
    mappings: newMappings,
  };
  return {
    config: saveConfig(userId, characterId, config, options),
    importedLabels,
    failed,
  };
}

export function getExpressionLabels(userId: string, characterId: string): string[] {
  const config = getExpressionConfig(userId, characterId);
  if (!config?.mappings) return [];
  return Object.keys(config.mappings);
}

export function hasExpressions(userId: string, characterId: string): boolean {
  const config = getExpressionConfig(userId, characterId);
  return !!config?.enabled && Object.keys(config.mappings).length > 0;
}

// ── Multi-character expression groups ─────────────────────────────────────────

/** Character name → { cleanLabel → imageId } mapping, stored in character.extensions.expression_groups. */
export type ExpressionGroups = Record<string, Record<string, string>>;

/**
 * Returns the multi-character expression groups from a character's extensions,
 * or null if the character doesn't have grouped expressions.
 */
export function getExpressionGroups(userId: string, characterId: string): ExpressionGroups | null {
  const character = getCharacter(userId, characterId);
  if (!character) return null;
  const groups = getExtensions(character).expression_groups;
  if (!groups || typeof groups !== "object" || Object.keys(groups).length === 0) return null;
  return groups as ExpressionGroups;
}

/** Returns true if a character has multi-character expression groups configured. */
export function hasExpressionGroups(userId: string, characterId: string): boolean {
  return getExpressionGroups(userId, characterId) !== null;
}

/** Replaces the full expression_groups object in character extensions. */
export function putExpressionGroups(
  userId: string,
  characterId: string,
  groups: ExpressionGroups,
): ExpressionGroups {
  const character = getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  const extensions = { ...getExtensions(character), expression_groups: groups };
  updateCharacter(userId, characterId, { extensions });
  return groups;
}

/** Removes a single label from a character group. Deletes the group if empty. */
export function removeGroupLabel(
  userId: string,
  characterId: string,
  groupName: string,
  label: string,
): ExpressionGroups {
  const groups = getExpressionGroups(userId, characterId);
  if (!groups || !groups[groupName]) throw new Error("Group not found");
  const { [label]: _, ...rest } = groups[groupName];
  const updated = { ...groups, [groupName]: rest };
  if (Object.keys(rest).length === 0) delete updated[groupName];
  return putExpressionGroups(userId, characterId, updated);
}

/** Creates a new empty character group. */
export function addGroup(
  userId: string,
  characterId: string,
  groupName: string,
): ExpressionGroups {
  const existing = getExpressionGroups(userId, characterId) || {};
  if (existing[groupName]) throw new Error("Group already exists");
  return putExpressionGroups(userId, characterId, { ...existing, [groupName]: {} });
}

/** Adds a single expression to a group. */
export function addGroupLabel(
  userId: string,
  characterId: string,
  groupName: string,
  label: string,
  imageId: string,
): ExpressionGroups {
  const existing = getExpressionGroups(userId, characterId) || {};
  const group = existing[groupName];
  if (!group) throw new Error("Group not found");
  return putExpressionGroups(userId, characterId, {
    ...existing,
    [groupName]: { ...group, [label]: imageId },
  });
}

/** Import a ZIP of named images into a specific expression group. */
export async function importGroupFromZip(
  userId: string,
  characterId: string,
  groupName: string,
  zipBuffer: Buffer,
): Promise<ExpressionGroups> {
  const existing = getExpressionGroups(userId, characterId) || {};
  const group = existing[groupName];
  if (!group) throw new Error("Group not found");

  const unzipped = unzipSync(new Uint8Array(zipBuffer), {
    filter: makeDecompressionCapFilter(),
  });

  const newMappings: Record<string, string> = { ...group };

  const mimeMap: Record<string, string> = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
  };

  for (const [entryName, data] of Object.entries(unzipped)) {
    if (!data || data.length === 0) continue;
    const ext = entryName.lastIndexOf(".") >= 0 ? entryName.slice(entryName.lastIndexOf(".")).toLowerCase() : "";
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const label = getBaseName(entryName).toLowerCase().replace(/[^a-z0-9_\- ]/g, "").trim();
    if (!label) continue;
    const filename = entryName.split("/").pop() || `${label}${ext}`;
    const file = new File([new Uint8Array(data).buffer as ArrayBuffer], filename, {
      type: mimeMap[ext] || "application/octet-stream",
    });
    const image = await uploadImage(userId, file, { owner_character_id: characterId });
    newMappings[label] = image.id;
  }

  return putExpressionGroups(userId, characterId, { ...existing, [groupName]: newMappings });
}

/**
 * Convert flat single-character expressions into a multi-character group.
 * Moves all mappings from `expressions.mappings` into a group named after the character,
 * then clears the flat config.
 */
export function convertToGroups(
  userId: string,
  characterId: string,
): ExpressionGroups {
  const character = getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  const config = getExpressionConfig(userId, characterId);
  const groupName = character.name || "Default";
  const mappings = config?.mappings && Object.keys(config.mappings).length > 0
    ? { ...config.mappings }
    : {};
  const groups: ExpressionGroups = { [groupName]: mappings };
  // Clear flat expressions and set groups
  const extensions = {
    ...getExtensions(character),
    expressions: { enabled: false, useAsAvatar: config?.useAsAvatar ?? false, defaultExpression: "", mappings: {} },
    expression_groups: groups,
  };
  updateCharacter(userId, characterId, { extensions });
  return groups;
}

/** Revert a single remaining group back to flat expression mode. */
export function convertToFlat(
  userId: string,
  characterId: string,
  groupName: string,
): ExpressionConfig {
  const groups = getExpressionGroups(userId, characterId);
  if (!groups || !groups[groupName]) throw new Error("Group not found");
  if (Object.keys(groups).length > 1) throw new Error("Cannot convert: multiple groups exist");
  const mappings = groups[groupName];
  const character = getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  const config: ExpressionConfig = {
    useAsAvatar: getExpressionConfig(userId, characterId)?.useAsAvatar ?? false,
    enabled: Object.keys(mappings).length > 0,
    defaultExpression: Object.keys(mappings)[0] || "",
    mappings,
  };
  const extensions: Record<string, any> = { ...getExtensions(character), expressions: config };
  delete extensions.expression_groups;
  updateCharacter(userId, characterId, { extensions });
  return config;
}

/** Removes an entire character group. */
export function removeGroup(
  userId: string,
  characterId: string,
  groupName: string,
): ExpressionGroups {
  const groups = getExpressionGroups(userId, characterId);
  if (!groups) throw new Error("No expression groups found");
  const { [groupName]: _, ...rest } = groups;
  return putExpressionGroups(userId, characterId, rest);
}
