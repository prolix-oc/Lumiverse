import { getDb } from "../../db/connection";
import { getBible } from "./bible.service";
import { getBuildRegistry, type WeaverBuildRegistry, type WeaverPeopleRegistry } from "./build-registry";
import {
  buildPeopleHarvestPrompt,
  buildPeopleHarvestUserMessage,
  buildPeopleProposePrompt,
  buildPeopleProposeUserMessage,
  buildPersonExtraPrompt,
  buildPersonExtraUserMessage,
  buildPersonQuestionPrompt,
  buildPersonQuestionUserMessage,
  buildPersonQuestionGatePrompt,
  buildPersonQuestionGateUserMessage,
  buildPersonWeavePrompt,
  buildPersonWeaveUserMessage,
  buildPersonWeaveGatePrompt,
  buildPersonWeaveGateUserMessage,
  type WeaverWorldMaterial,
} from "./prompts";
import { buildDynamicQuestionVerdict } from "./dynamic-question-gate";
import { ensureRoleBook, findBoundRoleBook } from "./worldbook-render.service";
import { ensureGovernanceForContext } from "./finalize.service";
import { createSession, getSession } from "./session.service";
import { seedSourceNoun } from "./seed-adapter";
import { getWeaverTuning } from "./tuning";
import { weaverGenerateJson } from "./llm";
import { getCharacterWorldBookIds } from "../../utils/character-world-books";
import * as charactersSvc from "../characters.service";
import { listEntries, getEntry, createEntry, updateEntry } from "../world-books.service";
import type { Character } from "../../types/character";
import type { WorldBook } from "../../types/world-book";
import type {
  WeaverSession,
  WeaverPerson,
  WeaverPersonAnswer,
  WeaverPersonTier,
  WeaverPersonOrigin,
  WeaverInterviewQuestion,
  WeaverResponseKind,
} from "../../types/weaver";
import { WEAVER_PERSON_TIERS } from "../../types/weaver";

interface PersonRow {
  id: string;
  session_id: string;
  name: string;
  hook: string;
  origin: string;
  tier: string;
  interview: string;
  npc_entry_id: string | null;
  promoted_session_id: string | null;
  created_at: number;
  updated_at: number;
}

function coerceTier(value: unknown): WeaverPersonTier {
  return WEAVER_PERSON_TIERS.includes(value as WeaverPersonTier)
    ? (value as WeaverPersonTier)
    : "unfleshed";
}

function coerceOrigin(value: unknown): WeaverPersonOrigin {
  if (value === "manual" || value === "interview") return value;
  return "proposed";
}

const ANSWER_KINDS: readonly WeaverResponseKind[] = ["typed", "picked", "enhanced"];

export function parsePersonInterview(value: unknown): WeaverPersonAnswer[] {
  let arr: unknown[] = [];
  if (Array.isArray(value)) arr = value;
  else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) arr = parsed;
    } catch {
      arr = [];
    }
  }
  const out: WeaverPersonAnswer[] = [];
  const seen = new Set<string>();
  for (const raw of arr) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const answer = typeof r.answer === "string" ? r.answer.trim() : "";
    if (!id || !answer || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      question: typeof r.question === "string" ? r.question.trim() : "",
      answer,
      kind: ANSWER_KINDS.includes(r.kind as WeaverResponseKind)
        ? (r.kind as WeaverResponseKind)
        : "typed",
    });
  }
  return out;
}

