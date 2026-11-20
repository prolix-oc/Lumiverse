import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getActivePoolsForUser, getPoolEntry, type PooledTokensEntry } from "./generation-pool.service";
import { getLiveActivityAPNsInfo, sendAPNsLiveActivity, type APNsEnvironment } from "./apns.service";
import { notificationPlainText } from "../utils/notification-text";
import { getActiveGeneration, stopGeneration } from "./generation/active-generation-registry";
import { getSetting } from "./settings.service";
import type { PushNotificationPreferences } from "../types/push";
import { isAPNsRelayCredential } from "./apns-relay.service";
import { openIOSNotificationSecret, sealIOSNotificationSecret } from "./apns-encryption";

const labels = { assembling: "Preparing response", council: "Consulting council", waiting: "Waiting for model",
  reasoning: "Thinking", streaming: "Writing response", inputNeeded: "Input needed", completed: "Response ready",
  stopped: "Generation stopped", error: "Generation failed", interrupted: "Generation unavailable" } as const;
export type ActivityPhase = keyof typeof labels;
export const isTerminalActivityPhase = (phase: string) => ["completed", "stopped", "error", "interrupted"].includes(phase);
export const activityState = (phase: ActivityPhase) => ({ phase, label: labels[phase] });
export function poolActivityPhase(entry: PooledTokensEntry): ActivityPhase {
  return !isTerminalActivityPhase(entry.status) && entry.councilRetryPending ? "inputNeeded" : entry.status;
}
interface Registration {
  id: string; user_id: string; chat_id: string; generation_id: string; device_id: string; bundle_id: string;
  environment: APNsEnvironment; server_origin: string; activity_id: string | null; push_token: string | null;
  token_registered_at: number; expires_at: number; desired_phase: ActivityPhase; delivered_phase: ActivityPhase | null;
  last_timestamp: number; next_attempt_at: number; attempts: number; ended_at: number | null; delivered_stage: number;
  delivery_mode: "relay" | "direct"; relay_credential: string | null;
}
const soundStage = (phase: ActivityPhase) => ({ assembling: 0, council: 0, waiting: 0, reasoning: 1,
  streaming: 2, completed: 3, error: 4 } as Partial<Record<ActivityPhase, number>>)[phase] ?? -1;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function liveActivitySnapshot(userId: string, generationIds: unknown) {
  if (!Array.isArray(generationIds) || generationIds.length > 32 || !generationIds.every(identifier)) throw new Error("Invalid activity identifiers");
  const snapshot = (id: string) => {
    const entry = getPoolEntry(id);
    return { generationId: id, state: activityState(entry?.userId === userId ? poolActivityPhase(entry) : "interrupted") };
  };
  return { active: getActivePoolsForUser(userId).slice(-16).map(entry => ({ generationId: entry.generationId })),
    existing: generationIds.map(snapshot) };
}

