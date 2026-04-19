import { getDb, onDbReset } from "../../db/connection";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import type {
  DreamWeaverSession,
  CreateSessionInput,
  DW_DRAFT_V1,
  UpdateSessionInput,
} from "../../types/dream-weaver";
import type { Character, UpdateCharacterInput } from "../../types/character";
import { rawGenerate } from "../generate.service";
import { getDWGenParams, applyDWGenParams, createDWTimeout } from "./dw-gen-params";
import * as connectionsSvc from "../connections.service";
import * as charactersSvc from "../characters.service";
import * as chatsSvc from "../chats.service";
import * as imagesSvc from "../images.service";
import * as worldBooksSvc from "../world-books.service";
import * as regexScriptsSvc from "../regex-scripts.service";
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from "../../utils/character-world-books";
import {
  DREAM_WEAVER_SYSTEM_PROMPT,
  WORLD_GENERATION_SYSTEM_PROMPT,
  EXTEND_SYSTEM_PROMPT,
  buildWorldGenerationPrompt,
  buildExtendPrompt,
  type ExtendTarget,
} from "./prompts";
import {
  applyAcceptedPortraitImageId,
  getAcceptedPortraitReference,
  isPersistablePortraitDataUrl,
} from "./portrait-reference";
import {
  canFinalizeSession,
  deriveSessionStateSnapshot,
  mergeGeneratedSoul,
} from "./session-state";

function emitProgress(
  userId: string,
  sessionId: string,
  operation: "soul" | "world" | "finalize",
  step: string,
  stepIndex: number,
  totalSteps: number,
  message: string,
): void {
  eventBus.emit(
    EventType.DREAM_WEAVER_PROGRESS,
    { sessionId, operation, step, stepIndex, totalSteps, message },
    userId,
  );
}

const DREAM_WEAVER_REQUIRED_COLUMNS: Array<[name: string, definition: string]> = [
  ["dream_text", "TEXT NOT NULL DEFAULT ''"],
  ["tone", "TEXT"],
  ["constraints", "TEXT"],
  ["dislikes", "TEXT"],
  ["persona_id", "TEXT"],
  ["connection_id", "TEXT"],
  ["draft", "TEXT"],
  ["soul_state", "TEXT NOT NULL DEFAULT 'empty'"],
  ["world_state", "TEXT NOT NULL DEFAULT 'empty'"],
  ["soul_revision", "INTEGER NOT NULL DEFAULT 0"],
  ["world_source_revision", "INTEGER"],
  ["character_id", "TEXT"],
  ["launch_chat_id", "TEXT"],
];

let dreamWeaverSchemaEnsured = false;

onDbReset(() => {
  dreamWeaverSchemaEnsured = false;
});

function createDreamWeaverTable(): void {
  const db = getDb();

  db.run(`
    CREATE TABLE IF NOT EXISTS dream_weaver_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      dream_text TEXT NOT NULL,
      tone TEXT,
      constraints TEXT,
      dislikes TEXT,
      persona_id TEXT,
      connection_id TEXT,
      draft TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      soul_state TEXT NOT NULL DEFAULT 'empty',
      world_state TEXT NOT NULL DEFAULT 'empty',
      soul_revision INTEGER NOT NULL DEFAULT 0,
      world_source_revision INTEGER,
      character_id TEXT,
      launch_chat_id TEXT,
      FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
      FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL,
      FOREIGN KEY (connection_id) REFERENCES connection_profiles(id) ON DELETE SET NULL,
      FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE SET NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
      ON dream_weaver_sessions(user_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
      ON dream_weaver_sessions(user_id, status)
  `);
}

function ensureDreamWeaverSchema(): void {
  if (dreamWeaverSchemaEnsured) return;

  const db = getDb();
  const existingTable = db
    .query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'dream_weaver_sessions'
    `)
    .get() as { name: string } | null;

  if (!existingTable) {
    createDreamWeaverTable();
    dreamWeaverSchemaEnsured = true;
    return;
  }

  const columns = db.query("PRAGMA table_info(dream_weaver_sessions)").all() as Array<{ name: string }>;
  const columnNames = new Set(columns.map((column) => column.name));
  const hasLegacyDreamDescription = columnNames.has("dream_description");
  const hasLegacyDraftData = columnNames.has("draft_data");

  for (const [columnName, definition] of DREAM_WEAVER_REQUIRED_COLUMNS) {
    if (!columnNames.has(columnName)) {
      db.run(`ALTER TABLE dream_weaver_sessions ADD COLUMN ${columnName} ${definition}`);
    }
  }

  if (hasLegacyDreamDescription) {
    db.run(`
      UPDATE dream_weaver_sessions
      SET dream_text = COALESCE(NULLIF(dream_text, ''), NULLIF(dream_description, ''))
      WHERE COALESCE(dream_text, '') = ''
    `);
  }

  if (hasLegacyDraftData) {
    db.run(`
      UPDATE dream_weaver_sessions
      SET draft = CASE
        WHEN draft IS NULL OR draft = '' THEN NULLIF(draft_data, '{}')
        ELSE draft
      END
      WHERE draft IS NULL OR draft = ''
    `);
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_user
      ON dream_weaver_sessions(user_id, created_at DESC)
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_dw_sessions_status
      ON dream_weaver_sessions(user_id, status)
  `);

  dreamWeaverSchemaEnsured = true;
}

function rowToSession(row: any): DreamWeaverSession {
  return {
    id: row.id,
    user_id: row.user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    dream_text: row.dream_text ?? "",
    tone: row.tone ?? null,
    constraints: row.constraints ?? null,
    dislikes: row.dislikes ?? null,
    persona_id: row.persona_id ?? null,
    connection_id: row.connection_id ?? null,
    draft: row.draft ?? null,
    status: row.status,
    soul_state: row.soul_state ?? "empty",
    world_state: row.world_state ?? "empty",
    soul_revision: Number(row.soul_revision ?? 0),
    world_source_revision: row.world_source_revision == null ? null : Number(row.world_source_revision),
    character_id: row.character_id ?? null,
    launch_chat_id: row.launch_chat_id ?? null,
  };
}

function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value.map((item) => coerceString(item)).filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }
  return String(value);
}

function coerceStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => coerceString(item)).filter(Boolean);
  if (value == null || value === "") return [];
  return [coerceString(value)].filter(Boolean);
}

function normalizeDraftStrings(draft: DW_DRAFT_V1): DW_DRAFT_V1 {
  const card = (draft.card ?? {}) as any;
  const normalizedCard = {
    ...card,
    name: coerceString(card.name),
    appearance: coerceString(card.appearance),
    description: coerceString(card.description),
    personality: coerceString(card.personality),
    scenario: coerceString(card.scenario),
    first_mes: coerceString(card.first_mes),
    system_prompt: coerceString(card.system_prompt),
    post_history_instructions: coerceString(card.post_history_instructions),
  };
  if (card.appearance_data && typeof card.appearance_data === "object" && !Array.isArray(card.appearance_data)) {
    const ad: Record<string, string> = {};
    for (const [k, v] of Object.entries(card.appearance_data)) ad[k] = coerceString(v);
    normalizedCard.appearance_data = ad;
  }

  const voice = (draft.voice_guidance ?? {}) as any;
  const voiceRules = (voice.rules ?? {}) as any;
  const normalizedVoice = {
    compiled: coerceString(voice.compiled),
    rules: {
      baseline: coerceStringArray(voiceRules.baseline),
      rhythm: coerceStringArray(voiceRules.rhythm),
      diction: coerceStringArray(voiceRules.diction),
      quirks: coerceStringArray(voiceRules.quirks),
      hard_nos: coerceStringArray(voiceRules.hard_nos),
    },
  };

  const normalizeAltList = (list: unknown): Array<{ id: string; label: string; content: string }> => {
    if (!Array.isArray(list)) return [];
    return list.map((item: any, idx: number) => ({
      id: coerceString(item?.id) || `alt_${idx}`,
      label: coerceString(item?.label),
      content: coerceString(item?.content),
    }));
  };
  const alt = (draft.alternate_fields ?? {}) as any;
  const normalizedAlt = {
    description: normalizeAltList(alt.description),
    personality: normalizeAltList(alt.personality),
    scenario: normalizeAltList(alt.scenario),
  };

  const normalizedGreetings = Array.isArray(draft.greetings)
    ? draft.greetings.map((g: any, idx: number) => ({
        id: coerceString(g?.id) || `g_${idx}`,
        label: coerceString(g?.label),
        content: coerceString(g?.content),
      }))
    : [];

  const meta = (draft.meta ?? {}) as any;
  const normalizedMeta = {
    ...meta,
    title: coerceString(meta.title),
    summary: coerceString(meta.summary),
    tags: coerceStringArray(meta.tags),
    content_rating: meta.content_rating === "nsfw" ? "nsfw" : "sfw",
  };

  return {
    ...draft,
    meta: normalizedMeta,
    card: normalizedCard,
    voice_guidance: normalizedVoice,
    alternate_fields: normalizedAlt,
    greetings: normalizedGreetings,
    lorebooks: Array.isArray(draft.lorebooks) ? draft.lorebooks : [],
    npc_definitions: Array.isArray(draft.npc_definitions) ? draft.npc_definitions : [],
    regex_scripts: Array.isArray(draft.regex_scripts) ? draft.regex_scripts : [],
  } as DW_DRAFT_V1;
}

function parseDraftResponse(content: string): DW_DRAFT_V1 {
  const trimmed = content.trim();
  const jsonContent = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  let draft: DW_DRAFT_V1;
  try {
    draft = JSON.parse(jsonContent) as DW_DRAFT_V1;
  } catch (err: any) {
    const repaired = safeParseJson(jsonContent);
    if (!repaired) {
      // A malformed model output or corrupted stored draft used to crash the
      // entire Dream Weaver session; surface a typed error instead.
      throw new Error(`Dream Weaver draft is not valid JSON: ${err?.message || "parse failed"}`);
    }
    draft = repaired as DW_DRAFT_V1;
  }

  if (!draft || typeof draft !== "object" || draft.format !== "DW_DRAFT_V1") {
    throw new Error("Dream Weaver returned an unexpected draft format");
  }

  return normalizeDraftStrings(draft);
}

export function parseStoredDreamWeaverDraft(
  rawDraft: string | null | undefined,
): DW_DRAFT_V1 | null {
  if (!rawDraft) return null;
  return parseDraftResponse(rawDraft);
}

interface DreamWeaverWorldDraft {
  lorebooks: any[];
  npc_definitions: any[];
  regex_scripts: any[];
}

