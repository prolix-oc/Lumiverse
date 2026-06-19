import { getBible } from "./bible.service";
import { getBuildRegistry } from "./build-registry";
import { buildDynamicQuestionVerdict } from "./dynamic-question-gate";
import { getWorldbookRole, type WorldbookRoleTriggering } from "./worldbook-roles";
import {
  buildDynamicWeavePrompt,
  buildDynamicWeaveUserMessage,
  buildDynamicWeaveGatePrompt,
  buildDynamicWeaveGateUserMessage,
  type WeaverDynamicWeaveRevision,
} from "./prompts";
import { seedSourceNoun } from "./seed-adapter";
import { weaverGenerateJsonWithUsage } from "./llm";
import { createWorldBook, createEntry, getWorldBook, updateWorldBook } from "../world-books.service";
import * as charactersSvc from "../characters.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../../utils/character-world-books";
import type { Character } from "../../types/character";
import type { WorldBook, CreateWorldBookEntryInput } from "../../types/world-book";
import type { WeaverSession, WeaverBibleDynamicEntry } from "../../types/weaver";

const MAX_KEYS_PER_ENTRY = 6;

export interface WeaverComposedDynamicEntry {
  title: string;
  content: string;
  keys: string[];
}

export function parseDynamicWeaveResponse(
  data: unknown,
  validIds: ReadonlySet<string>,
): Map<string, WeaverComposedDynamicEntry> {
  const out = new Map<string, WeaverComposedDynamicEntry>();
  if (!data || typeof data !== "object") return out;
  const entries = (data as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return out;
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || !validIds.has(id) || out.has(id)) continue;
    const title = typeof r.title === "string" ? r.title.trim() : "";
    const content = typeof r.content === "string" ? r.content.trim() : "";
    if (!title || !content) continue;
    const keys = Array.isArray(r.keywords)
      ? r.keywords
          .filter((k): k is string => typeof k === "string")
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, MAX_KEYS_PER_ENTRY)
      : [];
    out.set(id, { title, content, keys });
  }
  return out;
}

export function parseDynamicWeaveVerdicts(
  data: unknown,
  criteria: readonly { key: string; label: string; description: string }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!data || typeof data !== "object") return out;
  const verdicts = (data as Record<string, unknown>).verdicts;
  if (!Array.isArray(verdicts)) return out;
  for (const raw of verdicts) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    if (!id || out.has(id)) continue;
    const verdict = buildDynamicQuestionVerdict(r, criteria);
    if (verdict.passed) continue;
    const notes = verdict.criteria.filter((c) => !c.passed && c.note).map((c) => c.note);
    out.set(id, notes.length > 0 ? notes : ["did not pass review"]);
  }
  return out;
}

export function dynamicEntryToEntryInput(
  entry: WeaverBibleDynamicEntry,
  composed: WeaverComposedDynamicEntry | undefined,
  triggering: WorldbookRoleTriggering,
): CreateWorldBookEntryInput {
  if (composed) {
    return {
      key: composed.keys,
      content: composed.content,
      comment: composed.title,
      vectorized: triggering === "meaning",
    };
  }
  return {
    key: [],
    content: entry.content,
    comment: entry.content.slice(0, 80),
    vectorized: triggering === "meaning",
  };
}

async function composeDynamicEntries(
  userId: string,
  session: WeaverSession,
  entries: readonly WeaverBibleDynamicEntry[],
): Promise<Map<string, WeaverComposedDynamicEntry>> {
  const reg = getBuildRegistry(session.build_type);
  const validIds = new Set(entries.map((e) => e.id));
  const weaveInput = {
    dream: session.seed.text,
    source_noun: seedSourceNoun(session.seed.type),
  };

  let composed: Map<string, WeaverComposedDynamicEntry>;
  try {
    const res = await weaverGenerateJsonWithUsage({
      userId,
      session,
      system: buildDynamicWeavePrompt(reg),
      user: buildDynamicWeaveUserMessage(reg, { ...weaveInput, entries }),
      temperature: 0.7,
    });
    composed = parseDynamicWeaveResponse(res.data, validIds);
  } catch {
    return new Map();
  }
  if (composed.size === 0) return composed;

  try {
    const judged = [...composed.entries()].map(([id, c]) => ({ id, title: c.title, content: c.content }));
    const gateRaw = await weaverGenerateJsonWithUsage({
      userId,
      session,
      system: buildDynamicWeaveGatePrompt(reg),
      user: buildDynamicWeaveGateUserMessage(reg, { composed: judged, entries }),
      temperature: 0.2,
      kind: "review",
    });
    const failing = parseDynamicWeaveVerdicts(gateRaw.data, reg.dynamicWeave.gateCriteria);
    if (failing.size === 0) return composed;

    const revise: WeaverDynamicWeaveRevision[] = [...failing.entries()]
      .filter(([id]) => composed.has(id))
      .map(([id, notes]) => ({
        id,
        title: composed.get(id)!.title,
        content: composed.get(id)!.content,
        notes,
      }));
    const failingEntries = entries.filter((e) => failing.has(e.id));
    const revised = await weaverGenerateJsonWithUsage({
      userId,
      session,
      system: buildDynamicWeavePrompt(reg),
      user: buildDynamicWeaveUserMessage(reg, { ...weaveInput, entries: failingEntries, revise }),
      temperature: 0.7,
    });
    for (const [id, entry] of parseDynamicWeaveResponse(revised.data, validIds)) {
      composed.set(id, entry);
    }
  } catch {
  }
  return composed;
}

