/**
 * Shared CHARX post-extraction processing.
 *
 * Single source of truth for applying everything a Lumiverse .charx archive
 * carries beyond card.json: the lumiverse_modules.json payload (expressions,
 * expression groups, alternate fields/avatars, world books, bundled regex
 * scripts), gallery uploads, inline asset-reference resolution, RisuAI module
 * regex + expression assets, multi-character expression grouping, and embedded
 * world-book auto-import.
 *
 * Every CHARX import path — single import, bulk import, URL import, and the
 * LumiHub installer — MUST funnel through `applyCharxModulesAndAssets` so they
 * cannot drift out of parity with the exporter (character-export.service.ts).
 * Mirror any new exported module field here, not in an individual handler.
 */
import * as svc from "./characters.service";
import * as images from "./images.service";
import * as gallerySvc from "./character-gallery.service";
import * as regexSvc from "./regex-scripts.service";
import * as exprSvc from "./expressions.service";
import * as wbSvc from "./world-books.service";
import * as cardSvc from "./character-card.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import { LANDING_PERSPECTIVE_LAYERS_KEY } from "./characters.service";
import { mapWithConcurrency } from "../utils/concurrency";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { CreateRegexScriptInput } from "../types/regex-script";

const GALLERY_UPLOAD_CONCURRENCY = 6;

// ─── RisuAI module regex import helper ────────────────────────────────────

function importRisuModuleRegexScripts(
  userId: string,
  characterId: string,
  module: cardSvc.RisuModule | null,
): number {
  if (!module?.regex?.length) return 0;
  const scripts = cardSvc.convertRisuRegexScripts(module.regex, characterId);
  let imported = 0;
  for (const script of scripts) {
    const result = regexSvc.createRegexScript(userId, script);
    if (typeof result !== "string") imported++;
  }
  return imported;
}

async function importRisuExpressionAssets(
  userId: string,
  characterId: string,
  assets: cardSvc.CharxExpressionAsset[],
): Promise<number> {
  if (!assets.length) return 0;
  const config = await exprSvc.importFromAssets(userId, characterId, assets);
  return Object.keys(config.mappings).length;
}

// ─── Auto-import embedded character book as world book ───────────────────

/**
 * Import a card's embedded CCSv3 `character_book` as a managed world book and
 * link it to the character. No-op if there are no entries, or if the character
 * already has world books linked (e.g. from lumiverse_modules.world_books — a
 * Lumiverse export carries the same lore in both places, so this guard prevents
 * a double import).
 */
export function autoImportEmbeddedWorldbook(userId: string, characterId: string): void {
  const character = svc.getCharacter(userId, characterId);
  if (!character) return;

  const charBook = character.extensions?.character_book;
  if (wbSvc.countImportedWorldBookEntries(charBook?.entries) === 0) return;

  // Skip if world books are already linked (e.g. from Lumiverse modules)
  const existingIds = getCharacterWorldBookIds(character.extensions);
  if (existingIds.length > 0) return;

  try {
    const { worldBook } = wbSvc.importCharacterBook(userId, characterId, character.name, charBook, {
      autoManagedByCharacter: true,
    });
    const nextExtensions = setCharacterWorldBookIds(
      { ...(character.extensions || {}) },
      [...existingIds, worldBook.id],
    );
    svc.updateCharacter(userId, characterId, { extensions: nextExtensions });
  } catch {
    // Non-critical — character is still imported without the world book
  }
}

export interface ApplyCharxOptions {
  /** Abort signal forwarded to world-book import (HTTP request cancellation). */
  signal?: AbortSignal;
  /** Emit IMPORT_GALLERY_PROGRESS events during gallery upload (single import UI). */
  emitGalleryProgress?: boolean;
  /**
   * Whether to import world books (both lumiverse_modules.world_books and the
   * embedded character_book). Defaults to true. The LumiHub installer passes
   * the user's opt-in here so "don't import the worldbook" is honored — and
   * because a Lumiverse export carries the same lore in both places, this single
   * flag must gate both sources.
   */
  importWorldBooks?: boolean;
}