function parseWorldDraftResponse(content: string): DreamWeaverWorldDraft {
  const parsed = safeParseJson(content) as Partial<DreamWeaverWorldDraft> | null;
  if (!parsed) {
    console.warn("[DreamWeaver] Could not parse world draft response — returning empty world");
    return { lorebooks: [], npc_definitions: [], regex_scripts: [] };
  }

  return {
    lorebooks: Array.isArray(parsed.lorebooks) ? parsed.lorebooks : [],
    npc_definitions: Array.isArray(parsed.npc_definitions) ? parsed.npc_definitions : [],
    regex_scripts: Array.isArray(parsed.regex_scripts) ? parsed.regex_scripts : [],
  };
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function serializeDraft(draft: DW_DRAFT_V1 | null | undefined): string | null {
  if (draft == null) return null;
  if (draft.format !== "DW_DRAFT_V1") {
    throw new Error("Dream Weaver draft payload is invalid");
  }
  return JSON.stringify(draft);
}

async function persistAcceptedPortraitImage(
  userId: string,
  draft: DW_DRAFT_V1,
): Promise<{ draft: DW_DRAFT_V1; imageId: string | null }> {
  const acceptedPortrait = getAcceptedPortraitReference(draft);
  if (!acceptedPortrait) {
    return { draft, imageId: null };
  }

  if (
    typeof acceptedPortrait.reference.image_id === "string" &&
    acceptedPortrait.reference.image_id.trim()
  ) {
    return {
      draft,
      imageId: acceptedPortrait.reference.image_id,
    };
  }

  if (!isPersistablePortraitDataUrl(acceptedPortrait.reference)) {
    return { draft, imageId: null };
  }

  const image = await imagesSvc.saveImageFromDataUrl(
    userId,
    acceptedPortrait.reference.image_url!,
    `${imagesSvc.IMAGE_GEN_FILENAME_PREFIX}dream-weaver-${acceptedPortrait.assetId}.png`,
  );

  return {
    draft: applyAcceptedPortraitImageId(draft, acceptedPortrait.assetId, image.id),
    imageId: image.id,
  };
}

export function createSession(userId: string, input: CreateSessionInput): DreamWeaverSession {
  ensureDreamWeaverSchema();

  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const dreamText = input.dream_text.trim();

  if (!dreamText) {
    throw new Error("Dream text is required");
  }

  db.prepare(`
    INSERT INTO dream_weaver_sessions (
      id, user_id, created_at, updated_at,
      dream_text, tone, constraints, dislikes, persona_id, connection_id,
      soul_state, world_state, soul_revision, world_source_revision, launch_chat_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    userId,
    now,
    now,
    dreamText,
    input.tone?.trim() || null,
    input.constraints?.trim() || null,
    input.dislikes?.trim() || null,
    input.persona_id || null,
    input.connection_id || null,
    "empty",
    "empty",
    0,
    null,
    null,
  );

  return getSession(userId, id)!;
}

export function getSession(userId: string, sessionId: string): DreamWeaverSession | null {
  ensureDreamWeaverSchema();

  const row = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).get(sessionId, userId) as any;

  return row ? rowToSession(row) : null;
}

export function listSessions(userId: string): DreamWeaverSession[] {
  ensureDreamWeaverSchema();

  const rows = getDb().prepare(`
    SELECT *
    FROM dream_weaver_sessions
    WHERE user_id = ?
    ORDER BY updated_at DESC, created_at DESC
  `).all(userId) as any[];

  return rows.map(rowToSession);
}

export async function updateSession(
  userId: string,
  sessionId: string,
  input: UpdateSessionInput,
): Promise<DreamWeaverSession> {
  ensureDreamWeaverSchema();

  const existing = getSession(userId, sessionId);
  if (!existing) throw new Error("Session not found");

  const updates: string[] = [];
  const params: any[] = [];
  let portraitImageId: string | null = null;

  if ("dream_text" in input) {
    const dreamText = input.dream_text?.trim() ?? "";
    if (!dreamText) throw new Error("Dream text is required");
    updates.push("dream_text = ?");
    params.push(dreamText);
  }

  if ("tone" in input) {
    updates.push("tone = ?");
    params.push(normalizeOptionalText(input.tone));
  }

  if ("constraints" in input) {
    updates.push("constraints = ?");
    params.push(normalizeOptionalText(input.constraints));
  }

  if ("dislikes" in input) {
    updates.push("dislikes = ?");
    params.push(normalizeOptionalText(input.dislikes));
  }

  if ("persona_id" in input) {
    updates.push("persona_id = ?");
    params.push(normalizeOptionalText(input.persona_id));
  }

  if ("connection_id" in input) {
    updates.push("connection_id = ?");
    params.push(normalizeOptionalText(input.connection_id));
  }

  if ("draft" in input) {
    const existingDraft = parseStoredDreamWeaverDraft(existing.draft);
    const nextDraft = input.draft
      ? await persistAcceptedPortraitImage(userId, input.draft)
      : { draft: input.draft, imageId: null };
    portraitImageId = nextDraft.imageId;
    const snapshot = deriveSessionStateSnapshot(existing, existingDraft, nextDraft.draft);
    updates.push("draft = ?");
    params.push(serializeDraft(nextDraft.draft));
    updates.push("status = ?");
    params.push(nextDraft.draft ? "complete" : "draft");
    updates.push("soul_state = ?");
    params.push(snapshot.soul_state);
    updates.push("world_state = ?");
    params.push(snapshot.world_state);
    updates.push("soul_revision = ?");
    params.push(snapshot.soul_revision);
    updates.push("world_source_revision = ?");
    params.push(snapshot.world_source_revision);
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push("updated_at = ?");
  params.push(Math.floor(Date.now() / 1000));
  params.push(sessionId, userId);

  getDb().prepare(`
    UPDATE dream_weaver_sessions
    SET ${updates.join(", ")}
    WHERE id = ? AND user_id = ?
  `).run(...params);

  if (existing.character_id && portraitImageId) {
    charactersSvc.setCharacterImage(userId, existing.character_id, portraitImageId);
  }

  return getSession(userId, sessionId)!;
}

async function executeDraftGeneration(
  userId: string,
  sessionId: string,
): Promise<void> {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const dwParams = getDWGenParams(userId);
  const dwAbort = createDWTimeout(dwParams);

  try {
    emitProgress(userId, sessionId, "soul", "reading_dream", 0, 3, "Reading dream");

    const connection = session.connection_id
      ? connectionsSvc.getConnection(userId, session.connection_id)
      : connectionsSvc.getDefaultConnection(userId);

    if (!connection) {
      throw new Error("No connection available");
    }

    emitProgress(userId, sessionId, "soul", "shaping_voice", 1, 3, "Shaping voice");

    const result = await rawGenerate(userId, {
      provider: connection.provider,
      model: connection.model,
      messages: [
        { role: "system", content: DREAM_WEAVER_SYSTEM_PROMPT },
        { role: "user", content: buildGenerationPrompt(session) },
      ],
      parameters: applyDWGenParams({ temperature: 1.0, max_tokens: 16384 }, dwParams),
      connection_id: connection.id,
      signal: dwAbort?.signal,
    });
    dwAbort?.cleanup();

    emitProgress(userId, sessionId, "soul", "binding_card", 2, 3, "Binding the card");

    const generatedDraft = parseDraftResponse(result.content);
    const previousDraft = parseStoredDreamWeaverDraft(session.draft);
    const nextDraft = mergeGeneratedSoul(previousDraft, generatedDraft);
    const snapshot = deriveSessionStateSnapshot(session, previousDraft, nextDraft);

    getDb().prepare(`
      UPDATE dream_weaver_sessions
      SET draft = ?, status = ?, soul_state = ?, world_state = ?, soul_revision = ?, world_source_revision = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      JSON.stringify(nextDraft),
      "complete",
      snapshot.soul_state,
      snapshot.world_state,
      snapshot.soul_revision,
      snapshot.world_source_revision,
      Math.floor(Date.now() / 1000),
      sessionId,
      userId,
    );

    eventBus.emit(EventType.DREAM_WEAVER_COMPLETE, { sessionId, operation: "soul" }, userId);
  } catch (error) {
    dwAbort?.cleanup();
    getDb().prepare(`
      UPDATE dream_weaver_sessions
      SET status = ?, soul_state = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run("error", "error", Math.floor(Date.now() / 1000), sessionId, userId);

    eventBus.emit(
      EventType.DREAM_WEAVER_ERROR,
      { sessionId, operation: "soul", error: error instanceof Error ? error.message : String(error) },
      userId,
    );
  }
}

export function generateDraft(
  userId: string,
  sessionId: string,
): DreamWeaverSession {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  if (session.status === "generating" || session.soul_state === "generating") {
    return session;
  }

  const connection = session.connection_id
    ? connectionsSvc.getConnection(userId, session.connection_id)
    : connectionsSvc.getDefaultConnection(userId);

  if (!connection) {
    throw new Error("No connection available");
  }

  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE dream_weaver_sessions
    SET status = ?, soul_state = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run("generating", "generating", now, sessionId, userId);

  const nextSession = getSession(userId, sessionId)!;
  eventBus.emit(EventType.DREAM_WEAVER_GENERATING, { sessionId, operation: "soul" }, userId);
  void executeDraftGeneration(userId, sessionId);
  return nextSession;
}

export function generateWorld(
  userId: string,
  sessionId: string,
): DreamWeaverSession {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const currentDraft = parseStoredDreamWeaverDraft(session.draft);
  if (!currentDraft) throw new Error("Generate Soul before World");

  const connection = session.connection_id
    ? connectionsSvc.getConnection(userId, session.connection_id)
    : connectionsSvc.getDefaultConnection(userId);

  if (!connection) {
    throw new Error("No connection available");
  }

  const now = Math.floor(Date.now() / 1000);
  getDb().prepare(`
    UPDATE dream_weaver_sessions SET world_state = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run("generating", now, sessionId, userId);

  const nextSession = getSession(userId, sessionId)!;
  eventBus.emit(EventType.DREAM_WEAVER_GENERATING, { sessionId, operation: "world" }, userId);
  void executeWorldGeneration(userId, sessionId);
  return nextSession;
}

async function executeWorldGeneration(
  userId: string,
  sessionId: string,
): Promise<void> {
  const dwParams = getDWGenParams(userId);
  const dwAbort = createDWTimeout(dwParams);

  try {
    const session = getSession(userId, sessionId);
    if (!session) throw new Error("Session not found");

    const currentDraft = parseStoredDreamWeaverDraft(session.draft);
    if (!currentDraft) throw new Error("No draft available");

    emitProgress(userId, sessionId, "world", "preparing", 0, 4, "Preparing world");

    const connection = session.connection_id
      ? connectionsSvc.getConnection(userId, session.connection_id)
      : connectionsSvc.getDefaultConnection(userId);

    if (!connection) {
      throw new Error("No connection available");
    }

    emitProgress(userId, sessionId, "world", "generating", 1, 4, "Building world");

    const result = await rawGenerate(userId, {
      provider: connection.provider,
      model: connection.model,
      messages: [
        { role: "system", content: WORLD_GENERATION_SYSTEM_PROMPT },
        { role: "user", content: buildWorldGenerationPrompt(session, currentDraft) },
      ],
      parameters: applyDWGenParams({ temperature: 0.8, max_tokens: 16384 }, dwParams),
      connection_id: connection.id,
      signal: dwAbort?.signal,
    });
    dwAbort?.cleanup();

    emitProgress(userId, sessionId, "world", "assembling", 2, 4, "Assembling lorebooks & NPCs");

    const worldDraft = parseWorldDraftResponse(result.content);
    const nextDraft: DW_DRAFT_V1 = {
      ...currentDraft,
      lorebooks: worldDraft.lorebooks,
      npc_definitions: worldDraft.npc_definitions,
      regex_scripts: worldDraft.regex_scripts,
    };
    const snapshot = deriveSessionStateSnapshot(
      session,
      currentDraft,
      nextDraft,
      { worldGeneratedFromCurrentSoul: true },
    );

    emitProgress(userId, sessionId, "world", "saving", 3, 4, "Saving world data");

    getDb().prepare(`
      UPDATE dream_weaver_sessions
      SET draft = ?, status = ?, soul_state = ?, world_state = ?, soul_revision = ?, world_source_revision = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run(
      JSON.stringify(nextDraft),
      "complete",
      snapshot.soul_state,
      snapshot.world_state,
      snapshot.soul_revision,
      snapshot.world_source_revision,
      Math.floor(Date.now() / 1000),
      sessionId,
      userId,
    );

    eventBus.emit(EventType.DREAM_WEAVER_COMPLETE, { sessionId, operation: "world" }, userId);
  } catch (error) {
    dwAbort?.cleanup();
    getDb().prepare(`
      UPDATE dream_weaver_sessions SET world_state = ?, updated_at = ?
      WHERE id = ? AND user_id = ?
    `).run("error", Math.floor(Date.now() / 1000), sessionId, userId);

    eventBus.emit(
      EventType.DREAM_WEAVER_ERROR,
      { sessionId, operation: "world", error: error instanceof Error ? error.message : String(error) },
      userId,
    );
  }
}

function buildGenerationPrompt(session: DreamWeaverSession): string {
  let prompt = `Dream: ${session.dream_text}`;

  if (session.tone) prompt += `\n\nTone: ${session.tone}`;
  if (session.constraints) prompt += `\n\nConstraints: ${session.constraints}`;
  if (session.dislikes) prompt += `\n\nHard No's (things to avoid): ${session.dislikes}`;

  return prompt;
}

// ---------------------------------------------------------------------------
// Finalize helpers — world books, NPCs, voice, regex
// ---------------------------------------------------------------------------

function buildSystemPromptWithVoiceGuidance(draft: DW_DRAFT_V1): string {
  let systemPrompt = draft.card.system_prompt || "";
  const compiled = draft.voice_guidance?.compiled?.trim();
  if (compiled) {
    const voiceSection = `## Voice & Speech Patterns\n${compiled}`;
    systemPrompt = systemPrompt.trim()
      ? `${systemPrompt.trim()}\n\n${voiceSection}`
      : voiceSection;
  }
  return systemPrompt;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function buildDreamWeaverMetadata(
  sessionId: string,
  draft: DW_DRAFT_V1,
): Record<string, unknown> {
  return {
    session_id: sessionId,
    kind: draft.kind,
    meta: draft.meta,
    voice_guidance: draft.voice_guidance,
    appearance: draft.card.appearance,
    appearance_data: draft.card.appearance_data ?? {},
  };
}

function buildCharacterExtensionsFromDraft(
  existingExtensions: Record<string, any> | undefined,
  sessionId: string,
  draft: DW_DRAFT_V1,
): Record<string, any> {
  return {
    ...(existingExtensions ?? {}),
    alternate_fields: draft.alternate_fields,
    dream_weaver: buildDreamWeaverMetadata(sessionId, draft),
  };
}

function buildCharacterPayloadFromDraft(
  sessionId: string,
  draft: DW_DRAFT_V1,
  existingExtensions?: Record<string, any>,
): UpdateCharacterInput {
  return {
    name: draft.card.name,
    description: draft.card.description,
    personality: draft.card.personality,
    scenario: draft.card.scenario,
    first_mes: draft.card.first_mes,
    system_prompt: buildSystemPromptWithVoiceGuidance(draft),
    post_history_instructions: draft.card.post_history_instructions,
    tags: draft.meta.tags,
    alternate_greetings: draft.greetings.slice(1).map((greeting) => greeting.content),
    extensions: buildCharacterExtensionsFromDraft(existingExtensions, sessionId, draft),
  };
}

function mergeMissingAlternateFields(
  existingAlternateFields: unknown,
  nextAlternateFields: DW_DRAFT_V1["alternate_fields"],
): { value: Record<string, any>; changed: boolean } {
  const merged = isRecord(existingAlternateFields) ? { ...existingAlternateFields } : {};
  let changed = !isRecord(existingAlternateFields);

  for (const fieldName of ["description", "personality", "scenario"] as const) {
    const existingEntries = Array.isArray(merged[fieldName]) ? merged[fieldName] : [];
    const nextEntries = nextAlternateFields[fieldName];
    if (existingEntries.length === 0 && nextEntries.length > 0) {
      merged[fieldName] = nextEntries;
      changed = true;
    }
  }

  return { value: merged, changed };
}

function mergeMissingDreamWeaverMetadata(
  existingMetadata: unknown,
  nextMetadata: ReturnType<typeof buildDreamWeaverMetadata>,
): { value: Record<string, any>; changed: boolean } {
  const merged = isRecord(existingMetadata) ? { ...existingMetadata } : {};
  let changed = !isRecord(existingMetadata);

  if (!hasText(merged.session_id) && hasText(nextMetadata.session_id)) {
    merged.session_id = nextMetadata.session_id;
    changed = true;
  }

  if (!hasText(merged.kind) && hasText(nextMetadata.kind)) {
    merged.kind = nextMetadata.kind;
    changed = true;
  }

  const nextMeta = isRecord(nextMetadata.meta) ? nextMetadata.meta : {};
  const mergedMeta = isRecord(merged.meta) ? { ...merged.meta } : {};
  let metaChanged = !isRecord(merged.meta);
  if (!hasText(mergedMeta.title) && hasText(nextMeta.title)) {
    mergedMeta.title = nextMeta.title;
    metaChanged = true;
  }
  if (!hasText(mergedMeta.summary) && hasText(nextMeta.summary)) {
    mergedMeta.summary = nextMeta.summary;
    metaChanged = true;
  }
  if ((!Array.isArray(mergedMeta.tags) || mergedMeta.tags.length === 0) && Array.isArray(nextMeta.tags) && nextMeta.tags.length > 0) {
    mergedMeta.tags = nextMeta.tags;
    metaChanged = true;
  }
  if (!hasText(mergedMeta.content_rating) && hasText(nextMeta.content_rating)) {
    mergedMeta.content_rating = nextMeta.content_rating;
    metaChanged = true;
  }
  if (metaChanged) {
    merged.meta = mergedMeta;
    changed = true;
  }

  const nextVoice = isRecord(nextMetadata.voice_guidance) ? nextMetadata.voice_guidance : {};
  const mergedVoice = isRecord(merged.voice_guidance) ? { ...merged.voice_guidance } : {};
  let voiceChanged = !isRecord(merged.voice_guidance);
  if (!hasText(mergedVoice.compiled) && hasText(nextVoice.compiled)) {
    mergedVoice.compiled = nextVoice.compiled;
    voiceChanged = true;
  }

  const nextRules = isRecord(nextVoice.rules) ? nextVoice.rules : {};
  const mergedRules = isRecord(mergedVoice.rules) ? { ...mergedVoice.rules } : {};
  let rulesChanged = !isRecord(mergedVoice.rules);
  for (const ruleName of ["baseline", "rhythm", "diction", "quirks", "hard_nos"] as const) {
    const existingRule = Array.isArray(mergedRules[ruleName]) ? mergedRules[ruleName] : [];
    const nextRule = Array.isArray(nextRules[ruleName]) ? nextRules[ruleName] : [];
    if (existingRule.length === 0 && nextRule.length > 0) {
      mergedRules[ruleName] = nextRule;
      rulesChanged = true;
    }
  }
  if (rulesChanged) {
    mergedVoice.rules = mergedRules;
    voiceChanged = true;
  }
  if (voiceChanged) {
    merged.voice_guidance = mergedVoice;
    changed = true;
  }

  if (!hasText(merged.appearance) && hasText(nextMetadata.appearance)) {
    merged.appearance = nextMetadata.appearance;
    changed = true;
  }

  const nextAppearanceData = isRecord(nextMetadata.appearance_data)
    ? nextMetadata.appearance_data
    : {};
  const mergedAppearanceData = isRecord(merged.appearance_data)
    ? { ...merged.appearance_data }
    : {};
  let appearanceDataChanged = !isRecord(merged.appearance_data);
  for (const [key, value] of Object.entries(nextAppearanceData)) {
    if (!hasText(mergedAppearanceData[key]) && hasText(value)) {
      mergedAppearanceData[key] = value;
      appearanceDataChanged = true;
    }
  }
  if (appearanceDataChanged && Object.keys(mergedAppearanceData).length > 0) {
    merged.appearance_data = mergedAppearanceData;
    changed = true;
  }

  return { value: merged, changed };
}

function buildMissingCharacterPayloadFromDraft(
  character: Character,
  sessionId: string,
  draft: DW_DRAFT_V1,
): UpdateCharacterInput | null {
  const next: UpdateCharacterInput = {};

  if (!hasText(character.name) && hasText(draft.card.name)) {
    next.name = draft.card.name;
  }
  if (!hasText(character.description) && hasText(draft.card.description)) {
    next.description = draft.card.description;
  }
  if (!hasText(character.personality) && hasText(draft.card.personality)) {
    next.personality = draft.card.personality;
  }
  if (!hasText(character.scenario) && hasText(draft.card.scenario)) {
    next.scenario = draft.card.scenario;
  }
  if (!hasText(character.first_mes) && hasText(draft.card.first_mes)) {
    next.first_mes = draft.card.first_mes;
  }

  const nextSystemPrompt = buildSystemPromptWithVoiceGuidance(draft);
  if (!hasText(character.system_prompt) && hasText(nextSystemPrompt)) {
    next.system_prompt = nextSystemPrompt;
  }
  if (
    !hasText(character.post_history_instructions)
    && hasText(draft.card.post_history_instructions)
  ) {
    next.post_history_instructions = draft.card.post_history_instructions;
  }
  if (character.tags.length === 0 && draft.meta.tags.length > 0) {
    next.tags = draft.meta.tags;
  }
  if (character.alternate_greetings.length === 0 && draft.greetings.length > 1) {
    next.alternate_greetings = draft.greetings.slice(1).map((greeting) => greeting.content);
  }

  const nextExtensions = { ...(character.extensions ?? {}) };
  let extensionsChanged = false;

  const alternateMerge = mergeMissingAlternateFields(
    character.extensions?.alternate_fields,
    draft.alternate_fields,
  );
  if (alternateMerge.changed) {
    nextExtensions.alternate_fields = alternateMerge.value;
    extensionsChanged = true;
  }

  const dreamWeaverMerge = mergeMissingDreamWeaverMetadata(
    character.extensions?.dream_weaver,
    buildDreamWeaverMetadata(sessionId, draft),
  );
  if (dreamWeaverMerge.changed) {
    nextExtensions.dream_weaver = dreamWeaverMerge.value;
    extensionsChanged = true;
  }

  if (extensionsChanged) {
    next.extensions = nextExtensions;
  }

  return Object.keys(next).length > 0 ? next : null;
}

function formatNpcEntryContent(npc: any, characterName: string): string {
  const parts: string[] = [];
  const header = npc.role ? `[${npc.name} — ${npc.role}]` : `[${npc.name}]`;
  parts.push(header);
  if (npc.description) parts.push(npc.description);
  if (npc.appearance) parts.push(`Appearance: ${npc.appearance}`);
  if (npc.personality) parts.push(`Personality: ${npc.personality}`);
  if (npc.voice) parts.push(`Voice: ${npc.voice}`);
  if (npc.relationship_to_card) {
    parts.push(`Relationship to ${characterName}: ${npc.relationship_to_card}`);
  }
  return parts.join("\n");
}

function deriveLorebookEntryComment(entry: any): string {
  if (hasText(entry?.comment)) return entry.comment.trim();
  if (hasText(entry?.name)) return entry.name.trim();

  const keywords: string[] = Array.isArray(entry?.keywords)
    ? entry.keywords.filter((keyword: unknown) => hasText(keyword)).map((keyword: string) => keyword.trim())
    : typeof entry?.keywords === "string"
      ? entry.keywords.split(",").map((keyword: string) => keyword.trim()).filter(Boolean)
      : [];
  if (keywords.length > 0) {
    return keywords.slice(0, 3).join(", ");
  }

  const content = coerceString(entry?.content).replace(/\s+/g, " ").trim();
  return content ? content.slice(0, 72) : "Lore Entry";
}

function deriveNpcEntryComment(npc: any): string {
  if (hasText(npc?.name)) return npc.name.trim();

  const keywords: string[] = Array.isArray(npc?.keyword_triggers)
    ? npc.keyword_triggers.filter((keyword: unknown) => hasText(keyword)).map((keyword: string) => keyword.trim())
    : [];
  if (keywords.length > 0) {
    return keywords.slice(0, 3).join(", ");
  }

  return "NPC";
}

function createWorldBooksFromDraft(
  userId: string,
  draft: DW_DRAFT_V1,
): string[] {
  const worldBookIds: string[] = [];

  // Lorebooks → world books
  for (const lorebook of draft.lorebooks || []) {
    const entries = lorebook.entries || [];
    if (!entries.length) continue;

    const book = worldBooksSvc.createWorldBook(userId, {
      name: lorebook.name || `${draft.card.name} — Lore`,
    });

    for (const entry of entries) {
      const keywords: string[] = Array.isArray(entry.keywords)
        ? entry.keywords
        : typeof entry.keywords === "string"
          ? entry.keywords.split(",").map((k: string) => k.trim()).filter(Boolean)
          : [];

      worldBooksSvc.createEntry(userId, book.id, {
        key: keywords,
        content: entry.content || "",
        comment: deriveLorebookEntryComment(entry),
        position: 0,
        priority: 10,
      });
    }

    worldBookIds.push(book.id);
  }

  // NPC definitions → world book with keyword-triggered entries
  const npcs = draft.npc_definitions || [];
  if (npcs.length > 0) {
    const npcBook = worldBooksSvc.createWorldBook(userId, {
      name: `${draft.card.name} — NPCs`,
    });

    for (const npc of npcs) {
      const keywords: string[] = Array.isArray(npc.keyword_triggers) && npc.keyword_triggers.length > 0
        ? npc.keyword_triggers
        : [npc.name].filter(Boolean);

      worldBooksSvc.createEntry(userId, npcBook.id, {
        key: keywords,
        content: formatNpcEntryContent(npc, draft.card.name),
        comment: deriveNpcEntryComment(npc),
        position: 0,
        priority: npc.importance === "major" ? 20 : 10,
        constant: npc.importance === "major",
      });
    }

    worldBookIds.push(npcBook.id);
  }

  return worldBookIds;
}

function createRegexScriptsFromDraft(
  userId: string,
  characterId: string,
  draft: DW_DRAFT_V1,
): void {
  for (const script of draft.regex_scripts || []) {
    if (!script.name || !script.find_regex) continue;

    regexScriptsSvc.createRegexScript(userId, {
      name: script.name,
      find_regex: script.find_regex,
      replace_string: script.replace_string || "",
      flags: script.flags || "gi",
      target: script.target || "response",
      scope: "character",
      scope_id: characterId,
      description: script.description || "",
      folder: `Dream Weaver — ${draft.card.name}`,
    });
  }
}

export async function finalize(
  userId: string,
  sessionId: string,
): Promise<{
  session: DreamWeaverSession;
  characterId: string;
  chatId: string | null;
  alreadyFinalized: boolean;
}> {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  const storedDraft = parseStoredDreamWeaverDraft(session.draft);
  if (!storedDraft) throw new Error("No draft to finalize");

  emitProgress(userId, sessionId, "finalize", "persisting_portrait", 0, 4, "Saving portrait");

  const persistedPortrait = await persistAcceptedPortraitImage(userId, storedDraft);
  const draft = persistedPortrait.draft;
  const portraitImageId = persistedPortrait.imageId;
  if (!draft) throw new Error("No draft to finalize");
  if (!canFinalizeSession(session, draft) && !session.character_id) {
    throw new Error("Dream Weaver session is not ready to finalize");
  }

  if (session.character_id) {
    emitProgress(userId, sessionId, "finalize", "creating_character", 1, 4, "Syncing character");

    const worldBookIds = createWorldBooksFromDraft(userId, draft);
    const character = charactersSvc.getCharacter(userId, session.character_id);
    const characterPayload = buildCharacterPayloadFromDraft(
      sessionId,
      draft,
      character?.extensions,
    );

    if (worldBookIds.length > 0) {
      if (character) {
        const existingIds = getCharacterWorldBookIds(character.extensions);
        const mergedIds = [...existingIds, ...worldBookIds];
        characterPayload.extensions = setCharacterWorldBookIds(
          characterPayload.extensions ?? character.extensions ?? {},
          mergedIds,
        );
      }
    }

    createRegexScriptsFromDraft(userId, session.character_id, draft);

    charactersSvc.updateCharacter(userId, session.character_id, characterPayload);

    if (portraitImageId) {
      charactersSvc.setCharacterImage(userId, session.character_id, portraitImageId);
    }

    emitProgress(userId, sessionId, "finalize", "creating_chat", 2, 4, "Setting up chat");

    const chatId = session.launch_chat_id ?? chatsSvc.createChat(userId, {
      character_id: session.character_id,
    }).id;

    emitProgress(userId, sessionId, "finalize", "complete", 3, 4, "Finishing up");

    if (chatId !== session.launch_chat_id || draft !== storedDraft) {
      getDb().prepare(`
        UPDATE dream_weaver_sessions
        SET launch_chat_id = ?, draft = ?, updated_at = ?
        WHERE id = ? AND user_id = ?
      `).run(chatId, serializeDraft(draft), Math.floor(Date.now() / 1000), sessionId, userId);
    }

    return {
      session: getSession(userId, sessionId)!,
      characterId: session.character_id,
      chatId,
      alreadyFinalized: true,
    };
  }

  emitProgress(userId, sessionId, "finalize", "creating_character", 1, 4, "Creating character");

  // Create world books from lorebooks + NPC definitions (before character so
  // we can attach the IDs at creation time).
  const worldBookIds = createWorldBooksFromDraft(userId, draft);

  let extensions: Record<string, unknown> = buildCharacterExtensionsFromDraft(
    {},
    sessionId,
    draft,
  );

  if (worldBookIds.length > 0) {
    extensions = setCharacterWorldBookIds(extensions as Record<string, any>, worldBookIds);
  }

  const characterPayload = buildCharacterPayloadFromDraft(
    sessionId,
    draft,
    extensions as Record<string, any>,
  );

  const character = charactersSvc.createCharacter(userId, {
    name: characterPayload.name!,
    description: characterPayload.description,
    personality: characterPayload.personality,
    scenario: characterPayload.scenario,
    first_mes: characterPayload.first_mes,
    system_prompt: characterPayload.system_prompt,
    post_history_instructions: characterPayload.post_history_instructions,
    tags: characterPayload.tags,
    alternate_greetings: characterPayload.alternate_greetings,
    extensions: characterPayload.extensions,
  });
  if (portraitImageId) {
    charactersSvc.setCharacterImage(userId, character.id, portraitImageId);
  }

  // Create character-scoped regex scripts
  createRegexScriptsFromDraft(userId, character.id, draft);

  emitProgress(userId, sessionId, "finalize", "creating_chat", 2, 4, "Setting up chat");

  const chat = chatsSvc.createChat(userId, {
    character_id: character.id,
  });

  emitProgress(userId, sessionId, "finalize", "complete", 3, 4, "Finishing up");

  getDb().prepare(`
    UPDATE dream_weaver_sessions
    SET draft = ?, character_id = ?, launch_chat_id = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(serializeDraft(draft), character.id, chat.id, Math.floor(Date.now() / 1000), sessionId, userId);

  return {
    session: getSession(userId, sessionId)!,
    characterId: character.id,
    chatId: chat.id,
    alreadyFinalized: false,
  };
}

export function deleteSession(userId: string, sessionId: string): void {
  ensureDreamWeaverSchema();

  getDb().prepare(`
    DELETE FROM dream_weaver_sessions
    WHERE id = ? AND user_id = ?
  `).run(sessionId, userId);
}

export interface SyncWorldResult {
  worldBookIds: string[];
  regexScriptsCreated: number;
}

export interface RepairCharacterCardResult {
  characterId: string | null;
  repaired: boolean;
}

export function repairCharacterCardDataFromSessionIfMissing(
  userId: string,
  sessionId: string,
): RepairCharacterCardResult {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  if (!session.character_id) {
    return { characterId: null, repaired: false };
  }

  const draft = parseStoredDreamWeaverDraft(session.draft);
  if (!draft) {
    return { characterId: session.character_id, repaired: false };
  }

  const character = charactersSvc.getCharacter(userId, session.character_id);
  if (!character) throw new Error("Character not found");

  const patch = buildMissingCharacterPayloadFromDraft(character, sessionId, draft);
  if (!patch) {
    return { characterId: session.character_id, repaired: false };
  }

  charactersSvc.updateCharacter(userId, session.character_id, patch);
  return { characterId: session.character_id, repaired: true };
}

export function syncWorldToCharacter(
  userId: string,
  sessionId: string,
): SyncWorldResult {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");
  if (!session.character_id) throw new Error("Session has no finalized character");

  const draft = parseStoredDreamWeaverDraft(session.draft);
  if (!draft) throw new Error("No draft to sync");

  const character = charactersSvc.getCharacter(userId, session.character_id);
  if (!character) throw new Error("Character not found");

  const worldBookIds = createWorldBooksFromDraft(userId, draft);

  if (worldBookIds.length > 0) {
    const existingIds = getCharacterWorldBookIds(character.extensions);
    const mergedIds = [...existingIds, ...worldBookIds];
    const nextExtensions = setCharacterWorldBookIds(
      character.extensions ?? {},
      mergedIds,
    );
    charactersSvc.updateCharacter(userId, session.character_id, {
      extensions: nextExtensions,
    });
  }

  const regexScriptsCreated = (draft.regex_scripts || []).filter(
    (s: any) => s.name && s.find_regex,
  ).length;
  createRegexScriptsFromDraft(userId, session.character_id, draft);

  return { worldBookIds, regexScriptsCreated };
}

// ---------------------------------------------------------------------------
// Truncated-JSON repair
// ---------------------------------------------------------------------------

/**
 * Attempt to repair JSON that was truncated mid-stream (e.g. by hitting
 * max_tokens). Closes unterminated strings and any open brackets/braces,
 * and strips trailing commas. Returns the repaired string — callers should
 * still wrap `JSON.parse()` in a try/catch because not all damage is
 * recoverable.
 */
function repairTruncatedJson(raw: string): string {
  let repaired = raw;

  let inString = false;
  let escaped = false;
  const openStack: string[] = [];

  for (let i = 0; i < repaired.length; i++) {
    const ch = repaired[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === "{") openStack.push("}");
      else if (ch === "[") openStack.push("]");
      else if (ch === "}" || ch === "]") openStack.pop();
    }
  }

  // Close an unterminated string (the most common truncation symptom)
  if (inString) {
    repaired += '"';
  }

  // Close all remaining open brackets/braces, stripping trailing commas
  // before each closing token so the JSON stays valid.
  while (openStack.length > 0) {
    repaired = repaired.replace(/,\s*$/, "");
    repaired += openStack.pop();
  }

  return repaired;
}

/**
 * Strip optional code-fence wrapper and parse JSON. On failure, attempt
 * truncation repair and retry once. Returns `null` if both attempts fail.
 */
function safeParseJson(content: string): any | null {
  const trimmed = content.trim();
  const jsonContent = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;

  try {
    return JSON.parse(jsonContent);
  } catch {
    // First parse failed — try repairing truncated JSON
  }

  try {
    const repaired = repairTruncatedJson(jsonContent);
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extend draft (additive generation)
// ---------------------------------------------------------------------------

export interface ExtendDraftInput {
  target: ExtendTarget;
  instruction?: string;
  count?: number;
  /** For lorebook_entries: generate entries inside this specific book rather than creating a new book. */
  bookId?: string;
}

export interface ExtendDraftResult {
  target: ExtendTarget;
  items: any[];
  /** Present when entries were generated for a specific book (lorebook_entries + bookId). */
  bookId?: string;
}

function parseExtendResponse(content: string, target: ExtendTarget, bookId?: string): any[] {
  const parsed = safeParseJson(content);
  if (!parsed) {
    console.warn("[DreamWeaver] Could not parse extend response — returning empty items");
    return [];
  }

  switch (target) {
    case "greetings":
      return Array.isArray(parsed.greetings) ? parsed.greetings : [];
    case "alternate_fields.description":
    case "alternate_fields.personality":
    case "alternate_fields.scenario":
      return Array.isArray(parsed.alternates) ? parsed.alternates : [];
    case "lorebook_entries":
      // Per-book mode returns { entries: [...] }; whole-book mode returns { lorebooks: [...] }
      if (bookId) {
        return Array.isArray(parsed.entries) ? parsed.entries : [];
      }
      return Array.isArray(parsed.lorebooks) ? parsed.lorebooks : [];
    case "npc_definitions":
      return Array.isArray(parsed.npc_definitions) ? parsed.npc_definitions : [];
    default:
      return [];
  }
}

export async function extendDraft(
  userId: string,
  sessionId: string,
  input: ExtendDraftInput,
): Promise<ExtendDraftResult> {
  ensureDreamWeaverSchema();

  const session = getSession(userId, sessionId);
  if (!session) throw new Error("Session not found");

  const draft = parseStoredDreamWeaverDraft(session.draft);
  if (!draft) throw new Error("No draft to extend. Generate a Soul draft first.");

  const connection = session.connection_id
    ? connectionsSvc.getConnection(userId, session.connection_id)
    : connectionsSvc.getDefaultConnection(userId);

  if (!connection) throw new Error("No connection available");

  const count = Math.min(Math.max(input.count ?? 2, 1), 5);
  const prompt = buildExtendPrompt(draft, input.target, count, input.instruction, input.bookId);

  const dwParams = getDWGenParams(userId);
  const dwAbort = createDWTimeout(dwParams);
  const result = await rawGenerate(userId, {
    provider: connection.provider,
    model: connection.model,
    messages: [
      { role: "system", content: EXTEND_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    parameters: applyDWGenParams({ temperature: 0.9, max_tokens: 16384 }, dwParams),
    connection_id: connection.id,
    signal: dwAbort?.signal,
  });
  dwAbort?.cleanup();

  return {
    target: input.target,
    bookId: input.bookId,
    items: parseExtendResponse(result.content, input.target, input.bookId),
  };
}
