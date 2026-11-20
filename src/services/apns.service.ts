import { createPrivateKey, createHash, sign, X509Certificate, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import type { PushPayload } from "../types/push";
import { issueIOSNotificationAvatarPath } from "./ios-notification-avatar";
import { notificationPlainText } from "../utils/notification-text";
import { getAPNsRoute } from "./apns-routing";
import { encryptAPNsPayload, encryptedAPNsPayload, openIOSNotificationSecret } from "./apns-encryption";
import { sendAPNsRelayNotification } from "./apns-relay.service";

export type APNsEnvironment = "development" | "production";
export const IOS_COMPLETION_SOUND = "lumiverse-complete.wav";
const activitySounds: Record<string, string> = { assembling: "lumiverse-prepare.wav", council: "lumiverse-prepare.wav",
  waiting: "lumiverse-prepare.wav", reasoning: "lumiverse-think.wav", streaming: "lumiverse-respond.wav", completed: IOS_COMPLETION_SOUND };
export interface APNsDestination {
  id?: string;
  device_token: string;
  bundle_id: string;
  environment: APNsEnvironment;
  server_origin: string;
  delivery_mode?: "relay" | "direct";
  relay_credential?: string | null;
  encryption_key?: string | null;
  encryption_key_id?: string | null;
}
export interface APNsTokenConfiguration { teamId: string; keyId: string; bundleId: string; privateKey: KeyObject }
export interface APNsCertificateConfiguration { bundleId: string; certificate: string; privateKey: KeyObject }
export type APNsConfiguration = APNsTokenConfiguration | APNsCertificateConfiguration;

let configuration: APNsConfiguration | undefined;
let liveConfiguration: APNsTokenConfiguration | undefined;
const jwts = new Map<string, { value: string; issuedAt: number }>();
const sessions = new Map<string, ClientHttp2Session>();

/** Keys belong on the server. Nothing returned by the public info route contains a key or token. */
export function getAPNsConfiguration(): APNsConfiguration | null {
  if (configuration) return configuration;
  const loaded = loadAPNsConfiguration(process.env);
  if (loaded) configuration = loaded;
  return loaded;
}

export function loadAPNsConfiguration(env: NodeJS.ProcessEnv, pushType: "alert" | "liveactivity" = "alert"): APNsConfiguration | null {
  if (pushType === "liveactivity") {
    // A certificate's private key isn't an APNs provider key. Allow both kinds
    // of delivery on servers that already use certificate-authenticated alerts.
    const keyPath = env.APNS_LIVE_ACTIVITY_PRIVATE_KEY_PATH || (!env.APNS_CERTIFICATE_PATH ? env.APNS_PRIVATE_KEY_PATH : undefined);
    if (!keyPath) return null;
    return loadAPNsConfiguration({ ...env, APNS_CERTIFICATE_PATH: undefined, APNS_PRIVATE_KEY_PATH: keyPath,
      APNS_TEAM_ID: env.APNS_LIVE_ACTIVITY_TEAM_ID || env.APNS_TEAM_ID,
      APNS_KEY_ID: env.APNS_LIVE_ACTIVITY_KEY_ID || env.APNS_KEY_ID,
      APNS_PRIVATE_KEY_PASSPHRASE: env.APNS_LIVE_ACTIVITY_PRIVATE_KEY_PASSPHRASE || (!env.APNS_CERTIFICATE_PATH ? env.APNS_PRIVATE_KEY_PASSPHRASE : undefined),
      APNS_PRIVATE_KEY_PASSPHRASE_FILE: env.APNS_LIVE_ACTIVITY_PRIVATE_KEY_PASSPHRASE_FILE || (!env.APNS_CERTIFICATE_PATH ? env.APNS_PRIVATE_KEY_PASSPHRASE_FILE : undefined) });
  }
  const teamId = env.APNS_TEAM_ID, keyId = env.APNS_KEY_ID;
  const keyPath = env.APNS_PRIVATE_KEY_PATH;
  const certificatePath = env.APNS_CERTIFICATE_PATH;
  if (!certificatePath && (!teamId || !keyId || !keyPath)) return null;
  const bundleId = env.APNS_BUNDLE_ID || "chat.lumiverse.ios";
  if (!keyPath || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error("Invalid APNs configuration");
  const passphrase = env.APNS_PRIVATE_KEY_PASSPHRASE_FILE
    ? readFileSync(env.APNS_PRIVATE_KEY_PASSPHRASE_FILE, "utf8").trimEnd()
    : env.APNS_PRIVATE_KEY_PASSPHRASE;
  const privateKey = createPrivateKey({ key: readFileSync(keyPath), ...(passphrase ? { passphrase } : {}) });
  if (certificatePath) {
    // Apple's downloaded .cer is DER; X509Certificate also accepts PEM.
    const certificate = new X509Certificate(readFileSync(certificatePath));
    const now = Date.now();
    if (!certificate.checkPrivateKey(privateKey)
      || now < Date.parse(certificate.validFrom) || now >= Date.parse(certificate.validTo))
      throw new Error("APNs certificate must be current and match its private key");
    const certificateBundleId = certificate.subject.split("\n").find(line => line.startsWith("UID="))?.slice(4);
    if (certificateBundleId !== bundleId) throw new Error("APNs certificate does not match the configured bundle ID");
    return { bundleId, certificate: certificate.toString(), privateKey };
  }
  if (!/^[A-Z0-9]{10}$/.test(teamId!) || !/^[A-Z0-9]{10}$/.test(keyId!)) throw new Error("Invalid APNs configuration");
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("APNs requires an ES256 (.p8) signing key");
  return { teamId: teamId!, keyId: keyId!, bundleId, privateKey };
}

export function getAPNsInfo(bundleId?: string): { configured: boolean; bundleId: string; reason: string | null;
  delivery: "relay" | "direct" | null; relayUrl?: string; encryptionRequired?: boolean } {
  const route = getAPNsRoute(bundleId);
  if (route.mode === "relay") return { configured: true, bundleId: route.bundleId, reason: null,
    delivery: "relay", relayUrl: route.relayUrl, encryptionRequired: true };
  if (!route.mode) return { configured: false, bundleId: route.bundleId, reason: route.reason, delivery: null };
  try {
    const config = getAPNsConfiguration();
    return { configured: !!config, bundleId: config?.bundleId || process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios",
      delivery: "direct", reason: config ? null : "The server needs an APNs signing key or certificate and matching private key before it can deliver iPhone notifications." };
  } catch {
    return { configured: false, bundleId: process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios",
      delivery: "direct", reason: "The server's APNs configuration is invalid. Ask the server administrator to check it." };
  }
}

function getLiveConfiguration(): APNsTokenConfiguration | null {
  if (liveConfiguration) return liveConfiguration;
  const loaded = loadAPNsConfiguration(process.env, "liveactivity");
  if (loaded && "teamId" in loaded) liveConfiguration = loaded;
  return liveConfiguration ?? null;
}

export function getLiveActivityAPNsInfo(bundleId?: string) {
  const route = getAPNsRoute(bundleId);
  if (route.mode === "relay") return { configured: true, bundleId: route.bundleId, reason: null, delivery: "relay" as const, relayUrl: route.relayUrl };
  if (!route.mode) return { configured: false, bundleId: route.bundleId, reason: route.reason, delivery: null };
  try {
    const config = getLiveConfiguration();
    return { configured: !!config, bundleId: config?.bundleId || process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios",
      delivery: "direct" as const, reason: config ? null : "Live Activities need an APNs ES256 provider key (.p8) on this server." };
  } catch {
    return { configured: false, bundleId: process.env.APNS_BUNDLE_ID || "chat.lumiverse.ios",
      delivery: "direct" as const, reason: "The server's Live Activities APNs key configuration is invalid." };
  }
}

export function createAPNsJWT(config: APNsTokenConfiguration, issuedAt = Math.floor(Date.now() / 1000)): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: issuedAt })}`;
  const signature = sign("sha256", Buffer.from(input), { key: config.privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${signature.toString("base64url")}`;
}

