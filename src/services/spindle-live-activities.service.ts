import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/connection";
import { activityCard, type ActivityCard } from "./spindle-live-activity-content";
import { encryptAPNsPayload, openIOSNotificationSecret, sealIOSNotificationSecret } from "./apns-encryption";
import { getLiveActivityAPNsInfo, sendAPNsSpindleActivity } from "./apns.service";
import { isAPNsRelayCredential } from "./apns-relay.service";
import { notificationPlainText } from "../utils/notification-text";
import { spindleActivityEncryption } from "./spindle-live-activity-encryption";
import type { LiveActivityResult, LiveActivityStatus, LiveActivityStartInput } from "../spindle/live-activities-contract";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
type Activity = { id: string; extension_id: string | null; user_id: string; activity_key: string; extension_name: string;
  content_json: string; revision: number; expires_at: number; ended_at: number | null };
type Device = { id: string; activity_id: string; destination_id: string; credential_hash: string; native_activity_id: string | null;
  token_epoch: string; token_registered_at: number; push_token: string | null; relay_credential: string | null; delivered_revision: number; last_timestamp: number;
  next_attempt_at: number; attempts: number; dismissed: number };
type Destination = { id: string; user_id: string; device_id: string; bundle_id: string; environment: "development" | "production";
  server_origin: string; delivery_mode: "direct" | "relay"; encryption_key: string; encryption_key_id: string };
