type JsonObject = Record<string, any>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
const indexOf = (value: unknown, fallback = 0): number => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : fallback;
const ordered = (values: Map<number, JsonObject>): JsonObject[] => [...values].sort(([a], [b]) => a - b).map(([, value]) => value);
const terminalResponse = (type: unknown) => ["response.completed", "response.done", "response.incomplete", "response.failed"].includes(type as string);

/** Merge provider deltas, preserving scalar metadata and joining only fields
 * that actually stream. Indexed tool/reasoning arrays represent single items. */
function mergeDelta(current: JsonObject, delta: JsonObject, depth = 0, parent = ""): JsonObject {
  if (depth > 100) throw new Error("Response nesting limit exceeded");
  const result = { ...current };
  for (const [key, value] of Object.entries(delta)) {
    const previous = Object.hasOwn(current, key) ? current[key] : undefined;
    let merged = value;
    if (typeof value === "string" && (["content", "text", "reasoning", "reasoning_content", "refusal", "arguments", "thinking", "signature", "data", "transcript", "summary"].includes(key) || (key === "name" && parent === "function"))) {
      merged = (typeof previous === "string" ? previous : "") + value;
    } else if (Array.isArray(value)) {
      const entries = Array.isArray(previous) ? [...previous] : [];
      if (["tool_calls", "reasoning_details"].includes(key)) {
        for (const [position, item] of value.entries()) {
          if (key === "reasoning_details" && !Number.isSafeInteger(item.index)) {
            entries.push(structuredClone(item));
            continue;
          }
          const index = indexOf(item.index, position);
          const existing = entries.findIndex((entry) => entry.index === index);
          const next = mergeDelta(existing < 0 ? {} : entries[existing], { ...item, index }, depth + 1, key);
          if (existing < 0) entries.push(next);
          else entries[existing] = next;
        }
        if (entries.every((entry) => Number.isSafeInteger(entry.index))) entries.sort((a, b) => a.index - b.index);
      } else entries.push(...value);
      merged = entries;
    } else if (object(value)) {
      merged = mergeDelta(object(previous) ? previous : {}, value, depth + 1, key);
    } else if (value === null && previous !== undefined) {
      merged = previous;
    }
    // Avoid invoking prototype setters on untrusted provider property names.
    Object.defineProperty(result, key, { value: merged, writable: true, enumerable: true, configurable: true });
  }
  return result;
}

function chatCompletion(events: JsonObject[]): JsonObject {
  let body: JsonObject = {};
  const choices = new Map<number, JsonObject>();
  for (const event of events) {
    const { choices: deltas, ...metadata } = event;
    body = { ...body, ...metadata };
    for (const [position, choice] of (deltas ?? []).entries()) {
      const index = indexOf(choice.index, position);
      const previous = choices.get(index) ?? { index, message: {} };
      const { delta, message, logprobs, ...fields } = choice;
      const next = { ...previous, ...fields, index, message: object(message) ? structuredClone(message) : mergeDelta(previous.message, delta ?? {}) };
      if (fields.finish_reason == null && previous.finish_reason) next.finish_reason = previous.finish_reason;
      if (logprobs) next.logprobs = mergeDelta(previous.logprobs ?? {}, logprobs);
      choices.set(index, next);
    }
  }
  if (body.object === "chat.completion.chunk") body.object = "chat.completion";
  for (const choice of choices.values()) {
    if (choice.message.tool_calls) choice.message.tool_calls = choice.message.tool_calls.map(({ index: _index, ...call }: JsonObject) => call);
  }
  return { ...body, choices: ordered(choices) };
}

function anthropicMessage(events: JsonObject[]): JsonObject {
  let body: JsonObject = {};
  const blocks = new Map<number, JsonObject>();
  const inputs = new Map<number, string>();
  for (const event of events) {
    const index = indexOf(event.index);
    if (event.type === "message_start") {
      body = { ...event.message };
      for (const [i, block] of (body.content ?? []).entries()) blocks.set(i, { ...block });
    } else if (event.type === "content_block_start") {
      blocks.set(index, { ...event.content_block });
    } else if (event.type === "content_block_delta") {
      const { type, partial_json, citation, ...delta } = event.delta ?? {};
      if (type === "input_json_delta") inputs.set(index, (inputs.get(index) ?? "") + (partial_json ?? ""));
      else if (type === "citations_delta") blocks.set(index, mergeDelta(blocks.get(index) ?? {}, { citations: [citation] }));
      else blocks.set(index, mergeDelta(blocks.get(index) ?? {}, delta));
    } else if (event.type === "message_delta") {
      body = { ...body, ...event.delta, ...(event.usage ? { usage: { ...body.usage, ...event.usage } } : {}) };
    }
  }
  for (const [index, input] of inputs) {
    // Interrupted tool arguments are kept as text; they are never executable.
    let parsed: unknown = input;
    try { parsed = JSON.parse(input); } catch { /* Incomplete response. */ }
    blocks.set(index, { ...blocks.get(index), input: parsed });
  }
  return { ...body, content: ordered(blocks) };
}

