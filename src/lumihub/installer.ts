/**
 * Handles remote install commands from LumiHub by calling existing Lumiverse
 * import services directly (no HTTP self-requests).
 */
import * as svc from "../services/characters.service";
import * as cardSvc from "../services/character-card.service";
import * as images from "../services/images.service";
import * as gallerySvc from "../services/character-gallery.service";
import { fetchChubGalleryUrls, fetchChubJson } from "../services/chub-api.service";
import { safeFetch } from "../utils/safe-fetch";
import { mapWithConcurrency } from "../utils/concurrency";
import { rewriteBotBooruUrl } from "../utils/botbooru";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as wbSvc from "../services/world-books.service";
import * as presetsSvc from "../services/presets.service";
import * as regexSvc from "../services/regex-scripts.service";
import * as settingsSvc from "../services/settings.service";
import * as themeAssetsSvc from "../services/theme-assets.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import { applyCharxModulesAndAssets } from "../services/charx-import.service";
import { resolveSealedPresetBlocksForInstall, type SealedManifest } from "./sealed-presets";
import { cloneSafePlainJsonObject } from "./payload-validation";
import type { PromptBlock, PromptVariableDef, PromptVariableValue } from "../types/preset";
import type {
  InstallCharacterPayload,
  InstallPresetPayload,
  InstallPresetResultPayload,
  InstallResultPayload,
  InstallThemePayload,
  InstallThemeResultPayload,
  InstallWorldbookPayload,
  InstallWorldbookResultPayload,
} from "./types";

/**
 * Install a character from a LumiHub remote command.
 * Returns an InstallResultPayload to send back over the WebSocket.
 */
export async function installCharacter(
  requestId: string,
  userId: string,
  payload: InstallCharacterPayload
): Promise<InstallResultPayload> {
  if (!userId) {
    return {
      requestId,
      success: false,
      error: "No target user configured for this LumiHub install",
      errorCode: "UNKNOWN",
    };
  }

  try {
    let result: InstallResultPayload;

    if (payload.source === "chub" && payload.importUrl) {
      result = await installFromChub(requestId, userId, payload);
    } else if (payload.importUrl) {
      // LumiHub URL-based install (e.g. .charx download)
      result = await installFromUrl(requestId, userId, payload);
    } else if (payload.cardData) {
      result = await installFromCardData(requestId, userId, payload);
    } else {
      return {
        requestId,
        success: false,
        error: "No card data or import URL provided",
        errorCode: "PARSE_ERROR",
      };
    }

    // Stamp install source metadata for manifest tracking
    if (result.success && result.characterId) {
      stampInstallSource(userId, result.characterId, payload);

      // Download and import gallery images (best-effort, non-blocking)
      if (payload.source !== "chub" && payload.galleryImageUrls && payload.galleryImageUrls.length > 0) {
        importGalleryFromUrls(userId, result.characterId, payload.galleryImageUrls).catch((err) => {
          console.warn("[LumiHub Installer] Gallery import failed:", err);
        });
      }
    }

    return result;
  } catch (err: any) {
    console.error("[LumiHub Installer] Error:", err);
    return {
      requestId,
      success: false,
      error: err.message || "Unknown error during installation",
      errorCode: "UNKNOWN",
    };
  }
}

/** Stamp install source metadata on a freshly-installed character for manifest tracking. */
function stampInstallSource(userId: string, characterId: string, payload: InstallCharacterPayload): void {
  try {
    const character = svc.getCharacter(userId, characterId);
    if (!character) return;
    const { buildCharacterSlug } = require("./manifest") as typeof import("./manifest");
    const slug = buildCharacterSlug(character.creator, character.name);

    const ext: Record<string, any> = {
      ...(character.extensions || {}),
      _lumiverse_install_source: payload.source,
      _lumiverse_install_slug: slug,
    };

    // Store canonical Chub slug so manifest matches LumiHub's fullPath-based lookup.
    // Prefer the explicit chubSlug from the payload (sent by LumiHub on install/update),
    // fall back to extracting from the import URL.
    if (payload.source === "chub") {
      if (payload.chubSlug) {
        ext._lumiverse_chub_slug = payload.chubSlug;
      } else if (payload.importUrl) {
        const match = payload.importUrl.match(/chub\.ai\/characters\/(.+?)(?:\?|$)/);
        if (match?.[1]) {
          ext._lumiverse_chub_slug = match[1].toLowerCase();
        }
      }
    }

    svc.updateCharacter(userId, characterId, { extensions: ext });
  } catch {
    // Non-critical — manifest will still work via creator/name derivation
  }
}

/**
 * Download gallery images from URLs and add them to the character's gallery.
 * Each image gets full-size + thumbnail storage via the gallery service.
 */
async function importGalleryFromUrls(userId: string, characterId: string, urls: string[]): Promise<void> {
  // Download through a small pool instead of serially — these are independent
  // network fetches. The subsequent gallery write stays serial below.
  const downloaded = await mapWithConcurrency(urls, 6, async (url): Promise<File | null> => {
    try {
      const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 50 * 1024 * 1024 });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") || "image/webp";
      const ext = contentType.includes("png") ? "png" : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "webp";
      const filename = `gallery_${crypto.randomUUID()}.${ext}`;
      return new File([buf], filename, { type: contentType });
    } catch {
      // Skip individual failures
      return null;
    }
  });
  const files: File[] = downloaded.filter((f): f is File => f !== null);

  if (files.length === 0) return;

  if (files.length > 3) {
    await gallerySvc.uploadBulkToGallery(userId, characterId, files);
  } else {
    for (const file of files) {
      try { await gallerySvc.uploadToGallery(userId, characterId, file); } catch { /* skip */ }
    }
  }
}

