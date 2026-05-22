import { getFirstUserId } from "../auth/seed";
import * as settingsSvc from "./settings.service";

export const SPINDLE_SETTINGS_KEY = "spindleSettings";

export const DEFAULT_INTERCEPTOR_TIMEOUT_MS = 10_000;
export const MIN_INTERCEPTOR_TIMEOUT_MS = 1_000;
export const MAX_INTERCEPTOR_TIMEOUT_MS = 300_000;
export const DEFAULT_DOCK_PANEL_DESKTOP_SIDE = "right" as const;

export type SpindleDockPanelDesktopSide = "left" | "right";

export interface SpindleSettings {
  interceptorTimeoutMs: number;
  dockPanelDesktopSide: SpindleDockPanelDesktopSide;
}

function normalizeDockPanelDesktopSide(raw: unknown): SpindleDockPanelDesktopSide {
  return raw === "left" ? "left" : DEFAULT_DOCK_PANEL_DESKTOP_SIDE;
}

function clampTimeout(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? raw : DEFAULT_INTERCEPTOR_TIMEOUT_MS;
  return Math.min(
    MAX_INTERCEPTOR_TIMEOUT_MS,
    Math.max(MIN_INTERCEPTOR_TIMEOUT_MS, Math.floor(n)),
  );
}

export function normalizeSpindleSettings(raw: unknown): SpindleSettings {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    interceptorTimeoutMs: clampTimeout(obj.interceptorTimeoutMs),
    dockPanelDesktopSide: normalizeDockPanelDesktopSide(obj.dockPanelDesktopSide),
  };
}

export function getSpindleSettings(userId: string | null | undefined): SpindleSettings {
  const resolvedUserId = userId && userId.length > 0 ? userId : getFirstUserId();
  if (!resolvedUserId) {
    return {
      interceptorTimeoutMs: DEFAULT_INTERCEPTOR_TIMEOUT_MS,
      dockPanelDesktopSide: DEFAULT_DOCK_PANEL_DESKTOP_SIDE,
    };
  }
  const row = settingsSvc.getSetting(resolvedUserId, SPINDLE_SETTINGS_KEY);
  return normalizeSpindleSettings(row?.value);
}

/**
 * Resolve the effective interceptor timeout for an extension. Manifest override
 * wins over the user's Spindle setting; both are clamped to [MIN, MAX].
 */
export function resolveInterceptorTimeout(
  manifestTimeoutMs: number | undefined,
  userId: string | null | undefined,
): number {
  if (typeof manifestTimeoutMs === "number" && Number.isFinite(manifestTimeoutMs)) {
    return clampTimeout(manifestTimeoutMs);
  }
  return getSpindleSettings(userId).interceptorTimeoutMs;
}
