import { getDb } from "../../db/connection";
import { getSession, setStage } from "./session.service";
import { getBible } from "./bible.service";
import { addSteer } from "./interview.service";
import { getField as getFieldDef, rankByOrder, isFieldId } from "./fields";
import { getBuildRegistry, type WeaverBuildRegistry } from "./build-registry";
import {
  criteriaForKind,
  buildFieldGateVerdict,
  deriveFieldStatus,
} from "./field-gate";
import {
  buildFieldRenderPrompt,
  buildFieldRenderUserMessage,
  buildFieldReviseUserMessage,
  buildFieldNudgeUserMessage,
  buildFieldGatePrompt,
  buildFieldGateUserMessage,
} from "./prompts";
import { getNarrationMode } from "./narration";
import {
  weaverGenerateTextWithUsage,
  weaverGenerateJsonWithUsage,
  type WeaverUsage,
} from "./llm";
import type {
  WeaverField,
  WeaverFieldStatus,
  WeaverFieldProvenance,
  WeaverGateVerdict,
  WeaverTokenUsage,
  WeaverSession,
} from "../../types/weaver";
import type { WeaverFieldDef } from "./fields";
import type { WeaverBibleSpine } from "../../types/weaver";

const RENDER_CONCURRENCY = 3;

const HAND_EDIT_GUARD = "This field is hand-edited — re-rendering it will replace your edit.";

interface RenderFieldOpts {
  signal?: AbortSignal;
  force?: boolean;
  nudge?: string;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function spineContentHash(spine: WeaverBibleSpine): string {
  const entries = [...spine.entries]
    .sort((a, b) => a.slot.localeCompare(b.slot))
    .map((e) => `${e.slot}${e.content}${e.origin}`)
    .join("");
  const links = [...spine.causal_links]
    .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
    .map((l) => `${l.from}${l.to}${l.relation}`)
    .join("");
  return fnv1aHex(`${spine.brief}${entries}${links}`);
}

/** Derived stale flag for a field, compared to the live Bible. Direct fields never go stale (4.4). */
function deriveStale(def: WeaverFieldDef, field: WeaverField, currentHash: string | null): boolean {
  if (def.render === "direct") return false;
  const fingerprint = field.provenance.bible_spine_hash;
  return currentHash != null && fingerprint != null && fingerprint !== currentHash;
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


/** Deterministic row id: one row per (session, field). Lets us upsert on the PK. */
function fieldRowId(sessionId: string, fieldId: string): string {
  return `${sessionId}:${fieldId}`;
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

function parseVerdict(value: unknown): WeaverGateVerdict | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  if (!Array.isArray(obj.criteria) && typeof obj.summary !== "string") return null;
  const criteria = Array.isArray(obj.criteria)
    ? obj.criteria
        .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object")
        .map((c) => ({
          key: typeof c.key === "string" ? c.key : "",
          label: typeof c.label === "string" ? c.label : "",
          passed: c.passed === true,
          note: typeof c.note === "string" ? c.note : "",
        }))
        .filter((c) => c.key)
    : [];
  return {
    passed: obj.passed === true,
    criteria,
    summary: typeof obj.summary === "string" ? obj.summary : "",
  };
}

function parseProvenance(value: unknown): WeaverFieldProvenance {
  const obj = parseObject(value);
  const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const status = obj.bible_status;
  return {
    bible_gated_at: numOrNull(obj.bible_gated_at),
    bible_updated_at: numOrNull(obj.bible_updated_at),
    bible_status: status === "gated" || status === "flagged" ? status : "pending",
    gate: parseVerdict(obj.gate),
    revised: obj.revised === true,
    bible_spine_hash: typeof obj.bible_spine_hash === "string" ? obj.bible_spine_hash : null,
    accepted: obj.accepted === true,
    nudge: typeof obj.nudge === "string" && obj.nudge.trim() ? obj.nudge : undefined,
  };
}

function parseStatus(value: unknown): WeaverFieldStatus {
  const allowed: WeaverFieldStatus[] = [
    "pending",
    "streaming",
    "passed",
    "flagged",
    "stale",
    "manually_edited",
  ];
  return allowed.includes(value as WeaverFieldStatus) ? (value as WeaverFieldStatus) : "pending";
}

function rowToField(row: Record<string, unknown>): WeaverField {
  return {
    id: row.id as string,
    session_id: row.session_id as string,
    field_name: row.field_name as string,
    content: (row.content as string) ?? "",
    status: parseStatus(row.status),
    provenance: parseProvenance(row.provenance),
    token_usage: parseUsage(row.token_usage),
    updated_at: (row.updated_at as number) ?? 0,
  };
}

function persistField(
  userId: string,
  sessionId: string,
  fieldId: string,
  content: string,
  status: WeaverFieldStatus,
  provenance: WeaverFieldProvenance,
  usage: WeaverTokenUsage,
): void {
  getDb()
    .prepare(
      `INSERT INTO weaver_fields (id, session_id, user_id, field_name, content, status, provenance, token_usage, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         status = excluded.status,
         provenance = excluded.provenance,
         token_usage = excluded.token_usage,
         updated_at = excluded.updated_at`,
    )
    .run(
      fieldRowId(sessionId, fieldId),
      sessionId,
      userId,
      fieldId,
      content,
      status,
      JSON.stringify(provenance),
      JSON.stringify(usage),
    );
}

/** The live Bible's content fingerprint, or null if there is no Bible yet. */
function currentSpineHash(userId: string, sessionId: string): string | null {
  const bible = getBible(userId, sessionId);
  return bible ? spineContentHash(bible.spine) : null;
}

function regFor(userId: string, sessionId: string): WeaverBuildRegistry {
  const session = getSession(userId, sessionId);
  return getBuildRegistry(session?.build_type ?? "");
}

/** All rendered fields for a session, in registry render order, with derived stale (4.1). */
export function getFields(userId: string, sessionId: string): WeaverField[] {
  const reg = regFor(userId, sessionId);
  const rows = getDb()
    .prepare(`SELECT * FROM weaver_fields WHERE session_id = ? AND user_id = ?`)
    .all(sessionId, userId) as Record<string, unknown>[];
  const byName = new Map(rows.map((r) => [r.field_name as string, rowToField(r)]));
  const currentHash = currentSpineHash(userId, sessionId);
  return rankByOrder(reg.fieldDefs).flatMap<WeaverField>((def) => {
    const field = byName.get(def.id);
    return field ? [{ ...field, stale: deriveStale(def, field, currentHash) }] : [];
  });
}

/** One rendered field by id (with derived stale), or null if it hasn't been rendered yet. */
export function getField(userId: string, sessionId: string, fieldId: string): WeaverField | null {
  const row = getDb()
    .prepare(`SELECT * FROM weaver_fields WHERE session_id = ? AND user_id = ? AND field_name = ?`)
    .get(sessionId, userId, fieldId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const field = rowToField(row);
  const def = getFieldDef(regFor(userId, sessionId).fieldDefs, fieldId);
  return { ...field, stale: def ? deriveStale(def, field, currentSpineHash(userId, sessionId)) : false };
}


function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /abort|cancel/i.test(err.message))
  );
}

