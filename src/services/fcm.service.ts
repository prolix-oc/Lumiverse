import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PushPayload } from "../types/push";
import { notificationPlainText } from "../utils/notification-text";

export interface FCMConfiguration { projectId: string; email: string; privateKey: KeyObject }
export function loadFCMConfiguration(env: NodeJS.ProcessEnv): FCMConfiguration | null {
  if (!env.FCM_SERVICE_ACCOUNT_PATH) return null;
  const account = JSON.parse(readFileSync(env.FCM_SERVICE_ACCOUNT_PATH, "utf8"));
  const projectId = env.FCM_PROJECT_ID || account.project_id;
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(projectId ?? "")
    || typeof account.client_email !== "string" || !account.client_email.endsWith(".iam.gserviceaccount.com"))
    throw new Error("Invalid FCM service account");
  const privateKey = createPrivateKey(account.private_key);
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("FCM requires an RSA service account key");
  return { projectId, email: account.client_email, privateKey };
}

export function getFCMInfo() {
  try {
    const config = loadFCMConfiguration(process.env);
    return { configured: !!config, projectId: config?.projectId ?? null,
      reason: config ? null : "The server needs Firebase provider configuration to deliver Android notifications." };
  } catch {
    return { configured: false, projectId: null, reason: "The server's Firebase provider configuration is invalid." };
  }
}

/** Fixed production endpoints; injectable endpoints let the real HTTP client run in local simulations. */
export class FCMProvider {
  private access: { token: string; expires: number } | null = null;
  private pending: Promise<string> | null = null;
  constructor(private config: FCMConfiguration, private endpoints = {
    oauth: "https://oauth2.googleapis.com/token", send: "https://fcm.googleapis.com",
  }) {}

  private async accessToken(): Promise<string> {
    if (this.access && this.access.expires > Date.now() + 60_000) return this.access.token;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: this.config.email,
        scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
      const assertion = `${input}.${sign("RSA-SHA256", Buffer.from(input), this.config.privateKey).toString("base64url")}`;
      const response = await fetch(this.endpoints.oauth, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
      if (!response.ok) throw new Error("FCM authorization failed");
      const value = await response.json() as { access_token?: string; expires_in?: number };
      if (!value.access_token || !Number.isFinite(value.expires_in) || value.expires_in! <= 0)
        throw new Error("Invalid FCM authorization response");
      this.access = { token: value.access_token, expires: Date.now() + Math.min(value.expires_in!, 3600) * 1000 };
      return value.access_token;
    })();
    try { return await this.pending } finally { this.pending = null }
  }

  async send(token: string, data: Record<string, string>, shouldSend = () => true): Promise<{ sent: boolean; invalidToken?: boolean }> {
    if (Buffer.byteLength(JSON.stringify(data)) > 3800) throw new Error("FCM notification exceeds payload limit");
    const accessToken = await this.accessToken();
    // Authorization can take a network round trip; the user may have returned meanwhile.
    if (!shouldSend()) return { sent: false };
    const response = await fetch(`${this.endpoints.send}/v1/projects/${this.config.projectId}/messages:send`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: { token, data, android: { priority: "high", ttl: "3600s" } } }),
    });
    if (response.ok) return { sent: true };
    if (response.status === 401) this.access = null;
    const body = await response.json().catch(() => null) as { error?: { details?: Array<{ "@type"?: string; errorCode?: string }> } } | null;
    return { sent: false, invalidToken: response.status === 404 && body?.error?.details?.some(
      detail => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError" && detail.errorCode === "UNREGISTERED") };
  }
}

let provider: { fingerprint: string; value: FCMProvider } | undefined;
export async function sendFCMNotification(token: string, data: Record<string, string>, shouldSend = () => true) {
  const config = loadFCMConfiguration(process.env);
  if (!config) return { sent: false };
  const fingerprint = `${config.projectId}:${config.email}:${config.privateKey.export({ type: "pkcs8", format: "pem" })}`;
  if (provider?.fingerprint !== fingerprint) provider = { fingerprint, value: new FCMProvider(config) };
  return provider.value.send(token, data, shouldSend);
}

/** Leave room for routing metadata and JSON escaping in FCM's 4 KB payload. */
export function boundedAndroidPayload(notification: PushPayload, avatarPath?: string): string {
  const candidate = notification.data?.chatId ?? notification.data?.url?.match(/^\/chat\/([A-Za-z0-9_-]{1,128})$/)?.[1];
  const chatId = typeof candidate === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : undefined;
  const payload = { title: Array.from(notification.title).slice(0, 100).join(""),
    body: Array.from(notification.body).slice(0, 500).join(""), tag: notification.tag?.slice(0, 160),
    data: { chatId, characterName: notificationPlainText(notification.data?.characterName, 100),
      error: !!(notification.data?.errorMessage || notification.data?.errorCode || notification.tag?.startsWith("generation-error-")) },
    avatarPath };
  while (Buffer.byteLength(JSON.stringify(payload)) > 2400) {
    if (payload.body) payload.body = Array.from(payload.body).slice(0, -32).join("");
    else {
      delete payload.avatarPath; delete payload.tag; payload.data.characterName = "";
      payload.title = Array.from(payload.title).slice(0, -16).join("");
    }
  }
  return JSON.stringify(payload);
}
