import { getDb } from "../../db/connection";
import { DEFAULT_BUILD_TYPE, getBuildType, isEnabledBuildType } from "./build-types";
import { getBuildRegistry } from "./build-registry";
import {
  emptyPersonaPlan,
  type WeaverSession,
  type CreateWeaverSessionInput,
  type UpdateWeaverSessionInput,
  type WeaverStage,
  type WeaverSessionStatus,
  type WeaverPersonaPlan,
} from "../../types/weaver";

const VALID_STAGES: readonly WeaverStage[] = [
  "dream",
  "readback",
  "interview",
  "bible",
  "render",
  "persona",
  "finalize",
];

const VALID_STATUSES: readonly WeaverSessionStatus[] = [
  "draft",
  "interviewing",
  "bible",
  "rendering",
  "finalized",
];

function rowToSession(row: any): WeaverSession {
  const sessionNumber = Number(row.session_number);
  return {
    id: row.id,
    user_id: row.user_id,
    session_number: Number.isFinite(sessionNumber) ? sessionNumber : 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    seed: {
      type: row.seed_type || "dream",
      text: row.seed_text ?? "",
      provenance: parseJsonObject(row.seed_provenance),
    },
    build_type: getBuildType(row.build_type) ? row.build_type : DEFAULT_BUILD_TYPE,
    stage: VALID_STAGES.includes(row.stage) ? row.stage : "dream",
    status: VALID_STATUSES.includes(row.status) ? row.status : "draft",
    connection_id: row.connection_id ?? null,
    model: row.model ?? null,
    persona_id: row.persona_id ?? null,
    narration_mode: row.narration_mode ?? null,
    persona_plan: parsePersonaPlan(row.persona_plan),
    character_id: row.character_id ?? null,
    launch_chat_id: row.launch_chat_id ?? null,
    interview_started_at: row.interview_started_at ?? null,
    interview_completed_at: row.interview_completed_at ?? null,
    display_name: null,
  };
}

export function nameFromSpine(spineJson: unknown, nameSlot: string): string | null {
  if (typeof spineJson !== "string" || !spineJson.trim()) return null;
  try {
    const spine = JSON.parse(spineJson);
    const entries = Array.isArray(spine?.entries) ? spine.entries : [];
    for (const e of entries) {
      if (e?.slot === nameSlot && typeof e.content === "string" && e.content.trim()) {
        return e.content.trim();
      }
    }
  } catch {}
  return null;
}

export function nameFromFacts(factsJson: unknown, nameSlot: string): string | null {
  if (typeof factsJson !== "string" || !factsJson.trim()) return null;
  try {
    const facts = JSON.parse(factsJson);
    if (!Array.isArray(facts)) return null;
    for (const f of facts) {
      if (f?.slot === nameSlot && typeof f.fact === "string" && f.fact.trim()) {
        return f.fact.trim();
      }
    }
  } catch { }
  return null;
}

