import { Hono } from "hono";
import * as svc from "../services/characters.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import * as cardSvc from "../services/character-card.service";
import * as exportSvc from "../services/character-export.service";
import * as gallerySvc from "../services/character-gallery.service";
import * as regexSvc from "../services/regex-scripts.service";
import * as exprSvc from "../services/expressions.service";
import * as wbSvc from "../services/world-books.service";
import { parsePagination } from "../services/pagination";
import { safeFetch, SSRFError, validateHost } from "../utils/safe-fetch";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import { createAvatarResolverResponse } from "../utils/avatar-cache";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { buildSlug } from "../lumihub/manifest";

const app = new Hono();

// ─── RisuAI module regex import helper ────────────────────────────────────

function importRisuModuleRegexScripts(
  userId: string,
  characterId: string,
  module: cardSvc.RisuModule | null
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
  assets: cardSvc.CharxExpressionAsset[]
): Promise<number> {
  if (!assets.length) return 0;
  const config = await exprSvc.importFromAssets(userId, characterId, assets);
  return Object.keys(config.mappings).length;
}

// ─── Auto-import embedded character book as world book ───────────────────

function autoImportEmbeddedWorldbook(userId: string, characterId: string): void {
  const character = svc.getCharacter(userId, characterId);
  if (!character) return;

  const charBook = character.extensions?.character_book;
  const entries = Array.isArray(charBook?.entries)
    ? charBook.entries
    : Object.values(charBook?.entries || {});
  if (entries.length === 0) return;

  // Skip if world books are already linked (e.g. from Lumiverse modules)
  const existingIds = getCharacterWorldBookIds(character.extensions);
  if (existingIds.length > 0) return;

  try {
    const { worldBook } = wbSvc.importCharacterBook(userId, characterId, character.name, charBook);
    const nextExtensions = setCharacterWorldBookIds(
      { ...(character.extensions || {}) },
      [...existingIds, worldBook.id],
    );
    svc.updateCharacter(userId, characterId, { extensions: nextExtensions });
  } catch {
    // Non-critical — character is still imported without the world book
  }
}

// ─── URL parsing helpers ──────────────────────────────────────────────────

const CHUB_DOMAINS = ["chub.ai", "www.chub.ai", "characterhub.org", "www.characterhub.org"];
const JANNY_DOMAINS = ["janitorai.com", "www.janitorai.com", "jannyai.com", "www.jannyai.com"];

function parseChubUrl(url: string): string | null {
  const parts = url.split("/");
  let domainIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (CHUB_DOMAINS.includes(parts[i].toLowerCase())) {
      domainIdx = i;
      break;
    }
  }
  if (domainIdx === -1) return null;

  const rest = parts.slice(domainIdx + 1);
  // Strip leading "characters" segment if present
  const start = rest[0]?.toLowerCase() === "characters" ? 1 : 0;
  const pathParts = rest.slice(start).filter(Boolean);
  if (pathParts.length >= 2) {
    return pathParts.slice(0, 2).join("/");
  }
  return null;
}

const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;

function parseJannyUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!JANNY_DOMAINS.includes(parsed.hostname.toLowerCase())) return null;
  } catch {
    return null;
  }
  const match = url.match(UUID_RE);
  return match ? match[0] : null;
}

// ─── Chub.ai character fetcher ────────────────────────────────────────────

async function fetchChubCharacter(chubPath: string, userId: string) {
  const apiUrl = `https://gateway.chub.ai/api/characters/${chubPath}?full=true`;
  const res = await safeFetch(apiUrl, {
    timeoutMs: 15_000,
    headers: { "Accept": "application/json", "User-Agent": "Lumiverse" },
  });
  if (!res.ok) {
    throw new Error(`Chub API returned ${res.status}`);
  }

  const data = await res.json() as any;
  const node = data?.node;
  if (!node) throw new Error("Invalid Chub API response: missing node");

  const def = node.definition ?? node;
  const name = def.name || node.name;
  if (!name) throw new Error("Character card from Chub is missing a name");

  // Build a V2-style card object for parseCardJson
  // Chub API field names differ from the standard card spec:
  //   Chub "personality"        → card "description"
  //   Chub "tavern_personality" → card "personality"
  //   Chub "description"        → card "creator_notes"
  //   Chub "example_dialogs"    → card "mes_example"
  //   Chub "first_message"      → card "first_mes"
  //   Chub "embedded_lorebook"  → card "character_book"
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

  // Fetch avatar image
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
    } catch {
      // Avatar fetch failed — character is still imported, just without an avatar
    }
  }

  // Stamp install source so LumiHub manifest can track this card for updates
  try {
    const freshChar = svc.getCharacter(userId, character.id);
    if (freshChar) {
      const slug = buildSlug(freshChar.creator, freshChar.name);
      svc.updateCharacter(userId, character.id, {
        extensions: {
          ...(freshChar.extensions || {}),
          _lumiverse_install_source: "chub",
          _lumiverse_install_slug: slug,
          _lumiverse_chub_slug: chubPath.toLowerCase(),
        },
      });
    }
  } catch {
    // Non-critical — manifest will still work via creator/name derivation
  }

  autoImportEmbeddedWorldbook(userId, character.id);
  return svc.getCharacter(userId, character.id)!;
}