/**
 * If the character has an embedded character_book and the payload requests it,
 * extract it as a standalone worldbook and associate it with the character.
 */
function maybeExtractWorldbook(
  userId: string,
  characterId: string,
  characterName: string,
  payload: InstallCharacterPayload
): void {
  if (!payload.importEmbeddedWorldbook) return;

  const character = svc.getCharacter(userId, characterId);
  const charBook = character?.extensions?.character_book;
  if (!charBook || !charBook.entries || charBook.entries.length === 0) return;

  try {
    const { worldBook } = wbSvc.importCharacterBook(userId, characterId, characterName, charBook, {
      autoManagedByCharacter: true,
    });
    // Associate the worldbook with the character (append to array)
    const currentIds = getCharacterWorldBookIds(character.extensions);
    const nextExtensions = setCharacterWorldBookIds(
      { ...(character.extensions || {}) },
      [...currentIds, worldBook.id],
    );
    svc.updateCharacter(userId, characterId, { extensions: nextExtensions });
  } catch (err) {
    console.warn("[LumiHub Installer] Embedded worldbook extraction failed:", err);
  }
}

/** Emit CHARACTER_EDITED so the frontend gallery refreshes immediately. */
function notifyCharacterCreated(userId: string, characterId: string): void {
  const character = svc.getCharacter(userId, characterId);
  if (character) {
    eventBus.emit(EventType.CHARACTER_EDITED, { id: characterId, character }, userId);
  }
}

/** Install from inline CCSv3 card data (LumiHub-sourced characters). */
async function installFromCardData(
  requestId: string,
  userId: string,
  payload: InstallCharacterPayload
): Promise<InstallResultPayload> {
  // Parse the card JSON using existing card service
  const cardInput = cardSvc.parseCardJson(payload.cardData!);
  const character = svc.createCharacter(userId, cardInput);

  // Bind any card-embedded regex scripts (Lumiverse bundle or SillyTavern) to
  // the new character. The CHARX/url path handles its own bundle separately.
  importCharacterRegexBestEffort(userId, character.id, cardInput.extensions);

  // Handle avatar if provided
  if (payload.avatarBase64) {
    try {
      const avatarBuffer = Buffer.from(payload.avatarBase64, "base64");
      const mime = payload.avatarMime || "image/png";
      const ext = mime.includes("webp") ? "webp" : mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : "png";
      const file = new File([avatarBuffer], `${character.id}.${ext}`, { type: mime });
      const image = await images.uploadImage(userId, file);
      svc.setCharacterImage(userId, character.id, image.id);
      svc.setCharacterAvatar(userId, character.id, image.filename);
    } catch (err) {
      // Avatar failed but character is still imported
      console.warn("[LumiHub Installer] Avatar import failed:", err);
    }
  }

  maybeExtractWorldbook(userId, character.id, payload.characterName, payload);

  const final = svc.getCharacter(userId, character.id);

  // Refresh gallery + notify the Lumiverse frontend
  notifyCharacterCreated(userId, character.id);
  eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
    characterId: character.id,
    characterName: final?.name || payload.characterName,
    source: "lumihub",
  }, userId);

  return {
    requestId,
    success: true,
    characterId: character.id,
    characterName: final?.name || payload.characterName,
  };
}

/**
 * Install from a URL (LumiHub .charx download or generic URL).
 * Fetches the file, detects format (charx/png/json), and imports with full asset support.
 */
