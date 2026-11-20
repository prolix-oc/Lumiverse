import * as settingsSvc from "./settings.service";
import { WORLD_BOOK_VECTOR_SETTINGS_KEY } from "./world-book-vector-constants";
import {
  normalizeWorldBookVectorSettings,
  type WorldBookVectorSettings,
} from "./world-book-vector-settings-model";

export {
  DEFAULT_WORLD_BOOK_VECTOR_SETTINGS,
  normalizeWorldBookVectorSettings,
  WORLD_BOOK_VECTOR_PRESETS,
  type WorldBookVectorPresetMode,
  type WorldBookVectorSettings,
} from "./world-book-vector-settings-model";

export function loadWorldBookVectorSettings(
  userId: string,
  defaultsOverride?: Partial<Omit<WorldBookVectorSettings, "presetMode">>,
): WorldBookVectorSettings {
  const raw = settingsSvc.getSetting(userId, WORLD_BOOK_VECTOR_SETTINGS_KEY)?.value;
  return normalizeWorldBookVectorSettings(raw, defaultsOverride);
}

export function saveWorldBookVectorSettings(
  userId: string,
  input: any,
  defaultsOverride?: Partial<Omit<WorldBookVectorSettings, "presetMode">>,
): WorldBookVectorSettings {
  const normalized = normalizeWorldBookVectorSettings(input, defaultsOverride);
  settingsSvc.putSetting(userId, WORLD_BOOK_VECTOR_SETTINGS_KEY, normalized);
  return normalized;
}