/** An alert payload needs no background mode and remains deliverable while the app is suspended. */
export function buildAPNsPayload(notification: PushPayload, serverOrigin?: string, avatarPath?: string, maxBytes = 4096): string {
  const limit = (text: string, bytes: number) => {
    let result = "", size = 0;
    for (const character of text) {
      size += Buffer.byteLength(character);
      if (size > bytes) break;
      result += character;
    }
    return result;
  };
  const chatId = notification.data?.chatId ?? notification.data?.url?.match(/^\/chat\/([A-Za-z0-9_-]{1,128})$/)?.[1];
  // Navigation is constructed from an identifier, never from an arbitrary push URL.
  const senderName = notificationPlainText(notification.data?.characterName, 100);
  const senderId = notification.icon?.match(/^\/api\/v1\/characters\/([A-Za-z0-9_-]{1,128})\/avatar\?size=sm$/)?.[1];
  const communication = avatarPath && senderId && senderName && chatId && /^[A-Za-z0-9_-]{1,128}$/.test(chatId)
    && !notification.data?.errorMessage && !notification.data?.errorCode && !notification.tag?.startsWith("generation-error-")
    ? { senderId, senderName: limit(senderName, 256), avatarPath } : undefined;
  const completion = notification.tag?.startsWith("generation-") && !notification.tag.startsWith("generation-error-")
    && !notification.data?.errorMessage && !notification.data?.errorCode;
  const payload = { aps: { alert: { title: limit(notification.title, 256), body: limit(notification.body, 2048) },
      sound: completion ? IOS_COMPLETION_SOUND : "default",
      ...(communication ? { "mutable-content": 1, "thread-id": chatId } : {}) },
    ...(communication ? { communication } : {}),
    ...(chatId && /^[A-Za-z0-9_-]{1,128}$/.test(chatId) ? { chatId } : {}),
    ...(serverOrigin ? { serverOrigin: limit(serverOrigin, 512) } : {}) };
  // JSON escaping can expand these bounded strings. Drop optional enrichment if
  // it alone exceeds APNs' limit, then shorten the original alert as needed.
  if (Buffer.byteLength(JSON.stringify({ ...payload, aps: { ...payload.aps, alert: { title: "", body: "" } } })) > maxBytes) {
    delete payload.communication;
    delete payload.aps["mutable-content"];
    delete payload.aps["thread-id"];
  }
  while (Buffer.byteLength(JSON.stringify(payload)) > maxBytes) {
    if (payload.aps.alert.body) payload.aps.alert.body = Array.from(payload.aps.alert.body).slice(0, -128).join("");
    else payload.aps.alert.title = Array.from(payload.aps.alert.title).slice(0, -32).join("");
  }
  return JSON.stringify(payload);
}

