/**
 * Handles remote install commands from LumiHub by calling existing Lumiverse
 * import services directly (no HTTP self-requests).
 */
import * as svc from "../services/characters.service";
import * as cardSvc from "../services/character-card.service";
import * as images from "../services/images.service";
import * as gallerySvc from "../services/character-gallery.service";
import { safeFetch } from "../utils/safe-fetch";
import { mapWithConcurrency } from "../utils/concurrency";
import { rewriteBotBooruUrl } from "../utils/botbooru";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getFirstUserId } from "../auth/seed";
import * as wbSvc from "../services/world-books.service";
import * as presetsSvc from "../services/presets.service";
import * as regexSvc from "../services/regex-scripts.service";
import * as settingsSvc from "../services/settings.service";
import * as themeAssetsSvc from "../services/theme-assets.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import { applyCharxModulesAndAssets } from "../services/charx-import.service";
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
  payload: InstallCharacterPayload
): Promise<InstallResultPayload> {
  const userId = getFirstUserId();
  if (!userId) {
    return {
      requestId,
      success: false,
      error: "No owner user configured on this Lumiverse instance",
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
      if (payload.galleryImageUrls && payload.galleryImageUrls.length > 0) {
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

  // Fetch from Chub API (same logic as characters.routes.ts fetchChubCharacter)
  const apiUrl = `https://gateway.chub.ai/api/characters/${chubPath}?full=true`;
  const res = await safeFetch(apiUrl, {
    timeoutMs: 15_000,
    headers: { "Accept": "application/json", "User-Agent": "Lumiverse" },
  });
  if (!res.ok) {
    return { requestId, success: false, error: `Chub API returned ${res.status}`, errorCode: "UNKNOWN" };
  }

  const data = (await res.json()) as any;
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
  payload: InstallWorldbookPayload
): Promise<InstallWorldbookResultPayload> {
  const userId = getFirstUserId();
  if (!userId) {
    return { requestId, success: false, error: "No owner user configured on this Lumiverse instance" };
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
        wbSvc.updateWorldBook(userId, result.worldBook.id, {
          metadata: {
            ...wb.metadata,
            _lumiverse_install_source: payload.source,
            source_creator: payload.worldbookName.includes("/") ? payload.worldbookName.split("/")[0] : "unknown",
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

/** Install a theme export from LumiHub into the owner's active theme settings. */
export async function installTheme(
  requestId: string,
  payload: InstallThemePayload,
): Promise<InstallThemeResultPayload> {
  const userId = getFirstUserId();
  if (!userId) {
    return { requestId, success: false, error: "No owner user configured on this Lumiverse instance" };
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

/** Install a Loom preset export from LumiHub into the owner's preset library. */
export async function installPreset(
  requestId: string,
  payload: InstallPresetPayload,
): Promise<InstallPresetResultPayload> {
  const userId = getFirstUserId();
  if (!userId) {
    return { requestId, success: false, error: "No owner user configured on this Lumiverse instance" };
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

    const presetInput = {
      name,
      provider: "loom",
      parameters: {
        samplerOverrides: isPlainObject(p.samplerOverrides) ? p.samplerOverrides : {},
        customBody: isPlainObject(p.customBody) ? p.customBody : {},
      },
      prompt_order: blocks,
      prompts: {
        promptBehavior: isPlainObject(p.promptBehavior) ? p.promptBehavior : {},
        completionSettings: isPlainObject(p.completionSettings) ? p.completionSettings : {},
        advancedSettings: isPlainObject(p.advancedSettings) ? p.advancedSettings : {},
      },
      metadata: {
        source: isPlainObject(p.source) ? p.source : null,
        modelProfiles: isPlainObject(p.modelProfiles) ? p.modelProfiles : {},
        schemaVersion: typeof p.schemaVersion === "number" ? p.schemaVersion : exported.schemaVersion ?? 1,
        description: typeof p.description === "string" ? p.description : "",
        isDefault: !!p.isDefault,
        lastProfileKey: typeof p.lastProfileKey === "string" ? p.lastProfileKey : null,
        promptVariables: isPlainObject(p.promptVariables) ? p.promptVariables : {},
        compatibility: isPlainObject(exported.compatibility) ? exported.compatibility : {},
        coverUrl: typeof exported.cover_url === "string" ? exported.cover_url : null,
        _lumiverse_install_source: "lumihub",
        _lumiverse_lumihub_id: payload.presetId,
        _lumiverse_preset_version: presetVersion,
        _lumiverse_preset_slug: presetSlug,
        _lumiverse_preset_creator: presetCreator,
      },
    };

    // Update the existing installation in place when this preset was installed
    // from LumiHub before, so "Update" advances the version instead of duplicating.
    const existing = presetsSvc.findPresetByLumihubId(userId, payload.presetId);
    let saved;
    if (existing) {
      saved = presetsSvc.updatePreset(userId, existing.id, presetInput)!;
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

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
