import { Hono } from "hono";
import * as svc from "../services/characters.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import * as cardSvc from "../services/character-card.service";
import * as characterLoraSvc from "../services/character-lora.service";
import * as exportSvc from "../services/character-export.service";
import * as tagLibrarySvc from "../services/tag-library-import.service";
import * as wbSvc from "../services/world-books.service";
import * as regexSvc from "../services/regex-scripts.service";
import { parsePagination } from "../services/pagination";
import { safeFetch, SSRFError, validateHost } from "../utils/safe-fetch";
import { rewriteBotBooruUrl } from "../utils/botbooru";
import { createAvatarResolverResponse } from "../utils/avatar-cache";
import { buildSlug } from "../lumihub/manifest";
import { applyCharxModulesAndAssets, autoImportEmbeddedWorldbook } from "../services/charx-import.service";

const app = new Hono();

// ─── Import error response helper ────────────────────────────────────────

function respondImportError(c: any, err: any, fallbackMessage: string) {
  // Log every import failure server-side so silent 4xx responses are traceable.
  // Generic 400s from the old code swallowed this — which is how a 500 MB
  // decompression-cap hit looked like "no backend error" to operators.
  console.error("[character import] failed:", err);
  if (err instanceof cardSvc.CharacterImportError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  return c.json({ error: err?.message || fallbackMessage }, 400);
}

// Bind any card-embedded regex scripts (Lumiverse bundle or SillyTavern) to a
// freshly-imported character. Best-effort: the character already exists, so a
// regex failure must not fail the import. CHARX imports bind their own bundle
// via applyCharxModulesAndAssets, so this is only used on the non-CHARX paths.
function importCardRegexBestEffort(userId: string, characterId: string, extensions: unknown): void {
  try {
    regexSvc.importCharacterBoundRegexScripts(userId, characterId, extensions);
  } catch (err) {
    console.error("[character import] regex import failed:", err);
  }
}

// ─── Portable LoRA surfacing ──────────────────────────────────────────────
//
// The portable LoRA reference (lumiverse_image_gen_lora) rides along in a
// character's `extensions` on every import format. We surface it in the import
// response as `lumiverse_lora` so the UI can show "this character expects
// <file> @ <weight>" and let the user confirm a binding. We deliberately do NOT
// auto-bind it: the runtime binding is per-user and may point at a different
// local LoRA library (and source_url is never auto-fetched).
function loraSurface(
  character: { extensions?: Record<string, any> } | null | undefined,
): { lumiverse_lora?: characterLoraSvc.PortableLoraReference } {
  const ref = character ? characterLoraSvc.readPortableLoraReference(character) : null;
  return ref ? { lumiverse_lora: ref } : {};
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

  const cardInput = cardSvc.normalizeJannyCharacterInput(await cardSvc.extractCardFromPng(file));
  const character = svc.createCharacter(userId, cardInput);

  // Use the PNG as avatar
  const image = await images.uploadImage(userId, file);
  svc.setCharacterImage(userId, character.id, image.id);
  svc.setCharacterAvatar(userId, character.id, image.filename);

  autoImportEmbeddedWorldbook(userId, character.id);
  return svc.getCharacter(userId, character.id)!;
}

// ─── Generic URL fetcher (PNG or JSON) ────────────────────────────────────

/**
 * Detect a binary card container by its magic bytes. Needed because some
 * sources (e.g. BotBooru's /download/png/{id}) serve cards from extensionless
 * URLs, so neither the `.png`/`.charx` suffix nor a trustworthy Content-Type
 * may be present.
 */
function sniffCardContainer(buf: ArrayBuffer): "png" | "zip" | null {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) {
    return "png";
  }
  // ZIP (charx): "PK" followed by a local-file / central-dir / end-of-archive marker
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
    return "zip";
  }
  return null;
}

