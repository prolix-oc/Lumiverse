import { createProviderPkce, exchangeProviderPkce } from "./provider-pkce";
import type { ConnectionProfile } from "../types/connection-profile";
import * as connSvc from "./connections.service";
import * as secretsSvc from "./secrets.service";
import { describeProviderError, fetchProviderJson } from "../utils/provider-errors";
import type { NanoGptBalance, NanoGptModelProviders, NanoGptPaygoUsage } from "../types/nanogpt";

const API_TIMEOUT_MS = 15_000;

/** Discovery and balance are rooted at /api, even with a subscription API base. */
export function resolveNanoGptApiEndpoint(apiUrl: string | null | undefined, path: string): URL {
  const url = new URL(apiUrl?.trim() || "https://nano-gpt.com/api/v1");
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("Invalid NanoGPT API URL");
  url.pathname = path;
  url.search = "";
  url.hash = "";
  return url;
}

export class NanoGptConnectionError extends Error {
  constructor(message: string, readonly status: 400 | 404) { super(message); }
}

async function resolveCredentials(userId: string, input: { connection_id?: string; api_url?: string; api_key?: string }) {
  const profile = input.connection_id ? connSvc.getConnection(userId, input.connection_id) : null;
  if (input.connection_id && !profile) throw new NanoGptConnectionError("Connection not found", 404);
  if (profile && profile.provider !== "nanogpt") throw new NanoGptConnectionError("Connection is not a NanoGPT profile", 400);
  const apiKey = (input.api_key?.trim() || (profile ? await secretsSvc.getSecret(userId, connSvc.connectionSecretKey(profile.id)) : "") || "")
    .trim().replace(/^Bearer\s+/i, "");
  if (!apiKey) throw new NanoGptConnectionError("A NanoGPT API key is required", 400);
  return { apiKey, apiUrl: input.api_url ?? profile?.api_url };
}

