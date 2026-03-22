import { unzipSync } from "fflate";
import { getCharacter, updateCharacter } from "./characters.service";
import { uploadImage } from "./images.service";
import type { Character } from "../types/character";

export interface ExpressionConfig {
  enabled: boolean;
  defaultExpression: string;
  mappings: Record<string, string>; // label → image_id
}

const EMPTY_CONFIG: ExpressionConfig = {
  enabled: false,
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
    defaultExpression: raw.defaultExpression ?? "",
    mappings: raw.mappings ?? {},
  };
}

function saveConfig(userId: string, characterId: string, config: ExpressionConfig): ExpressionConfig {
  const character = getCharacter(userId, characterId);
  if (!character) throw new Error("Character not found");
  const extensions = { ...getExtensions(character), expressions: config };
  updateCharacter(userId, characterId, { extensions });
  return config;
}

export function putExpressionConfig(userId: string, characterId: string, config: ExpressionConfig): ExpressionConfig {
  return saveConfig(userId, characterId, {
    enabled: !!config.enabled,
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
    filter: (entry) => {
      const ext = getFileExtension(entry.name);
      return IMAGE_EXTENSIONS.has(ext);
    },
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

    const image = await uploadImage(userId, file);
    newMappings[label] = image.id;
  }

  const config: ExpressionConfig = {
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
    enabled: existing.enabled,
    defaultExpression: existing.defaultExpression === label
      ? (Object.keys(rest)[0] || "")
      : existing.defaultExpression,
    mappings: rest,
  };

  return saveConfig(userId, characterId, config);
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