async function installFromUrl(
  requestId: string,
  userId: string,
  payload: InstallCharacterPayload
): Promise<InstallResultPayload> {
  // BotBooru browseable URLs rewrite to the PNG download (card + avatar);
  // everything else is fetched as provided.
  const url = rewriteBotBooruUrl(payload.importUrl!, "png") ?? payload.importUrl!;

  const res = await safeFetch(url, {
    timeoutMs: 30_000,
    maxBytes: 100 * 1024 * 1024, // 100MB for .charx
  });
  if (!res.ok) {
    return { requestId, success: false, error: `Failed to fetch URL: ${res.status}`, errorCode: "UNKNOWN" };
  }

  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();

  // Detect .charx (ZIP)
  if (contentType.includes("application/zip") || url.toLowerCase().endsWith(".charx")) {
    const file = new File([buf], "import.charx", { type: "application/zip" });
    const charxResult = await cardSvc.extractCardFromCharx(file);
    const character = svc.createCharacter(userId, charxResult.card);

    // Full CHARX processing shared with the app's import endpoints: expressions,
    // expression groups, alternate fields/avatars, bundled regex scripts, gallery
    // + inline asset resolution, and RisuAI module/expressions. World-book import
    // — both lumiverse_modules.world_books and the embedded character_book, which
    // a Lumiverse export carries identically — is gated on the hub user's opt-in
    // so "don't import the worldbook" is honored.
    await applyCharxModulesAndAssets(userId, character, charxResult, {
      importWorldBooks: !!payload.importEmbeddedWorldbook,
    });

    const final = svc.getCharacter(userId, character.id);

    notifyCharacterCreated(userId, character.id);
    eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
      characterId: character.id,
      characterName: final?.name || payload.characterName,
      source: "lumihub",
    }, userId);

    return {
      requestId,
      success: true,
      characterId: character.id,
      characterName: final?.name || payload.characterName,
    };
  }

  // Detect PNG
  if (contentType.includes("image/png") || url.toLowerCase().endsWith(".png")) {
    const file = new File([buf], "import.png", { type: "image/png" });
    const cardInput = await cardSvc.extractCardFromPng(file);
    const character = svc.createCharacter(userId, cardInput);

    importCharacterRegexBestEffort(userId, character.id, cardInput.extensions);

    const image = await images.uploadImage(userId, file);
    svc.setCharacterImage(userId, character.id, image.id);
    svc.setCharacterAvatar(userId, character.id, image.filename);

    maybeExtractWorldbook(userId, character.id, payload.characterName, payload);

    const final = svc.getCharacter(userId, character.id);

    notifyCharacterCreated(userId, character.id);
    eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
      characterId: character.id,
      characterName: final?.name || payload.characterName,
      source: "lumihub",
    }, userId);

    return {
      requestId,
      success: true,
      characterId: character.id,
      characterName: final?.name || payload.characterName,
    };
  }

  // Assume JSON
  const text = new TextDecoder().decode(buf);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return { requestId, success: false, error: "URL did not return valid CHARX, PNG, or JSON", errorCode: "PARSE_ERROR" };
  }

  const cardInput = cardSvc.parseCardJson(json);
  const character = svc.createCharacter(userId, cardInput);

  importCharacterRegexBestEffort(userId, character.id, cardInput.extensions);

  maybeExtractWorldbook(userId, character.id, payload.characterName, payload);

  const final = svc.getCharacter(userId, character.id);

  notifyCharacterCreated(userId, character.id);
  eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
    characterId: character.id,
    characterName: final?.name || payload.characterName,
    source: "lumihub",
  }, userId);

  return {
    requestId,
    success: true,
    characterId: character.id,
    characterName: final?.name || payload.characterName,
  };
}

/** Import card-embedded regex scripts onto a freshly-installed character without
 * letting a regex failure abort the install (the character is already created). */
function importCharacterRegexBestEffort(userId: string, characterId: string, extensions: unknown): void {
  try {
    regexSvc.importCharacterBoundRegexScripts(userId, characterId, extensions);
  } catch (err) {
    console.warn("[LumiHub Installer] Character regex import failed:", err);
  }
}

/** Install from a Chub URL (reuses existing Chub fetch logic). */
async function installFromChub(
  requestId: string,
  userId: string,
  payload: InstallCharacterPayload
): Promise<InstallResultPayload> {
  // Extract the Chub path from the URL
  const url = payload.importUrl!;
  const match = url.match(/chub\.ai\/characters\/(.+?)(?:\?|$)/);
  const chubPath = match?.[1];
  if (!chubPath) {
    return {
      requestId,
      success: false,
      error: "Invalid Chub character URL",
      errorCode: "PARSE_ERROR",
    };
  }

  const data = await fetchChubJson(`characters/${chubPath}?full=true`);
  const node = data?.node;
  if (!node) {
    return { requestId, success: false, error: "Invalid Chub API response", errorCode: "PARSE_ERROR" };
  }

  const def = node.definition ?? node;
  const name = def.name || node.name;
  if (!name) {
    return { requestId, success: false, error: "Chub character missing name", errorCode: "PARSE_ERROR" };
  }

  const creatorName = node.fullPath?.split("/")[0] ?? "";
  const card: Record<string, any> = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: def.personality ?? "",
      personality: def.tavern_personality ?? "",
      scenario: def.scenario ?? "",
      first_mes: def.first_message ?? def.first_mes ?? "",
      mes_example: def.example_dialogs ?? def.mes_example ?? "",
      creator: creatorName,
      creator_notes: def.description ?? def.creator_notes ?? "",
      system_prompt: def.system_prompt ?? "",
      post_history_instructions: def.post_history_instructions ?? "",
      tags: Array.isArray(node.topics) ? node.topics : (Array.isArray(def.tags) ? def.tags : []),
      alternate_greetings: Array.isArray(def.alternate_greetings) ? def.alternate_greetings : [],
      extensions: def.extensions ?? {},
    },
  };

  const characterBook = def.embedded_lorebook ?? def.character_book;
  if (characterBook) {
    card.data.extensions = { ...card.data.extensions, character_book: characterBook };
  }

  const cardInput = cardSvc.parseCardJson(card);
  const character = svc.createCharacter(userId, cardInput);

  importCharacterRegexBestEffort(userId, character.id, cardInput.extensions);

  // Fetch avatar
  const avatarUrl = node.max_res_url || node.avatar_url;
  if (avatarUrl) {
    try {
      const imgRes = await safeFetch(avatarUrl, { timeoutMs: 15_000, maxBytes: 50 * 1024 * 1024 });
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        const contentType = imgRes.headers.get("content-type") || "image/png";
        const ext = contentType.includes("webp") ? "webp" : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "png";
        const file = new File([buf], `${character.id}.${ext}`, { type: contentType });
        const image = await images.uploadImage(userId, file);
        svc.setCharacterImage(userId, character.id, image.id);
        svc.setCharacterAvatar(userId, character.id, image.filename);
      }
    } catch { /* avatar fetch failed, character still imported */ }
  }

  maybeExtractWorldbook(userId, character.id, name, payload);

  try {
    const galleryUrls = payload.galleryImageUrls?.length
      ? payload.galleryImageUrls
      : await fetchChubGalleryUrls(node.id);
    if (galleryUrls.length > 0) {
      await importGalleryFromUrls(userId, character.id, galleryUrls);
    }
  } catch (err) {
    console.warn("[LumiHub Installer] Chub gallery import failed:", err);
  }

  const final = svc.getCharacter(userId, character.id);

  notifyCharacterCreated(userId, character.id);
  eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
    characterId: character.id,
    characterName: final?.name || name,
    source: "chub",
  }, userId);

  return {
    requestId,
    success: true,
    characterId: character.id,
    characterName: final?.name || name,
  };
}

