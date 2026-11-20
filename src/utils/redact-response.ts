import { collectRequestCredentials, redactRequestValue } from "./redact-request";
import { finalizeProviderResponse } from "../llm/finalize-response";

export function redactResponseBody(body: string, credentials: readonly string[], sanitize: (value: unknown) => unknown = (value) => value): {
  text: string; format: "json" | "text"; redacted: boolean; terminal: boolean; failed: boolean; partial?: boolean;
} {
  const failed = (data: any): boolean => !!data && typeof data === "object"
    && (!!data.error || ["error", "response.failed"].includes(data.type));
  let json: unknown;
  let parsed = false;
  try { json = JSON.parse(body); parsed = true; } catch { /* SSE or plain text. */ }
  if (parsed) {
    const safe = redactRequestValue(sanitize(json), credentials);
    return { text: JSON.stringify(safe, null, 2), format: "json", redacted: JSON.stringify(safe) !== JSON.stringify(json), terminal: true, failed: failed(json) };
  }
  if (/^data:/m.test(body)) {
    const values: unknown[] = [];
    let pending = "";
    let end = 0;
    for (const match of body.matchAll(/^data:[^\r\n]*/gm)) {
      if (pending && /\r?\n\r?\n/.test(body.slice(end, match.index))) throw new Error("Incomplete response event");
      pending += (pending ? "\n" : "") + match[0].slice(5).replace(/^ /, "");
      end = match.index + match[0].length;
      let value: unknown = pending;
      if (/^\s*[\[{]/.test(pending) && pending !== "[DONE]") {
        try { value = JSON.parse(pending); } catch { continue; }
      }
      values.push(value);
      pending = "";
    }
    // Malformed/truncated JSON is omitted rather than exposing unparseable
    // credential fields. The transport still delivers the original intact.
    if (pending) throw new Error("Incomplete response event");
    const final = finalizeProviderResponse(values);
    // Collect secrets from all events, including discarded metadata, then
    // redact the assembled body to catch credentials split across deltas.
    const safe = redactRequestValue(sanitize(final.body), collectRequestCredentials(values, credentials));
    return {
      text: JSON.stringify(safe, null, 2), format: "json", redacted: JSON.stringify(safe) !== JSON.stringify(final.body),
      terminal: final.terminal, failed: final.failed, partial: !final.terminal,
    };
  }
  if (/^\s*[\[{]/.test(body)) throw new Error("Incomplete response JSON");
  const text = redactRequestValue(sanitize(body), credentials) as string;
  return { text, format: "text", redacted: text !== body, terminal: false, failed: false };
}
