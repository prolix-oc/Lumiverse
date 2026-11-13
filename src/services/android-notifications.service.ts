import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";
import { getVapidPublicKey } from "../crypto/vapid";
import { eventBus } from "../ws/bus";
import { invalidateDesktopNotificationTickets } from "../ws/tickets";
import { sendFCMNotification, boundedAndroidPayload } from "./fcm.service";
import { getFCMRoute, fcmDeliveryAllowed, OFFICIAL_ANDROID_PACKAGE } from "./fcm-routing";
import { encryptFCMPayload, openAndroidSecret, sealAndroidSecret, validateAndroidEncryption } from "./fcm-encryption";
import { isFCMRelayCredential, revokeFCMRelayDestination, sendFCMRelayNotification } from "./fcm-relay.service";
import type { AndroidPushDestinationRecord, CreateAndroidPushDestinationInput, PushPayload } from "../types/push";

type PrivateDestination = Omit<AndroidPushDestinationRecord, "type"> & { device_token: string | null; server_origin: string; registered_at: number; enrollment_id: string | null; relay_url: string | null; relay_credential: string | null; encryption_key: string | null; encryption_key_id: string | null };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const androidServerInstanceId = () => `lvdi_${createHash("sha256").update(getVapidPublicKey()).digest("base64url").slice(0, 32)}`;
export function getAndroidNotificationInfo() { return { ...getFCMRoute(), encryptionVersion: 1, serverInstanceId: androidServerInstanceId() } }
export function listAndroidDestinations(userId: string): AndroidPushDestinationRecord[] {
  return (getDb().query(`SELECT id, user_id, device_id, transport, project_id, delivery_mode, package_name, label, user_agent, created_at, updated_at
    FROM android_push_destinations WHERE user_id = ? ORDER BY created_at DESC`).all(userId) as Array<Omit<AndroidPushDestinationRecord, "type">>)
    .map(row => ({ ...row, type: "android_native" }));
}
function revoke(userId: string, id: string) {
  invalidateDesktopNotificationTickets(userId, id);
  eventBus.disconnectDesktopNotificationDestination(userId, id);
}
export function createAndroidDestination(userId: string, input: CreateAndroidPushDestinationInput) {
  if (!input || !validId(input.deviceId) || input.deviceId.length < 16 || !["local", "fcm"].includes(input.transport))
    throw new Error("Invalid Android destination");
  if (input.accountId !== undefined && input.accountId !== userId) throw new Error("The account changed during notification enrollment");
  const origin = new URL(input.serverOrigin);
  if (!["http:", "https:"].includes(origin.protocol) || origin.origin !== input.serverOrigin || input.serverOrigin.length > 512)
    throw new Error("Invalid Android server origin");
  if (input.transport === "local") {
    if (!process.env.LUMIVERSE_ANDROID_HOST || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
      throw new Error("Local notifications require the embedded Android backend");
  } else {
    const info = getFCMRoute();
    if (!info.configured || input.projectId !== info.projectId) throw new Error(info.reason || "The APK and server Firebase projects do not match");
    if (input.delivery && input.delivery !== info.delivery) throw new Error("The Android delivery route changed. Try enrolling again.");
    if ((input.packageName || OFFICIAL_ANDROID_PACKAGE) !== info.packageName) throw new Error("The Android package does not match this server configuration");
    if (info.delivery === "relay" && (!isFCMRelayCredential(input.relayCredential) || !input.encryption || !input.enrollmentId))
      throw new Error("Update the Android app and complete relay verification before enabling notifications.");
    if (info.delivery === "direct" && (typeof input.deviceToken !== "string" || !/^[A-Za-z0-9_:.-]{32,4096}$/.test(input.deviceToken))) throw new Error("Invalid FCM token");
  }
  const route = input.transport === "fcm" ? getFCMRoute() : null;
  const encryption = input.transport === "fcm" && input.encryption ? validateAndroidEncryption(input.encryption) : undefined;
  if (input.enrollmentId !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(input.enrollmentId)) throw new Error("Invalid Android enrollment ID");
  if (encryption && !input.enrollmentId) throw new Error("Missing Android encryption context");
  const retired: PrivateDestination[] = [];
  const credential = `lva_${randomBytes(32).toString("base64url")}`, now = Math.floor(Date.now() / 1000);
  const result = getDb().transaction(() => {
    // Resume/poll and foreground opt-in can finish together. Reusing the same
    // verified encryption context must not create two competing destinations.
    if (encryption && input.enrollmentId) {
      const current = getDb().query("SELECT * FROM android_push_destinations WHERE enrollment_id=?").get(input.enrollmentId) as PrivateDestination | null;
      if (current && current.user_id === userId && current.device_id === input.deviceId && current.server_origin === origin.origin
        && current.project_id === input.projectId && current.delivery_mode === route?.delivery && current.package_name === route.packageName
        && current.encryption_key_id === encryption.keyId && current.encryption_key
        && openAndroidSecret(current.encryption_key, `key:${current.id}`) === encryption.key
        && (route.delivery !== "relay" || (current.relay_url === route.relayUrl && current.relay_credential
          && openAndroidSecret(current.relay_credential, `relay:${current.id}`) === input.relayCredential))
        && (route.delivery !== "direct" || current.device_token === input.deviceToken)) {
        getDb().query("UPDATE android_push_destinations SET token_hash=?,updated_at=? WHERE id=?").run(hash(credential), now, current.id);
        return { destination: listAndroidDestinations(userId).find(row => row.id === current.id)!, credential, serverInstanceId: androidServerInstanceId() };
      }
    }
    const old = getDb().query(`SELECT * FROM android_push_destinations WHERE device_id = ? OR (device_token IS NOT NULL AND device_token = ?)`)
      .all(input.deviceId, input.deviceToken ?? null) as PrivateDestination[];
    for (const row of old) { getDb().query("DELETE FROM android_push_destinations WHERE id = ?").run(row.id); revoke(row.user_id, row.id); if (row.enrollment_id !== input.enrollmentId) retired.push(row) }
    // A new ID makes delayed pushes from an earlier account/enrollment unusable.
    const id = crypto.randomUUID();
    getDb().query(`INSERT INTO android_push_destinations
      (id,user_id,device_id,transport,device_token,project_id,server_origin,token_hash,label,user_agent,created_at,updated_at,registered_at,delivery_mode,package_name,enrollment_id,relay_url,relay_credential,encryption_key,encryption_key_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, userId, input.deviceId, input.transport,
        input.transport === "fcm" && route?.delivery === "direct" ? input.deviceToken! : null, input.transport === "fcm" ? input.projectId! : null,
        origin.origin, hash(credential), typeof input.label === "string" ? input.label.slice(0, 100) : "Lumiverse Android",
        typeof input.userAgent === "string" ? input.userAgent.slice(0, 500) : "", now, now, Date.now(), route?.delivery || "direct", route?.packageName || OFFICIAL_ANDROID_PACKAGE,
        encryption ? input.enrollmentId! : null, route?.delivery === "relay" ? route.relayUrl! : null,
        sealAndroidSecret(route?.delivery === "relay" ? input.relayCredential : undefined, `relay:${id}`),
        sealAndroidSecret(encryption?.key, `key:${id}`), encryption?.keyId ?? null);
    return { destination: listAndroidDestinations(userId).find(row => row.id === id)!, credential, serverInstanceId: androidServerInstanceId() };
  })();
  for (const row of retired) void revokeRelay(row).catch(() => {});
  return result;
}
async function revokeRelay(row: PrivateDestination) {
  if (row.delivery_mode === "relay" && row.relay_url && row.relay_credential)
    await revokeFCMRelayDestination(row.relay_url, openAndroidSecret(row.relay_credential, `relay:${row.id}`));
}
export function authenticateAndroidCredential(credential: string) {
  if (!/^lva_[A-Za-z0-9_-]{43}$/.test(credential)) return null;
  const row = getDb().query("SELECT id, user_id FROM android_push_destinations WHERE token_hash = ? AND transport = 'local'")
    .get(hash(credential)) as { id: string; user_id: string } | null;
  return row ? { destinationId: row.id, userId: row.user_id } : null;
}
export async function deleteAndroidDestination(userId: string, id: string): Promise<boolean> {
  const row = getDb().query("DELETE FROM android_push_destinations WHERE id = ? AND user_id = ? RETURNING *").get(id, userId) as PrivateDestination | null;
  if (!row) return false;
  revoke(userId, id);
  try { await revokeRelay(row); } catch { /* Local revocation succeeds during relay outages. */ }
  return true;
}

function avatarProof(destinationId: string, characterId: string, expires: number) {
  return createHmac("sha256", getEncryptionKeyBytes()).update(JSON.stringify(["lumiverse-android-avatar-v1", destinationId, characterId, expires])).digest();
}
export function androidAvatarPath(destinationId: string, characterId: string, now = Math.floor(Date.now() / 1000)) {
  const expires = now + 3900;
  return `/api/android-notifications/v1/avatar/${destinationId}/${characterId}?expires=${expires}&signature=${avatarProof(destinationId, characterId, expires).toString("base64url")}`;
}
export function verifyAndroidAvatar(destinationId: string, characterId: string, expiry?: string, proof?: string, now = Math.floor(Date.now() / 1000)) {
  if (!validId(destinationId) || !validId(characterId) || !/^\d{1,12}$/.test(expiry ?? "") || !/^[A-Za-z0-9_-]{43}$/.test(proof ?? "")) return false;
  const expires = Number(expiry);
  return expires > now && expires <= now + 3900 && timingSafeEqual(Buffer.from(proof!, "base64url"), avatarProof(destinationId, characterId, expires));
}
export async function sendAndroidNotifications(userId: string, notification: PushPayload, destinationId?: string, shouldSend = () => true) {
  const rows = getDb().query("SELECT * FROM android_push_destinations WHERE user_id = ?").all(userId) as PrivateDestination[];
  const results = await Promise.allSettled(rows.filter(row => !destinationId || row.id === destinationId).map(async row => {
    if (!shouldSend()) return 0;
    const characterId = notification.icon?.match(/^\/api\/v1\/characters\/([A-Za-z0-9_-]{1,128})\/avatar\?size=sm$/)?.[1];
    const payload = boundedAndroidPayload(notification, characterId ? androidAvatarPath(row.id, characterId) : undefined);
    if (row.transport === "local") return eventBus.sendDesktopNotification(userId, [row.id], JSON.parse(payload));
    if (!fcmDeliveryAllowed(row.delivery_mode)) return 0;
    if ((row.enrollment_id || row.encryption_key || row.encryption_key_id) && !(row.enrollment_id && row.encryption_key && row.encryption_key_id)) return 0;
    const encrypted = row.encryption_key && row.encryption_key_id && row.enrollment_id ? encryptFCMPayload(payload, row.id, userId,
      { key: openAndroidSecret(row.encryption_key, `key:${row.id}`), keyId: row.encryption_key_id },
      { projectId: row.project_id!, packageName: row.package_name, enrollmentId: row.enrollment_id,
        serverOrigin: row.server_origin, serverInstanceId: androidServerInstanceId() }) : undefined;
    const result = row.delivery_mode === "relay"
      ? encrypted && row.relay_url && row.relay_credential
        ? await sendFCMRelayNotification(row.relay_url, openAndroidSecret(row.relay_credential, `relay:${row.id}`), encrypted, shouldSend)
        : { sent: false }
      : await sendFCMNotification(row.device_token!, encrypted ? { lvEncrypted: JSON.stringify(encrypted), enrollmentId: row.enrollment_id! }
        : { payload, destinationId: row.id, serverOrigin: row.server_origin, serverInstanceId: androidServerInstanceId() }, shouldSend);
    if (result.invalidToken) getDb().query("DELETE FROM android_push_destinations WHERE id = ? AND registered_at = ?")
      .run(row.id, row.registered_at);
    return result.sent ? 1 : 0;
  }));
  return results.reduce((count, result) => count + (result.status === "fulfilled" ? result.value : 0), 0);
}