/**
 * Install a worldbook from a LumiHub remote command.
 */
export async function installWorldbook(
  requestId: string,
  userId: string,
  payload: InstallWorldbookPayload
): Promise<InstallWorldbookResultPayload> {
  if (!userId) {
    return { requestId, success: false, error: "No target user configured for this LumiHub install" };
  }

  try {
    let importData: { name: string; description: string; entries: any[] };

    if (payload.source === "lumihub" && payload.worldbookData) {
      // Inline worldbook data from LumiHub
      importData = payload.worldbookData;
    } else if (payload.source === "chub" && payload.importUrl) {
      // Fetch from Chub API
      const resp = await safeFetch(payload.importUrl, {
        headers: { Accept: "application/json" },
        timeoutMs: 15_000,
        maxBytes: 100 * 1024 * 1024,
      });

      if (!resp.ok) {
        return { requestId, success: false, error: `Failed to fetch lorebook from Chub: ${resp.status}` };
      }

      const json = await resp.json() as any;
      const def = json.node?.definition;
      if (!def) {
        return { requestId, success: false, error: "No definition found in Chub lorebook response" };
      }

      const rawEntries = def.embedded_lorebook?.entries || [];
      importData = {
        name: def.name || payload.worldbookName,
        description: def.description || "",
        entries: rawEntries,
      };
    } else {
      return { requestId, success: false, error: "Missing worldbook data or import URL" };
    }

    if (importData.entries.length === 0) {
      return { requestId, success: false, error: "No lorebook entries found" };
    }

    const result = await wbSvc.importWorldBook(userId, importData);

    // Stamp install source metadata for manifest tracking
    try {
      const wb = wbSvc.getWorldBook(userId, result.worldBook.id);
      if (wb) {
        // Prefer the explicit creator sent by LumiHub so the manifest/stats slug
        const sourceCreator =
          (typeof payload.worldbookCreator === "string" && payload.worldbookCreator.trim())
            ? payload.worldbookCreator.trim()
            : payload.worldbookName.includes("/")
              ? payload.worldbookName.split("/")[0]
              : "unknown";
        wbSvc.updateWorldBook(userId, result.worldBook.id, {
          metadata: {
            ...wb.metadata,
            _lumiverse_install_source: payload.source,
            source_creator: sourceCreator,
          },
        });
      }
    } catch { /* non-critical */ }

    eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
      characterId: result.worldBook.id,
      characterName: importData.name,
      source: payload.source,
    }, userId);

    return {
      requestId,
      success: true,
      worldbookId: result.worldBook.id,
      worldbookName: importData.name,
    };
  } catch (err: any) {
    console.error("[LumiHub Installer] Worldbook install error:", err);
    return { requestId, success: false, error: err.message || "Unknown error during worldbook install" };
  }
}

/** Install a theme export from LumiHub into the linked user's active theme settings. */
export async function installTheme(
  requestId: string,
  userId: string,
  payload: InstallThemePayload,
): Promise<InstallThemeResultPayload> {
  if (!userId) {
    return { requestId, success: false, error: "No target user configured for this LumiHub install" };
  }

  try {
    const themeData = payload.themeData;
    const theme = normalizeThemeConfig(themeData.theme);
    const components = normalizeThemeComponents(themeData.components);
    const globalCSS = typeof themeData.globalCSS === "string" ? themeData.globalCSS.slice(0, 2_000_000) : "";
    const bundleId = crypto.randomUUID();
    const hasEnabledComponentCSS = Object.values(components).some((component) => component.enabled && component.css.trim());

    await importThemeAssets(userId, bundleId, themeData.assets);

    settingsSvc.putMany(userId, {
      theme: {
        ...theme,
        id: typeof theme.id === "string" && theme.id.trim() ? theme.id : payload.themeId,
        name: typeof theme.name === "string" && theme.name.trim() ? theme.name : payload.themeName,
      },
      customCSS: {
        css: globalCSS,
        enabled: !!globalCSS.trim() || hasEnabledComponentCSS,
        revision: Date.now(),
        bundleId,
      },
      componentOverrides: components,
    });

    eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
      characterId: payload.themeId,
      characterName: payload.themeName,
      source: "lumihub",
      type: "theme",
    }, userId);

    return {
      requestId,
      success: true,
      themeId: payload.themeId,
      themeName: payload.themeName,
    };
  } catch (err: any) {
    console.error("[LumiHub Installer] Theme install error:", err);
    return { requestId, success: false, error: err.message || "Unknown error during theme install" };
  }
}

