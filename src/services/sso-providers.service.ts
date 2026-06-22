import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getDb } from "../db/connection";
import { getEncryptionKeyBytes } from "../crypto/init";
import { env } from "../env";

export type SsoProviderKind = "authelia" | "authentik" | "keycloak" | "custom_oidc";

export interface SsoProviderPublic {
  id: string;
  provider_kind: SsoProviderKind;
  name: string;
  slug: string;
  enabled: boolean;
  issuer_url: string;
  discovery_url: string;
  client_id: string;
  has_client_secret: boolean;
  scopes: string[];
  pkce: boolean;
  allow_signup: boolean;
  metadata: Record<string, unknown>;
  redirect_uri: string;
  active_redirect_uri: string | null;
  active: boolean;
  requires_restart: boolean;
  created_at: number;
  updated_at: number;
}

export interface SsoProviderLoginOption {
  provider_id: string;
  provider_kind: SsoProviderKind;
  name: string;
}

export interface SsoProviderAuthConfig {
  providerId: string;
  clientId: string;
  clientSecret: string;
  discoveryUrl: string;
  redirectURI: string;
  scopes: string[];
  pkce: boolean;
  allowSignup: boolean;
}

export interface SsoUserLink {
  user_id: string;
  username: string | null;
  email: string | null;
  name: string | null;
  role: string | null;
  provider_id: string;
  provider_name: string;
  provider_kind: SsoProviderKind;
  account_id: string;
  linked_at: number | null;
  updated_at: number | null;
}

export interface SsoRecoveryStatus {
  owner_count: number;
  owner_credential_count: number;
  owner_sso_link_count: number;
  password_login_enabled: boolean;
  can_recover: boolean;
}

type SsoProviderRow = {
  id: string;
  provider_kind: SsoProviderKind;
  name: string;
  slug: string;
  enabled: number;
  issuer_url: string;
  discovery_url: string;
  client_id: string;
  encrypted_client_secret: string | null;
  client_secret_iv: string | null;
  client_secret_tag: string | null;
  scopes: string;
  pkce: number;
  allow_signup: number;
  metadata: string;
  created_at: number;
  updated_at: number;
};

const VALID_KINDS = new Set<SsoProviderKind>(["authelia", "authentik", "keycloak", "custom_oidc"]);
const DEFAULT_SCOPES = ["openid", "profile", "email"];
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const MAX_NAME_LENGTH = 80;
const MAX_URL_LENGTH = 2048;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_SECRET_LENGTH = 4096;
let activeProviderRedirectUris = new Map<string, string>();

