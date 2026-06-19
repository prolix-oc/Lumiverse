/**
 * HuggingFace access token storage + request auth.
 *
 * The owner can store a single server-wide HuggingFace token (encrypted at rest
 * via the secrets table) so the tokenizer subsystem can read gated/private repos.
 * The token is resolved against the first user (the owner) — matching how other
 * global settings (dns/sharp/spindle) resolve, and because the tokenizer instance
 * cache is server-wide rather than per-request.
 *
 * SECURITY: the token is only ever attached to requests whose host is a recognised
 * HuggingFace host (`hfAuthHeaders`). Custom tokenizer URLs pointing at other hosts
 * never receive it. The plaintext is never returned by the API (only `configured`).
 */
import * as secretsSvc from "./secrets.service";
import { getFirstUserId } from "../auth/seed";

export const HF_API_TOKEN_SECRET = "huggingface_api_token";

export const HF_HOSTS = new Set(["huggingface.co", "hf.co", "www.huggingface.co"]);

export function isHfHost(hostname: string): boolean {
  return HF_HOSTS.has(hostname.toLowerCase());
}

/**
 * Read the stored token (decrypted). Defensive: returns null if no owner exists,
 * nothing is stored, or the DB/crypto isn't ready — so the no-token path can never
 * break tokenizer loading.
 */
export async function getHfToken(): Promise<string | null> {
  try {
    const ownerId = getFirstUserId();
    if (!ownerId) return null;
    const token = await secretsSvc.getSecret(ownerId, HF_API_TOKEN_SECRET);
    return token && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

export async function hasHfToken(): Promise<boolean> {
  const ownerId = getFirstUserId();
  if (!ownerId) return false;
  return secretsSvc.validateSecret(ownerId, HF_API_TOKEN_SECRET);
}

/** Store (trimmed, non-empty) or clear (empty/null) the token. Returns the new state. */
export async function setHfToken(token: string | null): Promise<{ configured: boolean }> {
  const ownerId = getFirstUserId();
  if (!ownerId) throw new Error("No owner account found to store the HuggingFace token against.");

  const trimmed = typeof token === "string" ? token.trim() : "";
  if (trimmed) {
    await secretsSvc.putSecret(ownerId, HF_API_TOKEN_SECRET, trimmed);
    return { configured: true };
  }
  secretsSvc.deleteSecret(ownerId, HF_API_TOKEN_SECRET);
  return { configured: false };
}

/**
 * Authorization header for a request — ONLY when the URL targets a HuggingFace
 * host and a token is configured. Otherwise an empty object (no header), which is
 * what guarantees the token never leaks to non-HF hosts.
 */
export async function hfAuthHeaders(url: string): Promise<Record<string, string>> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  if (!isHfHost(host)) return {};
  const token = await getHfToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
