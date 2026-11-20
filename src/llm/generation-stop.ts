import type { GenerationStopDetails } from "./types";

/** A completed transport can still contain a truncated or blocked generation. */
export function describeGenerationStop(
  reason: string | undefined,
  details?: GenerationStopDetails | null,
): string | undefined {
  const code = details?.type === "refusal" && (!reason || ["stop", "completed"].includes(reason.toLowerCase()))
    ? "refusal" : reason?.toLowerCase();
  const explanation = details?.explanation ? ` ${details.explanation}` : "";
  if (details?.type === "blocked_prompt") {
    return `The provider blocked the prompt (${details.category || reason}).${explanation}`;
  }
  switch (code) {
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "The response reached its output token limit before finishing. Reasoning can also count toward this limit. Increase the response token limit or lower reasoning effort." + explanation;
    case "refusal":
      return `The provider declined the response${details?.category ? ` (${details.category})` : ""}.${explanation || " No explanation was provided."}`;
    case "content_filter":
    case "safety":
    case "blocklist":
    case "prohibited_content":
    case "spii":
    case "image_safety":
    case "image_prohibited_content":
    case "escalation":
      return `The provider stopped the response because of a content filter (${reason}).${explanation}`;
    case "recitation":
    case "image_recitation":
      return `The provider stopped the response because it may reproduce protected material (${reason}).${explanation}`;
    case "language":
      return `The provider stopped the response because of an unsupported language.${explanation}`;
    case "malformed_function_call":
    case "unexpected_tool_call":
    case "too_many_tool_calls":
    case "missing_thought_signature":
      return `The provider could not complete the tool call (${reason}).${explanation}`;
    case "error":
    case "failed":
    case "incomplete":
    case "cancelled":
    case "other":
    case "image_other":
    case "no_image":
    case "malformed_response":
    case "finish_reason_unspecified":
      return `The provider did not complete the response (${reason}).${explanation}`;
  }
  // Gemini and Responses explicitly mark unsuccessful outcomes even when a
  // newer provider introduces a reason this version does not yet recognize.
  if (details && ["failed", "incomplete"].includes(details.type)) {
    return `The provider did not complete the response (${reason || details.type}).${explanation}`;
  }
  return undefined;
}
