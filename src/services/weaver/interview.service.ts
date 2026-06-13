import { getDb } from "../../db/connection";
import { getSession } from "./session.service";
import { getExtraction, addCommittedFact, revertSlotsToGaps, forgetSlots } from "./extraction.service";
import { isSlotId, slotParts, slotHasElicit, getSlot, IMPACT_WEIGHT } from "./slots";
import { getBuildRegistry, type WeaverBuildRegistry } from "./build-registry";
import {
  getDynamicState,
  answerDynamicQuestion,
  clearDynamicLane,
  MAX_DYNAMIC_QUESTIONS,
} from "./dynamic-question.service";
import { buildDynamicQuestionVerdict } from "./dynamic-question-gate";
import { weaverGenerateJson } from "./llm";
import {
  buildInterviewerPrompt,
  buildInterviewerUserMessage,
  buildQuestionGatePrompt,
  buildQuestionGateUserMessage,
  buildSparkPrompt,
  buildSparkUserMessage,
  buildEnhancePrompt,
  buildEnhanceUserMessage,
  buildSpilloverPrompt,
  buildSpilloverUserMessage,
} from "./prompts";
import { seedSourceNoun } from "./seed-adapter";
import { DYNAMIC_TARGET, OPT_IN_PREFIX } from "../../types/weaver";
import type {
  WeaverInterviewTurn,
  WeaverInterviewState,
  WeaverInterviewPhase,
  WeaverInterviewQuestion,
  WeaverElicitTarget,
  WeaverCandidate,
  WeaverTasteProfile,
  WeaverResponseKind,
  WeaverFactSource,
  WeaverCommittedFact,
  GenerateQuestionInput,
  AnswerInterviewQuestionInput,
  SparkQuestionInput,
  EnhanceAnswerInput,
} from "../../types/weaver";

const RESPONSE_KINDS: readonly WeaverResponseKind[] = [
  "typed",
  "picked",
  "enhanced",
  "pick",
  "blend",
  "redirect",
  "inferred",
];

const KIND_SOURCE: Partial<Record<WeaverResponseKind, WeaverFactSource>> = {
  typed: "user",
  picked: "picked",
  enhanced: "enhanced",
  pick: "picked",
};

function sourceForKind(kind: WeaverResponseKind): WeaverFactSource {
  return KIND_SOURCE[kind] ?? "user";
}

const QUESTION_ATTEMPTS = 3;

export function getTaste(userId: string): WeaverTasteProfile {
  const row = getDb()
    .prepare(`SELECT profile FROM weaver_taste WHERE user_id = ?`)
    .get(userId) as { profile?: string } | undefined;
  if (!row?.profile) return { steers: [] };
  try {
    const parsed = JSON.parse(row.profile);
    const steers = Array.isArray(parsed?.steers)
      ? parsed.steers.filter((s: unknown) => typeof s === "string" && s.trim())
      : [];
    return { steers };
  } catch {
    return { steers: [] };
  }
}

const MAX_STEERS = 24;

export function addSteer(userId: string, steer: string): void {
  const trimmed = steer.trim();
  if (!trimmed) return;
  const taste = getTaste(userId);
  const steers = [...taste.steers.filter((s) => s !== trimmed), trimmed].slice(-MAX_STEERS);
  getDb()
    .prepare(
      `INSERT INTO weaver_taste (user_id, profile, updated_at)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(user_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`,
    )
    .run(userId, JSON.stringify({ steers }));
}

function rowToTurn(row: any): WeaverInterviewTurn {
  const addr = typeof row.slot === "string" ? row.slot : "";
  const sep = addr.indexOf(":");
  const slot = sep >= 0 ? addr.slice(0, sep) : addr;
  const part = sep >= 0 ? addr.slice(sep + 1) : "";
  return {
    id: row.id,
    session_id: row.session_id,
    seq: row.seq,
    slot,
    part,
    question: parseTurnQuestion(row.axis),
    response_kind: RESPONSE_KINDS.includes(row.response_kind) ? row.response_kind : "typed",
    response: typeof row.response === "string" ? safeText(row.response) : "",
    created_at: row.created_at,
  };
}

export function parseTurnQuestion(value: unknown): { prompt: string; why: string } {
  if (typeof value !== "string") return { prompt: "", why: "" };
  try {
    const o = JSON.parse(value);
    const prompt =
      typeof o?.prompt === "string" ? o.prompt : typeof o?.name === "string" ? o.name : "";
    const why =
      typeof o?.why === "string" ? o.why : typeof o?.description === "string" ? o.description : "";
    return { prompt, why };
  } catch {
    return { prompt: "", why: "" };
  }
}