/** Install a Loom preset export from LumiHub into the linked user's preset library. */
export async function installPreset(
  requestId: string,
  userId: string,
  payload: InstallPresetPayload,
  dependencies: InstallPresetDependencies = {},
): Promise<InstallPresetResultPayload> {
  if (!userId) {
    return { requestId, success: false, error: "No target user configured for this LumiHub install" };
  }

  try {
    const exported = payload.presetData;
    const preset = exported.preset;
    if (!preset || typeof preset !== "object" || Array.isArray(preset)) {
      return { requestId, success: false, error: "Preset export is missing preset data" };
    }
    const p = preset as Record<string, any>;
    const name = typeof p.name === "string" && p.name.trim() ? p.name : payload.presetName;
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];

    // Version sits directly below `name` in the export; fall back to the top-level field.
    const presetVersion =
      typeof p.presetVersion === "string" ? p.presetVersion
      : typeof payload.presetVersion === "string" ? payload.presetVersion
      : null;
    const presetSlug = typeof payload.presetSlug === "string" ? payload.presetSlug : null;
    const presetCreator = typeof payload.presetCreator === "string" ? payload.presetCreator : null;
    // LumiHub detects installed presets by canonical creator/name slug. Prefer
    // the immutable Hub id, then use that same slug identity as a constrained
    // fallback so a re-created/migrated Hub listing still updates the installed
    // row instead of producing a second local copy.
    const existing = presetsSvc.findPresetByLumihubId(userId, payload.presetId)
      ?? (presetSlug ? presetsSvc.findLumihubPresetBySlug(userId, presetSlug) : null);
    const existingPassthroughMetadata = existing
      ? extractPresetPassthroughMetadata({ metadata: existing.metadata })
      : {};
    const passthroughMetadata = extractPresetPassthroughMetadata(p);
    const sealedPreset = resolveInstallSealedManifest(payload);
    const sealedPresetVersion = typeof sealedPreset?.version === "string" ? sealedPreset.version : presetVersion;
    const materializedBlocks = await materializeSealedPresetBlocks(
      userId,
      blocks,
      payload.presetId,
      sealedPresetVersion,
      sealedPreset,
      dependencies.resolveSealedBlocks ?? resolveSealedPresetBlocksForInstall,
    );
    const incomingSamplerOverrides = isPlainObject(p.samplerOverrides) ? p.samplerOverrides : {};
    const incomingCustomBody = isPlainObject(p.customBody) ? p.customBody : {};
    const incomingPromptVariables = isPlainObject(p.promptVariables) ? p.promptVariables : {};
    const samplerOverrides = existing && isPlainObject(existing.parameters?.samplerOverrides)
      ? existing.parameters.samplerOverrides
      : incomingSamplerOverrides;
    const customBody = existing && isPlainObject(existing.parameters?.customBody)
      ? existing.parameters.customBody
      : incomingCustomBody;
    const promptVariables = existing
      ? mergePromptVariableSelections(
          existing.prompt_order,
          materializedBlocks,
          existing.metadata?.promptVariables,
          incomingPromptVariables,
        )
      : incomingPromptVariables;

    const presetInput = {
      name,
      provider: "loom",
      parameters: {
        samplerOverrides,
        customBody,
      },
      prompt_order: materializedBlocks,
      prompts: {
        promptBehavior: isPlainObject(p.promptBehavior) ? p.promptBehavior : {},
        completionSettings: isPlainObject(p.completionSettings) ? p.completionSettings : {},
        advancedSettings: isPlainObject(p.advancedSettings) ? p.advancedSettings : {},
      },
      metadata: {
        ...existingPassthroughMetadata,
        ...passthroughMetadata,
        source: isPlainObject(p.source) ? p.source : null,
        modelProfiles: isPlainObject(p.modelProfiles) ? p.modelProfiles : {},
        schemaVersion: typeof p.schemaVersion === "number" ? p.schemaVersion : exported.schemaVersion ?? 1,
        description: typeof p.description === "string" ? p.description : "",
        isDefault: !!p.isDefault,
        lastProfileKey: typeof p.lastProfileKey === "string" ? p.lastProfileKey : null,
        promptVariables,
        compatibility: isPlainObject(exported.compatibility) ? exported.compatibility : {},
        coverUrl: typeof exported.cover_url === "string" ? exported.cover_url : null,
        _lumiverse_install_source: "lumihub",
        _lumiverse_lumihub_id: payload.presetId,
        _lumiverse_preset_version: presetVersion,
        _lumiverse_preset_slug: presetSlug,
        _lumiverse_preset_creator: presetCreator,
        _lumiverse_sealed_preset: sealedPreset,
      },
    };

    // Update the existing installation in place when this preset was installed
    // from LumiHub before, so "Update" advances the version instead of duplicating.
    let saved;
    if (existing) {
      saved = presetsSvc.updatePreset(userId, existing.id, {
        ...presetInput,
        expected_cache_revision: existing.cache_revision,
      })!;
    } else {
      saved = presetsSvc.createPreset(userId, presetInput);
      eventBus.emit(EventType.PRESET_CHANGED, { id: saved.id, preset: saved }, userId);
    }

    // Preset-bound regex scripts ride at the top level of the export (sibling to
    // `preset`); import them so remote installs keep parity with local preset
    // imports. On update, clear the previous install's scripts first so successive
    // versions don't accumulate duplicates. Best-effort — the preset is already saved.
    try {
      if (existing) {
        regexSvc.deleteRegexScriptsByPresetId(userId, saved.id);
      }
      const regexScripts = extractPresetRegexScripts(exported);
      if (regexScripts.length > 0) {
        regexSvc.importPresetBoundRegexScripts(userId, saved.id, saved.name, regexScripts);
      }
    } catch (err) {
      console.warn("[LumiHub Installer] Preset regex import failed:", err);
    }

    eventBus.emit(EventType.LUMIHUB_INSTALL_COMPLETED, {
      characterId: saved.id,
      characterName: saved.name,
      source: "lumihub",
      type: "preset",
    }, userId);

    return {
      requestId,
      success: true,
      presetId: saved.id,
      presetName: saved.name,
    };
  } catch (err: any) {
    console.error("[LumiHub Installer] Preset install error:", err);
    return { requestId, success: false, error: err.message || "Unknown error during preset install" };
  }
}

