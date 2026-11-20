const REDACTED = "[REDACTED]";
const SECRET_FIELDS = new Set([
  "key", "apikey", "secret", "secretkey", "secretref", "password", "passwd",
  "authorization", "proxyauthorization", "cookie", "setcookie", "bearer",
  "token", "accesstoken", "refreshtoken", "idtoken", "authtoken", "xauthtoken",
  "xapikey", "xgoogapikey", "xaccesstoken", "privatekey", "clientsecret",
  "awsaccesskeyid", "awssecretaccesskey", "awssessiontoken", "credential", "credentials",
]);

export function isCredentialField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SECRET_FIELDS.has(normalized)
    || /(?:apikey|secretkey|privatekey|clientsecret|password|accesstoken|refreshtoken|authtoken)$/.test(normalized);
}

/** Transport credentials are used only for redaction, never included in a record. */
export function transportCredentials(input: RequestInfo | URL, init: RequestInit): string[] {
  const secrets: string[] = [];
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  for (const [key, value] of headers) {
    if (isCredentialField(key)) {
      secrets.push(value);
      if (/^(Bearer|Basic)\s/i.test(value)) secrets.push(value.replace(/^\S+\s+/, ""));
    }
  }
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.username) secrets.push(decodeURIComponent(url.username));
  if (url.password) secrets.push(decodeURIComponent(url.password));
  for (const [key, value] of url.searchParams) {
    if (isCredentialField(key)) secrets.push(value);
  }
  return secrets;
}

/** Credentials remain only in the active capture, never in a history record. */
export function collectRequestCredentials(value: unknown, credentials: readonly string[]): string[] {
  const secrets = new Set<string>();
  const addSecret = (secret: string) => {
    if (!secret) return;
    secrets.add(secret);
    secrets.add(encodeURIComponent(secret));
    secrets.add(JSON.stringify(secret).slice(1, -1));
    if (/^(Bearer|Basic)\s/i.test(secret)) addSecret(secret.replace(/^\S+\s+/, ""));
  };
  const collectCredentialParts = (part: unknown, depth = 0): void => {
    if (depth > 100) throw new Error("Request nesting limit exceeded");
    if (typeof part === "string" && /^\s*[\[{]/.test(part)) {
      let parsed: unknown;
      try { parsed = JSON.parse(part); } catch { return; }
      collectCredentialParts(parsed, depth + 1);
      return;
    }
    if (!part || typeof part !== "object") return;
    for (const [key, nested] of Object.entries(part)) {
      if (isCredentialField(key) && typeof nested === "string") addSecret(nested);
      else collectCredentialParts(nested, depth + 1);
    }
  };
  for (const credential of credentials) {
    addSecret(credential);
    try { collectCredentialParts(JSON.parse(credential)); } catch { /* Ordinary API key. */ }
  }
  // A custom body may carry a second credential. Remove every occurrence of
  // those values too, including copies in prompts, tool results, and metadata.
  collectCredentialParts(value);
  return [...secrets].sort((a, b) => b.length - a.length);
}

/** Produces a new JSON value. Also sanitizes JSON embedded in tool-result strings. */
export function redactRequestValue(value: unknown, credentials: readonly string[]): unknown {
  const orderedSecrets = collectRequestCredentials(value, credentials);
  const redactText = (text: string): string => {
    let result = text;
    for (const secret of orderedSecrets) result = result.split(secret).join(REDACTED);
    return result
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, REDACTED)
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 " + REDACTED)
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED)
      .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/g, REDACTED)
      .replace(/([?&](?:key|api[_-]?key|access[_-]?token|token|secret|signature|x-amz-signature)=)[^&#\s"'<>]+/gi, "$1" + REDACTED)
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\s*[=:]\s*)(?:\[REDACTED\]|"[^"\n]*"|'[^'\n]*'|[^\s,;&}\]]+)/gi, "$1" + REDACTED);
  };
  const visit = (part: unknown, depth: number): unknown => {
    if (depth > 100) throw new Error("Request nesting limit exceeded");
    if (typeof part === "string") {
      // Parse before textual replacement so escaped secrets are compared as values.
      if (/^\s*[\[{]/.test(part)) {
        let nested: unknown;
        let parsed = false;
        try { nested = JSON.parse(part); parsed = true; } catch { /* Plain text. */ }
        if (parsed) {
          const safe = visit(nested, depth + 1);
          if (JSON.stringify(safe) !== JSON.stringify(nested)) return JSON.stringify(safe);
        }
      }
      return redactText(part);
    }
    if (Array.isArray(part)) return part.map((item) => visit(item, depth + 1));
    if (part && typeof part === "object") {
      return Object.fromEntries(Object.entries(part).map(([key, nested]) => [
        redactText(key), isCredentialField(key) ? REDACTED : visit(nested, depth + 1),
      ]));
    }
    return part;
  };
  return visit(value, 0);
}