/** The browser can mint a credential scoped to this generation and its activity. */
export function prepareLiveActivity(userId: string, input: Record<string, unknown>) {
  const info = getLiveActivityAPNsInfo(typeof input.bundleId === "string" ? input.bundleId : undefined);
  if (!info.configured) throw new Error(info.reason!);
  const entry = identifier(input.generationId) ? getPoolEntry(input.generationId) : undefined;
  if (!entry || entry.userId !== userId) throw new Error("Generation not found");
  if (!identifier(input.deviceId) || input.deviceId.length < 16 || input.bundleId !== info.bundleId
    || !["development", "production"].includes(String(input.environment))) throw new Error("Invalid activity installation");
  const origin = typeof input.serverOrigin === "string" ? new URL(input.serverOrigin) : null;
  if (!origin || !["https:", "http:"].includes(origin.protocol) || origin.origin !== input.serverOrigin
    || origin.username || origin.password || origin.origin.length > 512) throw new Error("Invalid activity server origin");
  if (info.delivery === "relay" && !getDb().query(`SELECT 1 FROM ios_push_destinations WHERE user_id = ? AND device_id = ?
    AND bundle_id = ? AND environment = ? AND server_origin = ? AND delivery_mode = 'relay'`).get(userId,
    input.deviceId as string, info.bundleId, input.environment as string, origin.origin))
    throw new Error("Enable notifications on this iPhone before starting relay Live Activities.");
  const now = Date.now(), expiresAt = now + 8 * 60 * 60 * 1000;
  const credential = randomBytes(32).toString("base64url"), id = crypto.randomUUID();
  const phase = poolActivityPhase(entry);
  getDb().transaction(() => {
    getDb().query("DELETE FROM ios_live_activities WHERE expires_at <= ?").run(now);
    // A repeated prepare replaces an abandoned enrollment; its old credential is revoked.
    getDb().query(`DELETE FROM ios_live_activities WHERE user_id = ? AND device_id = ? AND bundle_id = ?
      AND environment = ? AND generation_id = ?`).run(userId, input.deviceId as string, info.bundleId, input.environment as string, entry.generationId);
    const count = getDb().query("SELECT COUNT(*) AS count FROM ios_live_activities WHERE user_id = ? AND device_id = ? AND ended_at IS NULL")
      .get(userId, input.deviceId as string) as { count: number };
    if (count.count >= 32) throw new Error("Too many Live Activities on this device");
    getDb().query(`INSERT INTO ios_live_activities (id, user_id, chat_id, generation_id, device_id, bundle_id,
      environment, server_origin, credential_hash, expires_at, desired_phase, delivery_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, userId, entry.chatId, entry.generationId, input.deviceId as string, info.bundleId,
        input.environment as string, origin.origin, hash(credential), expiresAt, phase, info.delivery || "direct");
  })();
  return { registrationId: id, credential, expiresAt, accountId: userId, serverOrigin: origin.origin, delivery: info.delivery || "direct",
    attributes: { generationId: entry.generationId, chatId: entry.chatId, serverOrigin: origin.origin, accountId: userId,
      characterName: notificationPlainText(entry.characterName, 60) || "Assistant", startedAt: entry.startedAt / 1000 },
    state: activityState(phase) };
}

function authorized(id: string, credential: string) {
  if (!identifier(id) || !/^[A-Za-z0-9_-]{43}$/.test(credential)) return null;
  return getDb().query("SELECT * FROM ios_live_activities WHERE id = ? AND credential_hash = ? AND expires_at > ?")
    .get(id, hash(credential), Date.now()) as Registration | null;
}
export function liveActivityAvatarOwner(id: string, credential: string) {
  const row = authorized(id, credential);
  if (!row || row.ended_at !== null) return null;
  const entry = getPoolEntry(row.generation_id);
  return entry?.userId === row.user_id && entry.characterId ? { userId: row.user_id, characterId: entry.characterId } : null;
}
export function refreshLiveActivity(id: string, credential: string, input: Record<string, unknown>) {
  const row = authorized(id, credential);
  if (!row) return null;
  if (!identifier(input.activityId) || (row.activity_id && row.activity_id !== input.activityId)
    || typeof input.pushToken !== "string" || !/^(?:[a-fA-F0-9]{2}){16,256}$/.test(input.pushToken)) throw new Error("Invalid activity token");
  if (row.delivery_mode === "relay" && !isAPNsRelayCredential(input.relayCredential)) throw new Error("Missing activity relay enrollment");
  const entry = getPoolEntry(row.generation_id);
  const phase = entry?.userId === row.user_id ? poolActivityPhase(entry)
    : isTerminalActivityPhase(row.desired_phase) ? row.desired_phase : "interrupted";
  // Idempotent retries don't reset delivery backoff or invalidate an in-flight send.
  const token = input.pushToken.toLowerCase();
  if (token !== row.push_token || (row.delivery_mode === "relay" && (!row.relay_credential
    || input.relayCredential !== openIOSNotificationSecret(row.relay_credential, `ios-activity:${id}`)))) {
    getDb().query(`UPDATE ios_live_activities SET activity_id = ?, push_token = ?, token_registered_at = ?, desired_phase = ?,
      delivered_phase = NULL, attempts = 0, next_attempt_at = 0, relay_credential = ? WHERE id = ?`)
      .run(input.activityId, token, Date.now(), phase,
        sealIOSNotificationSecret(row.delivery_mode === "relay" ? input.relayCredential as string : undefined, `ios-activity:${id}`), id);
  }
  void flushLiveActivities().catch(() => console.warn("[live-activities] Enrollment update deferred"));
  return { state: activityState(phase) };
}
export function revokeLiveActivity(id: string, credential: string): boolean {
  const row = authorized(id, credential);
  return !!row && getDb().query("DELETE FROM ios_live_activities WHERE id = ?").run(id).changes > 0;
}

/** A widget can stop only the generation bound to its enrollment, never a chat's newer generation. */
export async function stopLiveActivityGeneration(id: string, credential: string) {
  const row = authorized(id, credential);
  if (!row) return null;
  const snapshot = () => {
    const entry = getPoolEntry(row.generation_id);
    return activityState(entry?.userId === row.user_id && entry.chatId === row.chat_id ? poolActivityPhase(entry)
      : isTerminalActivityPhase(row.desired_phase) ? row.desired_phase : "interrupted");
  };
  const state = snapshot();
  if (isTerminalActivityPhase(state.phase)) return { state };
  const active = getActiveGeneration(row.generation_id);
  if (!active || active.userId !== row.user_id || active.chatId !== row.chat_id) throw new Error("Generation is no longer active");
  if (!active.controller.signal.aborted) stopGeneration(row.user_id, row.generation_id);
  // Let normal generation teardown save partial output and publish its terminal
  // event. A slow provider must not keep a Lock Screen action waiting forever.
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([active.completion.catch(() => {}), new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); })]);
  } finally { clearTimeout(timeout); }
  return { state: snapshot() };
}

let flushing: Promise<void> | null = null;
let flushRequested = false;
let timestampTimer: ReturnType<typeof setTimeout> | undefined;
let timestampDue = Infinity;
function retryAtTimestampBoundary(lastTimestamp: number) {
  const due = (lastTimestamp + 1) * 1000;
  if (due >= timestampDue) return;
  clearTimeout(timestampTimer);
  timestampDue = due;
  timestampTimer = setTimeout(() => {
    timestampDue = Infinity;
    void flushLiveActivities().catch(() => console.warn("[live-activities] Update deferred"));
  }, Math.max(1, due - Date.now()));
  timestampTimer.unref();
}
/** Persistent retries + one serialized sender prevent an old phase overwriting completion. */
export function flushLiveActivities(): Promise<void> {
  flushRequested = true;
  if (flushing) return flushing;
  flushing = (async () => {
    do { flushRequested = false; await flush(); } while (flushRequested);
  })().finally(() => { flushing = null; });
  return flushing;
}
async function flush() {
  const db = getDb(), now = Date.now();
  db.query("DELETE FROM ios_live_activities WHERE expires_at <= ?").run(now);
  const rows = db.query(`SELECT * FROM ios_live_activities WHERE push_token IS NOT NULL AND next_attempt_at <= ?
    AND (ended_at IS NULL OR delivered_phase IS NULL)`).all(now) as Registration[];
  // Bounded batches keep one slow provider response from blocking every installation.
  for (let offset = 0; offset < rows.length; offset += 8) {
    await Promise.all(rows.slice(offset, offset + 8).map(async row => {
      const entry = getPoolEntry(row.generation_id);
      const phase = entry?.userId === row.user_id ? poolActivityPhase(entry)
        : isTerminalActivityPhase(row.desired_phase) ? row.desired_phase : "interrupted";
      if (phase === row.delivered_phase && !isTerminalActivityPhase(phase) && now - row.last_timestamp * 1000 < 240_000) return;
      // ActivityKit orders by Unix seconds. Never reuse a timestamp for a newer state.
      const timestamp = Math.floor(Date.now() / 1000);
      if (timestamp <= row.last_timestamp) { retryAtTimestampBoundary(row.last_timestamp); return; }
      db.query("UPDATE ios_live_activities SET desired_phase = ? WHERE id = ?").run(phase, row.id);
      try {
        const preferences = getSetting(row.user_id, "pushNotificationPreferences")?.value as Partial<PushNotificationPreferences> | undefined;
        const stage = soundStage(phase);
        // Persist observed progress even when foreground/preferences mute a cue.
        // Phase regressions, token refreshes and heartbeats must never replay it.
        const activityAlert = stage > row.delivered_stage && row.delivered_phase !== phase && preferences?.enabled !== false
          && preferences?.events?.[phase === "error" ? "generation_error" : "generation_ended"] !== false
          && !eventBus.isUserVisible(row.user_id);
        const terminalAlert = isTerminalActivityPhase(phase) && activityAlert;
        // Alerting updates precede a silent end so ActivityKit plays the sound.
        const ending = isTerminalActivityPhase(phase) && !terminalAlert;
        const result = await sendAPNsLiveActivity({ device_token: row.push_token!, bundle_id: row.bundle_id, environment: row.environment,
          delivery_mode: row.delivery_mode, relay_credential: row.relay_credential ? openIOSNotificationSecret(row.relay_credential, `ios-activity:${row.id}`) : null },
          activityState(phase), timestamp, ending, phase !== row.delivered_phase, activityAlert);
        if (result.invalidToken || (result.invalidatedAt !== undefined && result.invalidatedAt >= row.token_registered_at)) {
          db.query("DELETE FROM ios_live_activities WHERE id = ? AND push_token = ? AND token_registered_at = ?")
            .run(row.id, row.push_token, row.token_registered_at);
        } else if (result.sent) {
          db.query(`UPDATE ios_live_activities SET delivered_phase = ?, delivered_stage = MAX(delivered_stage, ?), last_timestamp = ?, attempts = 0, next_attempt_at = ?,
            ended_at = ? WHERE id = ? AND push_token = ? AND token_registered_at = ?`)
            .run(phase, stage, timestamp, terminalAlert ? Date.now() + 10_000 : 0, ending ? Date.now() : null, row.id, row.push_token, row.token_registered_at);
        } else retry(row);
      } catch { retry(row); }
    }));
  }
}
function retry(row: Registration) {
  getDb().query(`UPDATE ios_live_activities SET attempts = attempts + 1, next_attempt_at = ?
    WHERE id = ? AND push_token = ? AND token_registered_at = ?`)
    .run(Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(row.attempts, 5)), row.id, row.push_token, row.token_registered_at);
}

let stop: (() => void) | undefined;
export function initLiveActivityListeners(): () => void {
  if (stop) return stop;
  const disposers = [EventType.GENERATION_STARTED, EventType.GENERATION_PHASE_CHANGED, EventType.GENERATION_ENDED,
    EventType.GENERATION_STOPPED, EventType.COUNCIL_TOOLS_FAILED].map(type => eventBus.on(type, event => {
    const { generationId } = event.payload as { generationId?: string };
    if (!event.userId || !generationId) return;
    const entry = getPoolEntry(generationId);
    const payload = event.payload as { error?: unknown; phase?: ActivityPhase };
    const phase = entry?.userId === event.userId ? poolActivityPhase(entry)
      : type === EventType.GENERATION_ENDED ? (payload.error ? "error" : "completed")
      : type === EventType.GENERATION_STOPPED ? "stopped" : undefined;
    if (phase) getDb().query("UPDATE ios_live_activities SET desired_phase = ? WHERE user_id = ? AND generation_id = ? AND ended_at IS NULL")
      .run(phase, event.userId, generationId);
    void flushLiveActivities().catch(() => console.warn("[live-activities] Update deferred"));
  }));
  const timer = setInterval(() => { void flushLiveActivities().catch(() => console.warn("[live-activities] Update deferred")); }, 2000);
  timer.unref();
  stop = () => { clearInterval(timer); clearTimeout(timestampTimer); timestampDue = Infinity; disposers.forEach(dispose => dispose()); stop = undefined; };
  return stop;
}