export interface InstallPresetDependencies {
  resolveSealedBlocks?: typeof resolveSealedPresetBlocksForInstall;
}

/**
 * Newer hubs send the sealed manifest beside presetData; older/alternate Hub
 * paths only embed it in compatibility. Accept both representations so a
 * protocol-version skew cannot turn a sealed placeholder into a successful,
 * unresolved install.
 */
function resolveInstallSealedManifest(payload: InstallPresetPayload): SealedManifest | null {
  const direct = parseSealedManifest(payload.sealedPreset);
  const compatibility = isPlainObject(payload.presetData?.compatibility)
    ? payload.presetData.compatibility
    : null;
  const lumiverse = compatibility && isPlainObject(compatibility.lumiverse)
    ? compatibility.lumiverse
    : null;
  const embedded = parseSealedManifest(lumiverse?.sealedPreset);

  if (direct && embedded && !sealedManifestsEqual(direct, embedded)) {
    throw new Error("LumiHub returned inconsistent sealed preset manifests");
  }
  return direct ?? embedded;
}

function parseSealedManifest(value: unknown): SealedManifest | null {
  if (!isPlainObject(value) || !Array.isArray(value.blocks) || value.blocks.length > 200) return null;
  if (value.version !== null && value.version !== undefined && (typeof value.version !== "string" || value.version.length > 64)) {
    return null;
  }
  const blocks: Array<{ key: string; sha256: string }> = [];
  for (const entry of value.blocks) {
    if (!isPlainObject(entry) || typeof entry.key !== "string" || !entry.key || entry.key.length > 256) return null;
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) return null;
    blocks.push({ key: entry.key, sha256: entry.sha256.toLowerCase() });
  }
  return {
    version: typeof value.version === "string" ? value.version : null,
    blocks,
  };
}