export async function renderBackingWorldbook(
  userId: string,
  session: WeaverSession,
  roleId: string,
  character: { id: string; name: string },
): Promise<WorldBook | null> {
  const role = getWorldbookRole(roleId);
  if (!role) throw new Error(`Unknown worldbook role: ${roleId}`);

  const bible = getBible(userId, session.id);
  const dynamic = bible?.spine.dynamic ?? [];
  if (dynamic.length === 0) return null;

  const composed = await composeDynamicEntries(userId, session, dynamic);

  const book = createWorldBook(userId, {
    name: role.bookName(character.name),
    description: role.bookDescription(character.name),
    metadata: {
      source: "weaver",
      weaver_role: role.id,
      weaver_session_id: session.id,
      source_character_id: character.id,
      auto_managed_by_character: true,
      weaver_rendered_entry_ids: dynamic.map((e) => e.id),
    },
  });

  for (const entry of dynamic) {
    createEntry(
      userId,
      book.id,
      dynamicEntryToEntryInput(entry, composed.get(entry.id), role.triggering),
    );
  }

  return book;
}

export function parseRenderedIds(metadata: unknown): Set<string> {
  const out = new Set<string>();
  if (!metadata || typeof metadata !== "object") return out;
  const raw = (metadata as Record<string, unknown>).weaver_rendered_entry_ids;
  if (!Array.isArray(raw)) return out;
  for (const id of raw) {
    if (typeof id === "string" && id.trim()) out.add(id);
  }
  return out;
}

export interface AppendBackingWorldbookResult {
  character: Character;
  book: WorldBook | null;
  added: number;
}

export function findBoundRoleBook(
  userId: string,
  character: Character,
  roleId: string,
): WorldBook | null {
  return (
    getCharacterWorldBookIds(character.extensions)
      .map((id) => getWorldBook(userId, id))
      .find(
        (b): b is WorldBook =>
          Boolean(b) &&
          (b!.metadata as Record<string, unknown> | undefined)?.weaver_role === roleId &&
          (b!.metadata as Record<string, unknown> | undefined)?.source_character_id === character.id,
      ) ?? null
  );
}

export function ensureRoleBook(
  userId: string,
  session: WeaverSession,
  roleId: string,
  character: Character,
): { character: Character; book: WorldBook } {
  const role = getWorldbookRole(roleId);
  if (!role) throw new Error(`Unknown worldbook role: ${roleId}`);

  const existing = findBoundRoleBook(userId, character, roleId);
  if (existing) return { character, book: existing };

  const book = createWorldBook(userId, {
    name: role.bookName(character.name),
    description: role.bookDescription(character.name),
    metadata: {
      source: "weaver",
      weaver_role: role.id,
      weaver_session_id: session.id,
      source_character_id: character.id,
      auto_managed_by_character: true,
    },
  });
  const boundIds = getCharacterWorldBookIds(character.extensions);
  const extensions = setCharacterWorldBookIds(character.extensions ?? {}, [...boundIds, book.id]);
  const updated = charactersSvc.updateCharacter(userId, character.id, { extensions });
  return { character: updated ?? character, book };
}

export async function appendBackingWorldbook(
  userId: string,
  session: WeaverSession,
  roleId: string,
  character: Character,
): Promise<AppendBackingWorldbookResult> {
  const role = getWorldbookRole(roleId);
  if (!role) throw new Error(`Unknown worldbook role: ${roleId}`);

  const book = findBoundRoleBook(userId, character, roleId);

  if (!book) {
    const created = await renderBackingWorldbook(userId, session, roleId, character);
    if (!created) return { character, book: null, added: 0 };
    const boundIds = getCharacterWorldBookIds(character.extensions);
    const extensions = setCharacterWorldBookIds(character.extensions ?? {}, [...boundIds, created.id]);
    const updated = charactersSvc.updateCharacter(userId, character.id, { extensions });
    const bible = getBible(userId, session.id);
    return {
      character: updated ?? character,
      book: created,
      added: bible?.spine.dynamic.length ?? 0,
    };
  }

  const bible = getBible(userId, session.id);
  const dynamic = bible?.spine.dynamic ?? [];
  const rendered = parseRenderedIds(book.metadata);
  const fresh = dynamic.filter((d) => !rendered.has(d.id));
  if (fresh.length === 0) return { character, book, added: 0 };

  const composed = await composeDynamicEntries(userId, session, fresh);

  for (const entry of fresh) {
    createEntry(
      userId,
      book.id,
      dynamicEntryToEntryInput(entry, composed.get(entry.id), role.triggering),
    );
  }

  const updatedBook = updateWorldBook(userId, book.id, {
    metadata: {
      ...(book.metadata ?? {}),
      weaver_rendered_entry_ids: [...rendered, ...fresh.map((e) => e.id)],
    },
  });

  return { character, book: updatedBook ?? book, added: fresh.length };
}
