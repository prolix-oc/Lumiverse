import { Hono } from "hono";
import { isDatabaseUnavailable } from "../db/execution";
import * as svc from "../services/characters.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import * as cardSvc from "../services/character-card.service";
import * as characterLoraSvc from "../services/character-lora.service";
import * as exportSvc from "../services/character-export.service";
import * as tagLibrarySvc from "../services/tag-library-import.service";
import * as wbSvc from "../services/world-books.service";
import * as regexSvc from "../services/regex-scripts.service";
import * as gallerySvc from "../services/character-gallery.service";
import {
  extractChubExpressionAssets,
  fetchChubGalleryUrls,
  fetchChubJson,
  readChubFullPath,
  type ChubExpressionAsset,
} from "../services/chub-api.service";
import * as exprSvc from "../services/expressions.service";
import { markChubExpressionsChecked, queueChubExpressionImport } from "../services/chub-expression-import.service";
import * as settingsSvc from "../services/settings.service";
import { fetchBotBooruGalleryUrls } from "../services/botbooru-api.service";
import { parsePagination } from "../services/pagination";
import { safeFetch, SSRFError, validateHost } from "../utils/safe-fetch";
import { parseBotBooruId, rewriteBotBooruUrl } from "../utils/botbooru";
import { createAvatarResolverResponse } from "../utils/avatar-cache";
import { buildSlug } from "../lumihub/manifest";
import { applyCharxModulesAndAssets, autoImportEmbeddedWorldbook } from "../services/charx-import.service";
import { importCharacterFile } from "../services/character-import.service";
import {
  characterImportJobs,
  CharacterImportJobError,
} from "../services/character-import-jobs.service";
import { mapWithConcurrency } from "../utils/concurrency";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Character, CharacterLibraryScope, CreateCharacterInput, UpdateCharacterInput } from "../types/character";

const app = new Hono();
const PERSPECTIVE_LAYERS = new Set<svc.PerspectiveLayerKind>(["background", "framing", "subject"]);
function parseLibraryScope(raw: unknown): CharacterLibraryScope | null {
  try { return svc.normalizeCharacterLibraryScope(raw); } catch { return null; }
}
function isInvalidLibraryScopeError(err: unknown): boolean {
  return err instanceof svc.InvalidCharacterLibraryScopeError || (typeof err === "object" && err !== null && (err as any).code === "INVALID_CHARACTER_LIBRARY_SCOPE");
}
function respondInvalidLibraryScope(c: any) { return c.json({ error: "invalid_scope" }, 400); }

// ─── Import error response helper ────────────────────────────────────────

function respondImportError(c: any, err: any, fallbackMessage: string) {
  // Log every import failure server-side so silent 4xx responses are traceable.
  // Generic 400s from the old code swallowed this — which is how a 500 MB
  // decompression-cap hit looked like "no backend error" to operators.
  console.error("[character import] failed:", err);
  if (isInvalidLibraryScopeError(err)) return respondInvalidLibraryScope(c);
  if (err instanceof cardSvc.CharacterImportError) {
    return c.json({ error: err.message, code: err.code }, err.status);
  }
  return c.json({ error: err?.message || fallbackMessage }, 400);
}