function responsesBody(events: JsonObject[]): JsonObject {
  const final = events.findLast((event) => terminalResponse(event.type) && object(event.response));
  // The provider's final snapshot is authoritative and already contains all
  // deltas. Adding accumulated text to it would duplicate the response.
  if (Array.isArray(final?.response.output)) return final!.response;
  let body: JsonObject = {};
  const output = new Map<number, JsonObject>();
  const itemIndexes = new Map<string, number>();
  const contentMaps = new Map<number, Map<string, Map<number, JsonObject>>>();
  for (const event of events) {
    if (object(event.response)) {
      body = { ...body, ...event.response };
      for (const [i, item] of (event.response.output ?? []).entries()) {
        output.set(i, structuredClone(item));
        contentMaps.delete(i);
      }
    }
    const index = indexOf(event.output_index, itemIndexes.get(event.item_id) ?? 0);
    const type = event.type;
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const itemIndex = indexOf(event.output_index, itemIndexes.get(event.item?.id) ?? output.size);
      output.set(itemIndex, structuredClone(event.item));
      contentMaps.delete(itemIndex);
      if (event.item?.id) itemIndexes.set(event.item.id, itemIndex);
    } else if (type === "response.function_call_arguments.delta" || type === "response.function_call_arguments.done") {
      const item = output.get(index) ?? { type: "function_call", id: event.item_id };
      output.set(index, { ...item, arguments: type.endsWith(".done") ? event.arguments : (item.arguments ?? "") + (event.delta ?? "") });
    } else if (/^response\.(output_text|refusal|reasoning_summary_text|content_part|reasoning_summary_part)\./.test(type)) {
      const reasoning = type.startsWith("response.reasoning_");
      const item = output.get(index) ?? (reasoning ? { type: "reasoning" } : { type: "message", role: "assistant" });
      const field = reasoning ? "summary" : "content";
      const partIndex = indexOf(reasoning ? event.summary_index : event.content_index);
      // Maps avoid allocating sparse arrays from provider-controlled indices.
      const fields = contentMaps.get(index) ?? new Map<string, Map<number, JsonObject>>();
      const parts = fields.get(field) ?? new Map<number, JsonObject>((item[field] ?? []).map((part: JsonObject, i: number) => [i, part]));
      fields.set(field, parts);
      contentMaps.set(index, fields);
      if (type.includes("_part.")) parts.set(partIndex, structuredClone(event.part));
      else {
        const refusal = type.startsWith("response.refusal.");
        const textField = refusal ? "refusal" : "text";
        const part = parts.get(partIndex) ?? { type: reasoning ? "summary_text" : refusal ? "refusal" : "output_text" };
        parts.set(partIndex, { ...part, [textField]: type.endsWith(".done") ? event[textField] : (part[textField] ?? "") + (event.delta ?? "") });
      }
      output.set(index, { ...item, [field]: ordered(parts) });
    }
  }
  return { ...body, ...(output.size ? { output: ordered(output) } : {}) };
}

function googleResponse(events: JsonObject[]): JsonObject {
  let body: JsonObject = {};
  const candidates = new Map<number, JsonObject>();
  for (const event of events) {
    const { candidates: updates, ...metadata } = event;
    body = { ...body, ...metadata };
    for (const [position, candidate] of (updates ?? []).entries()) {
      const index = indexOf(candidate.index, position);
      const previous = candidates.get(index) ?? {};
      const next = { ...previous, ...candidate };
      if (candidate.content) {
        const parts: JsonObject[] = [...(previous.content?.parts ?? [])];
        for (const part of candidate.content.parts ?? []) {
          const last = parts.at(-1);
          // Keep reasoning and tool/multimodal parts distinct. A signature
          // belongs to its part and must not be moved onto another tool call.
          if (typeof part.text === "string" && typeof last?.text === "string"
            && !!part.thought === !!last.thought && !last.thoughtSignature) {
            parts[parts.length - 1] = { ...last, ...part, text: last.text + part.text };
          } else if (last && part.thoughtSignature && Object.keys(part).length === 1) {
            parts[parts.length - 1] = { ...last, thoughtSignature: part.thoughtSignature };
          } else parts.push(structuredClone(part));
        }
        next.content = { ...previous.content, ...candidate.content, parts };
      }
      // Usage-only success envelopes must not erase an earlier failure.
      if (previous.finishReason && previous.finishReason !== "STOP" && candidate.finishReason === "STOP") next.finishReason = previous.finishReason;
      candidates.set(index, next);
    }
  }
  return { ...body, ...(candidates.size ? { candidates: ordered(candidates) } : {}) };
}

/** Produce one provider-shaped response from a stream, never an event log. */
export function finalizeProviderResponse(values: unknown[]): { body: unknown; terminal: boolean; failed: boolean } {
  const events = values.filter(object);
  const finalResponse = events.findLast((event) => terminalResponse(event.type));
  const error = events.findLast((event) => !!event.error || event.type === "error" || event.type === "response.failed");
  const terminal = values.includes("[DONE]") || events.some((event) => event.type === "message_stop" || terminalResponse(event.type)
    || event.choices?.some((choice: JsonObject) => !!choice.finish_reason)
    || event.candidates?.some((candidate: JsonObject) => !!candidate.finishReason) || !!event.promptFeedback?.blockReason) || !!error;
  if (error && !terminalResponse(error.type)) return { body: error, terminal: true, failed: true };
  let body: unknown;
  if (events.some((event) => typeof event.type === "string" && event.type.startsWith("response."))) body = responsesBody(events);
  else if (events.some((event) => event.type === "message_start" || event.type === "content_block_start")) body = anthropicMessage(events);
  else if (events.some((event) => Array.isArray(event.choices))) body = chatCompletion(events);
  else if (events.some((event) => Array.isArray(event.candidates) || event.usageMetadata || event.promptFeedback)) body = googleResponse(events);
  else {
    // Registered sidecars may send a complete JSON payload in a final event.
    // Unknown delta protocols cannot be presented as a finalized response.
    const last = events.at(-1);
    if (!last || Object.hasOwn(last, "delta") || last.type === "ping") throw new Error("No finalized provider response");
    body = last;
  }
  return { body, terminal, failed: !!error || finalResponse?.type === "response.failed" || (object(body) && !!body.error) };
}
