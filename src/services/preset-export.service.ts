import { ZipArchive, type ArchiverError } from "archiver";
import { Writable } from "stream";
import type { Preset, PromptBlock } from "../types/preset";
import * as presetsSvc from "./presets.service";
import { exportRegexScripts, exportRegexScriptsAsync } from "./regex-scripts.service";

const MAX_BULK_PRESETS = 200;
const PREPARE_TTL_MS = 10 * 60 * 1000;

interface PreparedPresetExport {
  userId: string;
  presetIds: string[];
  filename: string;
  createdAt: number;
}

const preparedExports = new Map<string, PreparedPresetExport>();

export interface PreparedPresetExportResult {
  downloadId: string;
  archiveUrl: string;
  filename: string;
  count: number;
}

function dedupePresetIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))]
    .slice(0, MAX_BULK_PRESETS);
}

function exportTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function sanitizeEntryBase(name: string, fallback: string): string {
  return name.replace(/[\/\\:*?"<>|\x00-\x1F\x7F]/g, "").trim() || fallback;
}

function uniqueEntryName(base: string, used: Set<string>): string {
  let name = `${base}.json`;
  let suffix = 2;
  while (used.has(name)) {
    name = `${base} (${suffix}).json`;
    suffix += 1;
  }
  used.add(name);
  return name;
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const OWNED_METADATA_KEYS = new Set([
  "source",
  "modelProfiles",
  "schemaVersion",
  "description",
  "coverUrl",
  "cover_url",
  "isDefault",
  "lastProfileKey",
  "promptVariables",
]);

function splitMetadata(metadata: Record<string, any>): {
  lumihubMeta: Record<string, unknown> | null;
  passthroughMetadata: Record<string, unknown>;
} {
  const lumihubMeta: Record<string, unknown> = {};
  const passthroughMetadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key.startsWith("_lumiverse_")) {
      if (key !== "_lumiverse_preset_version") lumihubMeta[key] = value;
      continue;
    }
    if (!OWNED_METADATA_KEYS.has(key)) {
      Object.defineProperty(passthroughMetadata, key, {
        value, enumerable: true, writable: true, configurable: true,
      });
    }
  }
  return {
    lumihubMeta: Object.keys(lumihubMeta).length > 0 ? lumihubMeta : null,
    passthroughMetadata,
  };
}

function exactSealedPlaceholder(content: unknown): string | null {
  if (typeof content !== "string") return null;
  return content.trim().match(/^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/)?.[1]?.trim() || null;
}

function sanitizeSealedBlocks(blocks: unknown[], lumihubMeta: Record<string, unknown> | null): unknown[] {
  const sealedPreset = isRecord(lumihubMeta?._lumiverse_sealed_preset)
    ? lumihubMeta._lumiverse_sealed_preset
    : null;
  const manifestKeys = new Set<string>();
  for (const block of Array.isArray(sealedPreset?.blocks) ? sealedPreset.blocks : []) {
    if (isRecord(block) && typeof block.key === "string" && block.key.trim()) {
      manifestKeys.add(block.key.trim());
    }
  }
  const isLegacyIllarinInstall = lumihubMeta?._lumiverse_install_source === "illarin";

  return blocks.map((raw) => {
    if (!isRecord(raw)) return raw;
    const block = raw as PromptBlock;
    const sealedKey = typeof block.sealedKey === "string" && block.sealedKey.trim()
      ? block.sealedKey.trim()
      : null;
    const placeholderKey = exactSealedPlaceholder(block.content);
    const inferredIllarinSource = isLegacyIllarinInstall && block.sealed === true;
    const key = sealedKey && (
      isProtectedSealedSource(block.sealedSource)
      || manifestKeys.has(sealedKey)
      || inferredIllarinSource
    )
      ? sealedKey
      : placeholderKey && manifestKeys.has(placeholderKey)
        ? placeholderKey
        : null;
    if (!key) return raw;
    return {
      ...raw,
      content: `{{presetBlock::${key}}}`,
      sealed: true,
      sealedKey: key,
      ...(inferredIllarinSource ? { sealedSource: "illarin" } : {}),
    };
  });
}

function isProtectedSealedSource(source: unknown): boolean {
  return source === "lumihub" || source === "illarin";
}

/** Build the same portable Loom shape as the single-preset browser export. */
export function buildPortablePresetExport(userId: string, preset: Preset): Record<string, unknown> {
  return portablePresetPayload(preset, exportRegexScripts(userId, { presetId: preset.id }).scripts);
}

export async function buildPortablePresetExportAsync(userId: string, preset: Preset): Promise<Record<string, unknown>> {
  return portablePresetPayload(preset, (await exportRegexScriptsAsync(userId, { presetId: preset.id })).scripts);
}

function portablePresetPayload(preset: Preset, scripts: unknown[]): Record<string, unknown> {
  const metadata = isRecord(preset.metadata) ? preset.metadata : {};
  const parameters = isRecord(preset.parameters) ? preset.parameters : {};
  const prompts = isRecord(preset.prompts) ? preset.prompts : {};
  const { lumihubMeta, passthroughMetadata } = splitMetadata(metadata);
  const payload: Record<string, unknown> = {
    name: preset.name,
    description: typeof metadata.description === "string" ? metadata.description : "",
    coverUrl: typeof metadata.coverUrl === "string"
      ? metadata.coverUrl
      : typeof metadata.cover_url === "string"
        ? metadata.cover_url
        : null,
    presetVersion: typeof metadata._lumiverse_preset_version === "string"
      ? metadata._lumiverse_preset_version
      : null,
    lumihubMeta,
    passthroughMetadata,
    schemaVersion: typeof metadata.schemaVersion === "number" ? metadata.schemaVersion : 1,
    createdAt: preset.created_at,
    updatedAt: preset.updated_at,
    blocks: sanitizeSealedBlocks(Array.isArray(preset.prompt_order) ? preset.prompt_order : [], lumihubMeta),
    source: isRecord(metadata.source) ? metadata.source : null,
    isDefault: metadata.isDefault === true,
    samplerOverrides: isRecord(parameters.samplerOverrides) ? parameters.samplerOverrides : {},
    customBody: isRecord(parameters.customBody) ? parameters.customBody : {},
    promptBehavior: isRecord(prompts.promptBehavior) ? prompts.promptBehavior : {},
    completionSettings: isRecord(prompts.completionSettings) ? prompts.completionSettings : {},
    advancedSettings: isRecord(prompts.advancedSettings) ? prompts.advancedSettings : {},
    modelProfiles: isRecord(metadata.modelProfiles) ? metadata.modelProfiles : {},
    lastProfileKey: typeof metadata.lastProfileKey === "string" ? metadata.lastProfileKey : null,
    promptVariables: isRecord(metadata.promptVariables) ? metadata.promptVariables : {},
  };

  if (scripts.length > 0) {
    payload.extensions = { regex_scripts: scripts };
  }
  return payload;
}

export function preparePresetBulkExport(userId: string, ids: readonly string[]): PreparedPresetExportResult | null {
  const presetIds = dedupePresetIds(ids).filter((id) => presetsSvc.getPreset(userId, id)?.provider === "loom");
  return rememberPreparedExport(userId, presetIds);
}

export async function preparePresetBulkExportAsync(userId: string, ids: readonly string[]): Promise<PreparedPresetExportResult | null> {
  const presets = await presetsSvc.getPresetsByIdsAsync(userId, dedupePresetIds(ids));
  return rememberPreparedExport(userId, presets.filter((preset) => preset.provider === "loom").map((preset) => preset.id));
}

function rememberPreparedExport(userId: string, presetIds: string[]): PreparedPresetExportResult | null {
  if (presetIds.length === 0) return null;

  const now = Date.now();
  for (const [id, entry] of preparedExports) {
    if (now - entry.createdAt > PREPARE_TTL_MS) preparedExports.delete(id);
  }

  const downloadId = crypto.randomUUID();
  const filename = `loom-presets-${exportTimestamp()}.zip`;
  preparedExports.set(downloadId, { userId, presetIds, filename, createdAt: now });
  return {
    downloadId,
    archiveUrl: `/api/v1/presets/bulk-export/${downloadId}`,
    filename,
    count: presetIds.length,
  };
}

export function consumePreparedPresetExport(userId: string, downloadId: string): PreparedPresetExport | null {
  const entry = preparedExports.get(downloadId);
  if (!entry || entry.userId !== userId || Date.now() - entry.createdAt > PREPARE_TTL_MS) return null;
  preparedExports.delete(downloadId);
  return entry;
}

function controllerSink(controller: ReadableStreamDefaultController<Uint8Array>): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      try {
        controller.enqueue(new Uint8Array(chunk));
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try { controller.close(); } catch { /* already closed */ }
      callback();
    },
  });
}