async function fetchGenericCharacter(url: string, userId: string) {
  const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 100 * 1024 * 1024 });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  const sniffed = sniffCardContainer(buf);

  if (sniffed === "png" || contentType.includes("image/png") || url.toLowerCase().endsWith(".png")) {
    const file = new File([buf], "import.png", { type: "image/png" });
    const cardInput = await cardSvc.extractCardFromPng(file);
    const character = svc.createCharacter(userId, cardInput);

    const image = await images.uploadImage(userId, file);
    svc.setCharacterImage(userId, character.id, image.id);
    svc.setCharacterAvatar(userId, character.id, image.filename);

    autoImportEmbeddedWorldbook(userId, character.id);
    return svc.getCharacter(userId, character.id)!;
  }

  if (sniffed === "zip" || contentType.includes("application/zip") || url.toLowerCase().endsWith(".charx")) {
    const file = new File([buf], "import.charx", { type: "application/zip" });
    const charxResult = await cardSvc.extractCardFromCharx(file);
    const character = svc.createCharacter(userId, charxResult.card);
    await applyCharxModulesAndAssets(userId, character, charxResult);
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
  const rawExcludeTags = c.req.query("exclude_tags");
  const excludeTags = rawExcludeTags ? rawExcludeTags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
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
      excludeTags,
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
      return c.json({ character, ...loraSurface(character) }, 201);
    }

    // Check for JannyAI URL
    const jannyId = parseJannyUrl(url);
    if (jannyId) {
      character = await fetchJannyCharacter(jannyId, userId);
      return c.json({ character, ...loraSurface(character) }, 201);
    }

    // Check for BotBooru URL → rewrite to the PNG download, which embeds a
    // SillyTavern-compatible card *and* an avatar, then reuse the generic importer.
    const botBooruPngUrl = rewriteBotBooruUrl(url, "png");
    if (botBooruPngUrl) {
      character = await fetchGenericCharacter(botBooruPngUrl, userId);
      return c.json({ character, ...loraSurface(character) }, 201);
    }

    // Generic URL (direct PNG or JSON link)
    character = await fetchGenericCharacter(url, userId);
    return c.json({ character, ...loraSurface(character) }, 201);
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
  for (const imageId of [info.avatar_crop_image_id, info.image_id]) {
    if (!imageId) continue;
    const filepath = await images.getImageFilePath(userId, imageId, tier);
    if (filepath) {
      return createAvatarResolverResponse(
        filepath,
        imageId + (tier ? `_${tier}` : ""),
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

app.get("/:id/image-gen-lora", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  if (!svc.getCharacter(userId, characterId)) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json({ binding: characterLoraSvc.getCharacterLora(userId, characterId) });
});

app.put("/:id/image-gen-lora", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "Body must be a JSON object" }, 400);
  }
  if (typeof body.lora_name !== "string" || !body.lora_name.trim()) {
    return c.json({ error: "lora_name is required" }, 400);
  }
  try {
    const binding = characterLoraSvc.setCharacterLora(userId, characterId, {
      lora_name: body.lora_name,
      weight_model: body.weight_model,
      weight_clip: body.weight_clip,
      base_tags: typeof body.base_tags === "string" ? body.base_tags : undefined,
      source_url: typeof body.source_url === "string" ? body.source_url : undefined,
    });
    return c.json({ binding });
  } catch (err: any) {
    if (err?.message === "Character not found") return c.json({ error: err.message }, 404);
    return c.json({ error: err?.message || "Invalid binding" }, 400);
  }
});