/** A verdict synthesized for a hard render failure — the reason lives in summary. */
function failureVerdict(message: string): WeaverGateVerdict {
  return { passed: false, criteria: [], summary: message };
}

async function gateContent(
  userId: string,
  session: WeaverSession,
  reg: WeaverBuildRegistry,
  field: WeaverFieldDef,
  content: string,
  spine: WeaverBibleSpine,
  signal?: AbortSignal,
): Promise<{ verdict: WeaverGateVerdict; usage: WeaverUsage }> {
  const res = await weaverGenerateJsonWithUsage({
    userId,
    session,
    system: buildFieldGatePrompt(reg, field),
    user: buildFieldGateUserMessage(reg, { field, content, spine }),
    temperature: 0.2,
    kind: "review",
    signal,
  });
  return {
    verdict: buildFieldGateVerdict(res.data, criteriaForKind(reg.fieldGateCriteria, field.kind)),
    usage: res.usage,
  };
}

export async function renderField(
  userId: string,
  sessionId: string,
  fieldId: string,
  opts: RenderFieldOpts = {},
): Promise<WeaverField> {
  const { signal, force, nudge } = opts;
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  if (!isFieldId(reg.fieldDefs, fieldId)) throw new Error(`Unknown field: ${fieldId}`);
  const field = getFieldDef(reg.fieldDefs, fieldId)!;

  const existing = getField(userId, sessionId, fieldId);
  if (existing?.status === "manually_edited" && !force) throw new Error(HAND_EDIT_GUARD);

  const bible = getBible(userId, sessionId);
  if (!bible) throw new Error("Synthesize a Bible first — there is nothing to render from");
  if (bible.spine.entries.length === 0) throw new Error("The Bible has no spine yet — synthesize it first");

  const spine = bible.spine;
  const provenanceBase = {
    bible_gated_at: bible.gated_at,
    bible_updated_at: bible.updated_at,
    bible_status: bible.status,
    bible_spine_hash: spineContentHash(spine),
  };

  if (field.render === "direct") {
    const entry = field.directSlot
      ? spine.entries.find((e) => e.slot === field.directSlot)
      : undefined;
    const content = entry?.content.trim() ?? "";
    const verdict: WeaverGateVerdict = content
      ? {
          passed: true,
          criteria: [],
          summary:
            "Carried straight from the Bible — this is already established, so it isn't generated or gated by the model.",
        }
      : failureVerdict("The Bible has no value for this field yet — go back and complete it.");
    const provenance: WeaverFieldProvenance = { ...provenanceBase, gate: verdict, revised: false };
    persistField(userId, sessionId, field.id, content, content ? "passed" : "flagged", provenance, emptyUsage());
    setStage(userId, sessionId, "render");
    return getField(userId, sessionId, field.id)!;
  }

  const steer = nudge?.trim() || undefined;
  try {
    const render = await weaverGenerateTextWithUsage({
      userId,
      session,
      system: buildFieldRenderPrompt(reg, field, getNarrationMode(session.narration_mode)),
      user: steer
        ? buildFieldNudgeUserMessage(reg, { field, spine, nudge: steer, previous: existing?.content })
        : buildFieldRenderUserMessage(reg, { field, spine }),
      temperature: 0.7,
      signal,
    });
    let content = render.text.trim();
    if (!content) throw new Error("The model returned an empty field");
    let usage = addUsage(emptyUsage(), render.usage);

    let gate = await gateContent(userId, session, reg, field, content, spine, signal);
    usage = addUsage(usage, gate.usage);
    let revised = false;

    if (!gate.verdict.passed) {
      const revise = await weaverGenerateTextWithUsage({
        userId,
        session,
        system: buildFieldRenderPrompt(reg, field, getNarrationMode(session.narration_mode)),
        user: buildFieldReviseUserMessage(reg, { field, spine, previous: content, verdict: gate.verdict }),
        temperature: 0.7,
        signal,
      });
      const revisedText = revise.text.trim();
      if (revisedText) {
        content = revisedText;
        revised = true;
        usage = addUsage(usage, revise.usage);
        gate = await gateContent(userId, session, reg, field, content, spine, signal);
        usage = addUsage(usage, gate.usage);
      }
    }

    const status = deriveFieldStatus(gate.verdict);
    const provenance: WeaverFieldProvenance = { ...provenanceBase, gate: gate.verdict, revised, nudge: steer };
    persistField(userId, sessionId, field.id, content, status, provenance, usage);
  } catch (err) {
    if (isAbort(err)) throw err;
    const reason = err instanceof Error ? err.message : "Render failed";
    const provenance: WeaverFieldProvenance = {
      ...provenanceBase,
      gate: failureVerdict(reason),
      revised: false,
      nudge: steer,
    };
    persistField(userId, sessionId, field.id, "", "flagged", provenance, emptyUsage());
  }

  if (steer) addSteer(userId, steer);

  setStage(userId, sessionId, "render");
  return getField(userId, sessionId, field.id)!;
}

