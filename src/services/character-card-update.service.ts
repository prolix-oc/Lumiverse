import { applyCharxModulesAndAssets } from "./charx-import.service";
import { readDatabaseRows } from "../db/queries";
import * as svc from "./characters.service";
import * as images from "./images.service";
import * as cardSvc from "./character-card.service";
import * as regexSvc from "./regex-scripts.service";
import * as wbSvc from "./world-books.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../utils/character-world-books";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import type { Character, CreateCharacterInput, UpdateCharacterInput } from "../types/character";

const MAX_AVATAR_PREVIEW_BYTES = 8 * 1024 * 1024;

// These values refer to locally-owned entities rather than portable card data.
// Replacing a JSON/PNG/CHARX card must not detach or delete the user's avatar,
// expression assets, world book links, or selected TTS voice unless explicitly requested.
export const LOCAL_CHARACTER_EXTENSION_KEYS = new Set([
  "expressions",
  "expression_groups",
  "alternate_fields",
  "alternate_avatars",
  "avatar_bindings",
  "world_book_id",
  "world_book_ids",
  "avatar_crop_image_id",
  "original_image_id",
  "risu_asset_map",
  "gallery_reference_sequence",
  "gallery_reference_names",
  "landing_perspective_layers",
  "ttsVoice",
  "greeting_tools",
  "greeting_backgrounds",
]);

export type SupportedCardFormat = "json" | "png" | "charx" | "jpeg_polyglot";

export interface ParsedCardBundle {
  format: SupportedCardFormat;
  filename: string;
  cardInput: CreateCharacterInput;
  avatarFile: File | null;
  charxResult: cardSvc.CharxResult | null;
}

export type CardMatchReason = "source_filename" | "name_and_creator" | "name";

export interface CharacterUpdateMatchCandidate {
  id: string;
  name: string;
  creator: string;
  image_id: string | null;
  updated_at: number;
  matchReason: CardMatchReason;
}

export interface CardUpdateExtrasSummary {
  embeddedLorebookEntries: number;
  lumiverseWorldBookCount: number;
  regexScriptCount: number;
  expressionCount: number;
  expressionGroupCount: number;
  galleryCount: number;
  alternateAvatarCount: number;
  alternateFieldKeys: string[];
  landingPerspectiveLayerCount: number;
}

export interface CardUpdatePreview {
  format: SupportedCardFormat;
  filename: string;
  incoming: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    creator: string;
    creator_notes: string;
    system_prompt: string;
    post_history_instructions: string;
    tags: string[];
    alternate_greetings: string[];
    extensions: Record<string, any>;
  };
  hasAvatar: boolean;
  avatarPreviewUrl: string | null;
  extras: CardUpdateExtrasSummary;
  matches?: CharacterUpdateMatchCandidate[];
}

export type CardScalarField =
  | "name"
  | "description"
  | "personality"
  | "scenario"
  | "mes_example"
  | "creator"
  | "creator_notes"
  | "system_prompt"
  | "post_history_instructions";

export const CARD_SCALAR_FIELDS: readonly CardScalarField[] = [
  "name",
  "description",
  "personality",
  "scenario",
  "mes_example",
  "creator",
  "creator_notes",
  "system_prompt",
  "post_history_instructions",
] as const;

const CARD_SCALAR_FIELD_SET = new Set<string>(CARD_SCALAR_FIELDS);

export type FirstMesUpdateMode = "keep" | "replace" | "replace_and_demote";
export type AlternateGreetingsUpdateMode = "keep" | "append_new" | "replace_all" | "select";
export type TagsUpdateMode = "keep" | "merge" | "replace";
export type AvatarUpdateMode = "keep" | "replace_primary" | "add_alternate";
export type ExtensionsUpdateMode = "keep" | "merge_portable" | "replace_portable";
export type WorldBookUpdateMode = "keep" | "import_new";
export type RegexUpdateMode = "keep" | "merge_new" | "replace_character_bound";
export type CharxAssetsUpdateMode = "keep" | "merge" | "replace";