const activity = (id: string) => getDb().query("SELECT * FROM spindle_live_activities WHERE id = ?").get(id) as Activity | null;
function owned(extensionId: string, userId: string, id: string) {
  const row = identifier(id) ? activity(id) : null;
  if (!row || row.extension_id !== extensionId || row.user_id !== userId) throw new Error("Live Activity not found");
  return row;
}
function result(row: Activity): LiveActivityResult {
  const started = getDb().query("SELECT 1 FROM spindle_live_activity_devices WHERE activity_id = ? AND native_activity_id IS NOT NULL AND dismissed = 0").get(row.id);
  return { id: row.id, revision: row.revision, state: row.ended_at || row.expires_at <= Date.now() ? "ended" : started ? "active" : "queued" };
}
export function spindleLiveActivityStatus(userId: string): LiveActivityStatus {
  const row = getDb().query(`SELECT COUNT(*) AS count FROM spindle_live_activity_clients c JOIN ios_push_destinations d ON d.id = c.destination_id
    WHERE d.user_id = ? AND d.encryption_key IS NOT NULL`).get(userId) as { count: number };
  return { available: row.count > 0, layouts: ["status", "progress", "image"], remoteStart: false, enrolledDevices: row.count };
}
export async function startSpindleLiveActivity(extensionId: string, extensionName: string, userId: string, input: LiveActivityStartInput) {
  if (!input || !identifier(input.key)) throw new Error("Live Activity key must contain 1–128 letters, digits, underscores or hyphens");
  const existing = getDb().query("SELECT * FROM spindle_live_activities WHERE extension_id = ? AND user_id = ? AND activity_key = ?")
    .get(extensionId, userId, input.key) as Activity | null;
  if (existing) return result(existing);
  const duration = input.durationSeconds ?? 3600;
  if (!Number.isInteger(duration) || duration < 60 || duration > 28800) throw new Error("Live Activity duration must be 60–28800 seconds");
  if (!spindleLiveActivityStatus(userId).available) throw new Error("Open an updated iOS app with notifications and Live Activities enabled first");
  const card = await activityCard(userId, input);
  const id = crypto.randomUUID();
  // Check again inside the transaction after asynchronous image preparation.
  return getDb().transaction(() => {
    const duplicate = getDb().query("SELECT * FROM spindle_live_activities WHERE extension_id = ? AND user_id = ? AND activity_key = ?")
      .get(extensionId, userId, input.key) as Activity | null;
    if (duplicate) return result(duplicate);
    const count = getDb().query("SELECT COUNT(*) AS count FROM spindle_live_activities WHERE user_id = ? AND ended_at IS NULL AND expires_at > ?")
      .get(userId, Date.now()) as { count: number };
    if (count.count >= 16) throw new Error("Too many Live Activities for this account");
    getDb().query(`INSERT INTO spindle_live_activities (id, extension_id, user_id, activity_key, extension_name, content_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, extensionId, userId, input.key, notificationPlainText(extensionName, 60), JSON.stringify(card), Date.now() + duration * 1000);
    return result(activity(id)!);
  })();
}
export async function updateSpindleLiveActivity(extensionId: string, userId: string, id: string, input: unknown) {
  const before = owned(extensionId, userId, id);
  if (before.ended_at || before.expires_at <= Date.now()) throw new Error("Live Activity has ended");
  const card = await activityCard(userId, input);
  const changed = getDb().query(`UPDATE spindle_live_activities SET content_json = ?, revision = revision + 1
    WHERE id = ? AND ended_at IS NULL AND expires_at > ?`).run(JSON.stringify(card), id, Date.now());
  if (!changed.changes) throw new Error("Live Activity has ended");
  void flushSpindleLiveActivities();
  return result(activity(id)!);
}
export function endSpindleLiveActivity(extensionId: string, userId: string, id: string) {
  owned(extensionId, userId, id);
  getDb().query("UPDATE spindle_live_activities SET ended_at = ?, revision = revision + 1 WHERE id = ? AND ended_at IS NULL").run(Date.now(), id);
  void flushSpindleLiveActivities();
  return result(activity(id)!);
}
function destination(userId: string, input: Record<string, unknown>): Destination {
  if (!identifier(input.deviceId) || typeof input.bundleId !== "string" || typeof input.serverOrigin !== "string") throw new Error("Invalid activity installation");
  const row = getDb().query(`SELECT * FROM ios_push_destinations WHERE user_id = ? AND device_id = ? AND bundle_id = ? AND environment = ?
    AND server_origin = ? AND encryption_key IS NOT NULL AND encryption_key_id IS NOT NULL`).get(userId, input.deviceId, input.bundleId,
      String(input.environment), input.serverOrigin) as Destination | null;
  if (!row || !getLiveActivityAPNsInfo(row.bundle_id).configured) throw new Error("Enable notifications on this installation first");
  return row;
}
function presentation(row: Activity, device: Device, dest: Destination) {
  const attributes = { id: row.id, registrationId: device.id, accountId: row.user_id, serverOrigin: dest.server_origin,
    extensionName: row.extension_name, bundleId: dest.bundle_id, environment: dest.environment };
  const card = JSON.parse(row.content_json) as ActivityCard;
  const encode = () => ({ version: 1, encrypted: encryptAPNsPayload(JSON.stringify({ ...card, id: row.id, revision: row.revision,
    terminal: !!row.ended_at || row.expires_at <= Date.now(), serverOrigin: dest.server_origin }),
    spindleActivityEncryption(device.credential_hash, device.id), dest.bundle_id, dest.environment) });
  let state = encode();
  // Native adds a 44-character, registration-scoped rendering key locally.
  const attributesSize = Buffer.byteLength(JSON.stringify({ ...attributes, renderKey: "x".repeat(44) }));
  if (attributesSize + Buffer.byteLength(JSON.stringify(state)) > 3800) { delete card.imageBase64; state = encode(); }
  if (attributesSize + Buffer.byteLength(JSON.stringify(state)) > 3800) throw new Error("Live Activity presentation is too large");
  return { attributes, state };
}
export function disableSpindleLiveActivityClient(userId: string, input: Record<string, unknown>) {
  const dest = destination(userId, input);
  getDb().query("DELETE FROM spindle_live_activity_clients WHERE destination_id = ?").run(dest.id);
  getDb().query("UPDATE spindle_live_activity_devices SET dismissed = 1, push_token = NULL, relay_credential = NULL WHERE destination_id = ?").run(dest.id);
}
export function spindleLiveActivitySnapshot(userId: string, input: Record<string, unknown>) {
  const dest = destination(userId, input);
  if (!Array.isArray(input.registrationIds) || input.registrationIds.length > 32 || !input.registrationIds.every(identifier))
    throw new Error("Invalid Live Activity registrations");
  const known = new Set(input.registrationIds);
  getDb().query("INSERT INTO spindle_live_activity_clients VALUES (?, ?) ON CONFLICT(destination_id) DO UPDATE SET seen_at = excluded.seen_at").run(dest.id, Date.now());
  const rows = getDb().query(`SELECT * FROM spindle_live_activities WHERE user_id = ? AND (expires_at > ? OR ended_at > ?)
    ORDER BY expires_at DESC LIMIT 32`).all(userId, Date.now(), Date.now() - 120000) as Activity[];
  const items = [];
  for (const row of rows) {
    let device = getDb().query("SELECT * FROM spindle_live_activity_devices WHERE activity_id = ? AND destination_id = ?").get(row.id, dest.id) as Device | null;
    if (device?.dismissed || ((!device || !known.has(device.id)) && (row.ended_at || row.expires_at <= Date.now()))) continue;
    let credential: string | undefined;
    if (!device || !known.has(device.id)) {
      credential = randomBytes(32).toString("base64url");
      const id = device?.id ?? crypto.randomUUID();
      getDb().query(`INSERT INTO spindle_live_activity_devices (id, activity_id, destination_id, credential_hash) VALUES (?, ?, ?, ?)
        ON CONFLICT(activity_id, destination_id) DO UPDATE SET credential_hash = excluded.credential_hash, native_activity_id = NULL,
          push_token = NULL, relay_credential = NULL, token_epoch = '', token_registered_at = 0, delivered_revision = 0, last_timestamp = 0, next_attempt_at = 0`).run(id, row.id, dest.id, hash(credential));
      device = getDb().query("SELECT * FROM spindle_live_activity_devices WHERE id = ?").get(id) as Device;
    }
    items.push({ registrationId: device.id, ...(credential ? { credential } : {}), ...presentation(row, device, dest),
      delivery: dest.delivery_mode, expiresAt: row.expires_at, revision: row.revision, ended: !!row.ended_at || row.expires_at <= Date.now() });
  }
  return { items };
}
function authorized(id: string, credential: string) {
  const row = identifier(id) ? getDb().query("SELECT * FROM spindle_live_activity_devices WHERE id = ?").get(id) as Device | null : null;
  if (!row || !/^[A-Za-z0-9_-]{43}$/.test(credential) || !timingSafeEqual(Buffer.from(row.credential_hash), Buffer.from(hash(credential)))) return null;
  return row;
}
export function refreshSpindleLiveActivity(id: string, credential: string, input: Record<string, unknown>) {
  const row = authorized(id, credential);
  if (!row || row.dismissed) return false;
  const dest = getDb().query("SELECT * FROM ios_push_destinations WHERE id = ?").get(row.destination_id) as Destination | null;
  if (!dest || !identifier(input.activityId) || (row.native_activity_id && input.activityId !== row.native_activity_id)
    || typeof input.pushToken !== "string" || !/^(?:[a-fA-F0-9]{2}){16,256}$/.test(input.pushToken)
    || (dest.delivery_mode === "relay" && !isAPNsRelayCredential(input.relayCredential))) throw new Error("Invalid activity token");
  const relay = dest.delivery_mode === "relay" ? input.relayCredential as string : undefined;
  const token = input.pushToken.toLowerCase();
  const oldRelay = row.relay_credential ? openIOSNotificationSecret(row.relay_credential, `spindle-activity:${id}`) : undefined;
  const changed = token !== row.push_token || relay !== oldRelay;
  if (changed) getDb().query(`UPDATE spindle_live_activity_devices SET native_activity_id = ?, push_token = ?, relay_credential = ?,
    token_epoch = ?, token_registered_at = ?, delivered_revision = 0, next_attempt_at = 0, attempts = 0 WHERE id = ?`)
    .run(input.activityId, token, sealIOSNotificationSecret(relay, `spindle-activity:${id}`), crypto.randomUUID(), Date.now(), id);
  void flushSpindleLiveActivities();
  return true;
}
export function dismissSpindleLiveActivity(id: string, credential: string) {
  const row = authorized(id, credential);
  if (row) getDb().query("UPDATE spindle_live_activity_devices SET dismissed = 1, push_token = NULL, relay_credential = NULL WHERE id = ?").run(id);
}
let sending: Promise<void> | undefined;
export function flushSpindleLiveActivities(): Promise<void> {
  if (sending) return sending;
  sending = flush().catch(() => { console.warn("[spindle-activities] Delivery deferred"); }).finally(() => { sending = undefined; });
  return sending;
}
async function flush() {
  const now = Date.now();
  getDb().query(`UPDATE spindle_live_activities SET ended_at = ?, revision = revision + 1 WHERE ended_at IS NULL AND (expires_at <= ?
    OR NOT EXISTS (SELECT 1 FROM extensions e JOIN extension_grants g ON g.extension_id = e.id
      WHERE e.id = spindle_live_activities.extension_id AND e.enabled = 1 AND g.permission = 'push_notification'
        AND g.scope = CASE WHEN e.install_scope IN ('user', 'operator') AND trim(COALESCE(e.installed_by_user_id, '')) != ''
          THEN e.install_scope || ':' || trim(e.installed_by_user_id) ELSE 'system' END))`).run(now, now);
  const devices = getDb().query(`SELECT r.* FROM spindle_live_activity_devices r JOIN spindle_live_activities a ON a.id = r.activity_id
    WHERE r.push_token IS NOT NULL AND r.dismissed = 0 AND r.delivered_revision < a.revision AND r.next_attempt_at <= ? LIMIT 64`).all(now) as Device[];
  for (const device of devices) {
    const row = activity(device.activity_id);
    const dest = getDb().query("SELECT * FROM ios_push_destinations WHERE id = ?").get(device.destination_id) as Destination | null;
    if (!row || !dest) continue;
    const timestamp = Math.floor(Date.now() / 1000);
    if (timestamp <= device.last_timestamp) continue;
    try {
      const { state } = presentation(row, device, dest);
      const delivery = await sendAPNsSpindleActivity({ device_token: device.push_token!, bundle_id: dest.bundle_id, environment: dest.environment,
        delivery_mode: dest.delivery_mode, relay_credential: device.relay_credential
          ? openIOSNotificationSecret(device.relay_credential, `spindle-activity:${device.id}`) : undefined }, state, timestamp, !!row.ended_at);
      // A rotated token must not be acknowledged or removed by an older send.
      if (delivery.invalidToken || (delivery.invalidatedAt !== undefined && delivery.invalidatedAt >= device.token_registered_at)) {
        getDb().query("UPDATE spindle_live_activity_devices SET dismissed = 1, push_token = NULL WHERE id = ? AND token_epoch = ?").run(device.id, device.token_epoch);
      } else if (delivery.sent) {
        getDb().query("UPDATE spindle_live_activity_devices SET delivered_revision = ?, last_timestamp = ?, attempts = 0 WHERE id = ? AND token_epoch = ?")
          .run(row.revision, timestamp, device.id, device.token_epoch);
      } else throw new Error("Deferred");
    } catch {
      getDb().query("UPDATE spindle_live_activity_devices SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ? AND token_epoch = ?")
        .run(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(device.attempts, 6)), device.id, device.token_epoch);
    }
  }
  getDb().query("DELETE FROM spindle_live_activities WHERE expires_at < ?").run(now - 12 * 3600000);
}
export function initSpindleLiveActivityDelivery() {
  const timer = setInterval(() => { void flushSpindleLiveActivities(); }, 2000);
  timer.unref();
  return () => clearInterval(timer);
}