export interface APNsDelivery { sent: boolean; invalidatedAt?: number; invalidToken?: boolean }

export async function sendAPNsNotification(destination: APNsDestination, notification: PushPayload): Promise<APNsDelivery> {
  const route = getAPNsRoute(destination.bundle_id);
  const mode = destination.delivery_mode ?? "direct";
  if (route.mode !== mode) return { sent: false };
  const characterId = notification.icon?.match(/^\/api\/v1\/characters\/([A-Za-z0-9_-]{1,128})\/avatar\?size=sm$/)?.[1];
  let avatarPath: string | undefined;
  if (destination.id && characterId && notification.data?.characterName) {
    try { avatarPath = issueIOSNotificationAvatarPath(destination.id, characterId); } catch { /* Plain alert fallback. */ }
  }
  const encryption = destination.encryption_key && destination.encryption_key_id
    ? { key: openIOSNotificationSecret(destination.encryption_key, `ios-key:${destination.id}`), keyId: destination.encryption_key_id } : undefined;
  const payload = buildAPNsPayload(notification, destination.server_origin, avatarPath, encryption ? 2600 : 4096);
  const encrypted = encryption ? encryptAPNsPayload(payload, encryption, destination.bundle_id, destination.environment) : undefined;
  const collapseId = notification.tag ? createHash("sha256").update(notification.tag).digest("hex") : undefined;
  if (mode === "relay") {
    if (!encrypted || !destination.relay_credential) return { sent: false };
    return sendAPNsRelayNotification(destination.bundle_id, openIOSNotificationSecret(destination.relay_credential, `ios-relay:${destination.id}`),
      { version: 1, type: "alert", encrypted, ...(collapseId ? { collapseId } : {}) });
  }
  const config = getAPNsConfiguration();
  if (!config || destination.bundle_id !== config.bundleId) return { sent: false };
  return sendAPNsRequest(config, destination, encrypted ? encryptedAPNsPayload(encrypted) : payload, "alert", "10", collapseId);
}

