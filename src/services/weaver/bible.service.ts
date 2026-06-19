import { getDb } from "../../db/connection";
import { getSession, setStage } from "./session.service";
import { getExtraction } from "./extraction.service";
import { getTaste } from "./interview.service";
import {
  isSlotId,
  slotParts,
  slotSynthesisGroup,
  type SpineSlot,
} from "./slots";
import { getBuildRegistry, type WeaverBuildRegistry } from "./build-registry";
import { weaverGenerateJsonWithUsage, type WeaverUsage } from "./llm";
import {
  buildBibleSynthesisPrompt,
  buildBibleSynthesisUserMessage,
  buildBibleWeavePrompt,
  buildBibleWeaveUserMessage,
  buildBibleGatePrompt,
  buildBibleGateUserMessage,
  type SynthesisTarget,
  type SynthesisPriorPart,
} from "./prompts";
import { buildGateVerdict, deriveStatus, applicableBibleCriteria } from "./gate";
import { seedSourceNoun } from "./seed-adapter";
import { getDynamicEntries } from "./dynamic-question.service";
import type {
  WeaverBible,
  WeaverBibleSpine,
  WeaverBibleEntry,
  WeaverBibleEntryPart,
  WeaverBibleCausalLink,
  WeaverBibleDynamicEntry,
  WeaverBibleOrigin,
  WeaverBibleStatus,
  WeaverGateVerdict,
  WeaverTokenUsage,
  WeaverCommittedFact,
  UpdateWeaverBibleInput,
} from "../../types/weaver";

function factKey(f: WeaverCommittedFact): string {
  return `${f.slot}:${f.part ?? f.slot}`;
}

function isHybrid(slot: SpineSlot): boolean {
  return Boolean(slot.parts && slot.parts.length > 0);
}

function activeSlots(reg: WeaverBuildRegistry, facts: WeaverCommittedFact[]): SpineSlot[] {
  const covered = new Set(facts.filter((f) => f.fact.trim()).map((f) => f.slot));
  return reg.slots.filter((s) => !s.optional || covered.has(s.id));
}

export function slotsToAuthor(reg: WeaverBuildRegistry, facts: WeaverCommittedFact[]): SpineSlot[] {
  const covered = new Set(facts.map((f) => f.slot));
  return reg.slots.filter((s) => !covered.has(s.id) && !s.optional);
}

export function partsToAuthor(reg: WeaverBuildRegistry, facts: WeaverCommittedFact[]): SynthesisTarget[] {
  const covered = new Set(facts.filter((f) => f.fact.trim()).map(factKey));
  const out: SynthesisTarget[] = [];
  for (const slot of activeSlots(reg, facts)) {
    const hybrid = isHybrid(slot);
    for (const part of slotParts(reg.slots, slot.id)) {
      if (covered.has(`${slot.id}:${part.id}`)) continue;
      const description = part.description ?? (hybrid ? undefined : slot.description);
      out.push({ slot: slot.id, part: part.id, label: part.label, description, fill: part.fill });
    }
  }
  return out;
}

interface AuthoredPart {
  slot: string;
  part: string;
  content: string;
}

export function coerceAuthoredParts(
  slots: readonly SpineSlot[],
  value: unknown,
  authorable: Set<string>,
): AuthoredPart[] {
  if (!Array.isArray(value)) return [];
  const out: AuthoredPart[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const slot = r.slot;
    if (typeof slot !== "string" || !isSlotId(slots, slot)) continue;
    const part = typeof r.part === "string" && r.part.trim() ? r.part.trim() : slot;
    const content = r.content;
    const key = `${slot}:${part}`;
    if (!authorable.has(key) || seen.has(key)) continue;
    if (typeof content !== "string" || !content.trim()) continue;
    seen.add(key);
    out.push({ slot, part, content: content.trim() });
  }
  return out;
}

function dominantOrigin(parts: WeaverBibleEntryPart[]): WeaverBibleOrigin {
  if (parts.some((p) => p.origin === "established")) return "established";
  if (parts.some((p) => p.origin === "authored")) return "authored";
  return "inferred";
}

function coerceLinks(slots: readonly SpineSlot[], value: unknown): WeaverBibleCausalLink[] {
  if (!Array.isArray(value)) return [];
  const out: WeaverBibleCausalLink[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const from = (raw as Record<string, unknown>).from;
    const to = (raw as Record<string, unknown>).to;
    const relation = (raw as Record<string, unknown>).relation;
    if (!isSlotId(slots, from) || !isSlotId(slots, to) || from === to) continue;
    if (typeof relation !== "string" || !relation.trim()) continue;
    out.push({ from, to, relation: relation.trim() });
  }
  return out;
}

