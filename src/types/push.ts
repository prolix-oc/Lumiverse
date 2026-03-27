export interface PushSubscriptionRecord {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  label: string;
  created_at: number;
  updated_at: number;
}

export interface CreatePushSubscriptionInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
  label?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: {
    url?: string;
    chatId?: string;
    characterName?: string;
  };
  icon?: string;
  image?: string;
}

export interface PushNotificationPreferences {
  enabled: boolean;
  events: {
    generation_ended: boolean;
    generation_error: boolean;
  };
}