function sealedManifestsEqual(left: SealedManifest, right: SealedManifest): boolean {
  if ((left.version ?? null) !== (right.version ?? null)) return false;
  const normalize = (manifest: SealedManifest) => (manifest.blocks ?? [])
    .map((block) => `${block.key ?? ""}:${(block.sha256 ?? "").toLowerCase()}`)
    .sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Clone metadata supplied by the hub before spreading it into the persisted
 * metadata object. Install requests normally arrive from JSON, but keeping the
 * check here makes direct callers obey the same plain-JSON contract and avoids
 * invoking getters or copying values from arbitrary prototypes.
 */
function extractPresetPassthroughMetadata(
  preset: Record<string, any>,
): Record<string, any> {
  const serializedField = readPresetMetadataField(preset, "metadata");
  const internalField = readPresetMetadataField(preset, "passthroughMetadata");
  const serializedMetadata = serializedField.present
    ? clonePresetMetadata(serializedField.value, "metadata")
    : {};
  const internalMetadata = internalField.present
    ? clonePresetMetadata(internalField.value, "passthroughMetadata")
    : {};

  // Both forms have appeared in exports. If an export carries both, the
  // internal Loom bag wins conflicts while the installer-owned fields below
  // remain authoritative either way.
  return { ...serializedMetadata, ...internalMetadata };
}

function readPresetMetadataField(
  preset: Record<string, any>,
  fieldName: "metadata" | "passthroughMetadata",
): { present: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(preset, fieldName);
  if (!descriptor) return { present: false };
  if (!Object.hasOwn(descriptor, "value")) {
    throw new Error(`Preset export has invalid ${fieldName}`);
  }
  return { present: true, value: descriptor.value };
}

function clonePresetMetadata(value: unknown, fieldName: string): Record<string, any> {
  try {
    return cloneSafePlainJsonObject(value) as Record<string, any>;
  } catch {
    throw new Error(`Preset export has invalid ${fieldName}`);
  }
}

/**
 * Carry user-selected variable values into the updated published definition.
 * Blocks are matched by stable block id; variables prefer their stable id and
 * fall back to name for older exports. Incompatible type changes fall back to
 * the publisher's new value/default, while modest range/option drift is adapted.
 */
function mergePromptVariableSelections(
  existingBlocksValue: unknown,
  updatedBlocksValue: unknown,
  existingValuesValue: unknown,
  incomingValuesValue: unknown,
): Record<string, Record<string, PromptVariableValue>> {
  const existingBlocks = Array.isArray(existingBlocksValue) ? existingBlocksValue as PromptBlock[] : [];
  const updatedBlocks = Array.isArray(updatedBlocksValue) ? updatedBlocksValue as PromptBlock[] : [];
  const existingValues = isPlainObject(existingValuesValue) ? existingValuesValue : {};
  const incomingValues = isPlainObject(incomingValuesValue) ? incomingValuesValue : {};
  const merged: Record<string, Record<string, PromptVariableValue>> = {};

  for (const [blockId, bucket] of Object.entries(incomingValues)) {
    if (isPlainObject(bucket)) merged[blockId] = { ...bucket } as Record<string, PromptVariableValue>;
  }

  const existingBlockById = new Map(
    existingBlocks
      .filter((block) => isPlainObject(block) && typeof block.id === "string")
      .map((block) => [block.id, block]),
  );

  for (const updatedBlock of updatedBlocks) {
    if (!isPlainObject(updatedBlock) || typeof updatedBlock.id !== "string" || !Array.isArray(updatedBlock.variables)) continue;
    const existingBlock = existingBlockById.get(updatedBlock.id);
    if (!existingBlock || !Array.isArray(existingBlock.variables)) continue;
    const existingBucket = existingValues[updatedBlock.id];
    if (!isPlainObject(existingBucket)) continue;

    const oldDefs = existingBlock.variables.filter(isPromptVariableDef);
    const oldDefById = new Map(oldDefs.map((def) => [def.id, def]));
    const oldDefByName = new Map(oldDefs.map((def) => [def.name, def]));
    const nextBucket = merged[updatedBlock.id] ?? {};

    for (const updatedDef of updatedBlock.variables) {
      if (!isPromptVariableDef(updatedDef)) continue;
      const oldDef = oldDefById.get(updatedDef.id) ?? oldDefByName.get(updatedDef.name);
      if (!oldDef || !Object.hasOwn(existingBucket, oldDef.name)) continue;
      const retained = adaptPromptVariableSelection(oldDef, updatedDef, existingBucket[oldDef.name]);
      if (retained !== undefined) nextBucket[updatedDef.name] = retained;
    }

    if (Object.keys(nextBucket).length > 0) merged[updatedBlock.id] = nextBucket;
  }

  return merged;
}

function isPromptVariableDef(value: unknown): value is PromptVariableDef {
  if (!isPlainObject(value) || typeof value.id !== "string" || typeof value.name !== "string") return false;
  switch (value.type) {
    case "text":
    case "textarea":
    case "number":
    case "slider":
    case "switch":
      return true;
    case "select":
    case "multiselect":
      return Array.isArray(value.options);
    default:
      return false;
  }
}

function adaptPromptVariableSelection(
  oldDef: PromptVariableDef,
  updatedDef: PromptVariableDef,
  value: unknown,
): PromptVariableValue | undefined {
  const oldFamily = promptVariableFamily(oldDef.type);
  const updatedFamily = promptVariableFamily(updatedDef.type);
  if (oldFamily !== updatedFamily) return undefined;

  switch (updatedFamily) {
    case "text":
      return typeof value === "string" ? value : undefined;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
      const min = "min" in updatedDef && typeof updatedDef.min === "number" ? updatedDef.min : undefined;
      const max = "max" in updatedDef && typeof updatedDef.max === "number" ? updatedDef.max : undefined;
      return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value));
    }
    case "switch":
      return value === 0 || value === 1 ? value : undefined;
    case "select": {
      if (updatedDef.type !== "select" || oldDef.type !== "select" || typeof value !== "string") return undefined;
      return mapPromptOptionId(oldDef, updatedDef, value);
    }
    case "multiselect": {
      if (updatedDef.type !== "multiselect" || oldDef.type !== "multiselect" || !Array.isArray(value)) return undefined;
      const retained = value
        .filter((id): id is string => typeof id === "string")
        .map((id) => mapPromptOptionId(oldDef, updatedDef, id))
        .filter((id): id is string => typeof id === "string");
      return retained.length > 0 || value.length === 0 ? [...new Set(retained)] : undefined;
    }
  }
}

function promptVariableFamily(type: PromptVariableDef["type"]): "text" | "number" | "switch" | "select" | "multiselect" {
  if (type === "text" || type === "textarea") return "text";
  if (type === "number" || type === "slider") return "number";
  return type;
}

function mapPromptOptionId(
  oldDef: Extract<PromptVariableDef, { type: "select" | "multiselect" }>,
  updatedDef: Extract<PromptVariableDef, { type: "select" | "multiselect" }>,
  selectedId: string,
): string | undefined {
  const updatedOptions = updatedDef.options.filter(isPromptVariableOption);
  const oldOptions = oldDef.options.filter(isPromptVariableOption);
  if (updatedOptions.some((option) => option.id === selectedId)) return selectedId;
  const oldValue = oldOptions.find((option) => option.id === selectedId)?.value;
  if (oldValue === undefined) return undefined;
  return updatedOptions.find((option) => option.value === oldValue)?.id;
}

function isPromptVariableOption(value: unknown): value is { id: string; label: string; value: string } {
  return isPlainObject(value)
    && typeof value.id === "string"
    && typeof value.label === "string"
    && typeof value.value === "string";
}