/** Content fields must match GenerationActivityAttributes.ContentState exactly. */
export async function sendAPNsLiveActivity(destination: Pick<APNsDestination, "device_token" | "bundle_id" | "environment" | "delivery_mode" | "relay_credential">,
  state: { phase: string; label: string }, timestamp: number, terminal: boolean, immediate = true, activityAlert = false): Promise<APNsDelivery> {
  const route = getAPNsRoute(destination.bundle_id), mode = destination.delivery_mode ?? "direct";
  if (route.mode !== mode) return { sent: false };
  if (mode === "relay") return destination.relay_credential
    ? sendAPNsRelayNotification(destination.bundle_id, destination.relay_credential, { version: 1, type: "liveactivity",
      phase: state.phase, timestamp, terminal, immediate, alert: activityAlert }) : { sent: false };
  const config = getLiveConfiguration();
  if (!config || config.bundleId !== destination.bundle_id) return { sent: false };
  // ActivityKit alerts belong to updates. Ending the activity bypasses the
  // expanded presentation and its sound; the sender ends it separately later.
  const alerting = !terminal && activityAlert;
  const sound = activitySounds[state.phase];
  const payload = JSON.stringify({ aps: { timestamp, event: terminal ? "end" : "update", "content-state": state,
    ...(sound && alerting
      ? { alert: { title: state.label, body: state.phase === "completed" ? "Open Lumiverse to read the response." : "Your response is in progress.", sound } } : {}),
    ...(state.phase === "error" && alerting
      ? { alert: { title: "Generation failed", body: "Open Lumiverse to review the generation.", sound: "default" } } : {}),
    "stale-date": timestamp + 300, ...(terminal ? { "dismissal-date": timestamp + 120 } : {}) } });
  if (Buffer.byteLength(payload) > 2048) throw new Error("Live Activity content is too large");
  return sendAPNsRequest(config, destination, payload, "liveactivity", immediate || terminal || state.phase === "inputNeeded" ? "10" : "5");
}

/** Versioned, encrypted content decoded by the compiled Spindle activity renderer. */
export async function sendAPNsSpindleActivity(destination: Pick<APNsDestination, "device_token" | "bundle_id" | "environment" | "delivery_mode" | "relay_credential">,
  state: { version: number; encrypted: import("./apns-encryption").EncryptedAPNsEnvelope }, timestamp: number, terminal: boolean): Promise<APNsDelivery> {
  const route = getAPNsRoute(destination.bundle_id), mode = destination.delivery_mode ?? "direct";
  if (route.mode !== mode) return { sent: false };
  if (mode === "relay") return destination.relay_credential
    ? sendAPNsRelayNotification(destination.bundle_id, destination.relay_credential, { version: 2, type: "liveactivity",
        timestamp, terminal, state }) : { sent: false };
  const config = getLiveConfiguration();
  if (!config || config.bundleId !== destination.bundle_id) return { sent: false };
  const payload = JSON.stringify({ aps: { timestamp, event: terminal ? "end" : "update", "content-state": state,
    "stale-date": timestamp + 300, ...(terminal ? { "dismissal-date": timestamp + 60 } : {}) } });
  if (Buffer.byteLength(payload) > 4096) throw new Error("Live Activity content is too large");
  return sendAPNsRequest(config, destination, payload, "liveactivity", terminal ? "10" : "5");
}