function respondImportJobError(c: any, err: unknown) {
  if (err instanceof CharacterImportJobError) {
    return c.json({ error: err.message, code: err.code }, err.status as any);
  }
  console.error("[character import job] failed:", err);
  return c.json({ error: err instanceof Error ? err.message : "Character import job failed" }, 500);
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

// These values refer to locally-owned entities rather than portable card data.
// Replacing a JSON/PNG card must not detach or delete the user's avatar,
// expression assets, world book links, or selected TTS voice.
const LOCAL_CHARACTER_EXTENSION_KEYS = new Set([
  "expressions",
  "expression_groups",
  "alternate_fields",
  "alternate_avatars",
  "world_book_id",
  "world_book_ids",
  "avatar_crop_image_id",
  "original_image_id",
  "risu_asset_map",
  "gallery_reference_sequence",
  "gallery_reference_names",
  "landing_perspective_layers",
  "ttsVoice",
]);

function buildCardReplacementInput(existing: Character, card: CreateCharacterInput): UpdateCharacterInput {
  const preservedExtensions = Object.fromEntries(
    Object.entries(existing.extensions ?? {}).filter(([key]) =>
      LOCAL_CHARACTER_EXTENSION_KEYS.has(key) || key.startsWith("_lumiverse_")
    )
  );

  return {
    // Deliberately omit `name`: this endpoint only replaces card contents.
    description: card.description ?? "",
    personality: card.personality ?? "",
    scenario: card.scenario ?? "",
    first_mes: card.first_mes ?? "",
    mes_example: card.mes_example ?? "",
    creator: card.creator ?? "",
    creator_notes: card.creator_notes ?? "",
    system_prompt: card.system_prompt ?? "",
    post_history_instructions: card.post_history_instructions ?? "",
    tags: card.tags ?? [],
    alternate_greetings: card.alternate_greetings ?? [],
    extensions: {
      ...(card.extensions ?? {}),
      ...preservedExtensions,
    },
  };
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
  try {
    const parsed = new URL(url);
    if (!CHUB_DOMAINS.includes(parsed.hostname.toLowerCase())) return null;
    const segments = parsed.pathname.split("/").filter(Boolean);
    const start = segments[0]?.toLowerCase() === "characters" ? 1 : 0;
    if (segments.length - start >= 2) {
      return segments.slice(start, start + 2).map(decodeURIComponent).join("/");
    }
    return null;
  } catch {
    // Fall through to legacy loose parsing below for pasted strings that URL()
    // will not accept but still contain a recognizable Chub path.
  }

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
  const pathParts = rest.slice(start).map((part) => part.split(/[?#]/, 1)[0]).filter(Boolean);
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

async function fetchChubLorebookDefinition(idOrPath: string | number): Promise<Record<string, any> | null> {
  try {
    const raw = String(idOrPath).replace(/^lorebooks\//, "");
    const data = await fetchChubJson(`lorebooks/${raw}?full=true`);
    return data?.node?.definition ?? null;
  } catch {
    return null;
  }
}

async function buildChubCharacterBook(def: Record<string, any>, data: Record<string, any>): Promise<Record<string, any> | undefined> {
  const embeddedBook = def.embedded_lorebook ?? def.character_book;
  const embeddedEntries = Array.isArray(embeddedBook?.entries) ? embeddedBook.entries : [];
  const relatedLorebooks = Array.isArray(data.node?.related_lorebooks) ? data.node.related_lorebooks : [];

  if (relatedLorebooks.length === 0) return embeddedBook || undefined;

  const linkedBooks = await Promise.all(
    relatedLorebooks.map(async (id: number) => {
      const relatedNode = data.nodes?.[String(id)];
      const definition = await fetchChubLorebookDefinition(relatedNode?.fullPath || id);
      const entries = definition?.embedded_lorebook?.entries ?? definition?.character_book?.entries;
      if (!Array.isArray(entries) || entries.length === 0) return null;
      return {
        id,
        name: relatedNode?.name || definition?.name || "Linked Lorebook",
        entries,
      };
    })
  );

  const linkedEntries = linkedBooks.flatMap((book) => book?.entries ?? []);
  const entries = [...embeddedEntries, ...linkedEntries];
  if (entries.length === 0) return embeddedBook || undefined;

  return {
    ...(embeddedBook && typeof embeddedBook === "object" ? embeddedBook : {}),
    name: linkedEntries.length > 0 ? `${def.name || data.node?.name || "Character"} Lorebooks` : embeddedBook?.name,
    entries,
  };
}

async function importGalleryFromUrls(userId: string, characterId: string, urls: string[]): Promise<void> {
  const downloaded = await mapWithConcurrency(urls, 6, async (url): Promise<File | null> => {
    try {
      const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 50 * 1024 * 1024 });
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      const contentType = res.headers.get("content-type") || "image/webp";
      const ext = contentType.includes("png") ? "png" : contentType.includes("jpeg") || contentType.includes("jpg") ? "jpg" : "webp";
      return new File([buf], `remote_gallery_${crypto.randomUUID()}.${ext}`, { type: contentType });
    } catch {
      return null;
    }
  });

  const files = downloaded.filter((file): file is File => file !== null);
  if (files.length === 0) return;
  if (files.length > 3) {
    await gallerySvc.uploadBulkToGallery(userId, characterId, files);
    return;
  }
  for (const file of files) {
    try { await gallerySvc.uploadToGallery(userId, characterId, file); } catch { /* skip */ }
  }
}

/**
 * Opt out of pulling expression packs during a Chub import.
 *
 * Defaults to on: a pack is part of what the card advertises, and gallery
 * images already import unconditionally, so this matches existing behaviour
 * rather than introducing a new prompt. The key is read here so the preference
 * is honoured the moment a UI toggle exists.
 */
const CHUB_IMPORT_EXPRESSIONS_KEY = "importChubExpressions";

function chubExpressionImportEnabled(userId: string): boolean {
  try {
    const setting = settingsSvc.getSetting(userId, CHUB_IMPORT_EXPRESSIONS_KEY);
    return setting?.value === false ? false : true;
  } catch {
    return true;
  }
}

/**
 * Download a Chub expression pack and register it as the character's
 * expressions, keyed by the pack's own labels.
 *
 * Mirrors importGalleryFromUrls, but the label is the whole point: these
 * images previously had no route into the expressions surface at all, and any
 * that reached the gallery arrived as unidentifiable files.
 */
async function importChubExpressions(
  userId: string,
  characterId: string,
  assets: ChubExpressionAsset[],
): Promise<void> {
  await queueChubExpressionImport(userId, characterId, assets);
}

async function fetchChubCharacter(chubPath: string, userId: string, libraryScope: CharacterLibraryScope) {
  const data = await fetchChubJson(`characters/${chubPath}?full=true`);
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
      description: def.personality ?? def.description ?? "",
      personality: def.tavern_personality ?? def.personality ?? "",
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

  const characterBook = await buildChubCharacterBook(def, data);
  if (characterBook) {
    card.data.character_book = characterBook;
  }

  const cardInput = cardSvc.parseCardJson(card);
  const character = svc.createCharacter(userId, { ...cardInput, library_scope: libraryScope });
  importCardRegexBestEffort(userId, character.id, cardInput.extensions);

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
    const freshChar = await svc.getCharacterAsync(userId, character.id);
    if (freshChar) {
      const slug = buildSlug(freshChar.creator, freshChar.name);
      await svc.updateCharacterAsync(userId, character.id, {
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

  const galleryUrls = await fetchChubGalleryUrls(node.id);
  if (galleryUrls.length > 0) {
    await importGalleryFromUrls(userId, character.id, galleryUrls);
  }

  // Best-effort, like the gallery above: a card that imported successfully
  // must not be rolled back because its expression images were unreachable.
  if (chubExpressionImportEnabled(userId)) {
    const expressionAssets = extractChubExpressionAssets(node);
    if (expressionAssets.length > 0) {
      try {
        await importChubExpressions(userId, character.id, expressionAssets);
      } catch (err) {
        console.warn("[character import] Chub expression import failed:", err);
      }
    }
  }

  return (await svc.getCharacterAsync(userId, character.id))!;
}

// ─── JannyAI character fetcher ────────────────────────────────────────────

async function fetchJannyCharacter(uuid: string, userId: string, libraryScope: CharacterLibraryScope) {
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
  const character = svc.createCharacter(userId, { ...cardInput, library_scope: libraryScope });

  // Use the PNG as avatar
  const image = await images.uploadImage(userId, file);
  svc.setCharacterImage(userId, character.id, image.id);
  svc.setCharacterAvatar(userId, character.id, image.filename);

  autoImportEmbeddedWorldbook(userId, character.id);
  return (await svc.getCharacterAsync(userId, character.id))!;
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

async function fetchGenericCharacter(url: string, userId: string, libraryScope: CharacterLibraryScope) {
  const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 100 * 1024 * 1024 });
  if (!res.ok) throw new Error(`Failed to fetch URL: ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  const buf = await res.arrayBuffer();
  const sniffed = sniffCardContainer(buf);

  if (sniffed === "png" || contentType.includes("image/png") || url.toLowerCase().endsWith(".png")) {
    const file = new File([buf], "import.png", { type: "image/png" });
    const cardInput = await cardSvc.extractCardFromPng(file);
    const character = svc.createCharacter(userId, { ...cardInput, library_scope: libraryScope });

    const image = await images.uploadImage(userId, file);
    svc.setCharacterImage(userId, character.id, image.id);
    svc.setCharacterAvatar(userId, character.id, image.filename);

    autoImportEmbeddedWorldbook(userId, character.id);
    return (await svc.getCharacterAsync(userId, character.id))!;
  }

  if (sniffed === "zip" || contentType.includes("application/zip") || url.toLowerCase().endsWith(".charx")) {
    const file = new File([buf], "import.charx", { type: "application/zip" });
    const charxResult = await cardSvc.extractCardFromCharx(file);
    const character = svc.createCharacter(userId, { ...charxResult.card, library_scope: libraryScope });
    await applyCharxModulesAndAssets(userId, character, charxResult);
    return (await svc.getCharacterAsync(userId, character.id))!;
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
  const character = svc.createCharacter(userId, { ...cardInput, library_scope: libraryScope });
  autoImportEmbeddedWorldbook(userId, character.id);
  return (await svc.getCharacterAsync(userId, character.id))!;
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
app.get("/index", (c) => c.json(svc.listCharacterIndex(c.get('userId'), parsePagination(c.req.query('limit'), c.req.query('offset')))));

app.get("/details", async (c) => {
  const ids = [...new Set((c.req.query('ids') ?? '').split(',').filter(Boolean))];
  if (ids.length === 0 || ids.length > 100 || ids.some(id => id.length > 128)) {
    return c.json({ error: 'Supply between 1 and 100 character ids' }, 400);
  }
  const characters = await svc.getCharactersByIdsAsync(c.get('userId'), ids, { excludeDeleting: true });
  return c.json(ids.flatMap(id => characters.has(id) ? [characters.get(id)!] : []));
});

app.get("/summary", (c) => {
  const userId = c.get("userId");
  const rawScope = c.req.query("scope");
  const scope = rawScope === undefined ? undefined : parseLibraryScope(rawScope);
  if (rawScope !== undefined && !scope) return c.json({ error: "scope must be either 'mine' or 'shared'" }, 400);
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
  const chatId = c.req.query("chat_id") || undefined;

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
      chatId,
      ...(scope ? { scope } : {}),
    })
  );
});

// ─── Tags endpoint for character browser ──────────────────────────────────
app.get("/tags", (c) => {
  const userId = c.get("userId");
  return c.json(svc.listCharacterTags(userId));
});

// ─── Bulk tag update (batch-select bar) ───────────────────────────────────
app.post("/bulk-tags", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!Array.isArray(body?.ids) || body.ids.length === 0 || body.ids.length > 1000) {
    return c.json({ error: "ids must be a non-empty array with at most 1000 items" }, 400);
  }
  try {
    const result = await svc.bulkUpdateCharacterTagsAsync(userId, {
      ids: Array.isArray(body?.ids) ? body.ids : [],
      operation: body?.operation,
      tags: Array.isArray(body?.tags) ? body.tags : [],
    });
    return c.json(result);
  } catch (err) {
    if (isDatabaseUnavailable(err)) throw err;
    const message = err instanceof Error ? err.message : "Failed to update tags";
    return c.json({ error: message }, 400);
  }
});

app.post("/folders/rename", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ old_name?: string; new_name?: string }>();
  const oldName = body.old_name?.trim() || "";
  const newName = body.new_name?.trim() || "";
  if (!oldName) return c.json({ error: "old_name is required" }, 400);
  if (!newName) return c.json({ error: "new_name is required" }, 400);

  const updated = await svc.renameCharacterFolderAsync(userId, oldName, newName);
  if (updated.length === 0) return c.json({ error: "Folder not found" }, 404);
  return c.json({ updated, count: updated.length });
});

app.post("/folders/delete", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ name?: string }>();
  const name = body.name?.trim() || "";
  if (!name) return c.json({ error: "name is required" }, 400);

  const updated = await svc.deleteCharacterFolderAsync(userId, name);
  return c.json({ updated, count: updated.length });
});

app.post("/bulk-update", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json<{ ids?: unknown; folder?: unknown }>();
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 1000) {
    return c.json({ error: "ids must be a non-empty array with at most 1000 items" }, 400);
  }
  const ids = body.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return c.json({ error: "ids must contain character ids" }, 400);
  if (typeof body.folder !== "string") return c.json({ error: "folder must be a string" }, 400);

  const updated = await svc.bulkUpdateCharacterFoldersAsync(userId, ids, body.folder);
  return c.json({ updated, count: updated.length });
});

app.post("/batch-delete", async (c) => {
  const userId = c.get("userId");
  const body: { ids?: unknown } = await c.req.json<{ ids?: unknown }>().catch(() => ({}));
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 1000) {
    return c.json({ error: "ids must be a non-empty array with at most 1000 items" }, 400);
  }
  const ids = body.ids.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return c.json({ error: "ids must contain character ids" }, 400);
  return c.json(await svc.batchDeleteCharacters(userId, ids));
});

app.post("/", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  try { return c.json(svc.createCharacter(userId, body), 201); } catch (err) { if (isInvalidLibraryScopeError(err)) return respondInvalidLibraryScope(c); throw err; }
});

// --- Static routes MUST come before /:id to avoid shadowing ---

app.post("/import-url", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  const libraryScope = body?.library_scope === undefined ? undefined : parseLibraryScope(body.library_scope);
  if (body?.library_scope !== undefined && !libraryScope) return c.json({ error: "library_scope must be either 'mine' or 'shared'" }, 400);
  const url = body.url;
  if (!url || typeof url !== "string") return c.json({ error: "url is required" }, 400);

  try {
    let character;

    // Check for Chub.ai URL
    const chubPath = parseChubUrl(url);
    if (chubPath) {
      character = await fetchChubCharacter(chubPath, userId, libraryScope || "mine");
      return c.json({ character, ...loraSurface(character) }, 201);
    }

    // Check for JannyAI URL
    const jannyId = parseJannyUrl(url);
    if (jannyId) {
      character = await fetchJannyCharacter(jannyId, userId, libraryScope || "mine");
      return c.json({ character, ...loraSurface(character) }, 201);
    }

    // Check for BotBooru URL → rewrite to the PNG download, which embeds a
    // SillyTavern-compatible card *and* an avatar, then reuse the generic importer.
    const botBooruId = parseBotBooruId(url);
    const botBooruPngUrl = rewriteBotBooruUrl(url, "png");
    if (botBooruId && botBooruPngUrl) {
      character = await fetchGenericCharacter(botBooruPngUrl, userId, libraryScope || "mine");
      try {
        const galleryUrls = await fetchBotBooruGalleryUrls(botBooruId);
        if (galleryUrls.length > 0) {
          await importGalleryFromUrls(userId, character.id, galleryUrls);
        }
      } catch (err) {
        console.warn("[character import] BotBooru gallery import failed:", err);
      }
      return c.json({ character, ...loraSurface(character) }, 201);
    }

    // Generic URL (direct PNG or JSON link)
    character = await fetchGenericCharacter(url, userId, libraryScope || "mine");
    return c.json({ character, ...loraSurface(character) }, 201);
  } catch (err: any) {
    if (isInvalidLibraryScopeError(err)) return respondInvalidLibraryScope(c);
    if (err instanceof SSRFError) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err.message || "Failed to import from URL" }, 400);
  }
});

// Replace only the portable card data on an existing character. This is kept
// separate from /import so a JSON/PNG upload cannot accidentally create a new
// character or replace its name/avatar.
app.post("/:id/replace-card", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  const existing = await svc.getCharacterAsync(userId, characterId);
  if (!existing) return c.json({ error: "Not found" }, 404);

  try {
    const formData = await c.req.formData();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return c.json({ error: "Character card file is required" }, 400);
    }

    const format = await cardSvc.detectCharacterImportFormat(file);
    let cardInput: CreateCharacterInput;
    if (format === "png") {
      cardInput = await cardSvc.extractCardFromPng(file);
    } else if (format === "json") {
      let json: unknown;
      try {
        json = JSON.parse(await file.text());
      } catch {
        return c.json({ error: "Invalid JSON in uploaded file" }, 400);
      }
      cardInput = cardSvc.parseCardJson(json);
    } else {
      return c.json({ error: "Only JSON and PNG character cards can replace card data" }, 400);
    }

    const updated = await svc.updateCharacterAsync(userId, characterId, buildCardReplacementInput(existing, cardInput));
    // The character was checked above, but preserve the normal 404 contract
    // should it be deleted between parsing and the update.
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  } catch (err: any) {
    return respondImportError(c, err, "Failed to replace character card data");
  }
});

// ─── Chub expression backfill ─────────────────────────────────────────────
// Registered above `/:id`: Hono matches in order, and `/:id` would otherwise
// capture "chub-expression-candidates" as a character id.

/** Labels already mapped for this character, so a backfill can skip them. */
function existingExpressionLabels(userId: string, characterId: string): Set<string> {
  const config = exprSvc.getExpressionConfig(userId, characterId);
  return new Set(Object.keys(config?.mappings ?? {}));
}

async function chubExpressionAssetsFor(slug: string): Promise<ChubExpressionAsset[]> {
  const data = await fetchChubJson(`characters/${slug}?full=true`);
  const node = data?.node;
  if (!node) throw new Error("Invalid Chub API response: missing node");
  return extractChubExpressionAssets(node);
}

/**
 * Which cards could gain expressions, without downloading anything.
 *
 * Only reports cards that trace back to Chub and have no expressions yet, so
 * the count is what a backfill would actually change rather than how many
 * Chub cards exist.
 */
app.get("/chub-expression-candidates", (c) => {
  const userId = c.get("userId");
  const candidates = svc
    .listCharacterExtensions(userId)
    .filter((row) => readChubFullPath(row.extensions) !== null)
    .filter((row) => !row.extensions?._lumiverse_chub_expressions_checked)
    .filter((row) => existingExpressionLabels(userId, row.id).size === 0)
    .map((row) => ({ id: row.id, name: row.name }));
  return c.json({ candidates, count: candidates.length });
});

/**
 * Pull this character's expression pack from the source it was imported from.
 *
 * Expressions only: the card's own fields are never re-read, so local edits
 * survive a backfill. Labels already mapped are skipped rather than replaced,
 * so hand-assigned expressions are never clobbered.
 */
app.post("/:id/chub-expressions", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  const character = await svc.getCharacterAsync(userId, characterId);
  if (!character) return c.json({ error: "Not found" }, 404);

  const slug = readChubFullPath(character.extensions);
  if (!slug) return c.json({ error: "This character was not imported from Chub" }, 400);

  try {
    let available: ChubExpressionAsset[];
    try {
      available = await chubExpressionAssetsFor(slug);
    } catch (err: any) {
      // A card whose source has been removed or renamed is a normal outcome,
      // not a failure to report as an error. Treat it as "nothing to fetch" so
      // the caller can say so plainly, and stamp it so it stops being offered.
      if (typeof err?.message === "string" && err.message.includes("404")) {
        markChubExpressionsChecked(userId, characterId);
        return c.json({ imported: 0, skipped: 0, available: 0, sourceMissing: true });
      }
      throw err;
    }

    if (available.length === 0) {
      markChubExpressionsChecked(userId, characterId);
      return c.json({ imported: 0, skipped: 0, available: 0 });
    }

    const existing = existingExpressionLabels(userId, characterId);
    const missing = available.filter((asset) => !existing.has(asset.label));
    if (missing.length === 0) {
      markChubExpressionsChecked(userId, characterId);
      return c.json({ imported: 0, skipped: available.length, available: available.length });
    }

    await importChubExpressions(userId, characterId, missing);
    const after = existingExpressionLabels(userId, characterId);
    const imported = missing.filter((asset) => after.has(asset.label)).length;
    markChubExpressionsChecked(userId, characterId);
    return c.json({
      imported,
      skipped: available.length - missing.length,
      available: available.length,
    });
  } catch (err: any) {
    if (err instanceof SSRFError) return c.json({ error: err.message }, 400);
    return c.json({ error: err.message || "Failed to fetch expressions from Chub" }, 502);
  }
});

app.get("/:id", async (c) => {
  const userId = c.get("userId");
  const char = await svc.getCharacterAsync(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);
  return c.json(char);
});

app.get("/:id/homepage-preview", (c) => {
  const preview = svc.getCharacterPreview(c.get("userId"), c.req.param("id"));
  if (!preview) return c.json({ error: "Not found" }, 404);
  return c.json(preview);
});

app.put("/:id", async (c) => {
  const userId = c.get("userId");
  const body = await c.req.json();
  try {
    const char = await svc.updateCharacterAsync(userId, c.req.param("id"), body);
    if (!char) return c.json({ error: "Not found" }, 404);
    return c.json(char);
  } catch (err) { if (isInvalidLibraryScopeError(err)) return respondInvalidLibraryScope(c); throw err; }
});

app.get("/deletions/:operationId", async (c) => {
  c.header("Cache-Control", "no-store");
  const operation = await svc.getDeletionOperationAsync(c.get("userId"), c.req.param("operationId"));
  if (!operation) return c.json({ error: "Not found" }, 404);
  return c.json(operation);
});

app.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const operationId = c.req.query("operation_id") ?? crypto.randomUUID();
  if (!/^[\w-]{1,128}$/.test(operationId)) return c.json({ error: "Invalid operation ID" }, 400);
  try {
    const operation = await svc.requestCharacterDeletionAsync(userId, c.req.param("id"), operationId);
    if (!operation) return c.json({ error: "Not found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ success: true, ...operation }, operation.status === "accepted" ? 202 : 200);
  } catch (error: any) {
    if (error?.code === "DELETION_ID_CONFLICT") return c.json({ error: "Operation ID is already in use" }, 409);
    throw error;
  }
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

app.get("/:id/image-gen-lora", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  if (!(await svc.getCharacterAsync(userId, characterId))) {
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

app.delete("/:id/image-gen-lora", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  if (!(await svc.getCharacterAsync(userId, characterId))) {
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
    const character = await svc.getCharacterAsync(userId, id);
    const name = exportSvc.sanitizeFilename(character?.name || "character");
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/png",
        "Content-Disposition": `attachment; filename="${name}.png"`,
      },
    });
  }

  if (format === "charx") {
    const requestedExportId = c.req.query("export_id");
    const exportId = requestedExportId && requestedExportId.length <= 128 ? requestedExportId : undefined;
    const emitProgress = (payload: Record<string, unknown>) => {
      try {
        eventBus.emit(EventType.CHARACTER_EXPORT_PROGRESS, { characterId: id, exportId, ...payload }, userId);
      } catch {
        // A download must not fail because the caller has no live WebSocket.
      }
    };

    emitProgress({ phase: "preparing" });
    try {
      const buf = await exportSvc.exportAsCharx(userId, id, {
        onProgress(progress) {
          // A card can contain hundreds of gallery images. Send enough updates
          // to feel live without flooding every connected client.
          if (
            progress.phase === "collecting_assets" &&
            progress.completed !== 0 &&
            progress.completed !== progress.total &&
            progress.completed % 4 !== 0
          ) {
            return;
          }
          emitProgress(progress);
        },
      });
      if (!buf) {
        emitProgress({ phase: "failed", error: "Character not found" });
        return c.json({ error: "Not found" }, 404);
      }
      const character = await svc.getCharacterAsync(userId, id);
      const name = exportSvc.sanitizeFilename(character?.name || "character");
      return new Response(new Uint8Array(buf), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${name}.charx"`,
          "Content-Length": String(buf.byteLength),
          "Cache-Control": "no-store",
        },
      });
    } catch (err: any) {
      emitProgress({ phase: "failed", error: err?.message || "Failed to export CHARX" });
      throw err;
    }
  }

  return c.json({ error: "Invalid format. Must be one of: json, png, charx" }, 400);
});

app.post("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const char = await svc.getCharacterAsync(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;
  const originalFile = formData.get("original_avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  const updated = await svc.replaceCharacterAvatar(userId, char.id, file, originalFile ?? undefined);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

app.post("/:id/perspective-layers", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  if (!(await svc.getCharacterAsync(userId, characterId))) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);
  if (typeof file.type === "string" && file.type && !file.type.startsWith("image/")) {
    return c.json({ error: "image file is required" }, 400);
  }

  const label = formData.get("label");
  const intensityRaw = formData.get("intensity");
  const intensity = typeof intensityRaw === "string" ? Number(intensityRaw) : undefined;

  try {
    const updated = await svc.addCharacterPerspectiveLayer(userId, characterId, file, {
      label: typeof label === "string" ? label : undefined,
      intensity,
    });
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated, 201);
  } catch (err: any) {
    return c.json({ error: err?.message || "Invalid image" }, 400);
  }
});

