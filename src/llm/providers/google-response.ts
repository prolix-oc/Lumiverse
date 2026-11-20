import type { GenerationResponse, StreamChunk, ToolCallResult } from "../types";
import { describeGenerationStop } from "../generation-stop";
import { incompleteStream, readProviderSse, throwIfProviderError } from "../provider-sse";

function parseGoogleChunk(data: any, replaySignatures: boolean): StreamChunk {
  const candidate = data.candidates?.[0];
  let text = "";
  let reasoning = "";
  let signature: string | undefined;
  const calls: ToolCallResult[] = [];
  for (const part of candidate?.content?.parts || []) {
    if (part.thought) reasoning += part.text || "";
    else if (part.functionCall) calls.push({
      name: part.functionCall.name, args: part.functionCall.args ?? {},
      call_id: crypto.randomUUID(), thought_signature: part.thoughtSignature,
    });
    else text += part.text || "";
    if (replaySignatures && !part.functionCall && typeof part.thoughtSignature === "string") {
      signature = part.thoughtSignature;
    }
  }
  const blockReason = data.promptFeedback?.blockReason;
  const blocked = blockReason && blockReason !== "BLOCK_REASON_UNSPECIFIED";
  const reason = blocked ? blockReason : candidate?.finishReason;
  const ratings = blocked ? data.promptFeedback?.safetyRatings : candidate?.safetyRatings;
  const categories = ratings?.filter((r: any) => r.blocked).map((r: any) => r.category).join(", ");
  const details = blocked || (reason && reason !== "STOP") || candidate?.finishMessage
    ? {
        type: blocked ? "blocked_prompt" : reason === "STOP" ? "finish_reason" : "incomplete",
        category: categories || reason,
        explanation: (blocked ? data.promptFeedback?.blockReasonMessage : candidate?.finishMessage) || null,
      }
    : undefined;
  const grounding = candidate?.groundingMetadata ?? data.groundingMetadata;
  const usage = data.usageMetadata;
  return {
    token: text,
    ...(reasoning ? { reasoning } : {}),
    ...(calls.length ? { tool_calls: calls } : {}),
    ...(signature ? { thought_signature: signature } : {}),
    ...(reason ? { finish_reason: reason === "STOP" ? "stop" : reason } : {}),
    ...(details ? { stop_details: details } : {}),
    ...(usage ? { usage: {
      prompt_tokens: usage.promptTokenCount || 0,
      completion_tokens: usage.candidatesTokenCount || 0,
      total_tokens: usage.totalTokenCount || 0,
      ...(grounding ? { provider_raw: { groundingMetadata: grounding } } : {}),
    } } : {}),
  };
}

export function parseGoogleResponse(data: any, provider: string, replaySignatures: boolean): GenerationResponse {
  throwIfProviderError(data, provider, "generate");
  const { token, ...chunk } = parseGoogleChunk(data, replaySignatures);
  if (!chunk.finish_reason) throw incompleteStream(provider);
  const failed = describeGenerationStop(chunk.finish_reason, chunk.stop_details);
  return {
    ...chunk, content: token,
    finish_reason: !failed && chunk.tool_calls ? "tool_calls" : chunk.finish_reason,
    ...(failed ? { tool_calls: undefined } : {}),
  };
}

/** Gemini and Vertex share the same response protocol. Keep the terminal
 * outcome until EOF so early STOP envelopes cannot hide later output/errors. */
export async function* readGoogleStream(
  res: Response, provider: string, replaySignatures: boolean, signal?: AbortSignal,
  onResponseActivity?: () => void,
): AsyncGenerator<StreamChunk> {
  let reason: string | undefined;
  let stopReceivedAt: number | undefined;
  let details: StreamChunk["stop_details"];
  let usage: StreamChunk["usage"];
  const toolCalls: ToolCallResult[] = [];
  for await (const data of readProviderSse(res, provider, signal)) {
    throwIfProviderError(data, provider, "stream");
    const chunk = parseGoogleChunk(data, replaySignatures);
    // A later success/usage envelope must never overwrite a recorded failure.
    if (chunk.finish_reason && !describeGenerationStop(reason, details)) {
      reason = chunk.finish_reason;
      stopReceivedAt = Date.now();
      details = chunk.stop_details;
    } else if (chunk.finish_reason === reason && chunk.stop_details) {
      details = {
        ...chunk.stop_details,
        explanation: chunk.stop_details.explanation || details?.explanation || null,
      };
    }
    if (chunk.tool_calls) { onResponseActivity?.(); toolCalls.push(...chunk.tool_calls); }
    if (chunk.usage) usage = chunk.usage;
    delete chunk.finish_reason;
    delete chunk.stop_details;
    delete chunk.tool_calls;
    if (chunk.token || chunk.reasoning || chunk.thought_signature || chunk.usage) yield chunk;
  }
  if (signal?.aborted) return;
  if (!reason) throw incompleteStream(provider);
  const calls = toolCalls.length && !describeGenerationStop(reason, details) ? toolCalls : undefined;
  yield {
    token: "", finish_reason: calls ? "tool_calls" : reason, stopReceivedAt,
    ...(calls ? { tool_calls: calls } : {}),
    ...(details ? { stop_details: details } : {}), usage,
  };
}