async function sendAPNsRequest(config: APNsConfiguration, destination: Pick<APNsDestination, "device_token" | "bundle_id" | "environment">,
  payload: string, pushType: "alert" | "liveactivity", priority: string, collapseId?: string): Promise<APNsDelivery> {
  const now = Math.floor(Date.now() / 1000);
  let authorization: string | undefined;
  if ("teamId" in config) {
    // Alerts and activities may share a provider key. Alternating push types
    // must not regenerate JWTs and trigger TooManyProviderTokenUpdates.
    const credentialId = `${config.teamId}:${config.keyId}`;
    let jwt = jwts.get(credentialId);
    if (!jwt || now - jwt.issuedAt >= 20 * 60 || now < jwt.issuedAt) {
      jwt = { value: createAPNsJWT(config, now), issuedAt: now };
      jwts.set(credentialId, jwt);
    }
    authorization = `bearer ${jwt.value}`;
  }
  const authority = destination.environment === "development"
    ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const sessionKey = `${authority}:${"certificate" in config ? "certificate" : `token:${config.teamId}:${config.keyId}`}`;
  let session = sessions.get(sessionKey);
  if (!session || session.destroyed || session.closed) {
    session = connect(authority, "certificate" in config ? {
      cert: config.certificate,
      key: config.privateKey.export({ type: "pkcs8", format: "pem" }),
      minVersion: "TLSv1.2",
    } : undefined);
    sessions.set(sessionKey, session);
    const connection = session;
    const forget = () => { if (sessions.get(sessionKey) === connection) sessions.delete(sessionKey); };
    connection.on("error", () => { forget(); connection.destroy(); });
    connection.on("goaway", () => { forget(); connection.close(); });
    connection.on("close", forget);
    connection.setTimeout(60_000, () => { forget(); connection.close(); });
    // An idle provider connection should not keep command-line processes alive.
    connection.unref();
  }
  return new Promise((resolve, reject) => {
    const stream = session!.request({ ":method": "POST", ":path": `/3/device/${destination.device_token}`,
      ...(authorization ? { authorization } : {}),
      "apns-topic": config.bundleId + (pushType === "liveactivity" ? ".push-type.liveactivity" : ""), "apns-push-type": pushType,
      "apns-priority": priority, "apns-expiration": String(now + (pushType === "liveactivity" ? 300 : 3600)),
      ...(collapseId ? { "apns-collapse-id": collapseId } : {}) });
    let status = 0, body = "", ended = false;
    const timer = setTimeout(() => stream.destroy(new Error("APNs request timed out")), 15_000);
    stream.on("response", headers => { status = Number(headers[":status"]); });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => { if (body.length < 4096) body += chunk; });
    stream.on("error", reject);
    stream.on("close", () => { clearTimeout(timer); if (!ended) reject(new Error("APNs stream closed before a response")); });
    stream.on("end", () => {
      ended = true;
      if (status === 200) { resolve({ sent: true }); return; }
      let error: { reason?: string; timestamp?: number } = {};
      try { error = JSON.parse(body); } catch { /* Non-JSON errors are not logged. */ }
      if (status === 410 && error.reason === "Unregistered" && typeof error.timestamp === "number" && Number.isFinite(error.timestamp)) {
        resolve({ sent: false, invalidatedAt: error.timestamp });
      } else if (pushType === "liveactivity" && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(error.reason ?? "")) {
        resolve({ sent: false, invalidToken: true });
      } else {
        // Never include device tokens, JWTs, or arbitrary response bodies in logs.
        console.warn(`[apns] Delivery rejected (${status}, ${String(error.reason || "unknown").replace(/[^A-Za-z]/g, "").slice(0, 80)})`);
        resolve({ sent: false });
      }
    });
    stream.end(payload);
  });
}