// ─── JannyAI character fetcher ────────────────────────────────────────────

async function fetchJannyCharacter(uuid: string, userId: string) {
  // safeFetch is GET-only; JannyAI requires POST — validate host then POST directly
  await validateHost("api.jannyai.com");
  const downloadRes = await fetch("https://api.jannyai.com/api/v1/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ characterId: uuid }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!downloadRes.ok) {
    throw new Error(`JannyAI API returned ${downloadRes.status}`);
  }

  const result = await downloadRes.json() as any;
  if (result.status !== "ok" || !result.downloadUrl) {
    throw new Error(result.error || "JannyAI download failed");
  }

  // Download the PNG card from the provided URL.
  // Use plain fetch (not safeFetch) — the download URL is a CDN/presigned URL from
  // JannyAI's own API. safeFetch's manual redirect handling breaks CDN redirects.
  // This matches SillyTavern's approach.
  const downloadUrl = new URL(result.downloadUrl);
  await validateHost(downloadUrl.hostname);
  const pngRes = await fetch(result.downloadUrl, { signal: AbortSignal.timeout(15_000) });
  if (!pngRes.ok) {
    throw new Error(`Failed to download JannyAI character image: ${pngRes.status}`);
  }

  const buf = await pngRes.arrayBuffer();
  const file = new File([buf], `${uuid}.png`, { type: "image/png" });

  const cardInput = await cardSvc.extractCardFromPng(file);
  const character = svc.createCharacter(userId, cardInput);

  // Use the PNG as avatar
  const image = await images.uploadImage(userId, file);
  svc.setCharacterImage(userId, character.id, image.id);
  svc.setCharacterAvatar(userId, character.id, image.filename);

  autoImportEmbeddedWorldbook(userId, character.id);
  return svc.getCharacter(userId, character.id)!;
}

// ─── Generic URL fetcher (PNG or JSON) ────────────────────────────────────

async function fetchGenericCharacter(url: string, userId: string) {
  const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 100 * 1024 * 1024 });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();

  if (contentType.includes("image/png") || url.toLowerCase().endsWith(".png")) {
    const file = new File([buf], "import.png", { type: "image/png" });
    const cardInput = await cardSvc.extractCardFromPng(file);
    const character = svc.createCharacter(userId, cardInput);

    const image = await images.uploadImage(userId, file);
    svc.setCharacterImage(userId, character.id, image.id);
    svc.setCharacterAvatar(userId, character.id, image.filename);

    autoImportEmbeddedWorldbook(userId, character.id);
    return svc.getCharacter(userId, character.id)!;
  }

  if (contentType.includes("application/zip") || url.toLowerCase().endsWith(".charx")) {
    const file = new File([buf], "import.charx", { type: "application/zip" });
    const { card: cardInput, avatarFile, galleryFiles, risuModule, expressionAssets } = await cardSvc.extractCardFromCharx(file);
    const character = svc.createCharacter(userId, cardInput);

    if (avatarFile) {
      const image = await images.uploadImage(userId, avatarFile);
      svc.setCharacterImage(userId, character.id, image.id);
      svc.setCharacterAvatar(userId, character.id, image.filename);
    }

    if (galleryFiles.length > 3) {
      await gallerySvc.uploadBulkToGallery(userId, character.id, galleryFiles);
    } else {
      for (const gf of galleryFiles) {
        try { await gallerySvc.uploadToGallery(userId, character.id, gf); } catch { /* skip */ }
      }
    }

    importRisuModuleRegexScripts(userId, character.id, risuModule);
    await importRisuExpressionAssets(userId, character.id, expressionAssets);

    autoImportEmbeddedWorldbook(userId, character.id);
    return svc.getCharacter(userId, character.id)!;
  }

  // Assume JSON
  const text = new TextDecoder().decode(buf);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("URL did not return valid PNG, CHARX, or JSON character data");
  }

  const cardInput = cardSvc.parseCardJson(json);
  const character = svc.createCharacter(userId, cardInput);
  autoImportEmbeddedWorldbook(userId, character.id);
  return svc.getCharacter(userId, character.id)!;
}