export interface CardUpdateSelection {
  fields?: CardScalarField[];
  firstMesMode?: FirstMesUpdateMode;
  alternateGreetingsMode?: AlternateGreetingsUpdateMode;
  keepExistingGreetingIndices?: number[];
  selectedIncomingGreetingIndices?: number[];
  tagsMode?: TagsUpdateMode;
  avatarMode?: AvatarUpdateMode;
  extensionsMode?: ExtensionsUpdateMode;
  worldBookMode?: WorldBookUpdateMode;
  regexMode?: RegexUpdateMode;
  charxAssetsMode?: CharxAssetsUpdateMode;
}

export interface CardUpdateApplySummary {
  updatedFields: string[];
  addedAlternateGreetings: number;
  demotedFirstMes: boolean;
  avatarUpdated: AvatarUpdateMode;
  worldBooksImported: number;
  regexScriptsImported: number;
  charxAssetsApplied: boolean;
}

export function buildCardReplacementInput(existing: Character, card: CreateCharacterInput): UpdateCharacterInput {
  const preservedExtensions = Object.fromEntries(
    Object.entries(existing.extensions ?? {}).filter(([key]) =>
      LOCAL_CHARACTER_EXTENSION_KEYS.has(key) || key.startsWith("_lumiverse_")
    )
  );

  return {
    // Deliberately omit `name`: legacy replace-card only replaces card contents.
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

export async function parseCardBundle(file: File): Promise<ParsedCardBundle> {
  const filename = file.name || "unknown";
  const detectedFormat = await cardSvc.detectCharacterImportFormat(file);

  if (detectedFormat === "png") {
    const cardInput = await cardSvc.extractCardFromPng(file);
    return {
      format: "png",
      filename,
      cardInput,
      avatarFile: file,
      charxResult: null,
    };
  }

  if (detectedFormat === "charx" || detectedFormat === "jpeg_polyglot") {
    const charxResult = await cardSvc.extractCardFromCharx(file);
    return {
      format: detectedFormat,
      filename,
      cardInput: charxResult.card,
      avatarFile: charxResult.avatarFile,
      charxResult,
    };
  }

  if (detectedFormat === "jpeg") {
    throw new Error("JPEG file does not contain embedded character card data");
  }

  const text = await file.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON in uploaded character card");
  }
  const cardInput = cardSvc.parseCardJson(json);
  return {
    format: "json",
    filename,
    cardInput,
    avatarFile: null,
    charxResult: null,
  };
}

function countIncomingRegexScripts(parsed: ParsedCardBundle): number {
  const ext = parsed.cardInput.extensions as Record<string, any> | undefined;
  const lumiverseCount = Array.isArray(parsed.charxResult?.lumiverseModules?.regex_scripts)
    ? parsed.charxResult!.lumiverseModules!.regex_scripts.length
    : Array.isArray(ext?.lumiverse_modules?.regex_scripts)
      ? ext!.lumiverse_modules.regex_scripts.length
      : 0;
  const stCount = Array.isArray(ext?.regex_scripts) ? ext!.regex_scripts.length : 0;
  const risuCount = Array.isArray(parsed.charxResult?.risuModule?.regex)
    ? parsed.charxResult!.risuModule!.regex.length
    : 0;

  // Lumiverse-native bundles take precedence over embedded ST scripts (avoid double-count).
  return (lumiverseCount > 0 ? lumiverseCount : stCount) + risuCount;
}

function summarizeExtras(parsed: ParsedCardBundle): CardUpdateExtrasSummary {
  const ext = parsed.cardInput.extensions as Record<string, any> | undefined;
  const lumiverse = parsed.charxResult?.lumiverseModules;
  const assetFiles = parsed.charxResult?.assetFiles;

  const consumedPaths = new Set<string>();
  let expressionCount = 0;
  let expressionGroupCount = 0;
  if (lumiverse?.expressions?.mappings) {
    for (const archivePath of Object.values(lumiverse.expressions.mappings)) {
      if (typeof archivePath === "string") consumedPaths.add(archivePath);
    }
    expressionCount = Object.keys(lumiverse.expressions.mappings).length;
  } else if (parsed.charxResult?.expressionAssets?.length) {
    expressionCount = parsed.charxResult.expressionAssets.length;
  }

  if (lumiverse?.expression_groups?.groups) {
    expressionGroupCount = Object.keys(lumiverse.expression_groups.groups).length;
    for (const labelMap of Object.values(lumiverse.expression_groups.groups)) {
      for (const archivePath of Object.values(labelMap)) {
        if (typeof archivePath === "string") consumedPaths.add(archivePath);
      }
    }
  } else if (parsed.charxResult?.expressionGroupAnalysis?.isMultiCharacter) {
    expressionGroupCount = Object.keys(parsed.charxResult.expressionGroupAnalysis.groups).length;
  }

  if (Array.isArray(lumiverse?.alternate_avatars)) {
    for (const av of lumiverse.alternate_avatars) {
      if (typeof av?.path === "string") consumedPaths.add(av.path);
    }
  }
  if (Array.isArray(lumiverse?.landing_perspective_layers)) {
    for (const layer of lumiverse.landing_perspective_layers) {
      if (typeof layer?.path === "string") consumedPaths.add(layer.path);
    }
  }

  let galleryCount = 0;
  if (assetFiles) {
    for (const [path, assetFile] of assetFiles) {
      if (consumedPaths.has(path)) continue;
      if (parsed.avatarFile && assetFile.name === parsed.avatarFile.name) continue;
      if (/^assets\/(icon|other)\//i.test(path)) galleryCount++;
    }
  }

  const alternateFieldKeys = lumiverse?.alternate_fields && typeof lumiverse.alternate_fields === "object"
    ? Object.keys(lumiverse.alternate_fields).filter((key) => Array.isArray(lumiverse.alternate_fields![key]) && lumiverse.alternate_fields![key].length > 0)
    : [];

  return {
    embeddedLorebookEntries: wbSvc.countImportedWorldBookEntries(ext?.character_book?.entries),
    lumiverseWorldBookCount: Array.isArray(lumiverse?.world_books) ? lumiverse.world_books.length : 0,
    regexScriptCount: countIncomingRegexScripts(parsed),
    expressionCount,
    expressionGroupCount,
    galleryCount,
    alternateAvatarCount: Array.isArray(lumiverse?.alternate_avatars) ? lumiverse.alternate_avatars.length : 0,
    alternateFieldKeys,
    landingPerspectiveLayerCount: Array.isArray(lumiverse?.landing_perspective_layers)
      ? lumiverse.landing_perspective_layers.length
      : 0,
  };
}

async function encodeAvatarPreviewUrl(avatarFile: File | null): Promise<string | null> {
  if (!avatarFile || avatarFile.size === 0 || avatarFile.size > MAX_AVATAR_PREVIEW_BYTES) {
    return null;
  }
  const buf = Buffer.from(await avatarFile.arrayBuffer());
  const mime = avatarFile.type && avatarFile.type.startsWith("image/")
    ? avatarFile.type
    : "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

export async function findMatchingCharactersForCard(
  userId: string,
  filename: string,
  cardInput: CreateCharacterInput,
): Promise<CharacterUpdateMatchCandidate[]> {
  const rows = await readDatabaseRows<{
    id: string;
    name: string;
    creator: string;
    image_id: string | null;
    updated_at: number;
    extensions: string;
  }>(
    `SELECT id, name, creator, image_id, updated_at, extensions
     FROM characters
     WHERE user_id = ? AND deleting = 0
     ORDER BY updated_at DESC`,
    [userId],
  );

  const normalizedFilename = filename && filename !== "unknown" ? filename.trim() : "";
  const normalizedName = (cardInput.name || "").trim().toLocaleLowerCase();
  const normalizedCreator = (cardInput.creator || "").trim().toLocaleLowerCase();

  const candidates: Array<{ priority: number; candidate: CharacterUpdateMatchCandidate }> = [];

  for (const row of rows) {
    let sourceFilename = "";
    try {
      const ext = row.extensions ? JSON.parse(row.extensions) : null;
      if (typeof ext?._lumiverse_source_filename === "string") {
        sourceFilename = ext._lumiverse_source_filename.trim();
      }
    } catch {
      // Ignore malformed extensions JSON
    }

    const rowName = (row.name || "").trim();
    const rowNameLower = rowName.toLocaleLowerCase();
    const rowCreatorLower = (row.creator || "").trim().toLocaleLowerCase();

    if (normalizedFilename && sourceFilename && sourceFilename === normalizedFilename) {
      candidates.push({
        priority: 0,
        candidate: {
          id: row.id,
          name: row.name,
          creator: row.creator || "",
          image_id: row.image_id || null,
          updated_at: row.updated_at,
          matchReason: "source_filename",
        },
      });
      continue;
    }

    if (normalizedName && rowNameLower === normalizedName) {
      const creatorMatches = !!normalizedCreator && rowCreatorLower === normalizedCreator;
      const exactCase = rowName === (cardInput.name || "").trim();
      candidates.push({
        priority: creatorMatches ? 1 : exactCase ? 2 : 3,
        candidate: {
          id: row.id,
          name: row.name,
          creator: row.creator || "",
          image_id: row.image_id || null,
          updated_at: row.updated_at,
          matchReason: creatorMatches ? "name_and_creator" : "name",
        },
      });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority || b.candidate.updated_at - a.candidate.updated_at);
  return candidates.slice(0, 20).map((item) => item.candidate);
}

export async function buildCardUpdatePreview(
  parsed: ParsedCardBundle,
  matches?: CharacterUpdateMatchCandidate[],
): Promise<CardUpdatePreview> {
  const { cardInput, avatarFile, filename, format } = parsed;
  const avatarPreviewUrl = await encodeAvatarPreviewUrl(avatarFile);

  return {
    format,
    filename,
    incoming: {
      name: cardInput.name ?? "",
      description: cardInput.description ?? "",
      personality: cardInput.personality ?? "",
      scenario: cardInput.scenario ?? "",
      first_mes: cardInput.first_mes ?? "",
      mes_example: cardInput.mes_example ?? "",
      creator: cardInput.creator ?? "",
      creator_notes: cardInput.creator_notes ?? "",
      system_prompt: cardInput.system_prompt ?? "",
      post_history_instructions: cardInput.post_history_instructions ?? "",
      tags: Array.isArray(cardInput.tags) ? cardInput.tags : [],
      alternate_greetings: Array.isArray(cardInput.alternate_greetings) ? cardInput.alternate_greetings : [],
      extensions: cardInput.extensions && typeof cardInput.extensions === "object" ? cardInput.extensions : {},
    },
    hasAvatar: !!avatarFile,
    avatarPreviewUrl,
    extras: summarizeExtras(parsed),
    ...(matches !== undefined ? { matches } : {}),
  };
}

function normalizeGreetingKey(value: string): string {
  return value.trim();
}

function mergeTags(existing: string[], incoming: string[]): string[] {
  const seen = new Set(existing);
  const result = [...existing];
  for (const tag of incoming) {
    if (typeof tag === "string" && tag && !seen.has(tag)) {
      seen.add(tag);
      result.push(tag);
    }
  }
  return result;
}

function filterPortableExtensions(extensions: Record<string, any> | undefined): Record<string, any> {
  if (!extensions || typeof extensions !== "object") return {};
  return Object.fromEntries(
    Object.entries(extensions).filter(([key]) =>
      !LOCAL_CHARACTER_EXTENSION_KEYS.has(key) && !key.startsWith("_lumiverse_")
    ),
  );
}

function regexSignature(script: { name?: string; scriptName?: string; find_regex?: string; findRegex?: string; replace_string?: string; replaceString?: string }): string {
  const name = script.name ?? script.scriptName ?? "";
  const find = script.find_regex ?? script.findRegex ?? "";
  const replace = script.replace_string ?? script.replaceString ?? "";
  return `${name}\u0000${find}\u0000${replace}`;
}

export async function applySelectiveCardUpdate(
  userId: string,
  existing: Character,
  parsed: ParsedCardBundle,
  selection: CardUpdateSelection,
  options: { signal?: AbortSignal } = {},
): Promise<{ character: Character; summary: CardUpdateApplySummary }> {
  const { cardInput } = parsed;
  const updateInput: UpdateCharacterInput = {};
  const updatedFields: string[] = [];
  const updatedTextFields = new Set<string>();
  const updatedGreetingIndices = new Set<number>();

  // 1. Scalar fields
  const requestedFields = Array.isArray(selection.fields) ? selection.fields : [];
  for (const field of requestedFields) {
    if (!CARD_SCALAR_FIELD_SET.has(field)) continue;
    const nextValue = String(cardInput[field] ?? "");
    if (field === "name" && !nextValue.trim()) continue;
    (updateInput as any)[field] = nextValue;
    updatedFields.push(field);
    updatedTextFields.add(field);
  }

  // 2. Greetings (first_mes + alternate_greetings)
  const firstMesMode: FirstMesUpdateMode = selection.firstMesMode ?? "keep";
  const alternateMode: AlternateGreetingsUpdateMode = selection.alternateGreetingsMode ?? "keep";

  const incomingFirstMes = cardInput.first_mes ?? "";
  const incomingAlternates = Array.isArray(cardInput.alternate_greetings) ? cardInput.alternate_greetings : [];
  const existingAlternates = Array.isArray(existing.alternate_greetings) ? existing.alternate_greetings : [];

  let demotedFirstMes = false;
  let addedAlternateGreetings = 0;

  if (firstMesMode === "replace" || firstMesMode === "replace_and_demote") {
    updateInput.first_mes = incomingFirstMes;
    updatedFields.push("first_mes");
    updatedTextFields.add("first_mes");
  }

  let nextAlternates: string[] | null = null;
  let keptExistingIndices: number[] | null = null;

  if (alternateMode === "replace_all") {
    nextAlternates = [...incomingAlternates];
    incomingAlternates.forEach((_, index) => updatedGreetingIndices.add(index));
    addedAlternateGreetings = incomingAlternates.length;
    updatedFields.push("alternate_greetings");
    updatedTextFields.add("alternate_greetings");
  } else if (alternateMode === "append_new") {
    const seen = new Set<string>();
    const activeFirstMes = updateInput.first_mes ?? existing.first_mes ?? "";
    if (activeFirstMes.trim()) seen.add(normalizeGreetingKey(activeFirstMes));
    for (const g of existingAlternates) seen.add(normalizeGreetingKey(g));

    const toAppend: string[] = [];
    for (const g of incomingAlternates) {
      const key = normalizeGreetingKey(g);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      toAppend.push(g);
    }
    if (toAppend.length > 0) {
      nextAlternates = [...existingAlternates, ...toAppend];
      toAppend.forEach((_, index) => updatedGreetingIndices.add(existingAlternates.length + index));
      addedAlternateGreetings = toAppend.length;
      updatedFields.push("alternate_greetings");
      updatedTextFields.add("alternate_greetings");
    }
  } else if (alternateMode === "select") {
    const keepIndices = Array.isArray(selection.keepExistingGreetingIndices)
      ? selection.keepExistingGreetingIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < existingAlternates.length)
      : existingAlternates.map((_, idx) => idx);
    keptExistingIndices = keepIndices;
    const kept = keepIndices.map((idx) => existingAlternates[idx]);
    const incomingIndices = Array.isArray(selection.selectedIncomingGreetingIndices)
      ? selection.selectedIncomingGreetingIndices.filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < incomingAlternates.length)
      : [];
    const added = incomingIndices.map((idx) => incomingAlternates[idx]);
    nextAlternates = [...kept, ...added];
    added.forEach((_, index) => updatedGreetingIndices.add(kept.length + index));
    addedAlternateGreetings = added.length;
    updatedFields.push("alternate_greetings");
    updatedTextFields.add("alternate_greetings");
  }

  if (firstMesMode === "replace_and_demote") {
    const oldFirstMes = existing.first_mes ?? "";
    if (oldFirstMes.trim()) {
      const baseAlternates = nextAlternates ?? [...existingAlternates];
      const existingKeys = new Set([
        normalizeGreetingKey(incomingFirstMes),
        ...baseAlternates.map(normalizeGreetingKey),
      ]);
      if (!existingKeys.has(normalizeGreetingKey(oldFirstMes))) {
        nextAlternates = [...baseAlternates, oldFirstMes];
        demotedFirstMes = true;
        if (!updatedFields.includes("alternate_greetings")) {
          updatedFields.push("alternate_greetings");
        }
      }
    }
  }

  if (nextAlternates !== null) {
    updateInput.alternate_greetings = nextAlternates;
  }

  // 3. Tags
  const tagsMode: TagsUpdateMode = selection.tagsMode ?? "keep";
  const incomingTags = Array.isArray(cardInput.tags) ? cardInput.tags : [];
  if (tagsMode === "replace") {
    updateInput.tags = [...incomingTags];
    updatedFields.push("tags");
  } else if (tagsMode === "merge") {
    const merged = mergeTags(existing.tags ?? [], incomingTags);
    if (merged.length !== (existing.tags ?? []).length) {
      updateInput.tags = merged;
      updatedFields.push("tags");
    }
  }

  // 4. Extensions (always preserving local Lumiverse state)
  const extensionsMode: ExtensionsUpdateMode = selection.extensionsMode ?? "keep";
  let workingExtensions: Record<string, any> = { ...(existing.extensions ?? {}) };
  let extensionsModified = false;

  if (extensionsMode === "replace_portable") {
    const preserved = Object.fromEntries(
      Object.entries(workingExtensions).filter(([key]) =>
        LOCAL_CHARACTER_EXTENSION_KEYS.has(key) || key.startsWith("_lumiverse_")
      ),
    );
    workingExtensions = {
      ...filterPortableExtensions(cardInput.extensions),
      ...preserved,
    };
    extensionsModified = true;
    updatedFields.push("extensions");
  } else if (extensionsMode === "merge_portable") {
    const portableIncoming = filterPortableExtensions(cardInput.extensions);
    if (Object.keys(portableIncoming).length > 0) {
      workingExtensions = {
        ...workingExtensions,
        ...portableIncoming,
      };
      extensionsModified = true;
      updatedFields.push("extensions");
    }
  }

  // Keep every greeting-indexed setting attached to the same retained content.
  const mainReplaced = firstMesMode === "replace" || firstMesMode === "replace_and_demote";
  if (mainReplaced || nextAlternates !== null) {
    const retained = alternateMode === "replace_all" ? [] : keptExistingIndices ?? existingAlternates.map((_, i) => i);
    const indexMap = new Map<number, number>();
    if (!mainReplaced) indexMap.set(0, 0);
    retained.forEach((oldIndex, newIndex) => indexMap.set(oldIndex + 1, newIndex + 1));
    if (demotedFirstMes) indexMap.set(0, nextAlternates!.length);
    const tools = workingExtensions.greeting_tools;
    if (tools && typeof tools === "object" && !Array.isArray(tools)) {
      const nextTools = { ...tools };
      if (mainReplaced) nextTools.mainGreeting = null;
      const titles: Record<string, any> = {};
      const ids: Record<string, string> = {};
      for (const [oldIndex, newIndex] of indexMap) {
        if (newIndex === 0) continue;
        const metadata = oldIndex === 0 ? tools.mainGreeting : tools.greetings?.[tools.indexMap?.[String(oldIndex - 1)]];
        const id = oldIndex === 0 ? metadata?.id : tools.indexMap?.[String(oldIndex - 1)];
        if (typeof id === "string") {
          ids[String(newIndex - 1)] = id;
          if (metadata) titles[id] = metadata;
        }
      }
      nextTools.indexMap = ids;
      nextTools.greetings = titles;
      workingExtensions.greeting_tools = nextTools;
    }
    if (workingExtensions.greeting_backgrounds && typeof workingExtensions.greeting_backgrounds === "object") {
      workingExtensions.greeting_backgrounds = Object.fromEntries(
        Object.entries(workingExtensions.greeting_backgrounds)
          .filter(([key]) => indexMap.has(Number(key)))
          .map(([key, value]) => [indexMap.get(Number(key)), value]),
      );
    }
    if (workingExtensions.avatar_bindings && typeof workingExtensions.avatar_bindings === "object") {
      workingExtensions.avatar_bindings = Object.fromEntries(Object.entries(workingExtensions.avatar_bindings).flatMap(([id, raw]) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const binding = { ...raw } as Record<string, any>;
        if (typeof binding.greeting_index === "number") {
          const nextIndex = indexMap.get(binding.greeting_index);
          if (nextIndex === undefined) delete binding.greeting_index;
          else binding.greeting_index = nextIndex;
        }
        return Object.keys(binding).length ? [[id, binding]] : [];
      }));
    }
    extensionsModified = true;
  }

  if (parsed.filename && parsed.filename !== "unknown" && !workingExtensions._lumiverse_source_filename) {
    workingExtensions = {
      ...workingExtensions,
      _lumiverse_source_filename: parsed.filename,
    };
    extensionsModified = true;
  }

  if (extensionsModified) {
    updateInput.extensions = workingExtensions;
  }

  let latest: Character = existing;
  let emittedEditedEvent = false;
  if (Object.keys(updateInput).length > 0) {
    const saved = await svc.updateCharacterAsync(userId, existing.id, updateInput);
    if (!saved) throw new Error("Character not found");
    latest = saved;
    emittedEditedEvent = true;
  }

  // 5. Avatar
  const avatarMode: AvatarUpdateMode = selection.avatarMode ?? "keep";
  let avatarUpdated: AvatarUpdateMode = "keep";
  if (parsed.avatarFile && avatarMode === "replace_primary") {
    const updatedWithAvatar = await svc.replaceCharacterAvatar(userId, existing.id, parsed.avatarFile);
    if (updatedWithAvatar) {
      latest = updatedWithAvatar;
      avatarUpdated = "replace_primary";
      emittedEditedEvent = true;
      updatedFields.push("avatar");
    }
  } else if (parsed.avatarFile && avatarMode === "add_alternate") {
    const img = await images.uploadImage(userId, parsed.avatarFile, { owner_character_id: existing.id });
    const currentAltAvatars = Array.isArray(latest.extensions?.alternate_avatars)
      ? [...latest.extensions.alternate_avatars]
      : [];
    currentAltAvatars.push({
      id: crypto.randomUUID(),
      image_id: img.id,
      label: cardInput.name?.trim() ? `${cardInput.name.trim()} (Imported)` : "Imported",
    });
    const savedAlt = await svc.updateCharacterAsync(userId, existing.id, {
      extensions: {
        ...(latest.extensions ?? {}),
        alternate_avatars: currentAltAvatars,
      },
    });
    if (savedAlt) {
      latest = savedAlt;
      avatarUpdated = "add_alternate";
      emittedEditedEvent = true;
      updatedFields.push("alternate_avatars");
    }
  }

  // 6. World books
  const worldBookMode: WorldBookUpdateMode = selection.worldBookMode ?? "keep";
  let worldBooksImported = 0;
  if (worldBookMode === "import_new") {
    const addedIds: string[] = [];
    const lumiverseBooks = parsed.charxResult?.lumiverseModules?.world_books;
    if (Array.isArray(lumiverseBooks) && lumiverseBooks.length > 0) {
      for (const bookData of lumiverseBooks) {
        try {
          const result = wbSvc.importLumiverseWorldBook(userId, existing.id, bookData, { signal: options.signal });
          addedIds.push(result.worldBook.id);
        } catch {
          // Skip individual book import errors
        }
      }
    } else {
      const charBook = cardInput.extensions?.character_book;
      if (wbSvc.countImportedWorldBookEntries(charBook?.entries) > 0) {
        const { worldBook } = wbSvc.importCharacterBook(userId, existing.id, latest.name, charBook, {
          autoManagedByCharacter: true,
        });
        addedIds.push(worldBook.id);
      }
    }

    if (addedIds.length > 0) {
      const currentIds = getCharacterWorldBookIds(latest.extensions);
      const nextIds = [...new Set([...currentIds, ...addedIds])];
      const nextExtensions = setCharacterWorldBookIds(
        {
          ...(latest.extensions ?? {}),
          ...(cardInput.extensions?.character_book ? { character_book: cardInput.extensions.character_book } : {}),
        },
        nextIds,
      );
      const savedWb = await svc.updateCharacterAsync(userId, existing.id, { extensions: nextExtensions });
      if (savedWb) {
        latest = savedWb;
        emittedEditedEvent = true;
      }
      worldBooksImported = addedIds.length;
      updatedFields.push("world_books");
    }
  }

  // 7. Regex scripts
  const regexMode: RegexUpdateMode = selection.regexMode ?? "keep";
  let regexScriptsImported = 0;
  if (regexMode === "replace_character_bound") {
    regexSvc.deleteRegexScriptsByCharacterId(userId, existing.id);
    const hasLumiverseBundle = !!(parsed.charxResult?.lumiverseModules?.regex_scripts?.length || cardInput.extensions?.lumiverse_modules?.regex_scripts?.length);
    if (hasLumiverseBundle) {
      const bundle = parsed.charxResult?.lumiverseModules?.regex_scripts ?? cardInput.extensions?.lumiverse_modules?.regex_scripts;
      regexScriptsImported += regexSvc.importCharacterBoundRegexScripts(
        userId,
        existing.id,
        { lumiverse_modules: { regex_scripts: bundle } },
        { bundleSource: parsed.charxResult ? "charx_bundle" : "card_bundle" },
      );
    } else if (Array.isArray(cardInput.extensions?.regex_scripts) && cardInput.extensions.regex_scripts.length > 0) {
      regexScriptsImported += regexSvc.importCharacterBoundRegexScripts(userId, existing.id, cardInput.extensions);
    }
    if (parsed.charxResult?.risuModule?.regex?.length) {
      for (const script of cardSvc.convertRisuRegexScripts(parsed.charxResult.risuModule.regex, existing.id)) {
        const res = regexSvc.createRegexScript(userId, script);
        if (typeof res !== "string") regexScriptsImported++;
      }
    }
    updatedFields.push("regex_scripts");
  } else if (regexMode === "merge_new") {
    const existingScripts = regexSvc.getRegexScriptsByCharacterId(userId, existing.id);
    const existingSigs = new Set(existingScripts.map(regexSignature));
    const bundle = parsed.charxResult?.lumiverseModules?.regex_scripts ?? cardInput.extensions?.lumiverse_modules?.regex_scripts;
    if (Array.isArray(bundle) && bundle.length > 0) {
      const filteredBundle = bundle.filter((script: any) => {
        if (!script || typeof script !== "object") return false;
        const sig = regexSignature(script);
        if (existingSigs.has(sig)) return false;
        existingSigs.add(sig);
        return true;
      });
      if (filteredBundle.length > 0) {
        regexScriptsImported += regexSvc.importCharacterBoundRegexScripts(
          userId,
          existing.id,
          { lumiverse_modules: { regex_scripts: filteredBundle } },
          { bundleSource: parsed.charxResult ? "charx_bundle" : "card_bundle" },
        );
      }
    } else if (Array.isArray(cardInput.extensions?.regex_scripts) && cardInput.extensions.regex_scripts.length > 0) {
      const filteredSt = cardInput.extensions.regex_scripts.filter((script: any) => {
        if (!script || typeof script !== "object") return false;
        const sig = regexSignature(script);
        if (existingSigs.has(sig)) return false;
        existingSigs.add(sig);
        return true;
      });
      if (filteredSt.length > 0) {
        regexScriptsImported += regexSvc.importCharacterBoundRegexScripts(
          userId,
          existing.id,
          { regex_scripts: filteredSt },
        );
      }
    }
    if (parsed.charxResult?.risuModule?.regex?.length) {
      for (const script of cardSvc.convertRisuRegexScripts(parsed.charxResult.risuModule.regex, existing.id)) {
        const sig = regexSignature(script);
        if (existingSigs.has(sig)) continue;
        existingSigs.add(sig);
        const res = regexSvc.createRegexScript(userId, script);
        if (typeof res !== "string") regexScriptsImported++;
      }
    }
    if (regexScriptsImported > 0) updatedFields.push("regex_scripts");
  }

  // 8. CHARX assets (expressions, gallery, alternate_fields, etc.)
  const charxAssetsMode: CharxAssetsUpdateMode = selection.charxAssetsMode ?? "keep";
  let charxAssetsApplied = false;
  if (parsed.charxResult && (charxAssetsMode === "merge" || charxAssetsMode === "replace")) {
    await applyCharxModulesAndAssets(userId, latest, parsed.charxResult, {
      assetMode: charxAssetsMode,
      importWorldBooks: false,
      updatedTextFields,
      updatedGreetingIndices,
      signal: options.signal,
    });
    charxAssetsApplied = true;
    if (charxAssetsApplied) {
      const refreshed = await svc.getCharacterAsync(userId, existing.id);
      if (refreshed) latest = refreshed;
      updatedFields.push("charx_assets");
    }
  }

  if (!emittedEditedEvent && updatedFields.length > 0) {
    eventBus.emit(EventType.CHARACTER_EDITED, { id: existing.id, character: latest }, userId);
  }

  return {
    character: latest,
    summary: {
      updatedFields,
      addedAlternateGreetings,
      demotedFirstMes,
      avatarUpdated,
      worldBooksImported,
      regexScriptsImported,
      charxAssetsApplied,
    },
  };
}
