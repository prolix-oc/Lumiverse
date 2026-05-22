import { getTextContent, type LlmMessage } from "../../../llm/types";
import { rawGenerate, type RawGenerateInput } from "../../generate.service";
import * as connectionsSvc from "../../connections.service";
import * as personasSvc from "../../personas.service";
import * as tokenizerSvc from "../../tokenizer.service";
import { getDWGenParams, applyDWGenParams } from "../dw-gen-params";
import { getFragment } from "../prompts/index";
import type { AnyDreamWeaverTool } from "./types";
import type { DreamWeaverSession, DreamWeaverWorkspace } from "../../../types/dream-weaver";
import type { Persona } from "../../../types/persona";

export interface AssemblePromptInput {
  tool: AnyDreamWeaverTool;
  session: DreamWeaverSession;
  draft: DreamWeaverWorkspace;
  args: Record<string, unknown>;
  nudgeText: string | null;
}

export function assemblePrompt(input: AssemblePromptInput): string {
  const { tool, session, draft, nudgeText } = input;

  const persona = loadPersona(session);

  const parts: string[] = [];
  parts.push(getFragment("base-system"));
  parts.push(getWorkspaceFrame(draft, persona));
  parts.push(tool.prompt);
  for (const id of tool.requiresFragments) parts.push(getFragment(id));

  if (draft.sources.length > 0) {
    parts.push(`## Accepted Sources\n${formatSources(draft.sources)}`);
  } else if (session.dream_text.trim()) {
    parts.push(`## Accepted Sources\nDream:\n${session.dream_text}`);
  }
  if (session.tone) parts.push(`## Tone\n${session.tone}`);
  if (session.constraints) parts.push(`## Constraints\n${session.constraints}`);
  if (session.dislikes) parts.push(`## Avoid\n${session.dislikes}`);

  const personaBlock = formatPersonaBlock(persona);
  if (personaBlock) parts.push(personaBlock);

  const slice = tool.contextSlice(draft);
  if (Object.keys(slice).length > 0) {
    parts.push(`## Current Draft (relevant slice)\n${JSON.stringify(slice, null, 2)}`);
  }

  if (nudgeText && nudgeText.trim().length > 0) {
    parts.push(`## Refinement guidance\n${nudgeText.trim()}`);
  }

  return parts.join("\n\n");
}

function loadPersona(session: DreamWeaverSession): Persona | null {
  if (!session.persona_id) return null;
  try {
    return personasSvc.getPersona(session.user_id, session.persona_id);
  } catch {
    return null;
  }
}

function formatPersonaBlock(persona: Persona | null): string {
  if (!persona) return "";
  const lines: string[] = [`Name: ${persona.name}`];
  if (persona.title?.trim()) lines.push(`Title: ${persona.title.trim()}`);
  const pronouns = [persona.subjective_pronoun, persona.objective_pronoun, persona.possessive_pronoun]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join("/");
  if (pronouns) lines.push(`Pronouns: ${pronouns}`);
  if (persona.description?.trim()) lines.push("", persona.description.trim());
  return `## User Persona ({{user}})\n${lines.join("\n")}`;
}

export interface ExecuteToolInput {
  userId: string;
  tool: AnyDreamWeaverTool;
  session: DreamWeaverSession;
  draft: DreamWeaverWorkspace;
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

function getWorkspaceFrame(workspace: DreamWeaverWorkspace, persona: Persona | null): string {
  if (workspace.kind === "scenario") {
    const personaHook = persona
      ? `The card's main character should pair with {{user}} (see "User Persona" below) — they are the protagonist NPC who interacts with ${persona.name} directly, not a copy of them.`
      : `The card's main character should pair with {{user}} — they are the protagonist NPC who interacts with {{user}} directly, not a copy of them.`;
    return [
      "## Workspace Kind: Scenario Card",
      "Build a SCENARIO card: a populated world with a main character, supporting NPCs, and lorebook entries.",
      personaHook,
      "Field interpretation for this kind:",
      "- name: the scenario title.",
      "- appearance / personality / voice: describe the MAIN CHARACTER (the protagonist NPC paired with {{user}}), not {{user}}.",
      "- scenario: the premise — current situation, tension, and how the main character relates to {{user}}.",
      "- first_mes: the opening scene that introduces the world, establishes the main character, and hands action to {{user}}.",
      "- NPCs: the supporting cast around the main character (allies, rivals, authority figures, minor recurring faces). Never duplicate the main character here.",
      "- Lorebook entries: world-level knowledge (places, factions, rules, history, organizations, customs, signature objects) that activates when referenced.",
      "Treat the world as inhabited and specific. Do not write a generic narrator-only card.",
    ].join("\n");
  }
  return [
    "## Workspace Kind: Character Card",
    "Build a single-character card. Interpret name, appearance, personality, scenario, voice, and first message as fields describing ONE protagonist character who interacts with {{user}}.",
    persona
      ? `The character should make sense paired with {{user}} (see "User Persona" below), but is a distinct individual — not a copy of ${persona.name}.`
      : "",
  ].filter(Boolean).join("\n");
}

function formatSources(sources: DreamWeaverWorkspace["sources"]): string {
  return sources
    .map((source, index) => {
      const meta = [
        source.tone ? `Tone: ${source.tone}` : "",
        source.constraints ? `Constraints: ${source.constraints}` : "",
        source.dislikes ? `Avoid: ${source.dislikes}` : "",
      ].filter(Boolean);
      return [
        `Source ${index + 1}: ${source.title} (${source.type})`,
        source.content,
        meta.length ? meta.join("\n") : "",
      ].filter(Boolean).join("\n");
    })
    .join("\n\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
