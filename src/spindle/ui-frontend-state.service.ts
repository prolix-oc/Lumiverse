/**
 * Per-user snapshot of extension-registered drawer tabs.
 *
 * Extension drawer tabs are registered in the frontend via
 * `ctx.frontend.registerDrawerTab(...)`; they have no backend representation
 * by default. To let the `spindle.ui` API enumerate them, the frontend
 * pushes the current list over the WebSocket whenever it changes
 * (`SPINDLE_UI_REGISTRY_SYNC`). This service caches the latest snapshot
 * per user.
 *
 * State is in-memory only — fine because the frontend re-syncs on every
 * reconnect.
 */

export type SpindleUIExtensionDrawerTabEntry = {
  id: string;
  extensionId: string;
  shortName?: string;
  tabName: string;
  tabDescription?: string;
  keywords?: string[];
};

const userExtensionTabs = new Map<string, SpindleUIExtensionDrawerTabEntry[]>();

const MAX_TABS_PER_USER = 64;
const MAX_KEYWORDS_PER_TAB = 16;
const MAX_STRING_LEN = 200;

function clampString(value: unknown, max = MAX_STRING_LEN): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function sanitizeTab(input: unknown): SpindleUIExtensionDrawerTabEntry | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = clampString(raw.id, 100);
  const extensionId = clampString(raw.extensionId, 100);
  const tabName = clampString(raw.tabName, 100);
  if (!id || !extensionId || !tabName) return null;

  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords
        .map((k) => clampString(k, 50))
        .filter((k): k is string => !!k)
        .slice(0, MAX_KEYWORDS_PER_TAB)
    : undefined;

  return {
    id,
    extensionId,
    tabName,
    shortName: clampString(raw.shortName, 32),
    tabDescription: clampString(raw.tabDescription, 200),
    keywords,
  };
}

export function setUserExtensionDrawerTabs(userId: string, tabs: unknown): void {
  if (!userId || typeof userId !== "string") return;
  const list = Array.isArray(tabs) ? tabs : [];
  const seen = new Set<string>();
  const sanitized: SpindleUIExtensionDrawerTabEntry[] = [];
  for (const raw of list) {
    const tab = sanitizeTab(raw);
    if (!tab) continue;
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    sanitized.push(tab);
    if (sanitized.length >= MAX_TABS_PER_USER) break;
  }
  if (sanitized.length === 0) {
    userExtensionTabs.delete(userId);
    return;
  }
  userExtensionTabs.set(userId, sanitized);
}

export function getUserExtensionDrawerTabs(userId?: string | null): SpindleUIExtensionDrawerTabEntry[] {
  if (!userId) return [];
  return userExtensionTabs.get(userId) ?? [];
}

export function clearUserExtensionDrawerTabs(userId: string): void {
  userExtensionTabs.delete(userId);
}
