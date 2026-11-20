export interface PushSubscriptionRecord {
  type: "web_push";
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

export interface DesktopNotificationDestinationRecord {
  type: "tauri_desktop";
  id: string;
  user_id: string;
  device_id: string;
  user_agent: string;
  label: string;
  platform: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
}

export type NotificationDestinationRecord =
  | PushSubscriptionRecord
  | IOSPushDestinationRecord
  | AndroidPushDestinationRecord
  | DesktopNotificationDestinationRecord;

export interface AndroidPushDestinationRecord {
  type: "android_native";
  id: string;
  user_id: string;
  device_id: string;
  transport: "local" | "fcm";
  project_id: string | null;
  delivery_mode: "direct" | "relay";
  package_name: string;
  label: string;
  user_agent: string;
  created_at: number;
  updated_at: number;
}

export interface CreateAndroidPushDestinationInput {
  accountId?: string;
  deviceId: string;
  transport: "local" | "fcm";
  serverOrigin: string;
  deviceToken?: string;
  projectId?: string;
  packageName?: string;
  delivery?: "direct" | "relay";
  enrollmentId?: string;
  relayCredential?: string;
  encryption?: { key: string; keyId: string };
  label?: string;
  userAgent?: string;
}

export interface IOSPushDestinationRecord {
  type: "ios_apns";
  id: string;
  user_id: string;
  device_id: string;
  bundle_id: string;
  environment: "development" | "production";
  delivery_mode: "direct" | "relay";
  label: string;
  user_agent: string;
  created_at: number;
  updated_at: number;
}

export interface CreateIOSPushDestinationInput {
  deviceId: string;
  deviceToken: string;
  bundleId: string;
  environment: "development" | "production";
  serverOrigin: string;
  delivery?: "direct" | "relay";
  relayCredential?: string;
  encryption?: { key: string; keyId: string };
  label?: string;
  userAgent?: string;
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

export interface CreateDesktopNotificationDestinationInput {
  deviceId: string;
  label?: string;
  platform?: string;
  userAgent?: string;
}

export interface DesktopNotificationEnrollment {
  destination: DesktopNotificationDestinationRecord;
  credential: string;
  serverInstanceId: string;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  data?: {
    url?: string;
    chatId?: string;
    characterName?: string;
    connectionName?: string;
    errorCode?: string;
    errorMessage?: string;
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
