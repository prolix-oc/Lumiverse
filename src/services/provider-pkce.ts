export type PkceProvider = "openrouter" | "nanogpt";

const providers = {
  openrouter: { name: "OpenRouter", origin: "https://openrouter.ai" },
  nanogpt: { name: "NanoGPT", origin: "https://nano-gpt.com" },
};

/** Shared by text and decision connections. The verifier stays on the server. */
export async function createProviderPkce(provider: PkceProvider, callbackUrl: string) {
  const codeVerifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64url");
  const sessionToken = crypto.randomUUID();
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const callback = new URL(callbackUrl);
  // Carry state in the callback itself as well as the authorization request so
  // OpenRouter callbacks work with the existing same-origin landing page.
  callback.searchParams.set("state", sessionToken);
  const params = new URLSearchParams({
    callback_url: callback.toString(),
    code_challenge: Buffer.from(hash).toString("base64url"),
    code_challenge_method: "S256",
    state: sessionToken,
    ...(provider === "nanogpt" ? { scope: "api.use models.read", client_name: "Lumiverse" } : {}),
  });
  return {
    auth_url: `${providers[provider].origin}/auth?${params}`,
    session_token: sessionToken,
    codeVerifier,
    callbackUrl: callback.toString(),
  };
}

export async function exchangeProviderPkce(provider: PkceProvider, code: string, codeVerifier: string): Promise<string> {
  const { name, origin } = providers[provider];
  const response = await fetch(`${origin}/api/v1/auth/keys`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code, code_verifier: codeVerifier,
      ...(provider === "openrouter" ? { code_challenge_method: "S256" } : { grant_type: "authorization_code" }),
    }),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  // Provider errors can contain credentials; never relay the raw body.
  if (!response.ok) throw new Error(`${name} key exchange failed (${response.status})`);
  const data = await response.json() as { key?: unknown; access_token?: unknown };
  const key = data?.key || (provider === "nanogpt" ? data?.access_token : undefined);
  if (typeof key !== "string" || !key.trim()) throw new Error(`${name} did not return an API key`);
  return key.trim();
}
