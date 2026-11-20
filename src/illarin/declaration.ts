/**
 * Declaration building for the Illarin connected-app protocol (v1).
 *
 * The declaration is the machine-readable description of this installation:
 * who we are, what we can accept, and which permissions we ask for. Illarin
 * enforces every limit on the wire (names ≤64 printable chars after trim,
 * arrays ≤32 unique entries ≤64 chars each, body ≤4 KiB, unknown fields
 * rejected), so this module validates before anything leaves the process.
 */

import {
  DECLARATION_LIMITS,
  ILLARIN_CAPABILITY_NAMESPACE,
  ILLARIN_PROTOCOL_VERSION,
  ILLARIN_SCOPES,
  type DeclarationUpdate,
  type IllarinDeclaration,
  type IllarinScope,
} from "./types";

/** Self-asserted on the approval screen and marked unverified by Illarin. */
export const DEFAULT_APPLICATION_NAME = "Lumiverse";

/**
 * Capabilities this installation claims, namespaced under our reverse-DNS
 * (lumiverse.chat). A capability is a claim about interoperability only —
 * inert until Illarin explicitly implements behavior that consumes it.
 */
export const ILLARIN_CAPABILITIES = Object.freeze([
  "character-import",
  "worldbook-import",
  "preset-install",
  "theme-install",
].map((name) => `${ILLARIN_CAPABILITY_NAMESPACE}:${name}`));

export const EXTENSION_INSTALL_CAPABILITY = `${ILLARIN_CAPABILITY_NAMESPACE}:extension-install`;

/**
 * Export targets Lumiverse can read, ordered most → least preferred.
 * Illarin delivers using the first supported entry and falls back to `raw`.
 * SillyTavern themes are deliberately absent — Lumiverse does not accept them.
 * Presets must use the Lumiverse writer, which also converts SillyTavern uploads.
 */
export const ILLARIN_ACCEPTED_TARGETS = Object.freeze([
  "charx",
  "chara_card_v3",
  "chara_card_v2",
  "lorebook",
  "lorebook_sillytavern",
  "preset_lumiverse",
  "theme_lumiverse",
  "pack_lumiverse",
  "extension_spindle",
]);

export interface DeclarationInput {
  applicationName?: string;
  instanceName: string;
  applicationVersion?: string;
  scopes: readonly IllarinScope[];
  installsExtensions?: boolean;
}

/** Build and wire-validate the link-time declaration. */
export function buildDeclaration(input: DeclarationInput): IllarinDeclaration {
  const declaration: IllarinDeclaration = {
    appName: (input.applicationName ?? DEFAULT_APPLICATION_NAME).trim(),
    name: input.instanceName.trim(),
    ...(input.applicationVersion === undefined ? {} : { appVersion: input.applicationVersion.trim() }),
    protocolVersion: ILLARIN_PROTOCOL_VERSION,
    capabilities: input.installsExtensions
      ? [...ILLARIN_CAPABILITIES, EXTENSION_INSTALL_CAPABILITY]
      : [...ILLARIN_CAPABILITIES],
    acceptedFormats: [...ILLARIN_ACCEPTED_TARGETS],
    permissions: [...input.scopes],
  };
  assertDeclarationWireLimits(declaration);
  return declaration;
}

/**
 * Derive the updatable declaration for `PUT /api/v1/connected-apps/me`. Names and
 * permissions are deliberately omitted — the endpoint cannot change them
 * and would reject them as unknown fields. Never widen access silently.
 */
export function buildDeclarationUpdate(declaration: IllarinDeclaration): DeclarationUpdate {
  return {
    ...(declaration.appVersion === undefined ? {} : { appVersion: declaration.appVersion }),
    protocolVersion: declaration.protocolVersion,
    capabilities: [...declaration.capabilities],
    acceptedFormats: [...declaration.acceptedFormats],
  };
}

// ─── Wire-limit validation ─────────────────────────────────────────────────

// C0/C1 control characters — the protocol requires "printable text".
const CONTROL_CHAR_PATTERN = /[\u0000-\u001F\u007F-\u009F]/;

/** Throws RangeError when any documented declaration bound is violated. */
export function assertDeclarationWireLimits(declaration: IllarinDeclaration): void {
  if (declaration.protocolVersion !== ILLARIN_PROTOCOL_VERSION) {
    throw new RangeError(`protocolVersion must be exactly ${ILLARIN_PROTOCOL_VERSION}`);
  }
  assertPrintableName("appName", declaration.appName);
  assertPrintableName("name", declaration.name);

  if (declaration.appVersion !== undefined) {
    const version = declaration.appVersion.trim();
    if (!version || version.length > DECLARATION_LIMITS.versionMaxChars || CONTROL_CHAR_PATTERN.test(version)) {
      throw new RangeError(
        `appVersion must be 1-${DECLARATION_LIMITS.versionMaxChars} printable characters`,
      );
    }
  }

  assertEntryArray("capabilities", declaration.capabilities);
  for (const capability of declaration.capabilities) {
    const separator = capability.indexOf(":");
    if (separator <= 0 || separator === capability.length - 1) {
      throw new RangeError(`capability "${capability}" must have the form "<namespace>:<name>"`);
    }
  }

  assertEntryArray("acceptedFormats", declaration.acceptedFormats);
  for (const target of declaration.acceptedFormats) {
    if (!/^[a-z0-9_]+$/.test(target)) {
      throw new RangeError(`accepted target "${target}" must be a lowercase module ID`);
    }
  }

  assertEntryArray("permissions", declaration.permissions);
  for (const scope of declaration.permissions) {
    if (!ILLARIN_SCOPES.includes(scope)) {
      throw new RangeError(`permission "${scope}" is not an Illarin permission`);
    }
  }

  // The whole request body may not exceed 4 KiB — measure exactly what is sent.
  const bodyBytes = new TextEncoder().encode(JSON.stringify(declaration)).length;
  if (bodyBytes > DECLARATION_LIMITS.maxBodyBytes) {
    throw new RangeError(
      `declaration body is ${bodyBytes} bytes; Illarin accepts at most ${DECLARATION_LIMITS.maxBodyBytes}`,
    );
  }
}

function assertPrintableName(field: string, value: string): void {
  const trimmed = value.trim();
  if (
    typeof value !== "string" ||
    trimmed.length === 0 ||
    trimmed.length > DECLARATION_LIMITS.nameMaxChars ||
    CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new RangeError(`${field} must be 1-${DECLARATION_LIMITS.nameMaxChars} printable characters`);
  }
}

function assertEntryArray(field: string, values: readonly string[]): void {
  if (!Array.isArray(values)) {
    throw new RangeError(`${field} must be an array, even when empty`);
  }
  if (values.length > DECLARATION_LIMITS.maxArrayEntries) {
    throw new RangeError(`${field} carries more than ${DECLARATION_LIMITS.maxArrayEntries} entries`);
  }
  if (new Set(values).size !== values.length) {
    throw new RangeError(`${field} entries must be unique`);
  }
  for (const entry of values) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > DECLARATION_LIMITS.maxEntryChars) {
      throw new RangeError(`${field} entries must be strings of 1-${DECLARATION_LIMITS.maxEntryChars} characters`);
    }
  }
}