/**
 * Apply all post-extraction CHARX side-content to an already-created character.
 * Returns the lumiverse_modules summary (counts of what was imported), if a
 * lumiverse_modules.json payload was present.
 */
export async function applyCharxModulesAndAssets(
  userId: string,
  character: any,
  charxResult: cardSvc.CharxResult,
  options: ApplyCharxOptions = {},
): Promise<{ lumiverseModulesSummary?: Record<string, any> }> {
  const { avatarFile, risuModule, expressionAssets, lumiverseModules, assetFiles, expressionGroupAnalysis } = charxResult;
  const importWorldBooks = options.importWorldBooks !== false;

  if (avatarFile) {
    const image = await images.uploadImage(userId, avatarFile);
    svc.setCharacterImage(userId, character.id, image.id);
    svc.setCharacterAvatar(userId, character.id, image.filename);
  }

  // Track archive-path → image-id for resolving inline asset references, and
  // which paths the modules already consumed so the rest fall through to gallery.
  const assetImageMap = new Map<string, string>();
  const consumedPaths = new Set<string>();
  let lumiverseModulesSummary: Record<string, any> | undefined;

  if (lumiverseModules) {
    const extensions: Record<string, any> = { ...(character.extensions || {}) };

    // Expressions
    if (lumiverseModules.expressions?.mappings) {
      const exprMappings: Record<string, string> = {};
      for (const [label, archivePath] of Object.entries(lumiverseModules.expressions.mappings)) {
        const assetFile = assetFiles.get(archivePath);
        if (assetFile) {
          const img = await images.uploadImage(userId, assetFile);
          exprMappings[label] = img.id;
          consumedPaths.add(archivePath);
          assetImageMap.set(archivePath, img.id);
        }
      }
      if (Object.keys(exprMappings).length > 0) {
        extensions.expressions = {
          enabled: lumiverseModules.expressions.enabled,
          defaultExpression: lumiverseModules.expressions.defaultExpression,
          mappings: exprMappings,
        };
      }
    }

    // Expression groups (multi-character)
    if (lumiverseModules.expression_groups?.groups) {
      const expressionGroups: Record<string, Record<string, string>> = {};
      for (const [groupName, labelMap] of Object.entries(lumiverseModules.expression_groups.groups)) {
        const groupMappings: Record<string, string> = {};
        for (const [label, archivePath] of Object.entries(labelMap)) {
          const assetFile = assetFiles.get(archivePath);
          if (assetFile) {
            const img = await images.uploadImage(userId, assetFile);
            groupMappings[label] = img.id;
            consumedPaths.add(archivePath);
            assetImageMap.set(archivePath, img.id);
          }
        }
        if (Object.keys(groupMappings).length > 0) {
          expressionGroups[groupName] = groupMappings;
        }
      }
      if (Object.keys(expressionGroups).length > 0) {
        extensions.expression_groups = expressionGroups;
      }
    }

    // Alternate fields
    if (lumiverseModules.alternate_fields) {
      extensions.alternate_fields = lumiverseModules.alternate_fields;
    }

    // Alternate avatars
    const altAvatars: Array<{ id: string; image_id: string; label: string }> = [];
    if (Array.isArray(lumiverseModules.alternate_avatars)) {
      for (const av of lumiverseModules.alternate_avatars) {
        const assetFile = assetFiles.get(av.path);
        if (assetFile) {
          const img = await images.uploadImage(userId, assetFile);
          altAvatars.push({ id: av.id || crypto.randomUUID(), image_id: img.id, label: av.label });
          consumedPaths.add(av.path);
          assetImageMap.set(av.path, img.id);
        }
      }
      if (altAvatars.length > 0) {
        extensions.alternate_avatars = altAvatars;
      }
    }

    // Landing perspective layers (ordered back → front)
    const landingLayers: Array<{ id: string; image_id: string; label?: string; intensity: number }> = [];
    if (Array.isArray(lumiverseModules.landing_perspective_layers)) {
      for (const layer of lumiverseModules.landing_perspective_layers) {
        if (!layer || typeof layer !== "object") continue;
        const path = typeof layer.path === "string" ? layer.path : null;
        if (!path) continue;
        const assetFile = assetFiles.get(path);
        if (!assetFile) continue;
        const img = await images.uploadOptimizedWebpImage(userId, assetFile, { owner_character_id: character.id });
        landingLayers.push({
          id: typeof layer.id === "string" && layer.id ? layer.id : crypto.randomUUID(),
          image_id: img.id,
          ...(typeof layer.label === "string" && layer.label ? { label: layer.label } : {}),
          intensity: typeof layer.intensity === "number" && Number.isFinite(layer.intensity)
            ? Math.max(0, Math.min(1.5, Math.round(layer.intensity * 100) / 100))
            : 0.6,
        });
        consumedPaths.add(path);
        assetImageMap.set(path, img.id);
        if (landingLayers.length >= 5) break;
      }
      if (landingLayers.length > 0) {
        extensions[LANDING_PERSPECTIVE_LAYERS_KEY] = landingLayers;
      }
    }

    // World books
    let importedWorldBookCount = 0;
    if (importWorldBooks && Array.isArray(lumiverseModules.world_books) && lumiverseModules.world_books.length > 0) {
      const importedBookIds: string[] = [];
      for (const bookData of lumiverseModules.world_books) {
        try {
          const result = wbSvc.importLumiverseWorldBook(userId, character.id, bookData, { signal: options.signal });
          importedBookIds.push(result.worldBook.id);
        } catch { /* skip individual failures */ }
      }
      if (importedBookIds.length > 0) {
        const currentIds = getCharacterWorldBookIds(extensions);
        Object.assign(extensions, setCharacterWorldBookIds(extensions, [...currentIds, ...importedBookIds]));
        importedWorldBookCount = importedBookIds.length;
      }
    }

    svc.updateCharacter(userId, character.id, { extensions });

    // Bundled regex scripts — rebound to the new character on import
    let regexScriptCount = 0;
    if (lumiverseModules.regex_scripts?.length) {
      for (const bundled of lumiverseModules.regex_scripts) {
        try {
          regexSvc.createRegexScript(userId, {
            ...(bundled as CreateRegexScriptInput),
            scope: "character",
            scope_id: character.id,
            character_id: character.id,
            metadata: { ...bundled.metadata, source: "charx_bundle" },
          });
          regexScriptCount++;
        } catch { /* skip individual failures */ }
      }
    }

    lumiverseModulesSummary = {
      has_expressions: !!extensions.expressions,
      has_alternate_fields: !!lumiverseModules.alternate_fields,
      has_alternate_avatars: altAvatars.length > 0,
      has_landing_perspective_layers: landingLayers.length > 0,
      landing_perspective_layer_count: landingLayers.length,
      has_world_books: importedWorldBookCount > 0,
      world_book_count: importedWorldBookCount,
      expression_count: Object.keys(extensions.expressions?.mappings || {}).length,
      regex_script_count: regexScriptCount,
      alternate_field_counts: lumiverseModules.alternate_fields
        ? Object.fromEntries(
            Object.entries(lumiverseModules.alternate_fields).map(
              ([k, v]) => [k, Array.isArray(v) ? v.length : 0],
            ),
          )
        : undefined,
    };
  }

  // Upload remaining (unconsumed) asset images to the gallery, tracking
  // archive path → image ID for inline asset resolution.
  const remainingGalleryEntries: Array<{ path: string; file: File }> = [];
  for (const [path, assetFile] of assetFiles) {
    if (consumedPaths.has(path)) continue;
    if (avatarFile && assetFile.name === avatarFile.name) continue;
    if (/^assets\/(icon|other)\//i.test(path)) {
      remainingGalleryEntries.push({ path, file: assetFile });
    }
  }
  const galleryTotal = remainingGalleryEntries.length;
  // Progress is reported by completion count — workers finish out of order
  // but the current/total ratio remains meaningful for UI feedback.
  let galleryCompleted = 0;
  await mapWithConcurrency(remainingGalleryEntries, GALLERY_UPLOAD_CONCURRENCY, async ({ path, file: gf }) => {
    try {
      const img = await images.uploadImage(userId, gf);
      gallerySvc.addToGallery(userId, character.id, img.id);
      assetImageMap.set(path, img.id);
    } catch { /* skip individual failures */ }
    galleryCompleted++;
    if (options.emitGalleryProgress && galleryTotal > 3) {
      eventBus.emit(
        EventType.IMPORT_GALLERY_PROGRESS,
        { characterId: character.id, current: galleryCompleted, total: galleryTotal, filename: gf.name },
        userId,
      );
    }
  });

  // Resolve inline asset references (embeded://, relative filenames, Risu
  // <img="...">) in character text fields, and store the Risu asset name →
  // image ID map for display-time resolution of AI-generated <img="..."> tags.
  const risuAssetMap: Record<string, string> = {};
  if (assetImageMap.size > 0) {
    const resolvedFields = cardSvc.resolveInlineAssetReferences(
      {
        first_mes: character.first_mes,
        description: character.description,
        personality: character.personality,
        scenario: character.scenario,
        mes_example: character.mes_example,
        system_prompt: character.system_prompt,
        post_history_instructions: character.post_history_instructions,
        creator_notes: character.creator_notes,
        alternate_greetings: character.alternate_greetings,
      },
      assetImageMap,
    );
    if (Object.keys(resolvedFields).length > 0) {
      svc.updateCharacter(userId, character.id, resolvedFields);
    }

    for (const [archivePath, imageId] of assetImageMap) {
      const stem = cardSvc.fileStem(archivePath);
      if (!risuAssetMap[stem]) risuAssetMap[stem] = imageId;
    }
    if (Object.keys(risuAssetMap).length > 0) {
      const char = svc.getCharacter(userId, character.id);
      if (char) {
        svc.updateCharacter(userId, character.id, {
          extensions: { ...(char.extensions || {}), risu_asset_map: risuAssetMap },
        });
      }
    }
  }

  importRisuModuleRegexScripts(userId, character.id, risuModule);

  // Multi-character expression handling: when expression assets span multiple
  // characters (detected by prefix grouping), store structured expression_groups
  // instead of a flat expression mapping. Skip if Lumiverse modules already
  // imported expression_groups.
  const charForExprCheck = svc.getCharacter(userId, character.id);
  const hasLumiverseGroups = !!charForExprCheck?.extensions?.expression_groups;
  if (!hasLumiverseGroups && expressionGroupAnalysis?.isMultiCharacter && Object.keys(risuAssetMap).length > 0) {
    const expressionGroups: Record<string, Record<string, string>> = {};
    for (const [groupName, labelMap] of Object.entries(expressionGroupAnalysis.groups)) {
      const groupMappings: Record<string, string> = {};
      for (const [cleanLabel, originalLabel] of Object.entries(labelMap)) {
        // risuAssetMap is keyed by stem (no extension); originalLabel may carry the
        // archive's extension, so fall back to stem.
        const imageId = risuAssetMap[originalLabel]
          ?? risuAssetMap[cardSvc.fileStem(originalLabel)];
        if (imageId) {
          groupMappings[cleanLabel] = imageId;
        }
      }
      if (Object.keys(groupMappings).length > 0) {
        expressionGroups[groupName] = groupMappings;
      }
    }

    if (Object.keys(expressionGroups).length > 0) {
      const char = svc.getCharacter(userId, character.id);
      if (char) {
        svc.updateCharacter(userId, character.id, {
          extensions: { ...(char.extensions || {}), expression_groups: expressionGroups },
        });
      }
    }
  } else {
    await importRisuExpressionAssets(userId, character.id, expressionAssets);
  }

  if (importWorldBooks) {
    autoImportEmbeddedWorldbook(userId, character.id);
  }

  return { lumiverseModulesSummary };
}