export class InvalidSsoProviderError extends Error {
  status = 400 as const;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function encryptionKey(): Buffer {
  return Buffer.from(getEncryptionKeyBytes());
}

function encryptSecret(value: string): { encrypted: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decryptSecret(row: Pick<SsoProviderRow, "encrypted_client_secret" | "client_secret_iv" | "client_secret_tag">): string | null {
  if (!row.encrypted_client_secret || !row.client_secret_iv || !row.client_secret_tag) return null;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(row.client_secret_iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(row.client_secret_tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(row.encrypted_client_secret, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getProviderMetadata(row: Pick<SsoProviderRow, "metadata">): Record<string, unknown> {
  return parseJsonObject(row.metadata);
}

function getProviderRedirectOrigin(row: Pick<SsoProviderRow, "metadata">): string | undefined {
  const metadata = getProviderMetadata(row);
  return typeof metadata.redirect_origin === "string" && metadata.redirect_origin.trim()
    ? metadata.redirect_origin.trim()
    : undefined;
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return sanitizeScopes(parsed);
  } catch {}
  return [...DEFAULT_SCOPES];
}

function sanitizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_SCOPES];
  const scopes = value
    .map((scope) => (typeof scope === "string" ? scope.trim() : ""))
    .filter((scope) => /^[A-Za-z0-9._:-]{1,80}$/.test(scope));
  const unique = Array.from(new Set(scopes));
  if (!unique.includes("openid")) unique.unshift("openid");
  return unique.slice(0, 20);
}

function normalizeUrl(value: unknown, field: string, required = false): string {
  if (value === undefined || value === null || value === "") {
    if (required) throw new InvalidSsoProviderError(`${field} is required`);
    return "";
  }
  if (typeof value !== "string") throw new InvalidSsoProviderError(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new InvalidSsoProviderError(`${field} is required`);
    return "";
  }
  if (trimmed.length > MAX_URL_LENGTH) throw new InvalidSsoProviderError(`${field} is too long`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidSsoProviderError(`${field} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new InvalidSsoProviderError(`${field} must use https unless it targets localhost`);
  }
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeOrigin(value: unknown, field: string): string {
  const normalized = normalizeUrl(value, field);
  if (!normalized) return "";
  const url = new URL(normalized);
  return url.origin;
}

function deriveDiscoveryUrl(issuerUrl: string, explicitDiscoveryUrl: string): string {
  if (explicitDiscoveryUrl) return explicitDiscoveryUrl;
  if (!issuerUrl) return "";
  return `${issuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
}

function normalizeSlug(value: unknown): string {
  if (typeof value !== "string") throw new InvalidSsoProviderError("slug is required");
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw new InvalidSsoProviderError("slug must be 3-64 chars and contain only lowercase letters, numbers, and hyphens");
  }
  return slug;
}

function normalizeKind(value: unknown): SsoProviderKind {
  if (typeof value !== "string" || !VALID_KINDS.has(value as SsoProviderKind)) {
    throw new InvalidSsoProviderError("provider_kind must be authelia, authentik, keycloak, or custom_oidc");
  }
  return value as SsoProviderKind;
}

function publicFromRow(row: SsoProviderRow): SsoProviderPublic {
  return {
    id: row.id,
    provider_kind: row.provider_kind,
    name: row.name,
    slug: row.slug,
    enabled: Boolean(row.enabled),
    issuer_url: row.issuer_url,
    discovery_url: row.discovery_url,
    client_id: row.client_id,
    has_client_secret: Boolean(row.encrypted_client_secret),
    scopes: parseScopes(row.scopes),
    pkce: Boolean(row.pkce),
    allow_signup: Boolean(row.allow_signup),
    metadata: getProviderMetadata(row),
    redirect_uri: getRedirectUri(row.slug, getProviderRedirectOrigin(row)),
    active_redirect_uri: activeProviderRedirectUris.get(row.slug) ?? null,
    active: activeProviderRedirectUris.has(row.slug),
    requires_restart: Boolean(row.enabled) !== activeProviderRedirectUris.has(row.slug)
      || (Boolean(row.enabled) && activeProviderRedirectUris.get(row.slug) !== getRedirectUri(row.slug, getProviderRedirectOrigin(row))),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function getRow(id: string): SsoProviderRow | null {
  return getDb().query("SELECT * FROM sso_providers WHERE id = ?").get(id) as SsoProviderRow | null;
}

export function getRedirectUri(slug: string, origin = process.env.AUTH_BASE_URL || `http://localhost:${env.port}`): string {
  const base = (origin || "").replace(/\/$/, "");
  return base ? `${base}/api/auth/oauth2/callback/${slug}` : `/api/auth/oauth2/callback/${slug}`;
}

function normalizeMetadata(input: any, existing?: string): string {
  const metadata = input?.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
    ? { ...input.metadata }
    : existing
      ? getProviderMetadata({ metadata: existing })
      : {};
  const redirectOriginInput = input?.redirect_origin ?? input?.redirectOrigin ?? metadata.redirect_origin;
  const redirectOrigin = normalizeOrigin(redirectOriginInput, "redirect_origin");
  if (redirectOrigin) metadata.redirect_origin = redirectOrigin;
  else delete metadata.redirect_origin;
  return JSON.stringify(metadata);
}

export function listSsoProviders(): SsoProviderPublic[] {
  const rows = getDb().query("SELECT * FROM sso_providers ORDER BY created_at DESC, name COLLATE NOCASE").all() as SsoProviderRow[];
  return rows.map(publicFromRow);
}

export function listSsoLoginOptions(): SsoProviderLoginOption[] {
  const rows = getDb()
    .query("SELECT provider_kind, name, slug FROM sso_providers WHERE enabled = 1 ORDER BY name COLLATE NOCASE")
    .all() as Pick<SsoProviderRow, "provider_kind" | "name" | "slug">[];
  return rows.filter((row) => activeProviderRedirectUris.has(row.slug)).map((row) => ({
    provider_id: row.slug,
    provider_kind: row.provider_kind,
    name: row.name,
  }));
}

export function getSsoProvider(id: string): SsoProviderPublic | null {
  const row = getRow(id);
  return row ? publicFromRow(row) : null;
}

export function createSsoProvider(input: any): SsoProviderPublic {
  const kind = normalizeKind(input?.provider_kind ?? input?.providerKind ?? "custom_oidc");
  const name = typeof input?.name === "string" ? input.name.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) throw new InvalidSsoProviderError("name is required and must be 1-80 chars");
  const slug = normalizeSlug(input?.slug);
  const issuerUrl = normalizeUrl(input?.issuer_url ?? input?.issuerUrl, "issuer_url", true);
  const discoveryUrl = deriveDiscoveryUrl(issuerUrl, normalizeUrl(input?.discovery_url ?? input?.discoveryUrl, "discovery_url"));
  const clientId = typeof input?.client_id === "string" ? input.client_id.trim() : typeof input?.clientId === "string" ? input.clientId.trim() : "";
  if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH) throw new InvalidSsoProviderError("client_id is required and must be 1-512 chars");
  const secret = typeof input?.client_secret === "string" ? input.client_secret : typeof input?.clientSecret === "string" ? input.clientSecret : "";
  if (!secret || secret.length > MAX_SECRET_LENGTH) throw new InvalidSsoProviderError("client_secret is required and must be 1-4096 chars");
  const encrypted = encryptSecret(secret);
  const id = crypto.randomUUID();
  const now = nowSec();
  const scopes = JSON.stringify(sanitizeScopes(input?.scopes));
  const metadata = normalizeMetadata(input);

  getDb().query(
    `INSERT INTO sso_providers (
      id, provider_kind, name, slug, enabled, issuer_url, discovery_url, client_id,
      encrypted_client_secret, client_secret_iv, client_secret_tag, scopes, pkce,
      allow_signup, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, kind, name, slug, input?.enabled ? 1 : 0, issuerUrl, discoveryUrl, clientId,
    encrypted.encrypted, encrypted.iv, encrypted.tag, scopes, input?.pkce === false ? 0 : 1,
    input?.allow_signup ? 1 : 0, metadata, now, now,
  );

  return publicFromRow(getRow(id)!);
}

export function updateSsoProvider(id: string, input: any): SsoProviderPublic | null {
  const existing = getRow(id);
  if (!existing) return null;

  const kind = input?.provider_kind !== undefined || input?.providerKind !== undefined
    ? normalizeKind(input.provider_kind ?? input.providerKind)
    : existing.provider_kind;
  const name = input?.name !== undefined ? String(input.name).trim() : existing.name;
  if (!name || name.length > MAX_NAME_LENGTH) throw new InvalidSsoProviderError("name is required and must be 1-80 chars");
  const slug = input?.slug !== undefined ? normalizeSlug(input.slug) : existing.slug;
  const issuerUrl = input?.issuer_url !== undefined || input?.issuerUrl !== undefined
    ? normalizeUrl(input.issuer_url ?? input.issuerUrl, "issuer_url", true)
    : existing.issuer_url;
  const explicitDiscovery = input?.discovery_url !== undefined || input?.discoveryUrl !== undefined
    ? normalizeUrl(input.discovery_url ?? input.discoveryUrl, "discovery_url")
    : existing.discovery_url;
  const discoveryUrl = deriveDiscoveryUrl(issuerUrl, explicitDiscovery);
  const clientId = input?.client_id !== undefined || input?.clientId !== undefined
    ? String(input.client_id ?? input.clientId).trim()
    : existing.client_id;
  if (!clientId || clientId.length > MAX_CLIENT_ID_LENGTH) throw new InvalidSsoProviderError("client_id is required and must be 1-512 chars");
  const scopes = input?.scopes !== undefined ? JSON.stringify(sanitizeScopes(input.scopes)) : existing.scopes;
  const metadata = input?.metadata !== undefined || input?.redirect_origin !== undefined || input?.redirectOrigin !== undefined
    ? normalizeMetadata(input, existing.metadata)
    : existing.metadata;
  const enabled = input?.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
  const pkce = input?.pkce !== undefined ? (input.pkce === false ? 0 : 1) : existing.pkce;
  const allowSignup = input?.allow_signup !== undefined || input?.allowSignup !== undefined
    ? ((input.allow_signup ?? input.allowSignup) ? 1 : 0)
    : existing.allow_signup;

  let encryptedClientSecret = existing.encrypted_client_secret;
  let clientSecretIv = existing.client_secret_iv;
  let clientSecretTag = existing.client_secret_tag;
  const nextSecret = input?.client_secret ?? input?.clientSecret;
  if (typeof nextSecret === "string" && nextSecret.length > 0) {
    if (nextSecret.length > MAX_SECRET_LENGTH) throw new InvalidSsoProviderError("client_secret must be 1-4096 chars");
    const encrypted = encryptSecret(nextSecret);
    encryptedClientSecret = encrypted.encrypted;
    clientSecretIv = encrypted.iv;
    clientSecretTag = encrypted.tag;
  }

  const now = nowSec();
  getDb().query(
    `UPDATE sso_providers SET
      provider_kind = ?, name = ?, slug = ?, enabled = ?, issuer_url = ?, discovery_url = ?, client_id = ?,
      encrypted_client_secret = ?, client_secret_iv = ?, client_secret_tag = ?, scopes = ?, pkce = ?,
      allow_signup = ?, metadata = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    kind, name, slug, enabled, issuerUrl, discoveryUrl, clientId,
    encryptedClientSecret, clientSecretIv, clientSecretTag, scopes, pkce,
    allowSignup, metadata, now, id,
  );

  return publicFromRow(getRow(id)!);
}

export function deleteSsoProvider(id: string): boolean {
  return getDb().query("DELETE FROM sso_providers WHERE id = ?").run(id).changes > 0;
}

export function listEnabledSsoAuthConfigs(): SsoProviderAuthConfig[] {
  const rows = getDb().query("SELECT * FROM sso_providers WHERE enabled = 1 ORDER BY created_at ASC").all() as SsoProviderRow[];
  const configs: SsoProviderAuthConfig[] = [];
  for (const row of rows) {
    const secret = decryptSecret(row);
    if (!row.slug || !row.client_id || !row.discovery_url || !secret) continue;
    configs.push({
      providerId: row.slug,
      clientId: row.client_id,
      clientSecret: secret,
      discoveryUrl: row.discovery_url,
      redirectURI: getRedirectUri(row.slug, getProviderRedirectOrigin(row)),
      scopes: parseScopes(row.scopes),
      pkce: Boolean(row.pkce),
      allowSignup: Boolean(row.allow_signup),
    });
  }
  activeProviderRedirectUris = new Map(configs.map((config) => [config.providerId, config.redirectURI]));
  return configs;
}

export function listSsoUserLinks(): SsoUserLink[] {
  const rows = getDb().query(
    `SELECT
       u.id AS user_id,
       u.username,
       u.email,
       u.name,
       u.role,
       p.slug AS provider_id,
       p.name AS provider_name,
       p.provider_kind,
       a.accountId AS account_id,
       a.createdAt AS linked_at,
       a.updatedAt AS updated_at
     FROM account a
     JOIN sso_providers p ON p.slug = a.providerId
     JOIN "user" u ON u.id = a.userId
     ORDER BY u.role = 'owner' DESC, u.username COLLATE NOCASE, p.name COLLATE NOCASE`,
  ).all() as any[];
  return rows.map((row) => ({
    user_id: row.user_id,
    username: row.username ?? null,
    email: row.email ?? null,
    name: row.name ?? null,
    role: row.role ?? null,
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    provider_kind: row.provider_kind,
    account_id: row.account_id,
    linked_at: typeof row.linked_at === "number" ? row.linked_at : null,
    updated_at: typeof row.updated_at === "number" ? row.updated_at : null,
  }));
}

export function listCurrentUserSsoLinks(userId: string): SsoUserLink[] {
  return listSsoUserLinks().filter((link) => link.user_id === userId);
}

export function unlinkCurrentUserSsoProvider(userId: string, providerId: string): boolean {
  const result = getDb().query("DELETE FROM account WHERE userId = ? AND providerId = ? AND providerId IN (SELECT slug FROM sso_providers)").run(userId, providerId);
  return result.changes > 0;
}

export function getSsoRecoveryStatus(): SsoRecoveryStatus {
  const row = getDb().query(
    `SELECT
       COUNT(*) AS owner_count,
       SUM(CASE WHEN credential.id IS NOT NULL THEN 1 ELSE 0 END) AS owner_credential_count,
       SUM(CASE WHEN sso.id IS NOT NULL THEN 1 ELSE 0 END) AS owner_sso_link_count
     FROM "user" u
     LEFT JOIN account credential ON credential.userId = u.id AND credential.providerId = 'credential'
     LEFT JOIN account sso ON sso.userId = u.id AND sso.providerId IN (SELECT slug FROM sso_providers WHERE enabled = 1)
     WHERE u.role = 'owner'`,
  ).get() as { owner_count: number; owner_credential_count: number | null; owner_sso_link_count: number | null } | null;
  const ownerCredentialCount = row?.owner_credential_count ?? 0;
  const ownerSsoLinkCount = row?.owner_sso_link_count ?? 0;
  return {
    owner_count: row?.owner_count ?? 0,
    owner_credential_count: ownerCredentialCount,
    owner_sso_link_count: ownerSsoLinkCount,
    password_login_enabled: true,
    can_recover: ownerCredentialCount > 0 || ownerSsoLinkCount > 0,
  };
}

export async function testDiscovery(input: any): Promise<{ ok: boolean; issuer?: string; authorization_endpoint?: string; token_endpoint?: string; userinfo_endpoint?: string; jwks_uri?: string; scopes_supported?: string[]; error?: string }> {
  const issuerUrl = normalizeUrl(input?.issuer_url ?? input?.issuerUrl, "issuer_url", true);
  const discoveryUrl = deriveDiscoveryUrl(issuerUrl, normalizeUrl(input?.discovery_url ?? input?.discoveryUrl, "discovery_url"));
  const res = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) return { ok: false, error: `Discovery returned ${res.status}` };
  const body = await res.json() as any;
  return {
    ok: true,
    issuer: typeof body.issuer === "string" ? body.issuer : undefined,
    authorization_endpoint: typeof body.authorization_endpoint === "string" ? body.authorization_endpoint : undefined,
    token_endpoint: typeof body.token_endpoint === "string" ? body.token_endpoint : undefined,
    userinfo_endpoint: typeof body.userinfo_endpoint === "string" ? body.userinfo_endpoint : undefined,
    jwks_uri: typeof body.jwks_uri === "string" ? body.jwks_uri : undefined,
    scopes_supported: Array.isArray(body.scopes_supported) ? body.scopes_supported.filter((s: unknown) => typeof s === "string") : undefined,
  };
}
