import {
  detectCharacterImportFormat,
  extractCardFromPng,
  extractCardFromCharx,
  parseCardJson,
} from "../character-card.service";
import { weaverGenerateJson, weaverGenerateTextWithUsage, type WeaverConnectionPrefs } from "./llm";
import { buildDynamicQuestionVerdict } from "./dynamic-question-gate";
import {
  readingActionsFor,
  importActionsFor,
  getImportAction,
} from "./registries/import-actions";
import {
  buildImportReadingPrompt,
  buildImportReadingUserMessage,
  buildEntryEnrichPrompt,
  buildEntryEnrichUserMessage,
  buildEntryEnrichGatePrompt,
  buildEntryEnrichGateUserMessage,
} from "./prompts";
import { createSession } from "./session.service";
import { importCharacterBook, importWorldBook, listEntries, getEntry, updateEntry } from "../world-books.service";
import * as charactersSvc from "../characters.service";
import { uploadImage } from "../images.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../../utils/character-world-books";
import type { CreateCharacterInput } from "../../types/character";
import type { WorldBook } from "../../types/world-book";
import type { WeaverSession } from "../../types/weaver";

export interface ImportedEntryLine {
  comment: string;
  content: string;
}

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeEntryLines(raw: unknown): ImportedEntryLine[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];
  const out: ImportedEntryLine[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const content = asTrimmed(entry.content);
    if (!content) continue;
    out.push({ comment: asTrimmed(entry.comment), content });
  }
  return out;
}

export function embeddedBookEntries(card: CreateCharacterInput): ImportedEntryLine[] {
  const book = card.extensions?.character_book;
  if (!book || typeof book !== "object") return [];
  return normalizeEntryLines((book as Record<string, unknown>).entries);
}

function block(label: string, body: string): string {
  return `${label}:\n${body}`;
}

function cardBlocks(card: CreateCharacterInput): [string, string][] {
  const candidates: [string, unknown][] = [
    ["DESCRIPTION", card.description],
    ["PERSONALITY", card.personality],
    ["SCENARIO", card.scenario],
    ["FIRST MESSAGE", card.first_mes],
    ["EXAMPLE MESSAGES", card.mes_example],
    ["CREATOR NOTES", card.creator_notes],
    ["SYSTEM PROMPT", card.system_prompt],
    ["POST-HISTORY INSTRUCTIONS", card.post_history_instructions],
  ];
  const out: [string, string][] = [];
  for (const [label, value] of candidates) {
    const body = asTrimmed(value);
    if (body) out.push([label, body]);
  }
  return out;
}

export interface WeaverImportFieldStat {
  id: string;
  words: number;
}

function wordCount(value: unknown): number {
  const text = asTrimmed(value);
  return text ? text.split(/\s+/).length : 0;
}

const CORE_CARD_FIELDS: [string, keyof CreateCharacterInput][] = [
  ["description", "description"],
  ["personality", "personality"],
  ["scenario", "scenario"],
  ["first_mes", "first_mes"],
  ["mes_example", "mes_example"],
];

export function cardFieldStats(card: CreateCharacterInput): WeaverImportFieldStat[] {
  const out: WeaverImportFieldStat[] = CORE_CARD_FIELDS.map(([id, key]) => ({
    id,
    words: wordCount(card[key]),
  }));
  const optional: [string, unknown][] = [
    ["creator_notes", card.creator_notes],
    ["system_prompt", card.system_prompt],
    ["post_history_instructions", card.post_history_instructions],
  ];
  for (const [id, value] of optional) {
    const words = wordCount(value);
    if (words > 0) out.push({ id, words });
  }
  const greetings = (card.alternate_greetings ?? []).map(asTrimmed).filter(Boolean);
  out.push({ id: "alternate_greetings", words: greetings.reduce((n, g) => n + wordCount(g), 0) });
  return out;
}

