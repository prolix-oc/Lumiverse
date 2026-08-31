// Plaintext credentials from legacy settings must never cross the portable
// archive boundary. Modern credentials travel only through the encrypted
// decryption-ticket workflow.

export type LegacyImageProvider = "nanogpt" | "novelai";

export interface LegacyImageProviderCredential {
  provider: LegacyImageProvider;
  apiKey: unknown;
  providerSettings: Record<string, unknown>;
}

export interface LegacyImagePrivateDataInspection {
  scrubbedValue: unknown;
  credentials: LegacyImageProviderCredential[];
  changed: boolean;
}

const MAX_PRIVATE_DATA_DEPTH = 128;
const PRIVATE_PROVIDER_JSON_MARKER = /\b(?:nanogpt|novelai)\b/;
const PRIVATE_DATA_FINGERPRINT_DOMAIN = "lumiverse-private-data-and-secret-inventory-v1";

export interface PrivateDataSecretInventoryEntry {
  key: string;
  encrypted_value: string;
  iv: string;
  tag: string;
  updated_at: number;
}

interface ScrubResult {
  value: unknown;
  changed: boolean;
}

function legacyProviderForKey(key: string): LegacyImageProvider | null {
  if (key === "nanogpt" || key === "novelai") return key;
  return null;
}

function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function copyEntriesBefore(
  target: Record<string, unknown>,
  entries: [string, unknown][],
  end: number,
): void {
  for (let index = 0; index < end; index++) {
    const [key, value] = entries[index];
    defineOwn(target, key, value);
  }
}

function looksLikeJsonContainer(value: string, allowEncodedString: boolean): boolean {
  const first = value.trimStart()[0];
  return first === "{" || first === "[" || (allowEncodedString && first === '"');
}

function classifyJsonMarkers(value: string): string {
  // Decode JSON Unicode escapes only for classification. The original string
  // remains byte-for-byte intact whenever no supported provider data exists.
  return value.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function scrubEncodedProviderContainer(
  value: string,
  provider: LegacyImageProvider | null,
  providerSettings: Record<string, unknown> | null,
  depth: number,
  credentials: LegacyImageProviderCredential[],
): ScrubResult {
  const classified = classifyJsonMarkers(value);
  const providerMarker = PRIVATE_PROVIDER_JSON_MARKER.test(classified);
  if (!looksLikeJsonContainer(value, provider !== null || providerMarker)) {
    return { value, changed: false };
  }
  // Outside a known provider scope, opaque JSON matters only when it can
  // contain a supported provider key. This leaves unrelated strings entirely
  // untouched and spends decoder depth only on credential-bearing candidates.
  if (provider === null && !providerMarker) return { value, changed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      "imageGeneration settings contain malformed JSON-encoded provider data",
    );
  }

  const scrubbed = scrubLegacyProviderSecrets(
    parsed,
    provider,
    providerSettings,
    depth + 1,
    credentials,
  );
  return scrubbed.changed
    ? { value: JSON.stringify(scrubbed.value), changed: true }
    : { value, changed: false };
}

function scrubLegacyProviderSecrets(
  value: unknown,
  provider: LegacyImageProvider | null,
  providerSettings: Record<string, unknown> | null,
  depth: number,
  credentials: LegacyImageProviderCredential[],
): ScrubResult {
  if (depth > MAX_PRIVATE_DATA_DEPTH) {
    throw new Error("imageGeneration settings exceed the portable privacy depth limit");
  }
  if (typeof value === "string") {
    return scrubEncodedProviderContainer(
      value,
      provider,
      providerSettings,
      depth,
      credentials,
    );
  }
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    for (let index = 0; index < value.length; index++) {
      const scrubbed = scrubLegacyProviderSecrets(
        value[index],
        provider,
        providerSettings,
        depth + 1,
        credentials,
      );
      if (scrubbed.changed && out === null) out = value.slice(0, index);
      if (out !== null) out.push(scrubbed.value);
    }
    return out === null
      ? { value, changed: false }
      : { value: out, changed: true };
  }
  if (!value || typeof value !== "object") return { value, changed: false };
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("imageGeneration settings contain a non-JSON value");
  }

  const objectValue = value as Record<string, unknown>;
  const explicitProvider = typeof objectValue.provider === "string"
    ? legacyProviderForKey(objectValue.provider)
    : null;
  const effectiveProvider = explicitProvider ?? provider;
  const scopedProviderSettings = effectiveProvider === null
    ? null
    : explicitProvider === null
      ? providerSettings ?? objectValue
      : objectValue;
  const entries = Object.entries(objectValue);
  let out: Record<string, unknown> | null = null;
  for (let index = 0; index < entries.length; index++) {
    const [key, entry] = entries[index];
    if (effectiveProvider !== null && key === "apiKey") {
      credentials.push({
        provider: effectiveProvider,
        apiKey: entry,
        providerSettings: scopedProviderSettings ?? objectValue,
      });
      if (out === null) {
        out = Object.create(null) as Record<string, unknown>;
        copyEntriesBefore(out, entries, index);
      }
      continue;
    }

    const nestedProvider = legacyProviderForKey(key);
    const scrubbed = scrubLegacyProviderSecrets(
      entry,
      nestedProvider ?? effectiveProvider,
      nestedProvider === null ? scopedProviderSettings : null,
      depth + 1,
      credentials,
    );
    if (scrubbed.changed && out === null) {
      out = Object.create(null) as Record<string, unknown>;
      copyEntriesBefore(out, entries, index);
    }
    if (out !== null) defineOwn(out, key, scrubbed.value);
  }
  return out === null
    ? { value, changed: false }
    : { value: out, changed: true };
}

