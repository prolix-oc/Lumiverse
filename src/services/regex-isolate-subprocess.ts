import { runIsolateProcessEntrypoint } from "./isolate-process-entrypoint";
import { runRegexRequest, type RegexRequest } from "../utils/regex-sandbox-core";

const REGEX_OPERATIONS = ["replace", "test", "collect", "capture-replacements"] as const;

type RegexPayload = Omit<RegexRequest, "id">;

function executeRegex(payload: unknown, requestId: string, operation: string): unknown {
  if (
    !payload
    || typeof payload !== "object"
    || Array.isArray(payload)
    || !("op" in payload)
    || payload.op !== operation
  ) {
    throw Object.assign(new TypeError("Regex isolate request is invalid"), { code: "invalid_input" });
  }
  return runRegexRequest({
    ...(payload as RegexPayload),
    id: requestId,
  } as RegexRequest);
}

const handlers = Object.fromEntries(
  REGEX_OPERATIONS.map((operation) => [
    operation,
    (payload: unknown, requestId: string) => executeRegex(payload, requestId, operation),
  ]),
);

await runIsolateProcessEntrypoint({ handlers });
