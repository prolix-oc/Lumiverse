import { loadFCMConfiguration } from "./fcm.service";

export const OFFICIAL_FIREBASE_PROJECT_ID = "lumiverse-bc911";
export const OFFICIAL_ANDROID_PACKAGE = "chat.lumiverse.prototype";
export const DEFAULT_FCM_RELAY_URL = "https://fcm-relay.lumiverse.chat";
export type FCMDeliveryMode = "direct" | "relay";
export function validFCMRelayOrigin(value: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password && (url.protocol === "https:"
      || (env.NODE_ENV === "test" && url.protocol === "http:" && url.hostname === "127.0.0.1"));
  } catch { return false; }
}
export function getFCMRoute(env: NodeJS.ProcessEnv = process.env): {
  configured: boolean; delivery: FCMDeliveryMode | null; projectId: string | null; packageName: string;
  relayUrl?: string; encryptionRequired: boolean; reason: string | null;
} {
  const packageName = env.FCM_PACKAGE_NAME || OFFICIAL_ANDROID_PACKAGE;
  const fail = (reason: string) => ({ configured: false, delivery: null, projectId: null, packageName, encryptionRequired: false, reason });
  const policy = env.FCM_DELIVERY_MODE || "auto";
  if (policy === "disabled") return fail("Android remote notifications are disabled on this server.");
  if (!["auto", "direct", "relay"].includes(policy)) return fail("Invalid FCM_DELIVERY_MODE server setting.");
  if (!/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(packageName)) return fail("Invalid Android package configuration.");
  if (policy === "direct" || (policy === "auto" && !!env.FCM_SERVICE_ACCOUNT_PATH)) {
    try {
      const config = loadFCMConfiguration(env);
      if (!config) return fail("The server needs Firebase provider configuration for direct Android delivery.");
      return { configured: true, delivery: "direct", projectId: config.projectId, packageName, encryptionRequired: false, reason: null };
    } catch { return fail("The server's Firebase provider configuration is invalid."); }
  }
  const relayUrl = env.FCM_RELAY_URL || DEFAULT_FCM_RELAY_URL;
  const projectId = env.FCM_RELAY_PROJECT_ID || OFFICIAL_FIREBASE_PROJECT_ID;
  if (!validFCMRelayOrigin(relayUrl, env)) return fail("Invalid FCM_RELAY_URL; use an HTTPS origin.");
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) return fail("Invalid relay Firebase project.");
  return { configured: true, delivery: "relay", projectId, packageName, relayUrl, encryptionRequired: true, reason: null };
}
export function fcmDeliveryAllowed(mode: FCMDeliveryMode) {
  const policy = process.env.FCM_DELIVERY_MODE || "auto";
  return policy === "auto" || policy === mode;
}