app.get("/", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const sort = c.req.query("sort");

  if (sort === "discover") {
    const rawSeed = c.req.query("seed");
    const seed = rawSeed ? parseInt(rawSeed, 10) : undefined;
    return c.json(svc.listCharactersDiscover(userId, pagination, isNaN(seed as number) ? undefined : seed));
  }

  return c.json(svc.listCharacters(userId, pagination));
});

// ─── Lightweight summary endpoint for character browser ───────────────────
app.get("/summary", (c) => {
  const userId = c.get("userId");
  const pagination = parsePagination(c.req.query("limit"), c.req.query("offset"));
  const search = c.req.query("search") || undefined;
  const rawTags = c.req.query("tags");
  const tags = rawTags ? rawTags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const sort = c.req.query("sort") || undefined;
  const direction = (c.req.query("direction") as "asc" | "desc") || undefined;
  const filterMode = (c.req.query("filter") as "all" | "favorites" | "non-favorites") || undefined;
  const rawSeed = c.req.query("seed");
  const seed = rawSeed ? parseInt(rawSeed, 10) : undefined;
  const rawFavorites = c.req.query("favorite_ids");
  const favoriteIds = rawFavorites ? rawFavorites.split(",").filter(Boolean) : undefined;

  return c.json(
    svc.listCharacterSummaries(userId, pagination, {
      search,
      tags,
      sort,
      direction,
      favoriteIds,
      filterMode,
      seed: isNaN(seed as number) ? undefined : seed,
    })
  );
});

// ─── Tags endpoint for character browser ──────────────────────────────────
app.get("/tags", (c) => {
  const userId = c.get("userId");
  return c.json(svc.listCharacterTags(userId));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const character = svc.createCharacter(userId, body);
  return c.json(character, 201);
});

// --- Static routes MUST come before /:id to avoid shadowing ---

app.post("/import-url", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const url = body.url;
  if (!url || typeof url !== "string") return c.json({ error: "url is required" }, 400);

  try {
    let character;

    // Check for Chub.ai URL
    const chubPath = parseChubUrl(url);
    if (chubPath) {
      character = await fetchChubCharacter(chubPath, userId);
      return c.json({ character }, 201);
    }

    // Check for JannyAI URL
    const jannyId = parseJannyUrl(url);
    if (jannyId) {
      character = await fetchJannyCharacter(jannyId, userId);
      return c.json({ character }, 201);
    }

    // Generic URL (direct PNG or JSON link)
    character = await fetchGenericCharacter(url, userId);
    return c.json({ character }, 201);
  } catch (err: any) {
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err.message || "Failed to import from URL" }, 400);
  }
});

app.get("/:id", (c) => {
  const userId = c.get("userId");
  const char = svc.getCharacter(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);
  return c.json(char);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const char = svc.updateCharacter(userId, c.req.param("id"), body);
  if (!char) return c.json({ error: "Not found" }, 404);
  return c.json(char);
});

app.delete("/:id", (c) => {
  const userId = c.get("userId");
  const deleted = svc.deleteCharacter(userId, c.req.param("id"));
  if (!deleted) return c.json({ error: "Not found" }, 404);
  return c.json({ success: true });
});

app.get("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const info = svc.getCharacterAvatarInfo(userId, c.req.param("id"));
  if (!info) return c.json({ error: "Not found" }, 404);

  const sizeParam = c.req.query("size") as images.ThumbTier | undefined;
  const tier = sizeParam === "sm" || sizeParam === "lg" ? sizeParam : undefined;

  // Prefer image_id, fall back to legacy avatar_path
  if (info.image_id) {
    const filepath = await images.getImageFilePath(userId, info.image_id, tier);
    if (filepath) {
      return createAvatarResolverResponse(
        filepath,
        info.image_id + (tier ? `_${tier}` : ""),
        c.req.header("If-None-Match")
      );
    }
  }

  if (info.avatar_path) {
    const filepath = await files.getAvatarPath(info.avatar_path);
    if (filepath) {
      return createAvatarResolverResponse(
        filepath,
        info.avatar_path,
        c.req.header("If-None-Match")
      );
    }
  }

  return c.json({ error: "Not found" }, 404);
});