function safeText(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof parsed.content === "string") return parsed.content;
  } catch {
  }
  return value;
}

function listTurns(userId: string, sessionId: string): WeaverInterviewTurn[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM weaver_interview_turns
        WHERE session_id = ? AND user_id = ?
        ORDER BY seq ASC`,
    )
    .all(sessionId, userId) as any[];
  return rows.map(rowToTurn);
}

function nextSeq(sessionId: string): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM weaver_interview_turns WHERE session_id = ?`)
    .get(sessionId) as { next: number };
  return row.next;
}

function partCovered(reg: WeaverBuildRegistry, facts: WeaverCommittedFact[], slot: string, part: string): boolean {
  const hybrid = slotParts(reg.slots, slot).length > 1;
  return facts.some((f) => f.slot === slot && (hybrid ? f.part === part : true));
}

function remainingTargets(reg: WeaverBuildRegistry, userId: string, sessionId: string): WeaverElicitTarget[] {
  const extraction = getExtraction(userId, sessionId);
  if (!extraction) return [];
  const facts = extraction.committed_facts;
  const gapSlots = new Set(extraction.gaps.map((g) => g.slot));
  const targets: WeaverElicitTarget[] = [];
  for (const slot of reg.slots) {
    if (!gapSlots.has(slot.id) || !slotHasElicit(reg.slots, slot.id)) continue;
    for (const p of slotParts(reg.slots, slot.id)) {
      if (p.fill !== "elicit") continue;
      if (!partCovered(reg, facts, slot.id, p.id)) {
        targets.push({ slot: slot.id, part: p.id, label: p.label });
      }
    }
  }
  return targets.sort(
    (a, b) =>
      IMPACT_WEIGHT[getSlot(reg.slots, b.slot)?.impact ?? "low"] -
      IMPACT_WEIGHT[getSlot(reg.slots, a.slot)?.impact ?? "low"],
  );
}

function interviewPhase(session: { interview_started_at: number | null; interview_completed_at: number | null }): WeaverInterviewPhase {
  if (session.interview_completed_at) return "complete";
  if (session.interview_started_at) return "active";
  return "pending";
}

function optInAddr(slotId: string): string {
  return `${OPT_IN_PREFIX}:${slotId}`;
}

export function pendingOptIn(
  reg: WeaverBuildRegistry,
  facts: readonly WeaverCommittedFact[],
  gaps: ReadonlySet<string>,
  turns: readonly WeaverInterviewTurn[],
  essentialsCovered: boolean,
): { slot: string } | null {
  if (!essentialsCovered) return null;
  for (const slot of reg.slots) {
    if (!slot.optIn) continue;
    if (facts.some((f) => f.slot === slot.id && f.fact.trim())) continue;
    if (gaps.has(slot.id)) continue;
    if (turns.some((t) => t.slot === OPT_IN_PREFIX && t.part === slot.id)) continue;
    return { slot: slot.id };
  }
  return null;
}

export function getInterviewState(userId: string, sessionId: string): WeaverInterviewState {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  const answered = listTurns(userId, sessionId);
  const remaining = remainingTargets(reg, userId, sessionId);
  const dynamic = getDynamicState(userId, sessionId);
  const extraction = getExtraction(userId, sessionId);
  const optIn = extraction
    ? pendingOptIn(
        reg,
        extraction.committed_facts,
        new Set(extraction.gaps.map((g) => g.slot)),
        answered,
        remaining.length === 0,
      )
    : null;
  return {
    phase: interviewPhase(session),
    answered,
    remaining_targets: remaining,
    no_gaps_remaining: remaining.length === 0,
    dynamic_count: dynamic.items.length,
    at_dynamic_cap: dynamic.at_cap,
    opt_in: optIn,
  };
}