export function buildPresetBulkExportStream(
  userId: string,
  presetIds: readonly string[],
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  let archive: ZipArchive | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        archive = new ZipArchive({ zlib: { level: 6 }, forceZip64: true });
        archive.on("warning", (error: ArchiverError) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`[preset export] ${error.message}`);
        });
        archive.on("error", (error: ArchiverError) => {
          try { controller.error(error); } catch { /* already closed */ }
        });
        const sink = controllerSink(controller);
        sink.on("error", (error) => { archive?.abort(); try { controller.error(error); } catch { /* already closed */ } });
        archive.pipe(sink);

        const usedNames = new Set<string>();
        for (const id of dedupePresetIds(presetIds)) {
          if (cancelled || signal?.aborted) throw signal?.reason ?? new DOMException("Aborted", "AbortError");
          const preset = await presetsSvc.getPresetAsync(userId, id);
          if (!preset || preset.provider !== "loom") continue;
          const entryName = uniqueEntryName(sanitizeEntryBase(preset.name, id), usedNames);
          const payload = await buildPortablePresetExportAsync(userId, preset);
          if (cancelled || signal?.aborted) throw signal?.reason ?? new DOMException("Aborted", "AbortError");
          archive.append(JSON.stringify(payload, null, 2), { name: entryName });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        await archive.finalize();
      })().catch((error) => {
        archive?.abort();
        try { controller.error(error); } catch { /* already closed */ }
      });
    },
    cancel() {
      cancelled = true;
      archive?.abort();
    },
  });
}
