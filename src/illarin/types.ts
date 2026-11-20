/**
 * Illarin connected-app protocol wire types — protocol version 1.
 *
 * Source of truth: the Illarin app-integration guide. Illarin rejects unknown JSON fields, so request
 * builders whitelist exactly the documented fields — never spread user
 * input into a request body.
 *
 * Token strings, codes, and verification URLs are opaque. Nothing in this
 * module may appear in logs, URLs, crash reports, or exported settings.
 */

/** The protocol version Illarin currently accepts. Exactly `1`. */
export const ILLARIN_PROTOCOL_VERSION = 1;

/**
 * Ask only for permissions this installation uses. The owner can change
 * grants at any time; a capabilities update cannot change permissions.
 */
export const ILLARIN_SCOPES = ["work:receive", "library:sync"] as const;

export type IllarinScope = (typeof ILLARIN_SCOPES)[number];

/**
 * Format module IDs supported by this app.
 * The list can grow on the server; unknown IDs grant nothing and cannot
 * select a writer Illarin does not have, so `acceptedFormats` is typed as
 * plain strings with this list as the known vocabulary.
 */
export const KNOWN_EXPORT_TARGETS = [
  "chara_card_v2",
  "chara_card_v3",
  "charx",
  "lorebook",
  "lorebook_sillytavern",
  "preset_sillytavern",
  "preset_lumiverse",
  "theme_sillytavern",
  "theme_lumiverse",
  "pack_lumiverse",
  "extension_spindle",
  "raw",
] as const;

/** Reverse-DNS namespace of lumiverse.chat, used for capabilities we own. */
export const ILLARIN_CAPABILITY_NAMESPACE = "chat.lumiverse";

/** Wire limits from the protocol guide. The server enforces these; so do we. */
export const DECLARATION_LIMITS = {
  nameMaxChars: 64,
  versionMaxChars: 64,
  maxArrayEntries: 32,
  maxEntryChars: 64,
  maxBodyBytes: 4096,
} as const;

/** The declaration every authorization path starts with. */
export interface IllarinDeclaration {
  appName: string;
  name: string;
  appVersion?: string;
  protocolVersion: number;
  capabilities: string[];
  acceptedFormats: string[];
  permissions: IllarinScope[];
}

/** `POST /api/v1/connect/authorizations` body — same-device browser flow. */
export interface BrowserAuthorizationRequest extends IllarinDeclaration {
  /** Literal loopback callback: `http://127.0.0.1:<port>/<path>` or `http://[::1]:<port>/<path>`. */
  redirectUri: string;
  /** 32–128 unreserved characters; compared constant-time on callback. */
  state: string;
  /** BASE64URL-NO-PADDING(SHA256(ASCII(code_verifier))). */
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/** `POST /api/v1/connect/requests` body — headless device fallback. Declaration only. */
export type DeviceAuthorizationRequest = IllarinDeclaration;

/**
 * `PUT /api/v1/connected-apps/me` body. A complete replacement; names and
 * permissions cannot be changed here.
 */
export interface DeclarationUpdate {
  appVersion?: string;
  protocolVersion: number;
  capabilities: string[];
  acceptedFormats: string[];
}

/** `POST /api/v1/connect/authorizations` response. */
export interface BrowserAuthorizationResponse {
  /** Contains a one-use request secret — open in the system browser, never fetch or log. */
  authorizationUrl: string;
  userCode: string;
  expiresAt: string;
}

export interface ConnectedApp {
  id: string;
  permissions: IllarinScope[];
}

/** Returned by token exchange, device poll success, and refresh. */
export interface TokenPair {
  accessToken: string;
  /** ISO timestamp; access tokens last 15 minutes. */
  accessTokenExpiresAt: string;
  refreshToken: string;
  connectedApp: ConnectedApp;
}

/** `POST /api/v1/connect/requests` response. */
export interface DeviceRequestResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
  /** Minimum seconds between polls. A `slow_down` raises it persistently. */
  interval: number;
}

/**
 * Outcome of one `POST /api/v1/connect/poll` call, mapped from the protocol's
 * status/error table. Network failures throw (outcome unknown) — the caller
 * backs off exponentially and never polls before the current interval.
 */
export type DevicePollResult =
  | { kind: "pending" }
  | { kind: "linked"; tokens: TokenPair }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "unknown_code" }
  | { kind: "slow_down"; retryAfterSeconds: number | null }
  | { kind: "rate_limited"; retryAfterSeconds: number | null };

export interface DeliveryArtifact {
  type: string;
  url: string;
  mediaId?: string;
  role?: string;
  isCover?: boolean;
}

export interface IllarinDelivery {
  id: string;
  workId: string;
  versionNumber: number;
  type: string;
  name: string;
  format: string;
  label: string;
  queuedAt: string;
  leaseExpiresAt: string;
  files: DeliveryArtifact[];
}

export interface TakedownNotice {
  workId: string;
  name: string;
  takenDownAt: string;
}

export interface DeliveryWorkList {
  sends: IllarinDelivery[];
  takedowns: TakedownNotice[];
}

export interface LibrarySyncEntry {
  workId: string;
  versionNumber?: number;
}

export interface LibrarySyncRequest {
  snapshot: boolean;
  appVersion: string;
  entries: LibrarySyncEntry[];
  removed?: string[];
}

export interface LibrarySyncResponse {
  accepted: number;
  removed: number;
  ignored: number;
  takedowns: TakedownNotice[];
}
