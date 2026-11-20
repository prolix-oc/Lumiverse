/** Install one Illarin delivery through Lumiverse's existing import paths. */

import { strFromU8, unzipSync } from "fflate";
import { fetchDeliveryArtifact } from "./api";
import { installExtensionDelivery } from "./extensions";
import type { IllarinDelivery } from "./types";
import {
  installCharacter,
  installPreset,
  installTheme,
  installWorldbook,
} from "../lumihub/installer";
import * as imagesSvc from "../services/images.service";
import * as packsSvc from "../services/packs.service";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_PRESET_COVER_BYTES = 50 * 1024 * 1024;
const MAX_THEME_BYTES = 200 * 1024 * 1024;
const MAX_THEME_ENTRIES = 500;
const MAX_THEME_EXPANDED_BYTES = 250 * 1024 * 1024;
const MAX_EXTENSION_BYTES = 32 * 1024 * 1024;

const PRESET_COVER_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/apng": "apng",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

function exportUrl(delivery: IllarinDelivery): string {
  const artifact = delivery.files.find((item) => item.type === "export");
  if (!artifact) throw new Error(`Illarin delivery ${delivery.id} has no export artifact`);
  return artifact.url;
}

async function fetchJsonArtifact(delivery: IllarinDelivery): Promise<Record<string, any>> {
  const response = await fetchDeliveryArtifact(exportUrl(delivery), { maxBytes: MAX_JSON_BYTES });
  const value = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Illarin delivery ${delivery.id} is not a JSON object`);
  }
  return value as Record<string, any>;
}

export interface PresetCoverDependencies {
  fetchArtifact: (url: string, options: { maxBytes: number }) => Promise<Response>;
  uploadImage: (userId: string, file: File) => Promise<{ url: string }>;
}

const presetCoverDependencies: PresetCoverDependencies = {
  fetchArtifact: fetchDeliveryArtifact,
  uploadImage: imagesSvc.uploadImage,
};

/**
 * Copy Illarin's short-lived cover artifact into Lumiverse-owned storage.
 * The local image URL remains usable after the delivery lease and signed URL
 * expire, and the worker will not acknowledge the delivery until this returns.
 */
export async function persistIllarinPresetCover(
  userId: string,
  delivery: IllarinDelivery,
  dependencies: PresetCoverDependencies = presetCoverDependencies,
): Promise<string | null> {
  const cover = delivery.files.find((artifact) => artifact.type === "picture" && artifact.isCover === true);
  if (!cover) return null;

  const response = await dependencies.fetchArtifact(cover.url, { maxBytes: MAX_PRESET_COVER_BYTES });
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  const extension = PRESET_COVER_EXTENSIONS[contentType];
  if (!extension) {
    throw new Error(`Illarin preset delivery ${delivery.id} has an unsupported cover type`);
  }
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PRESET_COVER_BYTES) {
    throw new Error(`Illarin preset delivery ${delivery.id} has an invalid cover size`);
  }
  const stored = await dependencies.uploadImage(
    userId,
    new File([bytes], `illarin-preset-cover.${extension}`, { type: contentType }),
  );
  return stored.url;
}

function safeArchivePath(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return Boolean(normalized)
    && !normalized.startsWith("/")
    && !normalized.split("/").includes("..")
    && /^[A-Za-z0-9._/-]+$/.test(normalized);
}

async function decodeThemeArtifact(delivery: IllarinDelivery): Promise<Record<string, any>> {
  const response = await fetchDeliveryArtifact(exportUrl(delivery), { maxBytes: MAX_THEME_BYTES });
  const bytes = new Uint8Array(await response.arrayBuffer());
  let entries: Record<string, Uint8Array>;
  let entryCount = 0;
  let declaredExpandedBytes = 0;
  try {
    entries = unzipSync(bytes, {
      // Check the central-directory sizes before fflate allocates expanded
      // buffers. Illarin assets are creator-controlled, so the compressed
      // download limit alone is not enough to rule out a zip bomb.
      filter: (entry) => {
        entryCount++;
        declaredExpandedBytes += entry.originalSize;
        if (entryCount > MAX_THEME_ENTRIES) throw new Error("too many entries");
        if (declaredExpandedBytes > MAX_THEME_EXPANDED_BYTES) throw new Error("expanded size is too large");
        if (!safeArchivePath(entry.name)) throw new Error("unsafe archive path");
        return true;
      },
    });
  } catch {
    throw new Error(`Illarin theme delivery ${delivery.id} is not a valid archive`);
  }
  const names = Object.keys(entries);
  if (names.length > MAX_THEME_ENTRIES || !entries["theme.json"]) {
    throw new Error(`Illarin theme delivery ${delivery.id} has an invalid archive layout`);
  }
  let expanded = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (!safeArchivePath(name)) throw new Error(`Illarin theme delivery ${delivery.id} has an unsafe path`);
    expanded += data.byteLength;
    if (expanded > MAX_THEME_EXPANDED_BYTES) {
      throw new Error(`Illarin theme delivery ${delivery.id} expands beyond the safe limit`);
    }
  }
  const manifest = JSON.parse(strFromU8(entries["theme.json"])) as Record<string, any>;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`Illarin theme delivery ${delivery.id} has an invalid manifest`);
  }
  const descriptors = Array.isArray(manifest.assets) ? manifest.assets : [];
  manifest.assets = descriptors.map((raw: any) => {
    if (!raw || typeof raw !== "object" || typeof raw.archivePath !== "string" || !safeArchivePath(raw.archivePath)) {
      throw new Error(`Illarin theme delivery ${delivery.id} has an invalid asset descriptor`);
    }
    const data = entries[raw.archivePath];
    if (!data) throw new Error(`Illarin theme delivery ${delivery.id} is missing ${raw.archivePath}`);
    return {
      slug: typeof raw.slug === "string" && raw.slug ? raw.slug : raw.archivePath,
      originalFilename: typeof raw.originalFilename === "string" ? raw.originalFilename : raw.archivePath.split("/").pop(),
      mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "application/octet-stream",
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
      dataBase64: Buffer.from(data).toString("base64"),
    };
  });
  return manifest;
}

function requireSuccess(result: { success: boolean; error?: string }, delivery: IllarinDelivery): void {
  if (!result.success) throw new Error(result.error || `Illarin ${delivery.type} installation failed`);
}

export function characterInstallPayload(delivery: IllarinDelivery) {
  return {
    source: "illarin" as const,
    characterId: delivery.workId,
    characterName: delivery.name,
    importUrl: exportUrl(delivery),
    importEmbeddedWorldbook: true,
    ...(delivery.format === "charx"
      ? {}
      : { galleryImageUrls: delivery.files.filter((item) => item.type === "picture").map((item) => item.url) }),
  };
}

/** Accept both portable Loom documents and LumiHub-style export envelopes. */
export function illarinPresetInstallPayload(
  delivery: IllarinDelivery,
  document: Record<string, any>,
  coverUrl: string | null,
) {
  const wrapped = Object.hasOwn(document, "preset");
  const preset = wrapped ? document.preset : document;
  if (!preset || typeof preset !== "object" || Array.isArray(preset) || !Array.isArray(preset.blocks)) {
    throw new Error(`Illarin preset delivery ${delivery.id} has no Lumiverse prompt blocks`);
  }
  if (!Number.isSafeInteger(delivery.versionNumber) || delivery.versionNumber < 1) {
    throw new Error(`Illarin preset delivery ${delivery.id} has an invalid version number`);
  }
  return {
    source: "illarin" as const,
    presetId: delivery.workId,
    presetName: delivery.name,
    presetVersion: typeof preset.presetVersion === "string" ? preset.presetVersion : null,
    presetVersionNumber: delivery.versionNumber,
    presetData: {
      ...(wrapped ? document : { preset }),
      // An absent sidecar must not erase a cover embedded in the export.
      ...(coverUrl === null ? {} : { coverUrl, cover_url: coverUrl }),
    },
  };
}

export async function installIllarinDelivery(userId: string, delivery: IllarinDelivery): Promise<void> {
  switch (delivery.type) {
    case "character": {
      const result = await installCharacter(delivery.id, userId, characterInstallPayload(delivery));
      requireSuccess(result, delivery);
      return;
    }
    case "lorebook": {
      const data = await fetchJsonArtifact(delivery);
      const result = await installWorldbook(delivery.id, userId, {
        source: "illarin",
        worldbookId: delivery.workId,
        worldbookName: delivery.name,
        worldbookData: data as any,
      });
      requireSuccess(result, delivery);
      return;
    }
    case "preset": {
      const preset = await fetchJsonArtifact(delivery);
      const coverUrl = await persistIllarinPresetCover(userId, delivery);
      const result = await installPreset(delivery.id, userId, illarinPresetInstallPayload(delivery, preset, coverUrl));
      requireSuccess(result, delivery);
      return;
    }
    case "theme": {
      const themeData = await decodeThemeArtifact(delivery);
      const result = await installTheme(delivery.id, userId, {
        source: "illarin",
        themeId: delivery.workId,
        themeName: delivery.name,
        themeData,
      });
      requireSuccess(result, delivery);
      return;
    }
    case "extension": {
      const response = await fetchDeliveryArtifact(exportUrl(delivery), { maxBytes: MAX_EXTENSION_BYTES });
      await installExtensionDelivery(userId, delivery, new Uint8Array(await response.arrayBuffer()));
      return;
    }
    case "pack": {
      const pack = packsSvc.importPack(userId, await fetchJsonArtifact(delivery) as any);
      eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
        characterId: pack.id,
        characterName: pack.name,
        source: "illarin",
        type: "pack",
      }, userId);
      return;
    }
    default:
      throw new Error(`Illarin send type "${delivery.type}" is not supported`);
  }
}