app.post("/:id/duplicate", (c) => {
  const userId = c.get("userId");
  const character = svc.duplicateCharacter(userId, c.req.param("id"));
  if (!character) return c.json({ error: "Not found" }, 404);
  return c.json(character, 201);
});

app.get("/:id/export", async (c) => {
  const userId = c.get("userId");
  const id = c.req.param("id");
  const format = (c.req.query("format") || "json") as "json" | "png" | "charx";

  if (format === "json") {
    const result = exportSvc.exportAsJson(userId, id);
    if (!result) return c.json({ error: "Not found" }, 404);
    const name = exportSvc.sanitizeFilename(result.data?.name || "character");
    return c.json(result, 200, {
      "Content-Disposition": `attachment; filename="${name}.json"`,
    });
  }

  if (format === "png") {
    const buf = await exportSvc.exportAsPng(userId, id);
    if (!buf) return c.json({ error: "Not found" }, 404);
    const character = svc.getCharacter(userId, id);
    const name = exportSvc.sanitizeFilename(character?.name || "character");
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${name}.png"`,
      },
    });
  }

  if (format === "charx") {
    const buf = await exportSvc.exportAsCharx(userId, id);
    if (!buf) return c.json({ error: "Not found" }, 404);
    const character = svc.getCharacter(userId, id);
    const name = exportSvc.sanitizeFilename(character?.name || "character");
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${name}.charx"`,
      },
    });
  }

  return c.json({ error: "Invalid format. Must be one of: json, png, charx" }, 400);
});

app.post("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const char = svc.getCharacter(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  // Clean up old image if present
  if (char.image_id) images.deleteImage(userId, char.image_id);
  if (char.avatar_path) await files.deleteAvatar(char.avatar_path);

  const image = await images.uploadImage(userId, file);
  svc.setCharacterImage(userId, char.id, image.id);
  svc.setCharacterAvatar(userId, char.id, image.filename);
  const updated = svc.getCharacter(userId, char.id);
  if (!updated) return c.json({ error: "Not found" }, 404);

  eventBus.emit(EventType.CHARACTER_EDITED, { id: char.id, character: updated }, userId);
  return c.json(updated);
});

