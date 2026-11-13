import * as settingsSvc from "../settings.service";

export interface WeaverTuning {
  propose_count: number | null;
  named_question_target: number | null;
  dynamic_question_cap: number | null;
  harvest_cap: number | null;
  generation_temperature: number | null;
  review_temperature: number | null;
  text_timeout_seconds: number | null;
}

export const WEAVER_TUNING_KEY = "weaverTuning";

export const WEAVER_TEXT_TIMEOUT_DEFAULT_SECONDS = 180;

const COUNT_FIELDS = [
  "propose_count",
  "named_question_target",
  "dynamic_question_cap",
  "harvest_cap",
] as const;
const TEMP_FIELDS = ["generation_temperature", "review_temperature"] as const;

const COUNT_MIN = 1;
const COUNT_MAX = 50;
const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TIMEOUT_MIN_SECONDS = 30;
const TIMEOUT_MAX_SECONDS = 1200;

function clampCount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(COUNT_MAX, Math.max(COUNT_MIN, Math.round(n)));
}

function clampTemperature(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, n));
}

function clampTimeoutSeconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(TIMEOUT_MAX_SECONDS, Math.max(TIMEOUT_MIN_SECONDS, Math.round(n)));
}

export function sanitizeWeaverTuning(raw: unknown): WeaverTuning {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = {} as Record<string, number | null>;
  for (const f of COUNT_FIELDS) out[f] = clampCount(obj[f]);
  for (const f of TEMP_FIELDS) out[f] = clampTemperature(obj[f]);
  out.text_timeout_seconds = clampTimeoutSeconds(obj.text_timeout_seconds);
  return out as unknown as WeaverTuning;
}

export function getWeaverTuning(userId: string): WeaverTuning {
  return sanitizeWeaverTuning(settingsSvc.getSetting(userId, WEAVER_TUNING_KEY)?.value);
}

export function setWeaverTuning(userId: string, input: unknown): WeaverTuning {
  const tuning = sanitizeWeaverTuning(input);
  settingsSvc.putSetting(userId, WEAVER_TUNING_KEY, tuning);
  return tuning;
}
