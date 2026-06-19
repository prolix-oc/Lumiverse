import { rawGenerate } from "../generate.service";
import { getConnection, getDefaultConnection } from "../connections.service";
import { getWeaverTuning } from "./tuning";

export interface WeaverConnectionPrefs {
  connection_id?: string | null;
  model?: string | null;
}

export function resolveWeaverConnection(userId: string, session: WeaverConnectionPrefs) {
  const conn =
    (session.connection_id ? getConnection(userId, session.connection_id) : null) ??
    getDefaultConnection(userId);
  if (!conn) throw new Error("Weaver session has no connection configured");
  const model = session.model?.trim() || conn.model;
  if (!model) throw new Error("Weaver session has no model configured");
  return { conn, model };
}

export function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1] : s;
}

export interface WeaverGenerateInput {
  userId: string;
  session: WeaverConnectionPrefs;
  system: string;
  user: string;
  temperature?: number;
  kind?: "generate" | "review";
  signal?: AbortSignal;
}

function resolveTemperature(input: WeaverGenerateInput, fallback: number): number {
  const tuning = getWeaverTuning(input.userId);
  const override =
    input.kind === "review" ? tuning.review_temperature : tuning.generation_temperature;
  return override ?? input.temperature ?? fallback;
}

export interface WeaverUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface WeaverGenerateResult {
  data: Record<string, unknown>;
  usage: WeaverUsage;
}

function normalizeUsage(usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined): WeaverUsage {
  const prompt = Math.max(0, Math.round(usage?.prompt_tokens ?? 0));
  const completion = Math.max(0, Math.round(usage?.completion_tokens ?? 0));
  const total = Math.max(0, Math.round(usage?.total_tokens ?? prompt + completion));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

export async function weaverGenerateJsonWithUsage(
  input: WeaverGenerateInput,
): Promise<WeaverGenerateResult> {
  const { conn, model } = resolveWeaverConnection(input.userId, input.session);
  const response = await rawGenerate(input.userId, {
    provider: conn.provider,
    model,
    connection_id: conn.id,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    parameters: { temperature: resolveTemperature(input, 0.4) },
    signal: input.signal,
  });

  const content = stripCodeFence((response.content ?? "").trim());
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Weaver model returned invalid JSON");
  }
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  return { data, usage: normalizeUsage(response.usage) };
}

export async function weaverGenerateJson(input: WeaverGenerateInput): Promise<Record<string, unknown>> {
  return (await weaverGenerateJsonWithUsage(input)).data;
}

export interface WeaverTextResult {
  text: string;
  usage: WeaverUsage;
}

export async function weaverGenerateTextWithUsage(
  input: WeaverGenerateInput,
): Promise<WeaverTextResult> {
  const { conn, model } = resolveWeaverConnection(input.userId, input.session);
  const response = await rawGenerate(input.userId, {
    provider: conn.provider,
    model,
    connection_id: conn.id,
    messages: [
      { role: "system", content: input.system },
      { role: "user", content: input.user },
    ],
    parameters: { temperature: resolveTemperature(input, 0.7) },
    signal: input.signal,
  });

  const text = stripCodeFence((response.content ?? "").trim()).trim();
  return { text, usage: normalizeUsage(response.usage) };
}