app.post("/import-bulk", async (c) => {
  const userId = c.get("userId");

  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) return c.json({ error: "files are required" }, 400);
    if (files.length > 500) return c.json({ error: "Maximum 500 files per bulk import" }, 400);

    const skipDuplicates = formData.get("skip_duplicates") === "true";

    const results: Array<{
      filename: string;
      success: boolean;
      character?: any;
      lorebook?: { name: string; entryCount: number };
      error?: string;
      skipped?: boolean;
    }> = [];

    for (const file of files) {
      const filename = file.name || "unknown";
      const filenameLower = filename.toLowerCase();
      try {
        let cardInput;
        let avatarFile: File | null = null;
        let charxGalleryFiles: File[] = [];
        let charxAssetFiles: Map<string, File> | null = null;
        let risuModule: cardSvc.RisuModule | null = null;
        let expressionAssets: cardSvc.CharxExpressionAsset[] = [];

        if (file.type === "image/png" || filenameLower.endsWith(".png")) {
          cardInput = await cardSvc.extractCardFromPng(file);
          avatarFile = file;
        } else if (filenameLower.endsWith(".charx") || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
          const charxResult = await cardSvc.extractCardFromCharx(file);
          cardInput = charxResult.card;
          avatarFile = charxResult.avatarFile;
          charxGalleryFiles = charxResult.galleryFiles;
          charxAssetFiles = charxResult.assetFiles;
          risuModule = charxResult.risuModule;
          expressionAssets = charxResult.expressionAssets;
        } else {
          const text = await file.text();
          const json = JSON.parse(text);
          cardInput = cardSvc.parseCardJson(json);
        }

        // Deduplication check
        if (skipDuplicates) {
          const hasRealFilename = filename && filename !== "unknown" && filename !== "";
          const existingByFile = hasRealFilename
            ? svc.findCharacterBySourceFilename(userId, filename)
            : null;

          if (existingByFile) {
            results.push({ filename, success: true, skipped: true, character: existingByFile });
            continue;
          }

          // No filename match — fall back to name-based check only when filename is absent
          if (!hasRealFilename && svc.characterExistsByName(userId, cardInput.name)) {
            const existing = svc.findCharactersByName(userId, cardInput.name);
            results.push({ filename, success: true, skipped: true, character: existing[0] });
            continue;
          }
        }

        const character = svc.createCharacter(userId, cardInput);

        // Store source filename so re-imports can deduplicate by file identity
        if (filename && filename !== "unknown" && filename !== "") {
          svc.setCharacterSourceFilename(userId, character.id, filename);
        }

        if (avatarFile) {
          const image = await images.uploadImage(userId, avatarFile);
          svc.setCharacterImage(userId, character.id, image.id);
          svc.setCharacterAvatar(userId, character.id, image.filename);
        }

        // Upload gallery images, tracking archive path → image ID for inline asset resolution
        const bulkAssetImageMap = new Map<string, string>();
        if (charxAssetFiles) {
          for (const [path, gf] of charxAssetFiles) {
            if (avatarFile && gf.name === avatarFile.name) continue;
            if (!/^assets\/(icon|other)\//i.test(path)) continue;
            try {
              const img = await images.uploadImage(userId, gf);
              gallerySvc.addToGallery(userId, character.id, img.id);
              bulkAssetImageMap.set(path, img.id);
            } catch { /* skip */ }
          }
        } else {
          for (const gf of charxGalleryFiles) {
            try { await gallerySvc.uploadToGallery(userId, character.id, gf); } catch { /* skip */ }
          }
        }

        // Resolve inline asset references in character text fields
        if (bulkAssetImageMap.size > 0) {
          const resolvedFields = cardSvc.resolveInlineAssetReferences(
            {
              first_mes: character.first_mes,
              description: character.description,
              alternate_greetings: character.alternate_greetings,
            },
            bulkAssetImageMap,
          );
          if (Object.keys(resolvedFields).length > 0) {
            svc.updateCharacter(userId, character.id, resolvedFields);
          }

          // Store Risu asset name → image ID mapping for display-time resolution
          const risuAssetMap: Record<string, string> = {};
          for (const [archivePath, imageId] of bulkAssetImageMap) {
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
        await importRisuExpressionAssets(userId, character.id, expressionAssets);
        autoImportEmbeddedWorldbook(userId, character.id);

        const imported = svc.getCharacter(userId, character.id)!;

        // Check for embedded lorebook
        let lorebook: { name: string; entryCount: number } | undefined;
        const charBook = imported.extensions?.character_book;
        if (charBook?.entries?.length) {
          const entries = Array.isArray(charBook.entries)
            ? charBook.entries
            : Object.values(charBook.entries);
          lorebook = {
            name: charBook.name || `${imported.name}'s Lorebook`,
            entryCount: entries.length,
          };
        }

        results.push({ filename, success: true, character: imported, lorebook });
      } catch (err: any) {
        results.push({
          filename,
          success: false,
          error: err.message || "Failed to import",
        });
      }
    }

    const imported = results.filter((r) => r.success && !r.skipped && r.character).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.success).length;

    return c.json({ results, summary: { total: files.length, imported, skipped, failed } }, 201);
  } catch (err: any) {
    return c.json({ error: err.message || "Bulk import failed" }, 400);
  }
});