export function composeCardSource(
  card: CreateCharacterInput,
  entries: ImportedEntryLine[] = embeddedBookEntries(card),
): string {
  const parts: string[] = [];
  const name = asTrimmed(card.name);
  if (name) parts.push(`NAME: ${name}`);

  for (const [label, body] of cardBlocks(card)) parts.push(block(label, body));

  const greetings = (card.alternate_greetings ?? []).map(asTrimmed).filter(Boolean);
  if (greetings.length > 0) {
    parts.push(block("ALTERNATE GREETINGS", greetings.map((g, i) => `(${i + 1})\n${g}`).join("\n\n")));
  }

  if (entries.length > 0) {
    parts.push(
      block(
        "LORE ENTRIES (the card's embedded worldbook)",
        entries.map((e) => `ENTRY${e.comment ? ` — ${e.comment}` : ""}:\n${e.content}`).join("\n\n"),
      ),
    );
  }

  return parts.join("\n\n");
}

export function composeWorldbookSource(
  name: string,
  description: string,
  entries: ImportedEntryLine[],
): string {
  const parts: string[] = [];
  const bookName = name.trim();
  if (bookName) parts.push(`WORLDBOOK: ${bookName}`);
  const about = description.trim();
  if (about) parts.push(block("ABOUT", about));
  if (entries.length > 0) {
    parts.push(
      entries.map((e) => `ENTRY${e.comment ? ` — ${e.comment}` : ""}:\n${e.content}`).join("\n\n"),
    );
  }
  return parts.join("\n\n");
}

export function cardImportProvenance(input: {
  originalName: string;
  originalFormat: string;
  originalCharacterId: string;
  embeddedBookId?: string;
  avatarImageId?: string;
}): Record<string, unknown> {
  return {
    import_kind: "card",
    original_name: input.originalName,
    original_format: input.originalFormat,
    original_character_id: input.originalCharacterId,
    ...(input.embeddedBookId ? { bind_world_book_ids: [input.embeddedBookId] } : {}),
    ...(input.avatarImageId ? { avatar_image_id: input.avatarImageId } : {}),
  };
}

export function bookImportProvenance(input: {
  originalName: string;
  bookId: string;
  bind: boolean;
}): Record<string, unknown> {
  return {
    import_kind: "worldbook",
    original_name: input.originalName,
    source_book_id: input.bookId,
    ...(input.bind ? { bind_world_book_ids: [input.bookId] } : {}),
  };
}

export function classifyJsonArtifact(json: unknown): "card" | "worldbook" | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  if ((obj.spec === "chara_card_v2" || obj.spec === "chara_card_v3") && obj.data) return "card";
  if ("entries" in obj && normalizeEntryLines(obj.entries).length > 0) return "worldbook";
  const hasName = asTrimmed(obj.name) !== "";
  const hasProse = [obj.description, obj.personality, obj.first_mes, obj.mes_example, obj.scenario]
    .some((v) => asTrimmed(v) !== "");
  if (hasName && hasProse) return "card";
  return null;
}

export interface ParsedImportArtifact {
  artifact: "card" | "worldbook";
  format: string;
  name: string;
  source: string;
  card?: CreateCharacterInput;
  avatarFile?: File;
  book?: { name: string; description: string; entries: ImportedEntryLine[]; raw: unknown };
}

function fileStem(name: string): string {
  const base = name.split("/").pop() ?? name;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

export async function parseImportFile(file: File): Promise<ParsedImportArtifact> {
  const format = await detectCharacterImportFormat(file);

  if (format === "png" || format === "charx" || format === "jpeg_polyglot") {
    let card: CreateCharacterInput;
    let avatarFile: File | undefined;
    if (format === "png") {
      card = await extractCardFromPng(file);
      avatarFile = file;
    } else {
      const charx = await extractCardFromCharx(file);
      card = charx.card;
      avatarFile = charx.avatarFile ?? undefined;
    }
    return {
      artifact: "card",
      format,
      name: asTrimmed(card.name) || fileStem(file.name ?? "") || "Imported card",
      source: composeCardSource(card),
      card,
      ...(avatarFile ? { avatarFile } : {}),
    };
  }

  if (format === "json") {
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      throw new Error("This file is not valid JSON");
    }
    const kind = classifyJsonArtifact(json);
    if (kind === "card") {
      const card = parseCardJson(json);
      return {
        artifact: "card",
        format,
        name: asTrimmed(card.name) || fileStem(file.name ?? "") || "Imported card",
        source: composeCardSource(card),
        card,
      };
    }
    if (kind === "worldbook") {
      const obj = json as Record<string, unknown>;
      const name =
        asTrimmed(obj.name) || asTrimmed(obj.originalName) || fileStem(file.name ?? "") || "Imported worldbook";
      const description = asTrimmed(obj.description);
      const entries = normalizeEntryLines(obj.entries);
      return {
        artifact: "worldbook",
        format,
        name,
        source: composeWorldbookSource(name, description, entries),
        book: { name, description, entries, raw: json },
      };
    }
    throw new Error("This JSON does not read as a character card or a worldbook");
  }

  throw new Error("This file does not read as a character card or a worldbook");
}