function fillDisplayNames(userId: string, sessions: WeaverSession[]): WeaverSession[] {
  if (sessions.length === 0) return sessions;
  const ids = sessions.map((s) => s.id);
  const marks = ids.map(() => "?").join(", ");
  const spines = new Map(
    (getDb()
      .prepare(`SELECT session_id, spine FROM weaver_bible WHERE user_id = ? AND session_id IN (${marks})`)
      .all(userId, ...ids) as Array<{ session_id: string; spine: unknown }>)
      .map((r) => [r.session_id, r.spine]),
  );
  const facts = new Map(
    (getDb()
      .prepare(`SELECT session_id, committed_facts FROM weaver_extraction WHERE user_id = ? AND session_id IN (${marks})`)
      .all(userId, ...ids) as Array<{ session_id: string; committed_facts: unknown }>)
      .map((r) => [r.session_id, r.committed_facts]),
  );
  return sessions.map((s) => {
    const nameSlot = getBuildRegistry(s.build_type).nameSlot;
    const name =
      nameFromSpine(spines.get(s.id), nameSlot) ?? nameFromFacts(facts.get(s.id), nameSlot);
    return name ? { ...s, display_name: name } : s;
  });
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parsePersonaPlan(value: unknown): WeaverPersonaPlan {
  const base = emptyPersonaPlan();
  if (typeof value !== "string" || !value.trim()) return base;
  try {
    const p = JSON.parse(value);
    if (!p || typeof p !== "object") return base;
    const pairing = (p.pairing && typeof p.pairing === "object" ? p.pairing : {}) as Record<string, unknown>;
    return {
      enabled: p.enabled === true,
      seed: typeof p.seed === "string" ? p.seed : "",
      draft: p.draft && typeof p.draft === "object" ? p.draft : null,
      pairing: {
        greeting: pairing.greeting === true,
        register: typeof pairing.register === "string" && pairing.register ? pairing.register : base.pairing.register,
        greeting_text: typeof pairing.greeting_text === "string" ? pairing.greeting_text : "",
      },
    };
  } catch {
    return base;
  }
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function nextSessionNumber(userId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(MAX(session_number), 0) + 1 AS next
         FROM weaver_sessions
        WHERE user_id = ?`,
    )
    .get(userId) as { next: number };
  return row.next;
}

export function createSession(
  userId: string,
  input: CreateWeaverSessionInput = {},
): WeaverSession {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const sessionNumber = nextSessionNumber(userId);

  const buildType = input.build_type ?? DEFAULT_BUILD_TYPE;
  if (!isEnabledBuildType(buildType)) {
    throw new Error(`This build type is not available yet: ${String(buildType)}`);
  }

  db.prepare(
    `INSERT INTO weaver_sessions (
       id, user_id, session_number, created_at, updated_at,
       build_type, seed_type, seed_text, seed_provenance,
       connection_id, model, persona_id, narration_mode
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    userId,
    sessionNumber,
    now,
    now,
    buildType,
    input.seed_type?.trim() || "dream",
    input.seed_text ?? "",
    JSON.stringify(input.seed_provenance ?? {}),
    normalizeOptionalText(input.connection_id),
    normalizeOptionalText(input.model),
    normalizeOptionalText(input.persona_id),
    normalizeOptionalText(input.narration_mode),
  );

  return getSession(userId, id)!;
}

export function getSession(userId: string, sessionId: string): WeaverSession | null {
  const row = getDb()
    .prepare(`SELECT * FROM weaver_sessions WHERE id = ? AND user_id = ?`)
    .get(sessionId, userId) as any;
  return row ? fillDisplayNames(userId, [rowToSession(row)])[0] : null;
}

export function listSessions(userId: string): WeaverSession[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM weaver_sessions
        WHERE user_id = ?
        ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(userId) as any[];
  return fillDisplayNames(userId, rows.map(rowToSession));
}

export function updateSession(
  userId: string,
  sessionId: string,
  input: UpdateWeaverSessionInput,
): WeaverSession {
  const existing = getSession(userId, sessionId);
  if (!existing) throw new Error("Session not found");

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if ("seed_text" in input) {
    updates.push("seed_text = ?");
    params.push(input.seed_text ?? "");
  }
  if ("stage" in input && input.stage) {
    if (!VALID_STAGES.includes(input.stage)) throw new Error("Invalid stage");
    updates.push("stage = ?");
    params.push(input.stage);
  }
  if ("status" in input && input.status) {
    if (!VALID_STATUSES.includes(input.status)) throw new Error("Invalid status");
    updates.push("status = ?");
    params.push(input.status);
  }
  if ("connection_id" in input) {
    updates.push("connection_id = ?");
    params.push(normalizeOptionalText(input.connection_id));
  }
  if ("model" in input) {
    updates.push("model = ?");
    params.push(normalizeOptionalText(input.model));
  }
  if ("persona_id" in input) {
    updates.push("persona_id = ?");
    params.push(normalizeOptionalText(input.persona_id));
  }
  if ("narration_mode" in input) {
    updates.push("narration_mode = ?");
    params.push(normalizeOptionalText(input.narration_mode));
  }
  if ("persona_plan" in input && input.persona_plan) {
    updates.push("persona_plan = ?");
    params.push(JSON.stringify(input.persona_plan));
  }
  if ("character_id" in input) {
    updates.push("character_id = ?");
    params.push(normalizeOptionalText(input.character_id));
  }
  if ("launch_chat_id" in input) {
    updates.push("launch_chat_id = ?");
    params.push(normalizeOptionalText(input.launch_chat_id));
  }

  if (updates.length === 0) return existing;

  updates.push("updated_at = ?");
  params.push(Math.floor(Date.now() / 1000));
  params.push(sessionId, userId);

  getDb()
    .prepare(`UPDATE weaver_sessions SET ${updates.join(", ")} WHERE id = ? AND user_id = ?`)
    .run(...params);

  return getSession(userId, sessionId)!;
}

export function setStage(
  userId: string,
  sessionId: string,
  stage: WeaverStage,
): WeaverSession {
  return updateSession(userId, sessionId, { stage });
}

export function deleteSession(userId: string, sessionId: string): boolean {
  const result = getDb()
    .prepare(`DELETE FROM weaver_sessions WHERE id = ? AND user_id = ?`)
    .run(sessionId, userId);
  return result.changes > 0;
}