export async function renderAllFields(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<WeaverField[]> {
  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const reg = getBuildRegistry(session.build_type);
  const bible = getBible(userId, sessionId);
  if (!bible) throw new Error("Synthesize a Bible first — there is nothing to render from");
  if (bible.spine.entries.length === 0) throw new Error("The Bible has no spine yet — synthesize it first");

  const locked = new Set(
    getFields(userId, sessionId)
      .filter((f) => f.status === "manually_edited" || f.provenance.accepted === true)
      .map((f) => f.field_name),
  );
  const defs = rankByOrder(reg.fieldDefs).filter((def) => !locked.has(def.id));
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < defs.length) {
      if (signal?.aborted) throw new Error("Render cancelled");
      const def = defs[cursor++];
      await renderField(userId, sessionId, def.id, { signal });
    }
  }
  const workerCount = Math.min(RENDER_CONCURRENCY, defs.length);
  if (workerCount > 0) await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return getFields(userId, sessionId);
}

export async function reRenderField(
  userId: string,
  sessionId: string,
  fieldId: string,
  opts: { signal?: AbortSignal; force?: boolean } = {},
): Promise<WeaverField> {
  return renderField(userId, sessionId, fieldId, opts);
}

export async function reRenderWithNudge(
  userId: string,
  sessionId: string,
  fieldId: string,
  nudge: string,
  opts: { signal?: AbortSignal; force?: boolean } = {},
): Promise<WeaverField> {
  const steer = nudge.trim();
  if (!steer) throw new Error("Add a nudge to steer the re-render");
  return renderField(userId, sessionId, fieldId, { signal: opts.signal, force: opts.force, nudge: steer });
}

export function editField(
  userId: string,
  sessionId: string,
  fieldId: string,
  content: string,
): WeaverField {
  if (!isFieldId(regFor(userId, sessionId).fieldDefs, fieldId)) throw new Error(`Unknown field: ${fieldId}`);
  const existing = getField(userId, sessionId, fieldId);
  if (!existing) throw new Error("Render the field first — there is nothing to edit yet");
  const trimmed = content.trim();
  if (!trimmed) throw new Error("A field cannot be empty");

  const provenance: WeaverFieldProvenance = {
    ...existing.provenance,
    bible_spine_hash: currentSpineHash(userId, sessionId) ?? existing.provenance.bible_spine_hash ?? null,
    accepted: false,
    nudge: undefined,
  };
  persistField(userId, sessionId, fieldId, trimmed, "manually_edited", provenance, existing.token_usage);
  return getField(userId, sessionId, fieldId)!;
}

export function acceptField(
  userId: string,
  sessionId: string,
  fieldId: string,
  accepted: boolean,
): WeaverField {
  if (!isFieldId(regFor(userId, sessionId).fieldDefs, fieldId)) throw new Error(`Unknown field: ${fieldId}`);
  const existing = getField(userId, sessionId, fieldId);
  if (!existing) throw new Error("Render the field first — there is nothing to accept yet");
  const provenance: WeaverFieldProvenance = { ...existing.provenance, accepted };
  persistField(userId, sessionId, fieldId, existing.content, existing.status, provenance, existing.token_usage);
  return getField(userId, sessionId, fieldId)!;
}