export interface WeaverImportReading {
  action: string;
  reason: string;
}

export function parseImportReading(
  raw: unknown,
  validActionIds: readonly string[],
): WeaverImportReading | null {
  if (!raw || typeof raw !== "object") return null;
  const action = asTrimmed((raw as Record<string, unknown>).action);
  if (!action || !validActionIds.includes(action)) return null;
  return { action, reason: asTrimmed((raw as Record<string, unknown>).reason) };
}

export interface WeaverImportInspection {
  artifact: "card" | "worldbook";
  format: string;
  name: string;
  field_stats: WeaverImportFieldStat[];
  entry_count: number;
  has_embedded_book: boolean;
  has_portrait: boolean;
  source_chars: number;
  actions: string[];
  reading: WeaverImportReading | null;
}

export async function inspectImport(
  userId: string,
  file: File,
  prefs: WeaverConnectionPrefs = {},
  signal?: AbortSignal,
): Promise<WeaverImportInspection> {
  const parsed = await parseImportFile(file);
  const readable = readingActionsFor(parsed.artifact);

  let reading: WeaverImportReading | null = null;
  if (readable.length >= 2 && parsed.source.trim()) {
    try {
      const raw = await weaverGenerateJson({
        userId,
        session: prefs,
        system: buildImportReadingPrompt(readable),
        user: buildImportReadingUserMessage(parsed.source),
        temperature: 0.2,
        kind: "review",
        signal,
      });
      reading = parseImportReading(raw, readable.map((a) => a.id));
    } catch {
      reading = null;
    }
  }

  const embedded = parsed.card ? embeddedBookEntries(parsed.card) : [];
  return {
    artifact: parsed.artifact,
    format: parsed.format,
    name: parsed.name,
    field_stats: parsed.card ? cardFieldStats(parsed.card) : [],
    entry_count: parsed.book ? parsed.book.entries.length : embedded.length,
    has_embedded_book: embedded.length > 0,
    has_portrait: Boolean(parsed.avatarFile),
    source_chars: parsed.source.length,
    actions: importActionsFor(parsed.artifact).map((a) => a.id),
    reading,
  };
}

export interface WeaverImportStartInput {
  action: string;
  connection_id?: string | null;
  model?: string | null;
  persona_id?: string | null;
}

export interface WeaverImportStartResult {
  session?: WeaverSession;
  world_book?: WorldBook;
  book_work?: boolean;
}

async function importOriginalCard(
  userId: string,
  parsed: ParsedImportArtifact,
): Promise<{ characterId: string; embeddedBookId?: string; avatarImageId?: string }> {
  const card = parsed.card!;
  const character = charactersSvc.createCharacter(userId, card);

  let avatarImageId: string | undefined;
  if (parsed.avatarFile) {
    try {
      const image = await uploadImage(userId, parsed.avatarFile);
      charactersSvc.setCharacterAvatarFromImage(userId, character.id, image.id);
      avatarImageId = image.id;
    } catch {
    }
  }

  let embeddedBookId: string | undefined;
  const charBook = card.extensions?.character_book;
  if (charBook && typeof charBook === "object" && embeddedBookEntries(card).length > 0) {
    const { worldBook } = importCharacterBook(userId, character.id, character.name, charBook, {
      autoManagedByCharacter: false,
    });
    const current = getCharacterWorldBookIds(character.extensions);
    const extensions = setCharacterWorldBookIds({ ...(character.extensions ?? {}) }, [
      ...current,
      worldBook.id,
    ]);
    charactersSvc.updateCharacter(userId, character.id, { extensions });
    embeddedBookId = worldBook.id;
  }

  return { characterId: character.id, ...(embeddedBookId ? { embeddedBookId } : {}), ...(avatarImageId ? { avatarImageId } : {}) };
}