/**
 * Inspect arbitrary imageGeneration JSON with the same recursive privacy
 * rules used at both portable boundaries. The scrubbed value is safe to
 * persist only after every returned credential has been migrated.
 */
export function inspectLegacyImageGenerationPrivateData(
  value: unknown,
): LegacyImagePrivateDataInspection {
  const credentials: LegacyImageProviderCredential[] = [];
  const scrubbed = scrubLegacyProviderSecrets(value, null, null, 0, credentials);
  return {
    scrubbedValue: scrubbed.value,
    credentials,
    changed: scrubbed.changed,
  };
}

function canonicalPrivateJson(value: unknown, depth = 0): string {
  if (depth > MAX_PRIVATE_DATA_DEPTH) {
    throw new Error("private data fingerprint exceeds the portable privacy depth limit");
  }
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("private data fingerprint contains a non-JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((entry) => canonicalPrivateJson(entry, depth + 1)).join(",") + "]";
  }
  if (!value || typeof value !== "object") {
    throw new Error("private data fingerprint contains a non-JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("private data fingerprint contains a non-JSON value");
  }
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map((key) => {
    const entry = record[key];
    if (entry === undefined) throw new Error("private data fingerprint contains undefined");
    return JSON.stringify(key) + ":" + canonicalPrivateJson(entry, depth + 1);
  }).join(",") + "}";
}

/**
 * Bind a prepared ticket to the exact safe image-generation projection and
 * encrypted secret-row inventory. Ciphertext identity detects replacements
 * without exposing a plaintext-derived digest to the ticket holder.
 */
export function fingerprintPrivateDataAndSecretInventory(
  imageGenerationSetting: unknown,
  secretInventory: readonly PrivateDataSecretInventoryEntry[],
): string {
  const inspection = inspectLegacyImageGenerationPrivateData(imageGenerationSetting);
  if (inspection.changed || inspection.credentials.length > 0) {
    throw new Error("imageGeneration settings contain unmigrated private data");
  }
  const seen = new Set<string>();
  const inventory = [...secretInventory].sort((a, b) => a.key.localeCompare(b.key)).map((entry) => {
    if (
      typeof entry.key !== "string" || entry.key.length === 0 || seen.has(entry.key)
      || typeof entry.encrypted_value !== "string"
      || typeof entry.iv !== "string"
      || typeof entry.tag !== "string"
      || !Number.isSafeInteger(entry.updated_at)
    ) {
      throw new Error("secret inventory is malformed or contains duplicate keys");
    }
    seen.add(entry.key);
    return entry;
  });
  const payload = canonicalPrivateJson({
    imageGenerationPresent: imageGenerationSetting !== undefined,
    imageGeneration: imageGenerationSetting ?? null,
    secretInventory: inventory,
  });
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(PRIVATE_DATA_FINGERPRINT_DOMAIN);
  hasher.update("\0");
  hasher.update(payload);
  return hasher.digest("hex");
}

/**
 * Remove supported legacy plaintext credentials from an imageGeneration
 * settings row. Malformed containers fail closed so export/import remains an
 * all-or-nothing operation rather than passing through an uninspected value.
 */
export function scrubLegacyImageGenerationSettingRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const rowEntries = Object.entries(row);
  const keyEntry = rowEntries.find(([key]) => key === "key");
  if (keyEntry?.[1] !== "imageGeneration") return row;
  const valueEntry = rowEntries.find(([key]) => key === "value");
  if (typeof valueEntry?.[1] !== "string") {
    throw new Error("imageGeneration settings value must be JSON text");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(valueEntry[1]);
  } catch {
    throw new Error("imageGeneration settings value is malformed JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("imageGeneration settings value must be a JSON object");
  }

  const inspection = inspectLegacyImageGenerationPrivateData(parsed);
  if (!inspection.changed) return row;

  // A null-prototype target plus defineProperty is deliberate: assignment to
  // a normal object's `__proto__` invokes its legacy setter and silently
  // drops valid own JSON data. Rebuild only changed rows and retain every own
  // entry, including an exact `__proto__` entry.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of rowEntries) {
    defineOwn(
      out,
      key,
      key === "value" ? JSON.stringify(inspection.scrubbedValue) : entry,
    );
  }
  return out;
}