export async function discoverModelProviders(userId: string, input: {
  connection_id?: string; api_url?: string; api_key?: string; model: string;
}): Promise<NanoGptModelProviders> {
  const { apiKey, apiUrl } = await resolveCredentials(userId, input);
  const url = resolveNanoGptApiEndpoint(apiUrl, `/api/models/${encodeURIComponent(input.model.trim())}/providers`);
  const raw = await fetchProviderJson<NanoGptModelProviders>("NanoGPT", "provider discovery", url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (typeof raw?.supportsProviderSelection !== "boolean" || !Array.isArray(raw.providers)) {
    throw new Error("NanoGPT returned an invalid provider list");
  }
  return {
    canonicalId: raw.canonicalId || input.model.trim(),
    displayName: raw.displayName || input.model.trim(),
    supportsProviderSelection: raw.supportsProviderSelection,
    defaultPrice: raw.defaultPrice,
    providers: raw.providers.filter((p) => p && typeof p.provider === "string" && p.provider.trim()).map((p) => ({
      provider: p.provider,
      displayName: p.displayName,
      available: p.available === true,
      pricing: p.pricing,
      effectivePricing: p.effectivePricing,
      quantization: p.quantization,
    })),
  };
}

function finiteNumber(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchPaygoBalance(apiKey: string, apiUrl?: string | null): Promise<NanoGptBalance> {
  const raw = await fetchProviderJson<any>("NanoGPT", "balance", resolveNanoGptApiEndpoint(apiUrl, "/api/check-balance"), {
    method: "POST",
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const balance = { usd_balance: finiteNumber(raw?.usd_balance), nano_balance: finiteNumber(raw?.nano_balance) };
  if (balance.usd_balance === null && balance.nano_balance === null) throw new Error("NanoGPT returned an invalid balance");
  return balance;
}

export async function fetchPaygoUsage(apiKey: string, apiUrl?: string | null, now = new Date()): Promise<NanoGptPaygoUsage> {
  const today = now.toISOString().slice(0, 10);
  const from = `${today.slice(0, 7)}-01`;
  const url = resolveNanoGptApiEndpoint(apiUrl, "/api/v1/usage");
  url.search = new URLSearchParams({ from, to: today, group_by: "day", scope: "current_key" }).toString();
  const raw = await fetchProviderJson<any>("NanoGPT", "usage", url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!raw?.totals || !Array.isArray(raw.byDay) || finiteNumber(raw.totals.netCostUsd) === null) {
    throw new Error("NanoGPT returned invalid usage totals");
  }
  const todayRow = raw.byDay.find((row: any) => row?.date === today);
  if (todayRow && finiteNumber(todayRow.netCostUsd) === null) throw new Error("NanoGPT returned invalid daily usage");
  return {
    from, to: today,
    asOf: typeof raw.asOf === "string" ? raw.asOf : null,
    usage_daily: todayRow ? finiteNumber(todayRow.netCostUsd)! : 0,
    usage_monthly: finiteNumber(raw.totals.netCostUsd)!,
    requests: finiteNumber(raw.totals.requests) ?? 0,
    inputTokens: finiteNumber(raw.totals.inputTokens) ?? 0,
    outputTokens: finiteNumber(raw.totals.outputTokens) ?? 0,
  };
}

export interface NanoGptAccountUsage {
  subscription: connSvc.NanoGptSubscriptionUsage | null;
  balance: NanoGptBalance | null;
  paygo: NanoGptPaygoUsage | null;
  errors: Partial<Record<"subscription" | "balance" | "paygo", string>>;
}

export async function fetchAccountUsage(userId: string, connectionId: string): Promise<NanoGptAccountUsage> {
  const { apiKey, apiUrl } = await resolveCredentials(userId, { connection_id: connectionId });
  const results = await Promise.allSettled([
    connSvc.fetchNanoGptSubscriptionUsage(userId, connectionId),
    fetchPaygoBalance(apiKey, apiUrl),
    fetchPaygoUsage(apiKey, apiUrl),
  ]);
  const account: NanoGptAccountUsage = { subscription: null, balance: null, paygo: null, errors: {} };
  const keys = ["subscription", "balance", "paygo"] as const;
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      Object.assign(account, { [keys[index]]: result.value });
    } else {
      account.errors[keys[index]] = result.status === "rejected"
        ? describeProviderError(result.reason, "NanoGPT usage unavailable")
        : "NanoGPT subscription usage unavailable";
    }
  });
  return account;
}

// ── PKCE OAuth ───────────────────────────────────────────────────────────────

interface PendingOAuth {
  connectionId?: string;
  connectionName?: string;
  codeVerifier: string;
  callbackUrl: string;
  createdAt: number;
}

/** In-memory store for pending OAuth sessions. Keyed by session_token. TTL: 5 minutes. */
const pendingOAuth = new Map<string, PendingOAuth>();
const OAUTH_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_OAUTH = 10_000;

function cleanupExpiredSessions(): void {
  const now = Date.now();
  for (const [token, session] of pendingOAuth) {
    if (now - session.createdAt > OAUTH_TTL_MS) {
      pendingOAuth.delete(token);
    }
  }
  while (pendingOAuth.size >= MAX_PENDING_OAUTH) {
    const oldest = pendingOAuth.keys().next();
    if (oldest.done) break;
    pendingOAuth.delete(oldest.value);
  }
}

export async function initiateOAuthAsync(
  callbackUrl: string,
  opts: { connectionId?: string; connectionName?: string },
): Promise<{ auth_url: string; session_token: string }> {
  cleanupExpiredSessions();

  const { auth_url, session_token, codeVerifier, callbackUrl: callbackUrlWithState } = await createProviderPkce("nanogpt", callbackUrl);
  pendingOAuth.set(session_token, {
    connectionId: opts.connectionId,
    connectionName: opts.connectionName,
    codeVerifier,
    callbackUrl: callbackUrlWithState,
    createdAt: Date.now(),
  });
  return { auth_url, session_token };
}

export async function completeOAuth(
  userId: string,
  sessionToken: string,
  code: string,
): Promise<{ success: boolean; connection_id: string; created?: boolean; profile?: ConnectionProfile }> {
  const session = pendingOAuth.get(sessionToken);
  if (!session) throw new Error("Invalid or expired session token");

  if (Date.now() - session.createdAt > OAUTH_TTL_MS) {
    pendingOAuth.delete(sessionToken);
    throw new Error("OAuth session has expired");
  }

  let connectionId = session.connectionId;
  let created = false;

  if (connectionId) {
    const conn = connSvc.getConnection(userId, connectionId);
    if (!conn) throw new Error("Connection not found");
    if (conn.provider !== "nanogpt") throw new Error("Connection is not a NanoGPT profile");
  }

  let apiKey: string;
  try {
    apiKey = await exchangeProviderPkce("nanogpt", code, session.codeVerifier);
  } catch (error) {
    pendingOAuth.delete(sessionToken);
    throw error;
  }

  if (!connectionId) {
    const profile = await connSvc.createConnection(userId, {
      name: session.connectionName || "NanoGPT",
      provider: "nanogpt",
    });
    connectionId = profile.id;
    created = true;
  }

  await connSvc.setConnectionApiKey(userId, connectionId, apiKey);
  pendingOAuth.delete(sessionToken);

  const profile = connSvc.getConnection(userId, connectionId)!;
  return { success: true, connection_id: connectionId, created, profile };
}