app.post("/import", async (c) => {
  const userId = c.get("userId");
  const contentType = c.req.header("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const formData = await c.req.formData();
      const file = formData.get("file") as File | null;
      if (!file) return c.json({ error: "file is required" }, 400);

      const nameLower = file.name?.toLowerCase() ?? "";
      if (file.type === "image/png" || nameLower.endsWith(".png")) {
        // PNG card — extract embedded JSON + use as avatar
        const cardInput = await cardSvc.extractCardFromPng(file);
        const character = svc.createCharacter(userId, cardInput);
        const image = await images.uploadImage(userId, file);
        svc.setCharacterImage(userId, character.id, image.id);
        svc.setCharacterAvatar(userId, character.id, image.filename);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({ character: imported }, 201);
      } else if (nameLower.endsWith(".charx") || file.type === "application/zip" || file.type === "application/x-zip-compressed") {
        // CHARX archive — ZIP with card.json + optional avatar + gallery images + modules
        const charxResult = await cardSvc.extractCardFromCharx(file);
        const { card: cardInput, avatarFile, risuModule, expressionAssets, lumiverseModules, assetFiles } = charxResult;
        const character = svc.createCharacter(userId, cardInput);
        // Track archive-path → image-id for resolving inline asset references in text fields
        const assetImageMap = new Map<string, string>();
        if (avatarFile) {
          const image = await images.uploadImage(userId, avatarFile);
          svc.setCharacterImage(userId, character.id, image.id);
          svc.setCharacterAvatar(userId, character.id, image.filename);
        }

        // Track consumed asset paths so remaining go to gallery
        const consumedPaths = new Set<string>();
        let lumiverseModulesSummary: Record<string, any> | undefined;

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
                assetImageMap.set(av.path, img.id);
              }
            }
            if (altAvatars.length > 0) {
              extensions.alternate_avatars = altAvatars;
            }
          }

          // Import world books from Lumiverse modules
          let importedWorldBookCount = 0;
          if (Array.isArray(lumiverseModules.world_books) && lumiverseModules.world_books.length > 0) {
            const importedBookIds: string[] = [];
            for (const bookData of lumiverseModules.world_books) {
              try {
                const result = wbSvc.importLumiverseWorldBook(userId, character.id, bookData);
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

          lumiverseModulesSummary = {
            has_expressions: !!extensions.expressions,
            has_alternate_fields: !!lumiverseModules.alternate_fields,
            has_alternate_avatars: altAvatars.length > 0,
            has_world_books: importedWorldBookCount > 0,
            world_book_count: importedWorldBookCount,
            expression_count: Object.keys(extensions.expressions?.mappings || {}).length,
            alternate_field_counts: lumiverseModules.alternate_fields
              ? Object.fromEntries(
                  Object.entries(lumiverseModules.alternate_fields).map(
                    ([k, v]) => [k, Array.isArray(v) ? v.length : 0]
                  )
                )
              : undefined,
          };
        }

        // Upload remaining unconsumed asset images to gallery, tracking archive path → image ID
        const remainingGalleryEntries: Array<{ path: string; file: File }> = [];
        for (const [path, assetFile] of assetFiles) {
          if (consumedPaths.has(path)) continue;
          if (avatarFile && assetFile.name === avatarFile.name) continue;
          if (/^assets\/(icon|other)\//i.test(path)) {
            remainingGalleryEntries.push({ path, file: assetFile });
          }
        }
        const galleryTotal = remainingGalleryEntries.length;
        for (let i = 0; i < galleryTotal; i++) {
          const { path, file: gf } = remainingGalleryEntries[i];
          if (galleryTotal > 3) {
            eventBus.emit(
              EventType.IMPORT_GALLERY_PROGRESS,
              { characterId: character.id, current: i + 1, total: galleryTotal, filename: gf.name },
              userId,
            );
          }
          try {
            const img = await images.uploadImage(userId, gf);
            gallerySvc.addToGallery(userId, character.id, img.id);
            assetImageMap.set(path, img.id);
          } catch { /* skip individual failures */ }
        }

        // Resolve inline asset references (embeded://, relative filenames, Risu <img="...">) in character text fields
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

          // Store Risu asset name → image ID mapping for display-time resolution of
          // AI-generated <img="AssetName"> tags (mirrors RisuAI's display-time asset lookup)
          const risuAssetMap: Record<string, string> = {};
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
        await importRisuExpressionAssets(userId, character.id, expressionAssets);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({
          character: imported,
          ...(lumiverseModulesSummary ? { lumiverse_modules: lumiverseModulesSummary } : {}),
        }, 201);
      } else {
        // JSON file — read text content, parse card spec
        const text = await file.text();
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          return c.json({ error: "Invalid JSON in uploaded file" }, 400);
        }
        const cardInput = cardSvc.parseCardJson(json);
        const character = svc.createCharacter(userId, cardInput);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({ character: imported }, 201);
      }
    } else {
      // Raw JSON body — support both card-spec wrapper and flat input
      const body = await c.req.json();
      const input = (body.spec && body.data) ? cardSvc.parseCardJson(body) : body;
      if (!input.name) return c.json({ error: "name is required" }, 400);
      const character = svc.createCharacter(userId, input);
      autoImportEmbeddedWorldbook(userId, character.id);
      const imported = svc.getCharacter(userId, character.id)!;
      return c.json({ character: imported }, 201);
    }
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to import character card" }, 400);
  }
});

export { app as charactersRoutes };
