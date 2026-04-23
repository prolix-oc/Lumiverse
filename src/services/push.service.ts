import { buildPushHTTPRequest } from "@pushforge/builder";
import { getDb } from "../db/connection";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { getVapidPrivateJWK } from "../crypto/vapid";
import { getSetting } from "./settings.service";
import type {
  PushSubscriptionRecord,
  CreatePushSubscriptionInput,
  PushPayload,
  PushNotificationPreferences,
} from "../types/push";

interface GenerationEndedPushPayload {
  chatId?: string;
  content?: string;
  error?: string;
}

export interface PushDispatchResult {
  sent: number;
  reason?: "no_subscriptions" | "disabled" | "event_disabled";
}

const DEFAULT_PREFERENCES: PushNotificationPreferences = {
  enabled: true,
  events: {
    generation_ended: true,
    generation_error: false,
  },
};

// PushForge derives the VAPID JWT exp from the message TTL. Using the exact
// 24h maximum is brittle because small clock skew between us and the push
// service can push exp over the spec limit and trigger a 403.
const PUSH_TTL_SECONDS = 23 * 60 * 60;

// ── Subscription CRUD ───────────────────────────────────────────────

export function listSubscriptions(userId: string): PushSubscriptionRecord[] {
  return getDb()
    .query("SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as PushSubscriptionRecord[];
}

export function createSubscription(
  userId: string,
  input: CreatePushSubscriptionInput
): PushSubscriptionRecord {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  getDb()
    .query(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         user_agent = excluded.user_agent,
         updated_at = excluded.updated_at`
    )
    .run(
      id,
      userId,
      input.endpoint,
      input.keys.p256dh,
      input.keys.auth,
      input.userAgent ?? "",
      input.label ?? "",
      now,
      now
    );

  // Return the actual row (may be the upserted one with a different id)
  const row = getDb()
    .query("SELECT * FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .get(userId, input.endpoint) as PushSubscriptionRecord;
  return row;
}

export function deleteSubscription(userId: string, id: string): boolean {
  const result = getDb()
    .query("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?")
    .run(id, userId);
  return result.changes > 0;
}

// ── Push Sending (PushForge — uses Web Crypto + fetch) ──────────────

export async function sendPushToUser(
  userId: string,
  notification: PushPayload
): Promise<number> {
  const subs = listSubscriptions(userId);
  if (subs.length === 0) return 0;

  const privateJWK = getVapidPrivateJWK();
  let sent = 0;

  const results = await Promise.allSettled(
    subs.map(async (sub) => {
      try {
        // Build the encrypted push request via PushForge
        const request = await buildPushHTTPRequest({
          privateJWK,
          subscription: {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          message: {
            payload: notification as any,
            adminContact: "mailto:noreply@lumiverse.app",
            options: {
              ttl: PUSH_TTL_SECONDS,
              urgency: "high",
            },
          },
        });

        // Send via fetch (Bun-native, no Node http/https needed)
        const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
        });

        if (response.ok || response.status === 201) {
          sent++;
        } else if (response.status === 410 || response.status === 404) {
          // Subscription expired — auto-cleanup
          getDb()
            .query("DELETE FROM push_subscriptions WHERE id = ?")
            .run(sub.id);
          console.log(`[push] Removed stale subscription ${sub.id} (${response.status})`);
        } else {
          const body = await response.text().catch(() => "");
          console.error(
            `[push] Push service returned ${response.status} for ${sub.id}: ${body.slice(0, 200)}`
          );
        }
      } catch (err: any) {
        console.error(`[push] Failed to send to ${sub.id}:`, err.message || err);
      }
    })
  );

  return sent;
}

// ── Preferences Helper ──────────────────────────────────────────────

function getPreferences(userId: string): PushNotificationPreferences {
  const setting = getSetting(userId, "pushNotificationPreferences");
  if (!setting) return DEFAULT_PREFERENCES;
  const stored = setting.value as Partial<PushNotificationPreferences> | null | undefined;
  return {
    ...DEFAULT_PREFERENCES,
    ...stored,
    events: {
      ...DEFAULT_PREFERENCES.events,
      ...(stored?.events ?? {}),
    },
  };
}

async function buildGenerationEndedNotification(
  payload: GenerationEndedPushPayload
): Promise<PushPayload> {
  const chatId = payload.chatId;
  const isError = !!payload.error;

  // Resolve character name for the notification title when the chat still exists.
  let characterName = "Lumiverse";
  if (chatId) {
    try {
      const chat = getDb()
        .query("SELECT character_id FROM chats WHERE id = ?")
        .get(chatId) as { character_id: string } | undefined;
      if (chat) {
        const char = getDb()
          .query("SELECT name FROM characters WHERE id = ?")
          .get(chat.character_id) as { name: string } | undefined;
        if (char?.name) characterName = char.name;
      }
    } catch {
      // Fallback to the generic app title.
    }
  }

  const targetUrl = chatId ? `/#/chat/${chatId}` : "/";

  return isError
    ? {
        title: "Generation Failed",
        body: (payload.error as string).slice(0, 120),
        tag: chatId ? `generation-error-${chatId}` : "generation-error-test",
        data: { url: targetUrl, chatId, characterName },
      }
    : {
        title: characterName,
        body: (payload.content ?? "Your generation finished.").slice(0, 120),
        tag: chatId ? `generation-${chatId}` : "generation-test",
        data: { url: targetUrl, chatId, characterName },
      };
}

export async function dispatchGenerationEndedPush(
  userId: string,
  payload: GenerationEndedPushPayload
): Promise<PushDispatchResult> {
  const prefs = getPreferences(userId);
  if (!prefs.enabled) return { sent: 0, reason: "disabled" };

  const isError = !!payload.error;
  if (isError && !prefs.events.generation_error) {
    return { sent: 0, reason: "event_disabled" };
  }
  if (!isError && !prefs.events.generation_ended) {
    return { sent: 0, reason: "event_disabled" };
  }

  if (listSubscriptions(userId).length === 0) {
    return { sent: 0, reason: "no_subscriptions" };
  }

  const notification = await buildGenerationEndedNotification(payload);
  const sent = await sendPushToUser(userId, notification);
  return { sent };
}

// ── EventBus Integration ────────────────────────────────────────────

export function initPushListeners(): void {
  eventBus.on(EventType.GENERATION_ENDED, async (event) => {
    const userId = event.userId;
    if (!userId) return;

    await dispatchGenerationEndedPush(userId, event.payload as GenerationEndedPushPayload).catch((err) => {
      console.error("[push] Failed to send push notifications:", err);
    });
  });

  console.log("[push] EventBus listeners registered");
}
