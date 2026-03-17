import { Hono } from "hono";
import * as svc from "../services/characters.service";
import * as files from "../services/files.service";
import * as images from "../services/images.service";
import * as cardSvc from "../services/character-card.service";
import { parsePagination } from "../services/pagination";
import { safeFetch, SSRFError, validateHost } from "../utils/safe-fetch";

const app = new Hono();

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
  const apiUrl = `https://api.chub.ai/api/characters/${chubPath}?full=true`;
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
      const imgRes = await safeFetch(avatarUrl, { timeoutMs: 15_000, maxBytes: 10 * 1024 * 1024 });
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

  // Download the PNG card from the provided URL
  const pngRes = await safeFetch(result.downloadUrl, { timeoutMs: 15_000, maxBytes: 10 * 1024 * 1024 });
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

  return svc.getCharacter(userId, character.id)!;
}

// ─── Generic URL fetcher (PNG or JSON) ────────────────────────────────────

async function fetchGenericCharacter(url: string, userId: string) {
  const res = await safeFetch(url, { timeoutMs: 15_000, maxBytes: 10 * 1024 * 1024 });
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

    return svc.getCharacter(userId, character.id)!;
  }

  // Assume JSON
  const text = new TextDecoder().decode(buf);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("URL did not return valid PNG or JSON character data");
  }

  const cardInput = cardSvc.parseCardJson(json);
  const character = svc.createCharacter(userId, cardInput);
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

app.get("/:id/avatar", (c) => {
  const userId = c.get("userId");
  const info = svc.getCharacterAvatarInfo(userId, c.req.param("id"));
  if (!info) return c.json({ error: "Not found" }, 404);

  // Prefer image_id, fall back to legacy avatar_path
  if (info.image_id) {
    const filepath = images.getImageFilePath(userId, info.image_id);
    if (filepath) {
      const response = new Response(Bun.file(filepath));
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
    }
  }

  if (info.avatar_path) {
    const filepath = files.getAvatarPath(info.avatar_path);
    if (filepath) {
      const response = new Response(Bun.file(filepath));
      response.headers.set("Cache-Control", "public, max-age=31536000, immutable");
      return response;
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

app.post("/:id/avatar", async (c) => {
  const userId = c.get("userId");
  const char = svc.getCharacter(userId, c.req.param("id"));
  if (!char) return c.json({ error: "Not found" }, 404);

  const formData = await c.req.formData();
  const file = formData.get("avatar") as File | null;
  if (!file) return c.json({ error: "avatar file is required" }, 400);

  // Clean up old image if present
  if (char.image_id) images.deleteImage(userId, char.image_id);
  if (char.avatar_path) files.deleteAvatar(char.avatar_path);

  const image = await images.uploadImage(userId, file);
  svc.setCharacterImage(userId, char.id, image.id);
  svc.setCharacterAvatar(userId, char.id, image.filename);
  return c.json({ image_id: image.id, avatar_path: image.filename });
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
      try {
        let cardInput;
        let isPng = false;

        if (file.type === "image/png" || filename.endsWith(".png")) {
          cardInput = await cardSvc.extractCardFromPng(file);
          isPng = true;
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

        if (isPng) {
          const image = await images.uploadImage(userId, file);
          svc.setCharacterImage(userId, character.id, image.id);
          svc.setCharacterAvatar(userId, character.id, image.filename);
        }

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

      if (file.type === "image/png" || file.name?.endsWith(".png")) {
        // PNG card — extract embedded JSON + use as avatar
        const cardInput = await cardSvc.extractCardFromPng(file);
        const character = svc.createCharacter(userId, cardInput);
        const image = await images.uploadImage(userId, file);
        svc.setCharacterImage(userId, character.id, image.id);
        svc.setCharacterAvatar(userId, character.id, image.filename);
        const imported = svc.getCharacter(userId, character.id)!;
        return c.json({ character: imported }, 201);
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
        return c.json({ character }, 201);
      }
    } else {
      // Raw JSON body — support both card-spec wrapper and flat input
      const body = await c.req.json();
      const input = (body.spec && body.data) ? cardSvc.parseCardJson(body) : body;
      if (!input.name) return c.json({ error: "name is required" }, 400);
      const character = svc.createCharacter(userId, input);
      return c.json({ character }, 201);
    }
  } catch (err: any) {
    return c.json({ error: err.message || "Failed to import character card" }, 400);
  }
});

export { app as charactersRoutes };
