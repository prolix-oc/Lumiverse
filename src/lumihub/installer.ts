/**
 * Handles remote install commands from LumiHub by calling existing Lumiverse
 * import services directly (no HTTP self-requests).
 */
import * as svc from "../services/characters.service";
import * as cardSvc from "../services/character-card.service";
import * as images from "../services/images.service";
import * as gallerySvc from "../services/character-gallery.service";
import * as exprSvc from "../services/expressions.service";
import { safeFetch } from "../utils/safe-fetch";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getFirstUserId } from "../auth/seed";
import * as wbSvc from "../services/world-books.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import type { InstallCharacterPayload, InstallResultPayload, InstallWorldbookPayload, InstallWorldbookResultPayload } from "./types";

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
  const files: File[] = [];
  for (const url of urls) {
    try {
      const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 50 * 1024 * 1024 });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") || "image/webp";
      const ext = contentType.includes("png") ? "png" : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "webp";
      const filename = `gallery_${crypto.randomUUID()}.${ext}`;
      files.push(new File([buf], filename, { type: contentType }));
    } catch {
      // Skip individual failures
    }
  }

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
    const { worldBook } = wbSvc.importCharacterBook(userId, characterId, characterName, charBook);
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
  const url = payload.importUrl!;

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
    const { card: cardInput, avatarFile, risuModule, expressionAssets, lumiverseModules, assetFiles } = charxResult;
    const character = svc.createCharacter(userId, cardInput);

    if (avatarFile) {
      const image = await images.uploadImage(userId, avatarFile);
      svc.setCharacterImage(userId, character.id, image.id);
      svc.setCharacterAvatar(userId, character.id, image.filename);
    }

    // Track consumed asset paths so remaining go to gallery
    const consumedPaths = new Set<string>();

    if (lumiverseModules) {
      const extensions: Record<string, any> = { ...(character.extensions || {}) };

      // Import expressions from Lumiverse modules
      if (lumiverseModules.expressions?.mappings) {
        const exprMappings: Record<string, string> = {};
        for (const [label, archivePath] of Object.entries(lumiverseModules.expressions.mappings)) {
          const assetFile = assetFiles.get(archivePath);
          if (assetFile) {
            const img = await images.uploadImage(userId, assetFile);
            exprMappings[label] = img.id;
            consumedPaths.add(archivePath);
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

      // Import alternate fields
      if (lumiverseModules.alternate_fields) {
        extensions.alternate_fields = lumiverseModules.alternate_fields;
      }

      // Import alternate avatars
      const altAvatars: Array<{ id: string; image_id: string; label: string }> = [];
      if (Array.isArray(lumiverseModules.alternate_avatars)) {
        for (const av of lumiverseModules.alternate_avatars) {
          const assetFile = assetFiles.get(av.path);
          if (assetFile) {
            const img = await images.uploadImage(userId, assetFile);
            altAvatars.push({ id: av.id || crypto.randomUUID(), image_id: img.id, label: av.label });
            consumedPaths.add(av.path);
          }
        }
        if (altAvatars.length > 0) {
          extensions.alternate_avatars = altAvatars;
        }
      }

      svc.updateCharacter(userId, character.id, { extensions });
    }

    // Upload remaining unconsumed images to gallery
    const remainingGalleryFiles: File[] = [];
    for (const [path, assetFile] of assetFiles) {
      if (consumedPaths.has(path)) continue;
      if (avatarFile && assetFile.name === avatarFile.name) continue;
      if (/^assets\/(icon|other)\//i.test(path)) {
        remainingGalleryFiles.push(assetFile);
      }
    }
    if (remainingGalleryFiles.length > 3) {
      await gallerySvc.uploadBulkToGallery(userId, character.id, remainingGalleryFiles);
    } else {
      for (const gf of remainingGalleryFiles) {
        try { await gallerySvc.uploadToGallery(userId, character.id, gf); } catch { /* skip */ }
      }
    }

    // Import RisuAI expression assets (heuristic-based, from x-risu-asset entries)
    if (expressionAssets.length > 0) {
      await exprSvc.importFromAssets(userId, character.id, expressionAssets);
    }

    // Import regex scripts from Lumiverse modules (bundled .charx)
    if (lumiverseModules?.regex_scripts?.length) {
      try {
        const regexSvc = await import("../services/regex-scripts.service");
        for (const bundled of lumiverseModules.regex_scripts) {
          try {
            regexSvc.createRegexScript(userId, {
              ...(bundled as import("../types/regex-script").CreateRegexScriptInput),
              scope: "character",
              scope_id: character.id,
              metadata: { ...bundled.metadata, source: "charx_bundle" },
            });
          } catch { /* skip individual failures */ }
        }
      } catch { /* skip if regex service unavailable */ }
    }

    // Import RisuAI regex scripts
    if (risuModule?.regex?.length) {
      const scripts = cardSvc.convertRisuRegexScripts(risuModule.regex, character.id);
      for (const script of scripts) {
        // Best-effort — skip failures
        try {
          const regexSvc = await import("../services/regex-scripts.service");
          regexSvc.createRegexScript(userId, script);
        } catch { /* skip */ }
      }
    }

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

  // Detect PNG
  if (contentType.includes("image/png") || url.toLowerCase().endsWith(".png")) {
    const file = new File([buf], "import.png", { type: "image/png" });
    const cardInput = await cardSvc.extractCardFromPng(file);
    const character = svc.createCharacter(userId, cardInput);

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
