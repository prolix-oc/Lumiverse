/**
 * Same-device browser authorization for Illarin (protocol v1).
 *
 * The backend binds a ONE-SHOT listener on a literal loopback address,
 * starts an authorization against Illarin, and hands the authorization URL
 * to the caller for opening in the system browser. When the owner approves,
 * the browser hits the loopback callback with `code` + `state`; the first
 * terminal callback (or the timeout) stops the listener permanently.
 *
 * Callback validation matrix (protocol conformance checklist):
 * - exact pre-opened path, GET only
 * - `state` compared constant-time against the original
 * - missing, duplicated, or unexpected parameters rejected
 * - `error=access_denied` reported as a denial
 * - any first callback is terminal: a second hit finds the port closed
 */

import { timingSafeEqual } from "node:crypto";
import { createBrowserAuthorization, exchangeAuthorizationCode, type IllarinFetch } from "./api";
import type { IllarinDeclaration, TokenPair } from "./types";

const CALLBACK_PATH = "/illarin/callback";
/** The authorization request expires in five minutes; mirror that. */
export const LINK_TIMEOUT_MS = 5 * 60_000;

export interface PkceMaterial {
  verifier: string;
  state: string;
  codeChallenge: string;
}

function randomBase64Url(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Verifier 43 chars and state 32 chars — both inside protocol bounds. */
export async function generatePkce(): Promise<PkceMaterial> {
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(24);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const codeChallenge = Buffer.from(digest).toString("base64url");
  return { verifier, state, codeChallenge };
}

export type BrowserLinkOutcome =
  | { kind: "linked"; tokens: TokenPair }
  | { kind: "denied" }
  | { kind: "timeout" }
  | { kind: "invalid_callback"; reason: string };

export interface BrowserLinkInput {
  baseUrl: string;
  declaration: IllarinDeclaration;
  /** Injectable transport for tests; production uses safeFetch. */
  fetchImpl?: IllarinFetch;
  /** Receives the authorization URL once the loopback listener is ready. */
  openAuthorization: (authorization: { authorizationUrl: string; userCode: string }) => void;
  /** Test seam: called once the loopback listener accepts connections. */
  onListening?: (redirectUri: string) => void;
  timeoutMs?: number;
}

interface CallbackEvaluation {
  /** Set when the callback carries an exchangeable code. */
  code: string | null;
  outcome: BrowserLinkOutcome | null;
  respond: Response;
}

function htmlResponse(title: string, message: string, accent: string): Response {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0f;color:#e0e0e8">
<div style="text-align:center;padding:2rem;border-radius:12px;background:#14141e;border:1px solid ${accent}"><h1 style="color:${accent};margin:0 0 .5rem">${title}</h1><p style="opacity:.8">${message}</p></div>
</body></html>`;
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Validate one callback request exactly once. */
function evaluateCallback(request: Request, expectedState: string): CallbackEvaluation {
  const invalid = (reason: string): CallbackEvaluation => ({
    code: null,
    outcome: { kind: "invalid_callback", reason },
    respond: htmlResponse("Linking failed", "The callback was rejected. Restart linking from settings.", "#e74c3c"),
  });

  if (request.method !== "GET") return invalid("wrong method");
  const url = new URL(request.url);
  if (url.pathname !== CALLBACK_PATH) return invalid("wrong path");

  // Missing, duplicated, or unexpected parameters are all rejected.
  const seen = new Map<string, number>();
  for (const key of url.searchParams.keys()) seen.set(key, (seen.get(key) ?? 0) + 1);
  for (const [key, count] of seen) {
    if (!["code", "error", "state"].includes(key)) return invalid(`unexpected parameter "${key}"`);
    if (count > 1) return invalid(`repeated parameter "${key}"`);
  }

  const state = url.searchParams.get("state");
  if (!state || !constantTimeEquals(state, expectedState)) return invalid("state mismatch");

  const error = url.searchParams.get("error");
  if (error && url.searchParams.has("code")) return invalid("code and error cannot both be present");
  if (error === "access_denied") {
    return {
      code: null,
      outcome: { kind: "denied" },
      respond: htmlResponse("Linking declined", "You declined this request. You can close this window.", "#e74c3c"),
    };
  }
  if (error) return invalid(`Illarin reported error="${error}"`);

  const code = url.searchParams.get("code");
  if (!code) return invalid("missing code");

  return {
    code,
    outcome: null,
    respond: htmlResponse("Linked", "Your instance is linked. You can close this window.", "#7c3aed"),
  };
}

/**
 * Run the full same-device browser link. Resolves once the first terminal
 * callback arrives or the timeout fires; the one-use code exchange happens
 * inside, so a `linked` outcome carries ready-to-persist credentials.
 * Exchange failures throw to the caller.
 */
export async function runBrowserLink(input: BrowserLinkInput): Promise<BrowserLinkOutcome> {
  const timeoutMs = input.timeoutMs ?? LINK_TIMEOUT_MS;
  const { verifier, state, codeChallenge } = await generatePkce();

  const { promise: callbackReceived, resolve: deliverCallback } = Promise.withResolvers<CallbackEvaluation>();
  let timer: Timer | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const evaluation = evaluateCallback(request, state);
      deliverCallback?.(evaluation);
      return evaluation.respond;
    },
  });
  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
  input.onListening?.(redirectUri);

  try {
    const authorization = await createBrowserAuthorization(input.baseUrl, {
      ...input.declaration,
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod: "S256",
    }, { fetchImpl: input.fetchImpl });

    input.openAuthorization({ authorizationUrl: authorization.authorizationUrl, userCode: authorization.userCode });

    const raced = await Promise.race([
      callbackReceived.then(() => "callback" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (raced === "timeout") return { kind: "timeout" };

    const evaluation = await callbackReceived;
    if (evaluation.outcome) return evaluation.outcome;
    if (!evaluation.code) return { kind: "invalid_callback", reason: "empty callback" };

    const tokens = await exchangeAuthorizationCode(input.baseUrl, {
      authorizationCode: evaluation.code,
      codeVerifier: verifier,
      redirectUri,
    }, { fetchImpl: input.fetchImpl });
    return { kind: "linked", tokens };
  } finally {
    clearTimeout(timer);
    // Graceful stop: the terminal response still flushes, but the port is
    // closed to any duplicate callback.
    server.stop();
  }
}
