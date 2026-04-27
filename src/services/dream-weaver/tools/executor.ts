import { getTextContent, type LlmMessage } from "../../../llm/types";
import { rawGenerate, type RawGenerateInput } from "../../generate.service";
import * as connectionsSvc from "../../connections.service";
import * as tokenizerSvc from "../../tokenizer.service";
import { getDWGenParams, applyDWGenParams } from "../dw-gen-params";
import { getFragment } from "../prompts/index";
import type { AnyDreamWeaverTool } from "./types";
import type { DraftV2, DreamWeaverSession } from "../../../types/dream-weaver";

export interface AssemblePromptInput {
  tool: AnyDreamWeaverTool;
  session: DreamWeaverSession;
  draft: DraftV2;
  args: Record<string, unknown>;
  nudgeText: string | null;
}

export function assemblePrompt(input: AssemblePromptInput): string {
  const { tool, session, draft, nudgeText } = input;

  const parts: string[] = [];
  parts.push(getFragment("base-system"));
  parts.push(tool.prompt);
  for (const id of tool.requiresFragments) parts.push(getFragment(id));

  parts.push(`## Dream\n${session.dream_text}`);
  if (session.tone) parts.push(`## Tone\n${session.tone}`);
  if (session.dislikes) parts.push(`## Avoid\n${session.dislikes}`);

  const slice = tool.contextSlice(draft);
  if (Object.keys(slice).length > 0) {
    parts.push(`## Current Draft (relevant slice)\n${JSON.stringify(slice, null, 2)}`);
  }

  if (nudgeText && nudgeText.trim().length > 0) {
    parts.push(`## Refinement guidance\n${nudgeText.trim()}`);
  }

  return parts.join("\n\n");
}

export interface ExecuteToolInput {
  userId: string;
  tool: AnyDreamWeaverTool;
  session: DreamWeaverSession;
  draft: DraftV2;
  args: Record<string, unknown>;
  nudgeText: string | null;
  signal?: AbortSignal;
}

export interface ExecuteToolResult {
  output: unknown;
  durationMs: number;
  tokenUsage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    tokenizer_name: string;
    model: string;
  };
}

export async function executeTool(input: ExecuteToolInput): Promise<ExecuteToolResult> {
  const start = Date.now();
  const systemPrompt = assemblePrompt(input);

  const conn = input.session.connection_id
    ? connectionsSvc.getConnection(input.userId, input.session.connection_id)
    : null;
  if (!conn) throw new Error("Session has no connection configured");
  const model = input.session.model?.trim() || conn.model;
  if (!model) throw new Error("Session has no model configured");

  const params = getDWGenParams(input.userId);
  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: "Run the tool described above against the dream and current draft. Return only the JSON output specified by the tool." },
  ];
  const counter = await tokenizerSvc.resolveCounter(model);
  const inputTokens = counter.count(tokenizerSvc.flattenMessagesForTokenCount(
    messages.map((msg) => ({ role: msg.role, content: getTextContent(msg) })),
  ));

  const base: Record<string, unknown> = {
    provider: conn.provider,
    model,
    messages,
    connection_id: input.session.connection_id!,
    parameters: { temperature: 0.85 },
    signal: input.signal,
  };

  const generateInput = applyDWGenParams(base, params) as unknown as RawGenerateInput & { signal?: AbortSignal };

  const response = await rawGenerate(input.userId, generateInput);

  const content = response.content?.trim() ?? "";
  const outputTokens = counter.count(content);
  const stripped = stripCodeFence(content);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`Tool ${input.tool.name} returned invalid JSON: ${truncate(stripped, 200)}`);
  }

  const result = input.tool.validate(parsed);
  if (!result.ok) {
    throw new Error(`Tool ${input.tool.name} output failed validation: ${result.error}`);
  }

  return {
    output: result.data,
    durationMs: Date.now() - start,
    tokenUsage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      tokenizer_name: counter.name,
      model,
    },
  };
}

function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