export function decideOptIn(
  userId: string,
  sessionId: string,
  slotId: string,
  enabled: boolean,
): WeaverInterviewState {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  const slot = getSlot(reg.slots, slotId);
  if (!slot?.optIn) throw new Error("This slot is not an opt-in");

  const decided = listTurns(userId, sessionId).some(
    (t) => t.slot === OPT_IN_PREFIX && t.part === slotId,
  );
  if (!decided) {
    const prompt = `Does this ${reg.subject.noun} push back?`;
    const response = enabled
      ? "Yes. It pursues its own agenda and holds hard lines."
      : "No. It hosts the scenes and follows the lead.";
    getDb()
      .prepare(
        `INSERT INTO weaver_interview_turns
           (id, session_id, user_id, seq, slot, axis, response_kind, response, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      )
      .run(
        crypto.randomUUID(),
        sessionId,
        userId,
        nextSeq(sessionId),
        optInAddr(slotId),
        JSON.stringify({ prompt, why: "", target: optInAddr(slotId) }),
        "picked",
        JSON.stringify(response),
      );
    if (enabled) revertSlotsToGaps(userId, sessionId, [slotId]);
  }

  return getInterviewState(userId, sessionId);
}

export function beginInterview(userId: string, sessionId: string): WeaverInterviewState {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  if (!session.interview_started_at) {
    getDb()
      .prepare(
        `UPDATE weaver_sessions
            SET interview_started_at = unixepoch(), stage = 'interview', updated_at = unixepoch()
          WHERE id = ? AND user_id = ?`,
      )
      .run(sessionId, userId);
  }
  return getInterviewState(userId, sessionId);
}

export function completeInterview(userId: string, sessionId: string): WeaverInterviewState {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  getDb()
    .prepare(
      `UPDATE weaver_sessions
          SET interview_completed_at = unixepoch(),
              interview_started_at = COALESCE(interview_started_at, unixepoch()),
              updated_at = unixepoch()
        WHERE id = ? AND user_id = ?`,
    )
    .run(sessionId, userId);
  return getInterviewState(userId, sessionId);
}

function coerceCandidates(value: unknown): WeaverCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: WeaverCandidate[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const caption = (raw as any).caption;
    const content = (raw as any).content;
    if (typeof content !== "string" || !content.trim()) continue;
    out.push({
      caption: typeof caption === "string" ? caption.trim() : "",
      content: content.trim(),
    });
  }
  return out;
}

function targetAddr(t: WeaverElicitTarget): string {
  return t.part && t.part !== t.slot ? `${t.slot}:${t.part}` : t.slot;
}

function priorityFor(reg: WeaverBuildRegistry, t: WeaverElicitTarget): { target: string; label: string; description?: string } {
  const slot = getSlot(reg.slots, t.slot);
  const hybrid = slotParts(reg.slots, t.slot).length > 1;
  const partDef = slotParts(reg.slots, t.slot).find((p) => p.id === t.part);
  const label =
    hybrid && partDef ? `${slot?.label ?? t.slot} — ${partDef.label}` : slot?.label ?? t.slot;
  const description = (hybrid ? partDef?.description : undefined) ?? slot?.description;
  return { target: targetAddr(t), label, ...(description ? { description } : {}) };
}

function fallbackQuestion(reg: WeaverBuildRegistry, t: WeaverElicitTarget): WeaverInterviewQuestion {
  const p = priorityFor(reg, t);
  return {
    id: crypto.randomUUID(),
    prompt: `${p.label} is still open for this ${reg.subject.noun}${p.description ? ` — ${p.description}` : ""}. What feels true here, in your own words?`,
    why: "This essential is still open; anything you give beats a guess from me.",
    target: p.target,
  };
}

export async function generateQuestion(
  userId: string,
  sessionId: string,
  input: GenerateQuestionInput = {},
  signal?: AbortSignal,
  opts: { ignoreCap?: boolean } = {},
): Promise<WeaverInterviewQuestion | null> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  const extraction = getExtraction(userId, sessionId);
  if (!extraction) throw new Error("Read the dream first — there is nothing to ask about yet");

  const remaining = remainingTargets(reg, userId, sessionId);
  const dynamic = getDynamicState(userId, sessionId);
  if (!opts.ignoreCap && remaining.length === 0 && dynamic.at_cap) return null;

  if (!session.interview_started_at) {
    getDb()
      .prepare(
        `UPDATE weaver_sessions
            SET interview_started_at = unixepoch(), stage = 'interview', updated_at = unixepoch()
          WHERE id = ? AND user_id = ?`,
      )
      .run(sessionId, userId);
  }

  const facts = extraction.committed_facts;
  const taste = getTaste(userId);
  const turns = listTurns(userId, sessionId);
  const asked = turns
    .filter((t) => t.question.prompt)
    .map((t) => ({ prompt: t.question.prompt, response: t.response }));
  const priorities = remaining.map((t) => priorityFor(reg, t));
  const allowedTargets = new Set(priorities.map((p) => p.target));
  const dream = session.seed.text;
  const sourceNoun = seedSourceNoun(session.seed.type);

  const avoid = [...(input.avoid ?? [])];
  for (let attempt = 0; attempt < QUESTION_ATTEMPTS; attempt++) {
    const proposal = await weaverGenerateJson({
      userId,
      session,
      system: buildInterviewerPrompt(reg, sourceNoun),
      user: buildInterviewerUserMessage(reg, {
        dream,
        facts,
        asked,
        priorities,
        dynamicItems: dynamic.items,
        taste,
        steer: input.steer,
        avoid,
        source_noun: sourceNoun,
      }),
      temperature: 0.9,
      signal,
    });

    const prompt = typeof proposal.prompt === "string" ? proposal.prompt.trim() : "";
    const why = typeof proposal.why === "string" ? proposal.why.trim() : "";
    if (!prompt) continue;

    let target =
      typeof proposal.target === "string" ? proposal.target.trim().replace(".", ":") : "";
    if (remaining.length === 0) {
      target = DYNAMIC_TARGET;
    } else if (!allowedTargets.has(target)) {
      avoid.push(prompt);
      continue;
    }

    const gateRaw = await weaverGenerateJson({
      userId,
      session,
      system: buildQuestionGatePrompt(reg),
      user: buildQuestionGateUserMessage(reg, { prompt, why, dream, facts, asked, source_noun: sourceNoun }),
      temperature: 0.2,
      kind: "review",
      signal,
    });
    if (buildDynamicQuestionVerdict(gateRaw, reg.questionGateCriteria).passed) {
      return { id: crypto.randomUUID(), prompt, why, target };
    }
    avoid.push(prompt);
  }

  return remaining.length > 0 ? fallbackQuestion(reg, remaining[0]) : null;
}

const MAX_SPILLOVER_FACTS = 4;

async function harvestSpillover(
  userId: string,
  sessionId: string,
  session: NonNullable<ReturnType<typeof getSession>>,
  input: { prompt: string; target: string; answer: string; kind: WeaverResponseKind },
  signal?: AbortSignal,
): Promise<void> {
  try {
    const extraction = getExtraction(userId, sessionId);
    if (!extraction) return;
    const reg = getBuildRegistry(session.build_type);
    const res = await weaverGenerateJson({
      userId,
      session,
      system: buildSpilloverPrompt(reg),
      user: buildSpilloverUserMessage(reg, {
        prompt: input.prompt,
        target: input.target,
        answer: input.answer,
        facts: extraction.committed_facts,
        source_noun: seedSourceNoun(session.seed.type),
      }),
      temperature: 0.2,
      kind: "review",
      signal,
    });
    const raw = Array.isArray((res as Record<string, unknown>).facts)
      ? ((res as Record<string, unknown>).facts as unknown[])
      : [];
    const source = sourceForKind(input.kind);
    for (const item of raw.slice(0, MAX_SPILLOVER_FACTS)) {
      if (!item || typeof item !== "object") continue;
      const slot = (item as any).slot;
      const fact = (item as any).fact;
      if (!isSlotId(reg.slots, slot) || typeof fact !== "string" || !fact.trim()) continue;
      const part = typeof (item as any).part === "string" && (item as any).part.trim() ? (item as any).part.trim() : undefined;
      const addr = part ? `${slot}:${part}` : slot;
      if (addr === input.target || slot === input.target) continue;
      addCommittedFact(userId, sessionId, slot, fact.trim(), part, source);
    }
  } catch {
  }
}

export async function answerQuestion(
  userId: string,
  sessionId: string,
  input: AnswerInterviewQuestionInput,
  signal?: AbortSignal,
): Promise<WeaverInterviewState> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const q = input.question;
  if (!q || typeof q.prompt !== "string" || !q.prompt.trim()) throw new Error("Missing question");
  const content = input.content?.trim();
  if (!content) throw new Error("Answer is empty");
  const kind: WeaverResponseKind = RESPONSE_KINDS.includes(input.kind) ? input.kind : "typed";
  const prompt = q.prompt.trim();
  const target = typeof q.target === "string" ? q.target.trim() : "";

  let addr: string;
  if (target === DYNAMIC_TARGET) {
    answerDynamicQuestion(userId, sessionId, {
      id: typeof q.id === "string" && q.id.trim() ? q.id : crypto.randomUUID(),
      question: prompt,
      answer: content,
    });
    addr = DYNAMIC_TARGET;
  } else {
    const reg = getBuildRegistry(session.build_type);
    const sep = target.indexOf(":");
    const slot = sep >= 0 ? target.slice(0, sep) : target;
    const part = sep >= 0 ? target.slice(sep + 1) : "";
    if (!isSlotId(reg.slots, slot)) throw new Error("Invalid question target");
    const validPart = part && slotParts(reg.slots, slot).some((p) => p.id === part) ? part : "";
    addCommittedFact(userId, sessionId, slot, content, validPart || undefined, sourceForKind(kind));
    addr = validPart && validPart !== slot ? `${slot}:${validPart}` : slot;
  }

  const id = crypto.randomUUID();
  const seq = nextSeq(sessionId);
  getDb()
    .prepare(
      `INSERT INTO weaver_interview_turns
         (id, session_id, user_id, seq, slot, axis, response_kind, response, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    )
    .run(
      id,
      sessionId,
      userId,
      seq,
      addr,
      JSON.stringify({ prompt, why: (q.why ?? "").trim(), target: target || addr }),
      kind,
      JSON.stringify(content),
    );

  if (input.steer && input.steer.trim()) addSteer(userId, input.steer);

  await harvestSpillover(
    userId,
    sessionId,
    session,
    { prompt, target: addr, answer: content, kind },
    signal,
  );

  return getInterviewState(userId, sessionId);
}

export async function sparkQuestion(
  userId: string,
  sessionId: string,
  input: SparkQuestionInput,
  signal?: AbortSignal,
): Promise<WeaverCandidate[]> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const extraction = getExtraction(userId, sessionId);
  if (!extraction) throw new Error("Read the dream first — there is nothing to ask about yet");
  const q = input.question;
  if (!q || typeof q.prompt !== "string" || !q.prompt.trim()) throw new Error("Missing question");
  const reg = getBuildRegistry(session.build_type);

  const res = await weaverGenerateJson({
    userId,
    session,
    system: buildSparkPrompt(reg, seedSourceNoun(session.seed.type)),
    user: buildSparkUserMessage(reg, {
      prompt: q.prompt.trim(),
      why: typeof q.why === "string" ? q.why.trim() : "",
      dream: session.seed.text,
      facts: extraction.committed_facts,
      taste: getTaste(userId),
      steer: input.steer,
      avoid: input.avoid,
      source_noun: seedSourceNoun(session.seed.type),
    }),
    temperature: 0.9,
    signal,
  });
  const options = coerceCandidates(res.options);
  if (options.length === 0) throw new Error("The model returned no usable options");
  return options;
}

export async function enhanceAnswer(
  userId: string,
  sessionId: string,
  input: EnhanceAnswerInput,
  signal?: AbortSignal,
): Promise<WeaverCandidate[]> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const extraction = getExtraction(userId, sessionId);
  if (!extraction) throw new Error("Read the dream first — there is nothing to ask about yet");
  const q = input.question;
  if (!q || typeof q.prompt !== "string" || !q.prompt.trim()) throw new Error("Missing question");
  const draft = input.draft?.trim();
  if (!draft) throw new Error("Write a draft answer first — there is nothing to extend");

  const res = await weaverGenerateJson({
    userId,
    session,
    system: buildEnhancePrompt(),
    user: buildEnhanceUserMessage(getBuildRegistry(session.build_type), {
      prompt: q.prompt.trim(),
      draft,
      dream: session.seed.text,
      facts: extraction.committed_facts,
      source_noun: seedSourceNoun(session.seed.type),
    }),
    temperature: 0.7,
    signal,
  });
  const options = coerceCandidates(res.options);
  if (options.length === 0) throw new Error("The model returned no usable options");
  return options;
}

export function resetInterview(userId: string, sessionId: string): WeaverInterviewState {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const turns = listTurns(userId, sessionId);
  const slots = [...new Set(turns.map((t) => t.slot))];
  const reg = getBuildRegistry(session.build_type);
  const optInSlots = slots.filter((s) => getSlot(reg.slots, s)?.optIn);
  const revert = slots.filter((s) => !optInSlots.includes(s));
  if (revert.length > 0) revertSlotsToGaps(userId, sessionId, revert);
  if (optInSlots.length > 0) forgetSlots(userId, sessionId, optInSlots);

  getDb()
    .prepare(`DELETE FROM weaver_interview_turns WHERE session_id = ? AND user_id = ?`)
    .run(sessionId, userId);

  clearDynamicLane(userId, sessionId);

  getDb()
    .prepare(
      `UPDATE weaver_sessions
          SET interview_completed_at = NULL,
              interview_started_at = unixepoch(),
              stage = 'interview',
              updated_at = unixepoch()
        WHERE id = ? AND user_id = ?`,
    )
    .run(sessionId, userId);

  return getInterviewState(userId, sessionId);
}