function parseDynamicRegion(value: unknown): WeaverBibleDynamicEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WeaverBibleDynamicEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id.trim() : "";
    const content = typeof r.content === "string" ? r.content.trim() : "";
    if (!id || !content || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      question: typeof r.question === "string" ? r.question.trim() : "",
      content,
      origin: coerceOrigin(r.origin),
    });
  }
  return out;
}

function buildFactContent(reg: WeaverBuildRegistry, facts: WeaverCommittedFact[]): Map<string, string[]> {
  const factContent = new Map<string, string[]>();
  for (const f of facts) {
    if (!f.fact.trim() || !isSlotId(reg.slots, f.slot)) continue;
    const key = factKey(f);
    const bucket = factContent.get(key);
    if (bucket) bucket.push(f.fact.trim());
    else factContent.set(key, [f.fact.trim()]);
  }
  return factContent;
}

function buildSlotEntry(
  reg: WeaverBuildRegistry,
  slot: SpineSlot,
  factContent: Map<string, string[]>,
  authoredBy: Map<string, string>,
): WeaverBibleEntry | null {
  const hybrid = isHybrid(slot);
  const builtParts: WeaverBibleEntryPart[] = [];

  if (hybrid) {
    const general = factContent.get(`${slot.id}:${slot.id}`);
    if (general && general.length) {
      builtParts.push({ id: slot.id, content: general.join(" "), origin: "established" });
    }
  }

  for (const part of slotParts(reg.slots, slot.id)) {
    const key = `${slot.id}:${part.id}`;
    const established = factContent.get(key);
    if (established && established.length) {
      builtParts.push({ id: part.id, content: established.join(" "), origin: "established" });
      continue;
    }
    const authored = authoredBy.get(key);
    if (authored) {
      builtParts.push({
        id: part.id,
        content: authored,
        origin: part.fill === "generate" ? "authored" : "inferred",
      });
    }
  }

  if (builtParts.length === 0) return null;

  if (hybrid) {
    const partLabel = (id: string) =>
      id === slot.id ? slot.label : slot.parts!.find((p) => p.id === id)?.label ?? id;
    const content = builtParts.map((bp) => `${partLabel(bp.id)}: ${bp.content}`).join(" ");
    return { slot: slot.id, content, origin: dominantOrigin(builtParts), parts: builtParts };
  }
  const only = builtParts[0];
  return { slot: slot.id, content: only.content, origin: only.origin };
}

export function assembleSpine(
  reg: WeaverBuildRegistry,
  facts: WeaverCommittedFact[],
  authoredRaw: unknown,
  linksRaw: unknown,
  briefRaw: unknown,
  dynamicRaw: unknown = [],
): WeaverBibleSpine {
  const authorable = new Set(partsToAuthor(reg, facts).map((t) => `${t.slot}:${t.part}`));
  const authoredBy = new Map(
    coerceAuthoredParts(reg.slots, authoredRaw, authorable).map((a) => [`${a.slot}:${a.part}`, a.content]),
  );

  const factContent = buildFactContent(reg, facts);

  const entries: WeaverBibleEntry[] = [];
  for (const slot of activeSlots(reg, facts)) {
    const entry = buildSlotEntry(reg, slot, factContent, authoredBy);
    if (entry) entries.push(entry);
  }

  const brief = typeof briefRaw === "string" ? briefRaw.trim() : "";
  return {
    entries,
    causal_links: coerceLinks(reg.slots, linksRaw),
    brief,
    dynamic: parseDynamicRegion(dynamicRaw),
  };
}

function emptyUsage(): WeaverTokenUsage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
}

function addUsage(base: WeaverTokenUsage, ...next: WeaverUsage[]): WeaverTokenUsage {
  return next.reduce<WeaverTokenUsage>(
    (acc, u) => ({
      prompt_tokens: acc.prompt_tokens + u.prompt_tokens,
      completion_tokens: acc.completion_tokens + u.completion_tokens,
      total_tokens: acc.total_tokens + u.total_tokens,
      calls: acc.calls + 1,
    }),
    base,
  );
}