function rowToPerson(row: PersonRow): WeaverPerson {
  return {
    id: row.id,
    session_id: row.session_id,
    name: row.name,
    hook: row.hook,
    origin: coerceOrigin(row.origin),
    tier: coerceTier(row.tier),
    interview: parsePersonInterview(row.interview),
    npc_entry_id: row.npc_entry_id,
    promoted_session_id: row.promoted_session_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readRows(userId: string, sessionId: string): WeaverPerson[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM weaver_people WHERE user_id = ? AND session_id = ? ORDER BY created_at, name`,
    )
    .all(userId, sessionId) as PersonRow[];
  return rows.map(rowToPerson);
}

export function listPeople(userId: string, sessionId: string): WeaverPerson[] {
  return readRows(userId, sessionId).map((p) => {
    if (!p.npc_entry_id || getEntry(userId, p.npc_entry_id)) return p;
    return { ...p, tier: "unfleshed", npc_entry_id: null };
  });
}

export function getPerson(
  userId: string,
  sessionId: string,
  personId: string,
): WeaverPerson | null {
  const row = getDb()
    .prepare(`SELECT * FROM weaver_people WHERE id = ? AND user_id = ? AND session_id = ?`)
    .get(personId, userId, sessionId) as PersonRow | undefined;
  if (!row) return null;
  const person = rowToPerson(row);
  if (person.npc_entry_id && !getEntry(userId, person.npc_entry_id)) {
    return { ...person, tier: "unfleshed", npc_entry_id: null };
  }
  return person;
}

function insertPerson(
  userId: string,
  sessionId: string,
  name: string,
  hook: string,
  origin: WeaverPersonOrigin,
): WeaverPerson {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO weaver_people (id, user_id, session_id, name, hook, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, userId, sessionId, name, hook, origin, now, now);
  return getPerson(userId, sessionId, id)!;
}

function hasName(people: readonly WeaverPerson[], name: string): boolean {
  const needle = name.trim().toLowerCase();
  return people.some((p) => p.name.trim().toLowerCase() === needle);
}

export function addPerson(
  userId: string,
  sessionId: string,
  input: { name?: unknown; hook?: unknown },
): WeaverPerson {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const hook = typeof input.hook === "string" ? input.hook.trim() : "";
  if (!name) throw new Error("A person needs a name");
  if (hasName(readRows(userId, sessionId), name)) {
    throw new Error(`${name} is already here`);
  }
  return insertPerson(userId, sessionId, name, hook, "manual");
}

export function removePerson(userId: string, sessionId: string, personId: string): void {
  const person = getPerson(userId, sessionId, personId);
  if (!person) throw new Error("No such person here");
  if (person.tier !== "unfleshed") {
    throw new Error("Fleshed people live in the NPC book — remove their entry there");
  }
  getDb()
    .prepare(`DELETE FROM weaver_people WHERE id = ? AND user_id = ? AND session_id = ?`)
    .run(personId, userId, sessionId);
}

export function parsePeopleProposal(
  data: unknown,
  takenNames: readonly string[],
): Array<{ name: string; hook: string }> {
  if (!data || typeof data !== "object") return [];
  const people = (data as Record<string, unknown>).people;
  if (!Array.isArray(people)) return [];
  const taken = new Set(takenNames.map((n) => n.trim().toLowerCase()));
  const out: Array<{ name: string; hook: string }> = [];
  for (const raw of people) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const hook = typeof r.hook === "string" ? r.hook.trim() : "";
    const anchor = typeof r.anchor === "string" ? r.anchor.trim() : "";
    if (!name || !anchor || taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    out.push({ name, hook });
  }
  return out;
}

export function getWorldMaterial(userId: string, session: WeaverSession): WeaverWorldMaterial {
  const bible = getBible(userId, session.id);
  if (!bible) throw new Error("No Bible — finalize the world first");

  const reg = getBuildRegistry(session.build_type);
  const roleId = reg.people?.associationRole ?? reg.finalizeBookRoles[0];
  const character = session.character_id
    ? charactersSvc.getCharacter(userId, session.character_id)
    : null;
  const loreBook = character && roleId ? findBoundRoleBook(userId, character, roleId) : null;
  return {
    dream: session.seed.text,
    spine: bible.spine,
    lore: loreBook ? listEntries(userId, loreBook.id) : [],
    source_noun: seedSourceNoun(session.seed.type),
  };
}

export const HARVEST_CAP = 12;
export async function harvestPeople(
  userId: string,
  session: WeaverSession,
): Promise<WeaverPerson[]> {
  const reg = getBuildRegistry(session.build_type);
  if (!reg.people) throw new Error("This build type has no people");

  const existing = readRows(userId, session.id);
  const material = getWorldMaterial(userId, session);
  const subjectName = session.character_id
    ? charactersSvc.getCharacter(userId, session.character_id)?.name ?? ""
    : "";
  const takenNames = [...existing.map((p) => p.name), ...(subjectName ? [subjectName] : [])];

  const data = await weaverGenerateJson({
    userId,
    session,
    system: buildPeopleHarvestPrompt(reg),
    user: buildPeopleHarvestUserMessage(reg, { material, takenNames }),
    temperature: 0.3,
    kind: "review",
  });

  const cap = getWeaverTuning(userId).harvest_cap ?? HARVEST_CAP;
  const harvested = parsePeopleProposal(data, takenNames).slice(0, cap);
  return harvested.map((p) => insertPerson(userId, session.id, p.name, p.hook, "interview"));
}

export async function proposePeople(
  userId: string,
  session: WeaverSession,
): Promise<WeaverPerson[]> {
  const reg = getBuildRegistry(session.build_type);
  if (!reg.people) throw new Error("This build type has no people");

  const existing = readRows(userId, session.id);
  const material = getWorldMaterial(userId, session);
  const subjectName = session.character_id
    ? charactersSvc.getCharacter(userId, session.character_id)?.name ?? ""
    : "";
  const takenNames = [...existing.map((p) => p.name), ...(subjectName ? [subjectName] : [])];
  const proposeCount = getWeaverTuning(userId).propose_count ?? reg.people.proposeCount;

  const data = await weaverGenerateJson({
    userId,
    session,
    system: buildPeopleProposePrompt(reg),
    user: buildPeopleProposeUserMessage(reg, {
      count: proposeCount,
      material,
      takenNames,
    }),
    temperature: 0.8,
  });

  const proposed = parsePeopleProposal(data, takenNames).slice(0, proposeCount);
  if (proposed.length === 0) {
    throw new Error("The world proposed no usable people — try again");
  }
  return proposed.map((p) => insertPerson(userId, session.id, p.name, p.hook, "proposed"));
}

export function parseFleshResponse(
  data: unknown,
  name: string,
): { content: string; keys: string[] } {
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
  const content = typeof obj.content === "string" ? obj.content.trim() : "";
  const seen = new Set([name.trim().toLowerCase()]);
  const keys = [name.trim()];
  if (Array.isArray(obj.aliases)) {
    for (const raw of obj.aliases) {
      if (typeof raw !== "string") continue;
      const alias = raw.trim();
      if (!alias || seen.has(alias.toLowerCase())) continue;
      seen.add(alias.toLowerCase());
      keys.push(alias);
      if (keys.length >= 4) break;
    }
  }
  return { content, keys };
}

function peopleRegFor(session: WeaverSession): { reg: WeaverBuildRegistry; people: WeaverPeopleRegistry } {
  const reg = getBuildRegistry(session.build_type);
  if (!reg.people) throw new Error("This build type has no people");
  return { reg, people: reg.people };
}

function requireCharacter(userId: string, session: WeaverSession): Character {
  const character = session.character_id
    ? charactersSvc.getCharacter(userId, session.character_id)
    : null;
  if (!character) throw new Error("The finalized card no longer exists");
  return character;
}

function ensurePeopleArtifacts(
  userId: string,
  session: WeaverSession,
  people: WeaverPeopleRegistry,
): { character: Character; book: WorldBook } {
  const character = requireCharacter(userId, session);
  const ensured = ensureRoleBook(userId, session, people.bookRole, character);
  const governed = ensureGovernanceForContext(userId, session, ensured.character, {
    hasNpcBook: true,
  });
  return { character: governed, book: ensured.book };
}

function personMaterial(person: WeaverPerson): {
  name: string;
  hook: string;
  interview: { question: string; answer: string; kind: string }[];
} {
  return { name: person.name, hook: person.hook, interview: person.interview };
}

function writePersonEntry(
  userId: string,
  person: WeaverPerson,
  book: WorldBook,
  flesh: { content: string; keys: string[] },
): string {
  if (person.npc_entry_id && getEntry(userId, person.npc_entry_id)) {
    updateEntry(userId, person.npc_entry_id, {
      key: flesh.keys,
      content: flesh.content,
      comment: person.name,
    });
    return person.npc_entry_id;
  }
  const entry = createEntry(userId, book.id, {
    key: flesh.keys,
    content: flesh.content,
    comment: person.name,
    vectorized: false,
  });
  if (!entry) throw new Error("The NPC book could not take the entry");
  return entry.id;
}

function markFleshed(
  userId: string,
  sessionId: string,
  personId: string,
  tier: WeaverPersonTier,
  npcEntryId: string,
): void {
  getDb()
    .prepare(
      `UPDATE weaver_people SET tier = ?, npc_entry_id = ?, updated_at = unixepoch()
        WHERE id = ? AND user_id = ? AND session_id = ?`,
    )
    .run(tier, npcEntryId, personId, userId, sessionId);
}

export interface FleshResult {
  person: WeaverPerson;
  book: WorldBook;
}

export async function fleshExtra(
  userId: string,
  session: WeaverSession,
  personId: string,
): Promise<FleshResult> {
  const { reg, people } = peopleRegFor(session);
  const person = getPerson(userId, session.id, personId);
  if (!person) throw new Error("No such person here");
  if (person.tier !== "unfleshed") throw new Error(`${person.name} is already fleshed`);

  const material = getWorldMaterial(userId, session);
  const data = await weaverGenerateJson({
    userId,
    session,
    system: buildPersonExtraPrompt(reg),
    user: buildPersonExtraUserMessage(reg, { person: personMaterial(person), material }),
    temperature: 0.7,
  });
  const flesh = parseFleshResponse(data, person.name);
  if (!flesh.content) throw new Error("The model returned no usable lines — try again");

  const { book } = ensurePeopleArtifacts(userId, session, people);
  const entryId = writePersonEntry(userId, person, book, flesh);
  markFleshed(userId, session.id, personId, "extra", entryId);
  return { person: getPerson(userId, session.id, personId)!, book };
}

const PERSON_QUESTION_ATTEMPTS = 3;

export async function personQuestion(
  userId: string,
  session: WeaverSession,
  personId: string,
  input: { avoid?: string[] } = {},
): Promise<WeaverInterviewQuestion | null> {
  const { reg, people } = peopleRegFor(session);
  const person = getPerson(userId, session.id, personId);
  if (!person) throw new Error("No such person here");

  const material = getWorldMaterial(userId, session);
  const pm = personMaterial(person);
  const avoid = [
    ...(input.avoid ?? []),
    ...person.interview.map((i) => i.question).filter(Boolean),
  ];

  for (let attempt = 0; attempt < PERSON_QUESTION_ATTEMPTS; attempt++) {
    const proposal = await weaverGenerateJson({
      userId,
      session,
      system: buildPersonQuestionPrompt(reg),
      user: buildPersonQuestionUserMessage(reg, { person: pm, material, avoid }),
      temperature: 0.9,
    });
    const prompt = typeof proposal.prompt === "string" ? proposal.prompt.trim() : "";
    const why = typeof proposal.why === "string" ? proposal.why.trim() : "";
    if (!prompt) continue;

    const gateRaw = await weaverGenerateJson({
      userId,
      session,
      system: buildPersonQuestionGatePrompt(reg),
      user: buildPersonQuestionGateUserMessage(reg, { prompt, why, person: pm, material }),
      temperature: 0.2,
      kind: "review",
    });
    if (buildDynamicQuestionVerdict(gateRaw, people.questionGateCriteria).passed) {
      return { id: crypto.randomUUID(), prompt, why, target: "person" };
    }
    avoid.push(prompt);
  }
  return null;
}

export function answerPersonQuestion(
  userId: string,
  session: WeaverSession,
  personId: string,
  input: { question?: unknown; kind?: unknown; content?: unknown },
): WeaverPerson {
  peopleRegFor(session);
  const person = getPerson(userId, session.id, personId);
  if (!person) throw new Error("No such person here");

  const q = input.question && typeof input.question === "object"
    ? (input.question as Record<string, unknown>)
    : {};
  const question = typeof q.prompt === "string" ? q.prompt.trim() : "";
  const id = typeof q.id === "string" && q.id.trim() ? q.id.trim() : crypto.randomUUID();
  const content = typeof input.content === "string" ? input.content.trim() : "";
  if (!question) throw new Error("Missing question");
  if (!content) throw new Error("Answer is empty");
  const kind = ANSWER_KINDS.includes(input.kind as WeaverResponseKind)
    ? (input.kind as WeaverResponseKind)
    : "typed";

  const next = [
    ...person.interview.filter((i) => i.id !== id),
    { id, question, answer: content, kind },
  ];
  getDb()
    .prepare(
      `UPDATE weaver_people SET interview = ?, updated_at = unixepoch()
        WHERE id = ? AND user_id = ? AND session_id = ?`,
    )
    .run(JSON.stringify(next), personId, userId, session.id);
  return getPerson(userId, session.id, personId)!;
}

export async function weaveNamed(
  userId: string,
  session: WeaverSession,
  personId: string,
): Promise<FleshResult> {
  const { reg, people } = peopleRegFor(session);
  const person = getPerson(userId, session.id, personId);
  if (!person) throw new Error("No such person here");
  if (person.interview.length === 0) {
    throw new Error("Answer at least one question before weaving");
  }

  const material = getWorldMaterial(userId, session);
  const pm = personMaterial(person);

  const compose = async (revise?: { content: string; notes: string[] }) => {
    const data = await weaverGenerateJson({
      userId,
      session,
      system: buildPersonWeavePrompt(reg),
      user: buildPersonWeaveUserMessage(reg, { person: pm, material, ...(revise ? { revise } : {}) }),
      temperature: 0.7,
    });
    return parseFleshResponse(data, person.name);
  };

  let flesh = await compose();
  if (!flesh.content) throw new Error("The model returned no usable entry — try again");

  try {
    const gateRaw = await weaverGenerateJson({
      userId,
      session,
      system: buildPersonWeaveGatePrompt(reg),
      user: buildPersonWeaveGateUserMessage(reg, { content: flesh.content, person: pm, material }),
      temperature: 0.2,
      kind: "review",
    });
    const verdict = buildDynamicQuestionVerdict(gateRaw, people.weaveGateCriteria);
    if (!verdict.passed) {
      const notes = verdict.criteria.filter((c) => !c.passed && c.note).map((c) => c.note);
      const revised = await compose({ content: flesh.content, notes });
      if (revised.content) flesh = revised;
    }
  } catch {
  }

  const { book } = ensurePeopleArtifacts(userId, session, people);
  const entryId = writePersonEntry(userId, person, book, flesh);
  markFleshed(userId, session.id, personId, "named", entryId);
  return { person: getPerson(userId, session.id, personId)!, book };
}

export function composeNpcDossier(input: {
  person: { name: string; hook: string; interview: readonly WeaverPersonAnswer[] };
  entryContent: string;
  worldName: string;
  worldBrief: string;
}): string {
  const parts = [`NAME: ${input.person.name}`];
  if (input.person.hook.trim()) parts.push(`WHO THEY ARE: ${input.person.hook.trim()}`);
  if (input.entryContent.trim()) parts.push(`THEIR ENTRY (as the narrator voices them):\n${input.entryContent.trim()}`);
  if (input.person.interview.length > 0) {
    parts.push(
      `THE AUTHOR'S ANSWERS ABOUT THEM:\n${input.person.interview
        .map((i) => `- Q: ${i.question}\n  A: ${i.answer}`)
        .join("\n")}`,
    );
  }
  if (input.worldBrief.trim()) {
    const where = input.worldName.trim() ? ` — ${input.worldName.trim()}` : "";
    parts.push(`THE WORLD THEY BELONG TO${where}:\n${input.worldBrief.trim()}`);
  }
  return parts.join("\n\n");
}

export function promoteNamed(userId: string, session: WeaverSession, personId: string): WeaverSession {
  const { people } = peopleRegFor(session);
  const person = getPerson(userId, session.id, personId);
  if (!person) throw new Error("No such person here");
  if (person.tier !== "named") throw new Error("Weave them as a Named NPC first — promotion builds on that material");
  if (person.promoted_session_id) {
    const existing = getSession(userId, person.promoted_session_id);
    if (existing) return existing;
  }

  const character = requireCharacter(userId, session);
  const bible = getBible(userId, session.id);
  const entry = person.npc_entry_id ? getEntry(userId, person.npc_entry_id) : null;
  const loreBook = findBoundRoleBook(userId, character, people.associationRole);

  const dossier = composeNpcDossier({
    person,
    entryContent: entry?.content ?? "",
    worldName: character.name,
    worldBrief: bible?.spine.brief ?? "",
  });

  const promoted = createSession(userId, {
    build_type: people.promoteTo,
    seed_type: "npc",
    seed_text: dossier,
    seed_provenance: {
      world_session_id: session.id,
      world_character_id: character.id,
      person_id: person.id,
      ...(loreBook ? { bind_world_book_ids: [loreBook.id] } : {}),
    },
    ...(session.connection_id ? { connection_id: session.connection_id } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.persona_id ? { persona_id: session.persona_id } : {}),
  });

  getDb()
    .prepare(
      `UPDATE weaver_people SET promoted_session_id = ?, updated_at = unixepoch()
        WHERE id = ? AND user_id = ? AND session_id = ?`,
    )
    .run(promoted.id, personId, userId, session.id);

  return promoted;
}

export interface WeaverHubCharacter {
  id: string;
  name: string;
}

export interface WeaverHubPromotion {
  person_id: string;
  name: string;
  session_id: string;
}

function safeParseExtensions(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function listInUniverse(
  userId: string,
  session: WeaverSession,
): { characters: WeaverHubCharacter[]; promotions: WeaverHubPromotion[] } {
  const { people } = peopleRegFor(session);
  const narrator = requireCharacter(userId, session);
  const loreBook = findBoundRoleBook(userId, narrator, people.associationRole);

  const characters: WeaverHubCharacter[] = [];
  if (loreBook) {
    const rows = getDb()
      .prepare(`SELECT id, name, extensions FROM characters WHERE user_id = ?`)
      .all(userId) as Array<{ id: string; name: string; extensions: unknown }>;
    for (const row of rows) {
      if (row.id === narrator.id) continue;
      if (getCharacterWorldBookIds(safeParseExtensions(row.extensions)).includes(loreBook.id)) {
        characters.push({ id: row.id, name: row.name });
      }
    }
  }

  const promotions: WeaverHubPromotion[] = [];
  for (const person of readRows(userId, session.id)) {
    if (!person.promoted_session_id) continue;
    const promoted = getSession(userId, person.promoted_session_id);
    if (promoted && promoted.status !== "finalized") {
      promotions.push({ person_id: person.id, name: person.name, session_id: promoted.id });
    }
  }

  return { characters, promotions };
}