async function materializeSealedPresetBlocks(
  userId: string,
  blocks: any[],
  hubPresetId: string,
  version: string | null,
  sealedPreset: SealedManifest | null,
  resolveSealedBlocks: typeof resolveSealedPresetBlocksForInstall,
): Promise<any[]> {
  const placeholderKeys = new Set<string>();
  for (const block of blocks) {
    if (!isPlainObject(block) || typeof block.content !== "string") continue;
    const key = extractExactSealedPlaceholder(block.content);
    if (key) placeholderKeys.add(key);
  }
  if (!placeholderKeys.size) return blocks;
  if (!sealedPreset) {
    throw new Error("LumiHub preset contains sealed placeholders but no sealed manifest");
  }
  const manifestBlocks = Array.isArray(sealedPreset?.blocks) ? sealedPreset.blocks : [];
  if (!manifestBlocks.length) {
    throw new Error("LumiHub preset contains sealed placeholders but the sealed manifest is empty");
  }

  const manifestByKey = new Map<string, { sha256: string }>();
  for (const entry of manifestBlocks) {
    if (typeof entry?.key === "string" && typeof entry?.sha256 === "string") {
      manifestByKey.set(entry.key, { sha256: entry.sha256 });
    }
  }
  if (!manifestByKey.size) {
    throw new Error("LumiHub preset contains sealed placeholders but the sealed manifest is invalid");
  }

  for (const key of placeholderKeys) {
    if (!manifestByKey.has(key)) {
      throw new Error(`Sealed preset manifest is missing prompt block: ${key}`);
    }
  }

  const resolved = await resolveSealedBlocks(userId, hubPresetId, version, sealedPreset);
  for (const key of placeholderKeys) {
    if (typeof resolved[key] !== "string") {
      throw new Error(`Unable to fetch or verify sealed preset block: ${key}`);
    }
  }

  return blocks.map((block) => {
    if (!isPlainObject(block) || typeof block.content !== "string") return block;
    const key = extractExactSealedPlaceholder(block.content);
    const manifestEntry = key ? manifestByKey.get(key) : null;
    if (!key || !manifestEntry) return block;
    return {
      ...block,
      content: resolved[key],
      sealed: true,
      sealedKey: key,
      sealedSource: "lumihub",
      sealedOriginPresetId: hubPresetId,
      sealedOriginVersion: version,
      sealedSha256: manifestEntry.sha256,
    };
  });
}

function extractExactSealedPlaceholder(content: string): string | null {
  const match = content.trim().match(/^\{\{(?:presetBlock|pblock)::([^}]+)\}\}$/);
  return match?.[1]?.trim() || null;
}

/**
 * Pull bound regex scripts out of a preset export, tolerating every location
 * LumiHub/Lumiverse have stored them in: top-level (the canonical export shape,
 * a sibling of `preset`), nested under `preset`, or under `extensions`.
 */
function extractPresetRegexScripts(exported: Record<string, any>): any[] {
  const candidates = [
    exported?.regex_scripts,
    exported?.preset?.regex_scripts,
    exported?.extensions?.regex_scripts,
    exported?.extensions?.lumiverse_modules?.regex_scripts,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

function normalizeThemeConfig(value: unknown): Record<string, any> {
  if (!isPlainObject(value)) throw new Error("Theme export is missing theme data");
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("Theme export is missing a theme name");
  if (value.mode !== "light" && value.mode !== "dark" && value.mode !== "system") {
    throw new Error("Theme export has an invalid mode");
  }
  const accent = value.accent;
  if (!isPlainObject(accent)
    || typeof accent.h !== "number"
    || typeof accent.s !== "number"
    || typeof accent.l !== "number") {
    throw new Error("Theme export has an invalid accent");
  }
  return {
    ...value,
    radiusScale: typeof value.radiusScale === "number" ? value.radiusScale : 1,
    enableGlass: typeof value.enableGlass === "boolean" ? value.enableGlass : false,
    fontScale: typeof value.fontScale === "number" ? value.fontScale : 1,
  };
}

function normalizeThemeComponents(value: unknown): Record<string, { css: string; tsx: string; enabled: boolean }> {
  if (!isPlainObject(value)) return {};
  const out: Record<string, { css: string; tsx: string; enabled: boolean }> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isPlainObject(raw) || typeof name !== "string" || !name.trim()) continue;
    const tsx = typeof raw.tsx === "string" ? raw.tsx.slice(0, 50_000) : "";
    out[name.slice(0, 128)] = {
      css: typeof raw.css === "string" ? raw.css.slice(0, 2_000_000) : "",
      tsx,
      // Match local theme-bundle imports: TSX overrides are imported disabled
      // until the owner reviews them manually.
      enabled: tsx.trim() ? false : raw.enabled !== false,
    };
  }
  return out;
}

async function importThemeAssets(userId: string, bundleId: string, assets: unknown): Promise<void> {
  if (!Array.isArray(assets) || assets.length === 0) return;
  if (assets.length > 500) throw new Error("Theme export contains too many assets");

  for (const raw of assets) {
    if (!isPlainObject(raw)) continue;
    const slug = typeof raw.slug === "string" ? raw.slug.slice(0, 255) : "";
    const dataBase64 = typeof raw.dataBase64 === "string" ? raw.dataBase64 : "";
    if (!slug || !dataBase64) continue;

    const originalFilename = typeof raw.originalFilename === "string" && raw.originalFilename.trim()
      ? raw.originalFilename.slice(0, 180)
      : slug.split("/").pop() || "asset";
    const mimeType = typeof raw.mimeType === "string" && raw.mimeType.trim()
      ? raw.mimeType.slice(0, 255)
      : "application/octet-stream";
    const tags = Array.isArray(raw.tags)
      ? raw.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 32)
      : [];
    const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};

    let bytes: Buffer;
    try {
      bytes = Buffer.from(dataBase64, "base64");
    } catch {
      throw new Error(`Theme asset "${slug}" is not valid base64`);
    }
    if (bytes.byteLength > 50 * 1024 * 1024) {
      throw new Error(`Theme asset "${slug}" exceeds 50 MB`);
    }

    await themeAssetsSvc.createThemeAsset(userId, {
      bundleId,
      file: new File([new Uint8Array(bytes)], originalFilename, { type: mimeType }),
      slug,
      tags,
      metadata,
    });
  }
}