app.put("/:id/perspective-layers", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || !Array.isArray((body as any).layers)) {
    return c.json({ error: "layers array is required" }, 400);
  }

  const updated = svc.updateCharacterPerspectiveLayers(userId, characterId, (body as any).layers);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

app.post("/:id/perspective-layers/:layer", async (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  const layer = c.req.param("layer") as svc.PerspectiveLayerKind;
  if (!PERSPECTIVE_LAYERS.has(layer)) return c.json({ error: "Invalid layer" }, 400);
  if (!(await svc.getCharacterAsync(userId, characterId))) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return c.json({ error: "image file is required" }, 400);
  if (typeof file.type === "string" && file.type && !file.type.startsWith("image/")) {
    return c.json({ error: "image file is required" }, 400);
  }

  try {
    const updated = await svc.setCharacterPerspectiveLayer(userId, characterId, layer, file);
    if (!updated) return c.json({ error: "Not found" }, 404);
    return c.json(updated);
  } catch (err: any) {
    return c.json({ error: err?.message || "Invalid image" }, 400);
  }
});

app.delete("/:id/perspective-layers/:layer", (c) => {
  const userId = c.get("userId");
  const characterId = c.req.param("id");
  const layer = c.req.param("layer");

  const updated = PERSPECTIVE_LAYERS.has(layer as svc.PerspectiveLayerKind)
    ? svc.clearCharacterPerspectiveLayer(userId, characterId, layer as svc.PerspectiveLayerKind)
    : svc.deleteCharacterPerspectiveLayer(userId, characterId, layer);
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

app.post("/import-jobs", async (c) => {
  const userId = c.get("userId");
  try {
    const body = await c.req.json<{ total?: unknown; skip_duplicates?: unknown }>().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON request body", code: "invalid_request" }, 400);
    const total = Number(body?.total);
    return c.json(characterImportJobs.create(userId, total, body?.skip_duplicates === true), 201);
  } catch (err) {
    return respondImportJobError(c, err);
  }
});

app.put("/import-jobs/:jobId/files/:index", async (c) => {
  const userId = c.get("userId");
  const requestBody = c.req.raw.body;
  if (!requestBody) return c.json({ error: "Request body is empty", code: "empty_file" }, 400);

  const contentType = c.req.header("content-type") || "application/octet-stream";
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    return c.json({
      error: "Multipart uploads are not supported for character import jobs; send the file as the raw request body",
      code: "multipart_not_supported",
    }, 415);
  }

  const contentLengthHeader = c.req.header("content-length");
  const declaredSize = contentLengthHeader == null ? null : Number(contentLengthHeader);
  const filename = c.req.query("filename") || "character-card";
  try {
    const snapshot = await characterImportJobs.upload(
      userId,
      c.req.param("jobId"),
      Number(c.req.param("index")),
      filename,
      contentType,
      requestBody,
      declaredSize,
    );
    return c.json(snapshot, 201);
  } catch (err) {
    return respondImportJobError(c, err);
  }
});

app.post("/import-jobs/:jobId/start", (c) => {
  try {
    return c.json(characterImportJobs.start(c.get("userId"), c.req.param("jobId")), 202);
  } catch (err) {
    return respondImportJobError(c, err);
  }
});

app.get("/import-jobs/:jobId/status", (c) => {
  const snapshot = characterImportJobs.get(c.get("userId"), c.req.param("jobId"));
  if (!snapshot) return c.json({ error: "Character import job not found", code: "job_not_found" }, 404);
  return c.json(snapshot);
});

app.post("/import-jobs/:jobId/cancel", (c) => {
  try {
    return c.json(characterImportJobs.cancel(c.get("userId"), c.req.param("jobId")));
  } catch (err) {
    return respondImportJobError(c, err);
  }
});

app.post("/import-bulk", async (c) => {
  const userId = c.get("userId");

  try {
    const formData = await c.req.formData();
    const files = formData.getAll("files") as File[];
    if (!files.length) return c.json({ error: "files are required" }, 400);
    if (files.length > 500) return c.json({ error: "Maximum 500 files per bulk import" }, 400);

    const skipDuplicates = formData.get("skip_duplicates") === "true";

    const results: Awaited<ReturnType<typeof importCharacterFile>>[] = [];

    for (const file of files) {
      const filename = file.name || "unknown";
      try {
        results.push(await importCharacterFile(userId, file, { skipDuplicates, emitEvent: false }));
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

    if (imported > 0) {
      eventBus.emit(EventType.CHARACTER_LIBRARY_CHANGED, {
        reason: "legacy_bulk_import",
        imported,
      }, userId);
    }

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
      const rawScope = formData.get("library_scope");
      const libraryScope = rawScope === null ? undefined : parseLibraryScope(rawScope);
      if (rawScope !== null && !libraryScope) return c.json({ error: "library_scope must be either 'mine' or 'shared'" }, 400);

      const detectedFormat = await cardSvc.detectCharacterImportFormat(file);

      if (detectedFormat === "png") {
        // PNG card — extract embedded JSON + use as avatar
        const cardInput = await cardSvc.extractCardFromPng(file);
        const character = svc.createCharacter(userId, { ...cardInput, ...(libraryScope ? { library_scope: libraryScope } : {}) });
        const image = await images.uploadImage(userId, file);
        svc.setCharacterImage(userId, character.id, image.id);
        svc.setCharacterAvatar(userId, character.id, image.filename);
        importCardRegexBestEffort(userId, character.id, cardInput.extensions);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = (await svc.getCharacterAsync(userId, character.id))!;
        return c.json({ character: imported, ...loraSurface(imported) }, 201);
      } else if (detectedFormat === "charx" || detectedFormat === "jpeg_polyglot") {
        // CHARX archive (or JPEG+ZIP polyglot) — ZIP with card.json + optional
        // avatar + gallery images + lumiverse_modules. The full processing is
        // shared with bulk & URL import so all paths stay in parity (see
        // applyCharxModulesAndAssets).
        const charxResult = await cardSvc.extractCardFromCharx(file);
        const character = svc.createCharacter(userId, { ...charxResult.card, ...(libraryScope ? { library_scope: libraryScope } : {}) });
        const { lumiverseModulesSummary } = await applyCharxModulesAndAssets(userId, character, charxResult, {
          signal: c.req.raw.signal,
          emitGalleryProgress: true,
        });
        const imported = (await svc.getCharacterAsync(userId, character.id))!;
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
        const character = svc.createCharacter(userId, { ...cardInput, ...(libraryScope ? { library_scope: libraryScope } : {}) });
        importCardRegexBestEffort(userId, character.id, cardInput.extensions);
        autoImportEmbeddedWorldbook(userId, character.id);
        const imported = (await svc.getCharacterAsync(userId, character.id))!;
        return c.json({ character: imported, ...loraSurface(imported) }, 201);
      }
    } else {
      // Raw JSON body — support both card-spec wrapper and flat input
      const body = await c.req.json();
      const rawScope = body?.library_scope;
      const libraryScope = rawScope === undefined ? undefined : parseLibraryScope(rawScope);
      if (rawScope !== undefined && !libraryScope) return c.json({ error: "library_scope must be either 'mine' or 'shared'" }, 400);
      const input = (body.spec && body.data) ? cardSvc.parseCardJson(body) : body;
      if (!input.name) return c.json({ error: "name is required" }, 400);
      const character = svc.createCharacter(userId, { ...input, ...(libraryScope ? { library_scope: libraryScope } : {}) });
      importCardRegexBestEffort(userId, character.id, input.extensions);
      autoImportEmbeddedWorldbook(userId, character.id);
      const imported = (await svc.getCharacterAsync(userId, character.id))!;
      return c.json({ character: imported, ...loraSurface(imported) }, 201);
    }
  } catch (err: any) {
    return respondImportError(c, err, "Failed to import character card");
  }
});

export { app as charactersRoutes };
