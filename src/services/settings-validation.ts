const MAX_SETTING_KEY_LENGTH = 200;
const MAX_SETTING_VALUE_BYTES = 2 * 1024 * 1024; // 2 MB serialized JSON
// Theme packs embed their assets as base64 in savedThemes. A fully supported
// 250 MiB theme archive expands to about 333 MiB when represented as JSON, so
// this leaves room for the manifest and saved-theme metadata.
export const MAX_SAVED_THEMES_VALUE_BYTES = 350 * 1024 * 1024;
const SETTING_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;

export class InvalidSettingError extends Error {
  status = 400 as const;
}


export function assertValidKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_SETTING_KEY_LENGTH) {
    throw new InvalidSettingError(
      `Setting key must be a non-empty string ≤${MAX_SETTING_KEY_LENGTH} chars`,
    );
  }
  if (!SETTING_KEY_PATTERN.test(key)) {
    throw new InvalidSettingError(
      "Setting key may only contain letters, digits, '.', '_', '-', and ':'",
    );
  }
}

export function serializeValueOrThrow(key: string, value: unknown): string {
  // Settings storage is opaque JSON; reject payloads that would otherwise
  // bloat the DB or block the event loop on every read.
  let json: string;
  try {
    json = JSON.stringify(value ?? null);
  } catch (err: any) {
    throw new InvalidSettingError(`Setting "${key}" value is not JSON-serializable: ${err?.message || "unknown"}`);
  }
  const maxBytes = key === "savedThemes"
    ? MAX_SAVED_THEMES_VALUE_BYTES
    : MAX_SETTING_VALUE_BYTES;
  if (json.length > maxBytes) {
    throw new InvalidSettingError(
      `Setting "${key}" exceeds ${maxBytes} bytes serialized`,
    );
  }
  return json;
}