function rowToBible(reg: WeaverBuildRegistry, row: Record<string, unknown>): WeaverBible {
  const spine = parseSpine(reg.slots, row.spine);
  return {
    session_id: row.session_id as string,
    spine,
    status: parseStatus(row.status),
    gate: parseGate(reg, row.gate, spine),
    token_usage: parseUsage(row.token_usage),
    gated_at: (row.gated_at as number) ?? null,
    updated_at: (row.updated_at as number) ?? null,
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function coerceOrigin(value: unknown): WeaverBibleOrigin {
  return ["established", "authored", "inferred"].includes(value as string)
    ? (value as WeaverBibleOrigin)
    : "authored";
}

function parseEntryParts(value: unknown): WeaverBibleEntryPart[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts: WeaverBibleEntryPart[] = [];
  for (const p of value) {
    if (!p || typeof p !== "object") continue;
    const r = p as Record<string, unknown>;
    if (typeof r.id !== "string" || !r.id.trim() || typeof r.content !== "string") continue;
    parts.push({ id: r.id, content: r.content.trim(), origin: coerceOrigin(r.origin) });
  }
  return parts.length > 0 ? parts : undefined;
}

export function parseSpine(slots: readonly SpineSlot[], value: unknown): WeaverBibleSpine {
  const obj = parseObject(value);
  const entries = Array.isArray(obj.entries)
    ? obj.entries
        .filter((e): e is Record<string, unknown> => {
          if (!e || typeof e !== "object") return false;
          const r = e as Record<string, unknown>;
          return isSlotId(slots, r.slot) && typeof r.content === "string";
        })
        .map((e) => {
          const parts = parseEntryParts(e.parts);
          const entry: WeaverBibleEntry = {
            slot: e.slot as string,
            content: (e.content as string).trim(),
            origin: coerceOrigin(e.origin),
          };
          return parts ? { ...entry, parts } : entry;
        })
    : [];
  const causal_links = coerceLinks(slots, obj.causal_links);
  const brief = typeof obj.brief === "string" ? obj.brief.trim() : "";
  return { entries, causal_links, brief, dynamic: parseDynamicRegion(obj.dynamic) };
}

function parseStatus(value: unknown): WeaverBibleStatus {
  return value === "gated" || value === "flagged" ? value : "pending";
}

function parseGate(reg: WeaverBuildRegistry, value: unknown, spine: WeaverBibleSpine): WeaverGateVerdict | null {
  const obj = parseObject(value);
  if (!Array.isArray(obj.criteria)) return null;
  return buildGateVerdict(obj, applicableBibleCriteria(reg.bibleGateCriteria, spine));
}

function parseUsage(value: unknown): WeaverTokenUsage {
  const obj = parseObject(value);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);
  return {
    prompt_tokens: num(obj.prompt_tokens),
    completion_tokens: num(obj.completion_tokens),
    total_tokens: num(obj.total_tokens),
    calls: num(obj.calls),
  };
}

function persist(
  userId: string,
  sessionId: string,
  spine: WeaverBibleSpine,
  status: WeaverBibleStatus,
  gate: WeaverGateVerdict | null,
  usage: WeaverTokenUsage,
  gatedAt: number | null,
): void {
  getDb()
    .prepare(
      `INSERT INTO weaver_bible (session_id, user_id, spine, status, gate, token_usage, gated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(session_id) DO UPDATE SET
         spine = excluded.spine,
         status = excluded.status,
         gate = excluded.gate,
         token_usage = excluded.token_usage,
         gated_at = excluded.gated_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      sessionId,
      userId,
      JSON.stringify(spine),
      status,
      JSON.stringify(gate ?? {}),
      JSON.stringify(usage),
      gatedAt,
    );
}

function regFor(userId: string, sessionId: string): WeaverBuildRegistry {
  const session = getSession(userId, sessionId);
  return getBuildRegistry(session?.build_type ?? "");
}

export function getBible(userId: string, sessionId: string): WeaverBible | null {
  const row = getDb()
    .prepare(`SELECT * FROM weaver_bible WHERE session_id = ? AND user_id = ?`)
    .get(sessionId, userId) as Record<string, unknown> | undefined;
  return row ? rowToBible(regFor(userId, sessionId), row) : null;
}

export async function synthesizeBible(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<WeaverBible> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  const extraction = getExtraction(userId, sessionId);
  if (!extraction) throw new Error("Read the dream first — there is nothing to synthesize");

  const facts = extraction.committed_facts;
  const taste = getTaste(userId);
  const targets = partsToAuthor(reg, facts);
  const dream = session.seed.text;
  const sourceNoun = seedSourceNoun(session.seed.type);
  const dynamicEntries = getDynamicEntries(userId, sessionId);

  let usage = emptyUsage();
  const authoredAll: AuthoredPart[] = [];
  for (const group of reg.synthesisGroups) {
    const groupTargets = targets.filter(
      (t) => slotSynthesisGroup(reg.slots, reg.synthesisGroups, t.slot) === group.id,
    );
    if (groupTargets.length === 0) continue;
    const res = await weaverGenerateJsonWithUsage({
      userId,
      session,
      system: buildBibleSynthesisPrompt(reg, group, sourceNoun),
      user: buildBibleSynthesisUserMessage(reg, {
        dream,
        facts,
        taste,
        targets: groupTargets,
        priorAuthored: authoredAll,
        dynamic: dynamicEntries,
        source_noun: sourceNoun,
      }),
      temperature: 0.7,
      signal,
    });
    const authorable = new Set(groupTargets.map((t) => `${t.slot}:${t.part}`));
    authoredAll.push(...coerceAuthoredParts(reg.slots, res.data.authored, authorable));
    usage = addUsage(usage, res.usage);
  }

  const partial = assembleSpine(reg, facts, authoredAll, [], "", dynamicEntries);
  if (partial.entries.length === 0) throw new Error("The model returned an unusable Bible");
  const weaveRes = await weaverGenerateJsonWithUsage({
    userId,
    session,
    system: buildBibleWeavePrompt(reg),
    user: buildBibleWeaveUserMessage(reg, partial, dream, sourceNoun),
    temperature: 0.5,
    signal,
  });
  usage = addUsage(usage, weaveRes.usage);

  const spine = assembleSpine(
    reg,
    facts,
    authoredAll,
    weaveRes.data.causal_links,
    weaveRes.data.brief,
    dynamicEntries,
  );

  const applicable = applicableBibleCriteria(reg.bibleGateCriteria, spine);
  const gateRes = await weaverGenerateJsonWithUsage({
    userId,
    session,
    system: buildBibleGatePrompt(reg, applicable),
    user: buildBibleGateUserMessage(reg, spine, dream, sourceNoun),
    temperature: 0.2,
    kind: "review",
    signal,
  });
  const verdict = buildGateVerdict(gateRes.data, applicable);
  const status = deriveStatus(verdict);
  usage = addUsage(usage, gateRes.usage);

  persist(userId, sessionId, spine, status, verdict, usage, Math.floor(Date.now() / 1000));
  setStage(userId, sessionId, "bible");
  return getBible(userId, sessionId)!;
}

export async function resynthesizeEntry(
  userId: string,
  sessionId: string,
  slotId: string,
  nudge?: string,
  signal?: AbortSignal,
): Promise<WeaverBible> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  if (!isSlotId(reg.slots, slotId)) throw new Error(`Unknown entry: ${slotId}`);

  const bible = getBible(userId, sessionId);
  if (!bible || bible.spine.entries.length === 0) {
    throw new Error("Synthesize a Bible first — there is nothing to redo");
  }
  const existingEntry = bible.spine.entries.find((e) => e.slot === slotId);
  if (!existingEntry) throw new Error("That entry isn't in the Bible");

  const extraction = getExtraction(userId, sessionId);
  if (!extraction) throw new Error("Read the dream first — there is nothing to synthesize");
  const facts = extraction.committed_facts;

  const targets = partsToAuthor(reg, facts).filter((t) => t.slot === slotId);
  if (targets.length === 0) {
    throw new Error("This entry is built from your own committed facts — edit it directly.");
  }

  const slot = reg.slots.find((s) => s.id === slotId)!;
  const group = reg.synthesisGroups.find(
    (g) => g.id === slotSynthesisGroup(reg.slots, reg.synthesisGroups, slotId),
  )!;
  const taste = getTaste(userId);
  const sourceNoun = seedSourceNoun(session.seed.type);
  const dynamicEntries = getDynamicEntries(userId, sessionId);

  // Every other entry's authored content gives the re-author pass coherence context.
  const priorAuthored = bible.spine.entries
    .filter((e) => e.slot !== slotId)
    .flatMap<SynthesisPriorPart>((e) =>
      e.parts && e.parts.length > 0
        ? e.parts
            .filter((p) => p.origin !== "established")
            .map((p) => ({ slot: e.slot, part: p.id, content: p.content }))
        : e.origin !== "established"
          ? [{ slot: e.slot, part: e.slot, content: e.content }]
          : [],
    );

  const res = await weaverGenerateJsonWithUsage({
    userId,
    session,
    system: buildBibleSynthesisPrompt(reg, group, sourceNoun),
    user: buildBibleSynthesisUserMessage(reg, {
      dream: session.seed.text,
      facts,
      taste,
      targets,
      priorAuthored,
      dynamic: dynamicEntries,
      source_noun: sourceNoun,
      nudge,
    }),
    temperature: 0.7,
    signal,
  });

  const authorable = new Set(targets.map((t) => `${t.slot}:${t.part}`));
  const authored = coerceAuthoredParts(reg.slots, res.data.authored, authorable);
  const authoredBy = new Map<string, string>();
  if (existingEntry.parts && existingEntry.parts.length > 0) {
    for (const p of existingEntry.parts) {
      if (p.origin !== "established") authoredBy.set(`${slotId}:${p.id}`, p.content);
    }
  } else if (existingEntry.origin !== "established") {
    authoredBy.set(`${slotId}:${slotId}`, existingEntry.content);
  }
  for (const a of authored) authoredBy.set(`${a.slot}:${a.part}`, a.content);

  const rebuilt = buildSlotEntry(reg, slot, buildFactContent(reg, facts), authoredBy);
  if (!rebuilt) throw new Error("The model returned nothing usable for this entry");

  const entries = bible.spine.entries.map((e) => (e.slot === slotId ? rebuilt : e));
  const spine: WeaverBibleSpine = { ...bible.spine, entries };
  const usage = addUsage(bible.token_usage, res.usage);
  persist(userId, sessionId, spine, "pending", bible.gate, usage, bible.gated_at);
  setStage(userId, sessionId, "bible");
  return getBible(userId, sessionId)!;
}

export async function gateBible(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<WeaverBible> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  const bible = getBible(userId, sessionId);
  if (!bible) throw new Error("No Bible to check yet");

  const applicable = applicableBibleCriteria(reg.bibleGateCriteria, bible.spine);
  const gateRes = await weaverGenerateJsonWithUsage({
    userId,
    session,
    system: buildBibleGatePrompt(reg, applicable),
    user: buildBibleGateUserMessage(reg, bible.spine, session.seed.text, seedSourceNoun(session.seed.type)),
    temperature: 0.2,
    kind: "review",
    signal,
  });
  const verdict = buildGateVerdict(gateRes.data, applicable);
  const status = deriveStatus(verdict);
  const usage = addUsage(bible.token_usage, gateRes.usage);

  persist(userId, sessionId, bible.spine, status, verdict, usage, Math.floor(Date.now() / 1000));
  return getBible(userId, sessionId)!;
}

export function syncDynamicRegion(userId: string, sessionId: string): WeaverBible | null {
  const bible = getBible(userId, sessionId);
  if (!bible) return null;

  const known = new Set(bible.spine.dynamic.map((d) => d.id));
  const fresh = getDynamicEntries(userId, sessionId).filter((d) => !known.has(d.id));
  if (fresh.length === 0) return bible;

  const spine: WeaverBibleSpine = {
    ...bible.spine,
    dynamic: [...bible.spine.dynamic, ...fresh],
  };
  persist(userId, sessionId, spine, bible.status, bible.gate, bible.token_usage, bible.gated_at);
  return getBible(userId, sessionId);
}

export function updateBible(
  userId: string,
  sessionId: string,
  input: UpdateWeaverBibleInput,
): WeaverBible {
  const reg = regFor(userId, sessionId);
  const bible = getBible(userId, sessionId);
  if (!bible) throw new Error("No Bible to edit yet");

  const entries =
    input.entries === undefined
      ? bible.spine.entries
      : input.entries
          .filter((e) => isSlotId(reg.slots, e.slot) && typeof e.content === "string" && e.content.trim())
          .map((e) => {
            const entry: WeaverBibleEntry = {
              slot: e.slot,
              content: e.content.trim(),
              origin: coerceOrigin(e.origin),
            };
            return e.parts ? { ...entry, parts: parseEntryParts(e.parts) } : entry;
          });

  const causal_links =
    input.causal_links === undefined ? bible.spine.causal_links : coerceLinks(reg.slots, input.causal_links);

  const brief = input.brief === undefined ? bible.spine.brief : input.brief.trim();

  const spine: WeaverBibleSpine = { entries, causal_links, brief, dynamic: bible.spine.dynamic };
  persist(userId, sessionId, spine, "pending", bible.gate, bible.token_usage, bible.gated_at);
  return getBible(userId, sessionId)!;
}