app.delete("/:id/image-gen-lora", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  if (!svc.getCharacter(userId, characterId)) {
    return c.json({ error: "Not found" }, 404);
  }
  characterLoraSvc.deleteCharacterLora(userId, characterId);
  return c.json({ success: true });
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
  const originalFile = formData.get("original_avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  const updated = await svc.replaceCharacterAvatar(userId, char.id, file, originalFile ?? undefined);
  if (!updated) return c.json({ error: "Not found" }, 404);
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
      lumiverse_lora?: characterLoraSvc.PortableLoraReference;
      error?: string;
      skipped?: boolean;
    }> = [];

    for (const file of files) {
      const filename = file.name || "unknown";
      try {
        let cardInput;
        let pngAvatar: File | null = null;
        let charxResult: cardSvc.CharxResult | null = null;

        const detectedFormat = await cardSvc.detectCharacterImportFormat(file);

        if (detectedFormat === "png") {
          cardInput = await cardSvc.extractCardFromPng(file);
          pngAvatar = file;
        } else if (detectedFormat === "charx" || detectedFormat === "jpeg_polyglot") {
          charxResult = await cardSvc.extractCardFromCharx(file);
          cardInput = charxResult.card;
        } else if (detectedFormat === "jpeg") {
          // Plain JPEG with no embedded data — skip
          results.push({ filename, success: false, error: "JPEG file does not contain embedded character card data" });
          continue;
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

        if (charxResult) {
          // Full CHARX processing (lumiverse_modules, gallery, inline assets,
          // RisuAI module/expressions) shared with single & URL import so the
          // bulk path keeps parity with the exporter.
          await applyCharxModulesAndAssets(userId, character, charxResult);
        } else {
          if (pngAvatar) {
            const image = await images.uploadImage(userId, pngAvatar);
            svc.setCharacterImage(userId, character.id, image.id);
            svc.setCharacterAvatar(userId, character.id, image.filename);
          }
          importCardRegexBestEffort(userId, character.id, cardInput.extensions);
          autoImportEmbeddedWorldbook(userId, character.id);
        }

        const imported = svc.getCharacter(userId, character.id)!;

        // Check for embedded lorebook
        let lorebook: { name: string; entryCount: number } | undefined;
        const charBook = imported.extensions?.character_book;
        const entryCount = wbSvc.countImportedWorldBookEntries(charBook?.entries);
        if (entryCount > 0) {
          lorebook = {
            name: charBook.name || `${imported.name}'s Lorebook`,
            entryCount,
          };
        }

        results.push({ filename, success: true, character: imported, lorebook, ...loraSurface(imported) });
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
    return respondImportError(c, err, "Bulk import failed");
  }
});

app.post("/import-tag-library", async (c) => {
  const userId = c.get("userId");
  const formData = await c.req.formData();
  const file = formData.get("file");

  if (!(file instanceof File) || file.size === 0) {
    return c.json({ error: "TagLibrary backup file is required" }, 400);
  }

  try {
    const result = await tagLibrarySvc.importTagLibraryBackup(userId, file);
    return c.json(result);
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to import TagLibrary backup" }, 400);
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

      const detectedFormat = await cardSvc.detectCharacterImportFormat(file);

      if (detectedFormat === "png") {
        // PNG card — extract embedded JSON + use as avatar
        const cardInput = await cardSvc.extractCardFromPng(file);
        const character = svc.createCharacter(userId, cardInput);
        const image = await images.uploadImage(userId, file);
        svc.setCharacterImage(userId, character.id, image.id);
        svc.setCharacterAvatar(userId, character.id, image.filename);
        importCardRegexBestEffort(userId, character.id, cardInput.extensions);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({ character: imported, ...loraSurface(imported) }, 201);
      } else if (detectedFormat === "charx" || detectedFormat === "jpeg_polyglot") {
        // CHARX archive (or JPEG+ZIP polyglot) — ZIP with card.json + optional
        // avatar + gallery images + lumiverse_modules. The full processing is
        // shared with bulk & URL import so all paths stay in parity (see
        // applyCharxModulesAndAssets).
        const charxResult = await cardSvc.extractCardFromCharx(file);
        const character = svc.createCharacter(userId, charxResult.card);
        const { lumiverseModulesSummary } = await applyCharxModulesAndAssets(userId, character, charxResult, {
          signal: c.req.raw.signal,
          emitGalleryProgress: true,
        });
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({
          character: imported,
          ...(lumiverseModulesSummary ? { lumiverse_modules: lumiverseModulesSummary } : {}),
          ...loraSurface(imported),
        }, 201);
      } else if (detectedFormat === "jpeg") {
        return c.json({ error: "JPEG file does not contain embedded character card data" }, 400);
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
        importCardRegexBestEffort(userId, character.id, cardInput.extensions);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({ character: imported, ...loraSurface(imported) }, 201);
      }
    } else {
      // Raw JSON body — support both card-spec wrapper and flat input
      const body = await c.req.json();
      const input = (body.spec && body.data) ? cardSvc.parseCardJson(body) : body;
      if (!input.name) return c.json({ error: "name is required" }, 400);
      const character = svc.createCharacter(userId, input);
      importCardRegexBestEffort(userId, character.id, input.extensions);
      autoImportEmbeddedWorldbook(userId, character.id);
      const imported = svc.getCharacter(userId, character.id)!;
      return c.json({ character: imported, ...loraSurface(imported) }, 201);
    }
  } catch (err: any) {
    return respondImportError(c, err, "Failed to import character card");
  }
});

export { app as charactersRoutes };