export async function startImport(
  userId: string,
  file: File,
  input: WeaverImportStartInput,
): Promise<WeaverImportStartResult> {
  const parsed = await parseImportFile(file);
  const action = getImportAction(input.action?.trim?.() ?? "");
  if (!action || action.artifact !== parsed.artifact) {
    throw new Error("That action does not apply to this file");
  }

  const sessionPrefs = {
    ...(input.connection_id ? { connection_id: input.connection_id } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.persona_id ? { persona_id: input.persona_id } : {}),
  };

  if (parsed.artifact === "card") {
    const fallback = await importOriginalCard(userId, parsed);
    const session = createSession(userId, {
      build_type: action.targetBuildType!,
      seed_type: action.seedType!,
      seed_text: parsed.source,
      seed_provenance: cardImportProvenance({
        originalName: parsed.name,
        originalFormat: parsed.format,
        originalCharacterId: fallback.characterId,
        embeddedBookId: fallback.embeddedBookId,
        avatarImageId: fallback.avatarImageId,
      }),
      ...sessionPrefs,
    });
    return { session };
  }

  const stored = importWorldBook(userId, parsed.book!.raw).worldBook;
  if (action.outcome === "book") {
    return { world_book: stored, ...(action.bookWork ? { book_work: true } : {}) };
  }

  const session = createSession(userId, {
    build_type: action.targetBuildType!,
    seed_type: action.seedType!,
    seed_text: parsed.source,
    seed_provenance: bookImportProvenance({
      originalName: parsed.name,
      bookId: stored.id,
      bind: action.bindSource === true,
    }),
    ...sessionPrefs,
  });
  return { session, world_book: stored };
}

function enrichWork() {
  const work = importActionsFor("worldbook").find((a) => a.bookWork)?.bookWork;
  if (!work) throw new Error("No enrichment action is registered");
  return work;
}

export interface WeaverEnrichEntryResult {
  entry_id: string;
  enriched: boolean;
  content: string;
  note: string;
}

export async function enrichEntry(
  userId: string,
  bookId: string,
  entryId: string,
  prefs: WeaverConnectionPrefs = {},
  signal?: AbortSignal,
): Promise<WeaverEnrichEntryResult> {
  const work = enrichWork();
  const entry = getEntry(userId, entryId);
  if (!entry || entry.world_book_id !== bookId) throw new Error("No such entry in this book");
  const original = entry.content.trim();
  if (!original) throw new Error("This entry has no content to deepen");

  const others = listEntries(userId, bookId)
    .filter((e) => e.id !== entryId && e.content.trim())
    .map((e) => ({ comment: e.comment, content: e.content }));
  const entryLine = { comment: entry.comment, content: original };

  const gateOnce = async (text: string) => {
    const raw = await weaverGenerateJson({
      userId,
      session: prefs,
      system: buildEntryEnrichGatePrompt(work),
      user: buildEntryEnrichGateUserMessage({ original, enriched: text }),
      temperature: 0.2,
      kind: "review",
      signal,
    });
    return buildDynamicQuestionVerdict(raw, work.gateCriteria);
  };

  const first = await weaverGenerateTextWithUsage({
    userId,
    session: prefs,
    system: buildEntryEnrichPrompt(work),
    user: buildEntryEnrichUserMessage({ entry: entryLine, others }),
    temperature: 0.7,
    signal,
  });
  let enriched = first.text.trim();
  if (!enriched) return { entry_id: entryId, enriched: false, content: original, note: "The model returned nothing" };

  let verdict = await gateOnce(enriched);
  if (!verdict.passed) {
    // The house discipline: cap-1 revise, then the original stands.
    const notes = verdict.criteria.filter((c) => !c.passed).map((c) => c.note).filter(Boolean);
    const second = await weaverGenerateTextWithUsage({
      userId,
      session: prefs,
      system: buildEntryEnrichPrompt(work),
      user: buildEntryEnrichUserMessage({ entry: entryLine, others, revise: { content: enriched, notes } }),
      temperature: 0.7,
      signal,
    });
    const revised = second.text.trim();
    if (revised) {
      verdict = await gateOnce(revised);
      if (verdict.passed) enriched = revised;
    }
    if (!verdict.passed) {
      return { entry_id: entryId, enriched: false, content: original, note: verdict.summary || "The original was kept" };
    }
  }

  updateEntry(userId, entryId, { content: enriched });
  return { entry_id: entryId, enriched: true, content: enriched, note: "" };
}
