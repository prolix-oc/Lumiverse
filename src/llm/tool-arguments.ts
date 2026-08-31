import { ProviderProtocolError } from "./stream-utils";

/**
 * Retained as a source-compatible export for callers that imported the old
 * sentinel. Provider parsers no longer return it: malformed or missing
 * provider-controlled arguments fail closed with ProviderProtocolError before
 * any tool executor can observe them.
 */
export const INVALID_TOOL_ARGUMENTS = Object.freeze(["invalid_tool_arguments"] as const);

/**
 * Parse provider function arguments without allowing malformed JSON to become
 * an executable empty argument object. Provider tool arguments must be a JSON
 * object; missing, malformed, null, array, and primitive values are protocol
 * failures.
 */
export function parseModelToolArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    throw new ProviderProtocolError("Provider tool arguments are missing or invalid");
  }

  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new ProviderProtocolError("Provider tool arguments are not valid JSON", { cause: error });
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderProtocolError("Provider tool arguments must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}
