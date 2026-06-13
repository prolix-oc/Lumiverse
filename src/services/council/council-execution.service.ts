import type {
  CouncilSettings,
  CouncilMember,
  CouncilToolResult,
  CouncilExecutionResult,
} from "lumiverse-spindle-types";
import type { LlmMessage } from "../../llm/types";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";
import { rawGenerate } from "../generate.service";
import * as chatsSvc from "../chats.service";
import * as charactersSvc from "../characters.service";
import * as personasSvc from "../personas.service";
import * as packsSvc from "../packs.service";
import * as connectionsSvc from "../connections.service";
import * as worldBooksSvc from "../world-books.service";
import * as settingsSvc from "../settings.service";
import { activateWorldInfo } from "../world-info-activation.service";
import { getCharacterWorldBookIds } from "../../utils/character-world-books";
import { getCouncilSettings, getAvailableTools } from "./council-settings.service";
import { parseMcpToolName } from "./mcp-tools";
import { getMcpClientManager } from "../mcp-client-manager";
import {
  buildCouncilMemberContext,
  getCouncilToolArgsSchema,
  getCouncilToolExecution,
  getExtensionToolRegistration,
  invokeExtensionCouncilTool,
  type RuntimeCouncilToolDefinition,
} from "./tool-runtime";
import { executeHostCouncilTool } from "./host-tools";
import { getExpressionLabels, hasExpressions } from "../expressions.service";
import { getSidecarSettings } from "../sidecar-settings.service";
import type { SidecarSettings } from "../sidecar-settings.service";
import { getToolChoiceParams } from "../memory-cortex/salience-sidecar";
import type { SidecarConfig } from "lumiverse-spindle-types";

const MAX_RETRIES = 3;
/** Pre-computed enrichment context from the generation chain. When provided,
 *  council tools use this data instead of independently loading and activating
 *  character/persona/world info. This ensures world info resolution happens at
 *  the top of the generation pipeline, giving council tools the same context. */
export interface CouncilEnrichment {
  character: import("../../types/character").Character | null;
  persona: import("../../types/persona").Persona | null;
  /** Chat messages with staged/excluded messages already filtered out. */
  messages: import("../../types/message").Message[];
  /** World info entries activated via keyword matching at the top of the generation chain. */
  activatedWorldInfoEntries: import("../../types/world-book").WorldBookEntry[];
}

const GOOGLE_PLANNING_PROVIDERS = new Set(["google", "google_vertex"]);

interface ExecuteInput {
  userId: string;
  chatId: string;
  personaId?: string;
  connectionId?: string;
  /** Pre-resolved settings — avoids re-fetching and ensures consistency with caller. */
  settings?: CouncilSettings;
  sidecarSettings?: SidecarSettings;
  /** Abort signal — when fired, stops executing further council tools. */
  signal?: AbortSignal;
  /** Pre-computed enrichment from the generation chain. When provided, council tools
   *  use this data instead of independently loading character/persona/WI. */
  enrichment?: CouncilEnrichment;
  /** When set, only re-execute these specific tool names (retry mode).
   *  Members are filtered to only include those with matching failed tools.
   *  Dice rolls are skipped — all matching members participate. */
  retryToolNames?: string[];
}

export interface CouncilHistoricalDeliberationEntry {
  id: string;
  createdAt: number;
  memberId: string;
  memberName: string;
  toolName: string;
  toolDisplayName: string;
  content: string;
}

export type CouncilExecutionResultWithHistory = CouncilExecutionResult & {
  historicalDeliberationBlock?: string;
};

const COUNCIL_HISTORY_METADATA_KEY = "council_deliberation_history_v1";
const MAX_HISTORY_RETENTION = 10;
const MAX_HISTORY_ENTRY_CHARS = 4000;
const MAX_HISTORY_TOTAL_ENTRIES = 200;

/**
 * Execute the full council cycle: roll dice per member, invoke sidecar LLM
 * for each tool, collect results, format deliberation block.
 */
export async function executeCouncil(
  input: ExecuteInput
): Promise<CouncilExecutionResultWithHistory | null> {
  const settings = input.settings ?? getCouncilSettings(input.userId);

  if (!settings.councilMode) {
    console.debug("[council] Skipped: councilMode is disabled");
    return null;
  }
  if (settings.members.length === 0) {
    console.debug("[council] Skipped: no members configured");
    return null;
  }

  // Tools are active if any member has tools assigned — no separate switch needed
  const hasTools = settings.members.some((m) => m.tools.length > 0);

  // Resolve sidecar connection from shared settings (falls back to legacy council config)
  const sidecar = input.sidecarSettings ?? getSidecarSettings(input.userId);
  if (hasTools && (!sidecar.connectionProfileId || !sidecar.model)) {
    console.warn("[council] Tools skipped: sidecar connection not configured (profileId=%s, model=%s)", sidecar.connectionProfileId, sidecar.model);
  }

  // Verify the sidecar connection exists (if tools need it)
  let sidecarConn = null;
  if (hasTools && sidecar.connectionProfileId) {
    sidecarConn = connectionsSvc.getConnection(input.userId, sidecar.connectionProfileId);
    if (!sidecarConn) {
      console.warn("[council] Tools skipped: sidecar connection profile '%s' not found", sidecar.connectionProfileId);
    }
  }

  const startTime = Date.now();
  const allResults: CouncilToolResult[] = [];
  const namedResults = new Map<string, string>();

  // Build available tools map
  const availableTools = new Map<string, RuntimeCouncilToolDefinition>();
  for (const t of await getAvailableTools(input.userId)) {
    availableTools.set(t.name, t);
  }

  // In retry mode, skip dice rolls and only include members with failed tools
  const retrySet = input.retryToolNames ? new Set(input.retryToolNames) : null;

  let activeMembers: CouncilMember[];
  if (retrySet) {
    // Retry mode: filter members to only those with matching failed tools,
    // and narrow their tool lists to just the failed ones
    activeMembers = settings.members
      .map((m) => ({
        ...m,
        tools: m.tools.filter((t) => retrySet.has(t)),
      }))
      .filter((m) => m.tools.length > 0);
    console.debug("[council] Retry mode: %d members with %d failed tools to re-execute",
      activeMembers.length, retrySet.size);
  } else {
    // Normal mode: roll dice for each member
    activeMembers = settings.members.filter((m) => {
      if (m.tools.length === 0) return false;
      if (m.chance >= 100) return true;
      if (m.chance <= 0) return false;
      return Math.random() * 100 < m.chance;
    });
  }

  if (activeMembers.length === 0) {
    console.debug("[council] Skipped: no members survived dice roll (total=%d)", settings.members.length);
    return null;
  }

  const historicalByAssignment = getHistoricalEntriesForMembers(
    input.userId,
    input.chatId,
    activeMembers,
  );

  eventBus.emit(EventType.COUNCIL_STARTED, {
    chatId: input.chatId,
    memberCount: activeMembers.length,
  }, input.userId);

  // Build shared context once
  const contextMessages = buildContextMessages(input, settings);

  // Execute members sequentially (abort-aware)
  for (const member of activeMembers) {
    if (input.signal?.aborted) {
      console.debug("[council] Aborted before member '%s'", member.itemName);
      break;
    }

    const memberResults = await executeMemberTools(
      input,
      settings,
      sidecar,
      member,
      availableTools,
      contextMessages,
      namedResults,
    );
    allResults.push(...memberResults);

    let memberAvatarUrl: string | null = null;
    try {
      const item = packsSvc.getLumiaItem(input.userId, member.itemId);
      memberAvatarUrl = item?.avatar_url || null;
    } catch {
      // Item may not exist — fall back to null
    }

    eventBus.emit(EventType.COUNCIL_MEMBER_DONE, {
      chatId: input.chatId,
      memberId: member.id,
      memberName: member.itemName,
      memberItemId: member.itemId,
      memberAvatarUrl,
      results: memberResults,
    }, input.userId);
  }

  const deliberationBlock = formatDeliberation(allResults, availableTools);
  const historicalDeliberationBlock = formatHistoricalDeliberations(
    historicalByAssignment,
  );
  const totalDurationMs = Date.now() - startTime;

  const result: CouncilExecutionResultWithHistory = {
    results: allResults,
    deliberationBlock,
    ...(historicalDeliberationBlock ? { historicalDeliberationBlock } : {}),
    totalDurationMs,
  };

  eventBus.emit(EventType.COUNCIL_COMPLETED, {
    chatId: input.chatId,
    totalDurationMs,
    resultCount: allResults.length,
  }, input.userId);

  return result;
}

/** Execute all assigned tools for a single council member. */
async function executeMemberTools(
  input: ExecuteInput,
  settings: CouncilSettings,
  sidecar: SidecarConfig,
  member: CouncilMember,
  tools: Map<string, RuntimeCouncilToolDefinition>,
  contextMessages: LlmMessage[],
  namedResults: Map<string, string>,
): Promise<CouncilToolResult[]> {
  const results: CouncilToolResult[] = [];

  // Resolve the backing Lumia item once — reused for identity prompt and the
  // CouncilMemberContext delivered to extension tool invocations.
  let lumiaItem: ReturnType<typeof packsSvc.getLumiaItem> = null;
  try {
    lumiaItem = packsSvc.getLumiaItem(input.userId, member.itemId);
  } catch {
    // Item may be missing (pack uninstalled mid-flight) — fall back to null.
  }

  const memberContext = buildCouncilMemberContext(member, lumiaItem);

  // Build member identity context
  const identityMsg = buildMemberIdentity(member, lumiaItem);

  for (const toolName of member.tools) {
    if (input.signal?.aborted) {
      console.debug("[council] Aborted before tool '%s' for member '%s'", toolName, member.itemName);
      break;
    }

    const toolDef = tools.get(toolName);
    if (!toolDef) continue;

    // Skip expression detector when the character has no expressions configured
    if (toolDef.name === "detect_expression") {
      const charId = input.enrichment?.character?.id;
      if (!charId || !hasExpressions(input.userId, charId)) continue;
    }

    const toolStart = Date.now();
    let success = false;
    let content = "";
    let error: string | undefined;

    const execution = getCouncilToolExecution(input.userId, toolDef);
    const extToolReg = execution === "extension" ? getExtensionToolRegistration(toolName) : undefined;
    const mcpMatch = execution === "mcp" ? parseMcpToolName(input.userId, toolName) : null;

    // Note: a member's retained history is intentionally NOT injected into its
    // own deliberation prompt. Showing the sidecar its verbatim prior output
    // reliably made it re-emit that output (the "history > 0 repeats the last
    // item" bug) — anti-repeat prompting alone did not hold. Continuity is
    // still preserved for the FINAL response via formatHistoricalDeliberations
    // (historicalDeliberationBlock), which is injected into the main synthesis
    // prompt rather than the per-member deliberation.

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (execution === "mcp") {
          const plannedArgs = await planCallableToolArgs(
            input.userId,
            sidecar,
            toolDef,
            member,
            identityMsg,
            contextMessages,
            settings.toolsSettings.timeoutMs,
            input.signal,
          );

          content = await getMcpClientManager().callTool(
            input.userId,
            mcpMatch!.serverId,
            mcpMatch!.toolName,
            plannedArgs,
            settings.toolsSettings.timeoutMs
          );
        } else if (execution === "extension") {
          // Pass the bare tool name (not qualified) so extension handlers can
          // match easily, and forward the full chat context so tools can act on it.
          // Extension tools receive the exact same context as sidecar tools —
          // system enrichment (character, persona, world info) plus the full
          // chat history governed by the sidecar context window setting.
          //
          // Context is delivered two ways for the same invocation:
          //   1. `args.context` — flattened string (role prefixes elided for
          //      system messages, multipart content dropped). Kept for
          //      backwards compatibility with extensions already reading it.
          //   2. `contextMessages` (top-level payload field) — structured
          //      LlmMessageDTO[], role boundaries preserved, multipart text
          //      extracted. Delivered via worker-host so it can't collide
          //      with user-space `args` (same rationale as `councilMember`).
          const bareToolName = extToolReg!.name;
          const contextSummary = contextMessages
            .map((m) => {
              const prefix = m.role === "system" ? "" : `${m.role}: `;
              return `${prefix}${typeof m.content === "string" ? m.content : ""}`;
            })
            .join("\n\n");

          content = await invokeExtensionCouncilTool(
            extToolReg!.extension_id,
            bareToolName,
            {
              context: contextSummary,
              // Deadline hint is opaque and useful for the extension; userId is
              // intentionally NOT included here — the worker host strips any
              // attempted __userId injection before posting to the worker.
              __deadlineMs: Date.now() + settings.toolsSettings.timeoutMs,
            },
            settings.toolsSettings.timeoutMs,
            memberContext,
            contextMessages
          );
        } else if (execution === "host") {
          const plannedArgs = await planCallableToolArgs(
            input.userId,
            sidecar,
            toolDef,
            member,
            identityMsg,
            contextMessages,
            settings.toolsSettings.timeoutMs,
            input.signal,
          );

          content = await executeHostCouncilTool({
            userId: input.userId,
            tool: toolDef,
            args: plannedArgs,
            member,
            memberContext,
            contextMessages,
            timeoutMs: settings.toolsSettings.timeoutMs,
            signal: input.signal,
          });
        } else {
          content = await invokeSidecarTool(
            input.userId,
            sidecar,
            toolDef,
            member,
            identityMsg,
            contextMessages,
            settings.toolsSettings,
            input.signal,
            input.enrichment
          );
        }
        success = true;
        break;
      } catch (err: any) {
        error = err.message;
        // Don't retry if the generation was aborted — bail out immediately
        if (input.signal?.aborted) break;
        if (execution === "extension" || execution === "mcp" || execution === "host") break;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
    }

    const result: CouncilToolResult & { resultVariable?: string } = {
      memberId: member.id,
      memberName: member.itemName,
      toolName,
      toolDisplayName: toolDef.displayName,
      success,
      content,
      error: success ? undefined : error,
      durationMs: Date.now() - toolStart,
    };
    // Propagate resultVariable from tool definition so callers can extract named results
    if (toolDef.resultVariable) {
      result.resultVariable = toolDef.resultVariable;
    }
    results.push(result);

    // Store named result if applicable
    if (success && toolDef.resultVariable) {
      namedResults.set(toolDef.resultVariable, content);
    }
  }

  return results;
}

function assignmentKey(memberId: string, toolName: string): string {
  return `${memberId}:${toolName}`;
}

function getToolHistoryRetention(member: CouncilMember, toolName: string): number {
  const value = (member as any).toolHistoryRetention?.[toolName];
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_HISTORY_RETENTION, Math.floor(value)));
}

function truncateHistoryContent(content: string): string {
  if (content.length <= MAX_HISTORY_ENTRY_CHARS) return content;
  return `${content.slice(0, MAX_HISTORY_ENTRY_CHARS).trimEnd()}\n[truncated]`;
}

function readCouncilHistory(
  userId: string,
  chatId: string,
): CouncilHistoricalDeliberationEntry[] {
  const chat = chatsSvc.getChat(userId, chatId);
  const raw = chat?.metadata?.[COUNCIL_HISTORY_METADATA_KEY];
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as any).entries)) {
    return [];
  }

  return (raw as any).entries.filter(
    (entry: any): entry is CouncilHistoricalDeliberationEntry =>
      entry &&
      typeof entry.id === "string" &&
      typeof entry.createdAt === "number" &&
      typeof entry.memberId === "string" &&
      typeof entry.memberName === "string" &&
      typeof entry.toolName === "string" &&
      typeof entry.toolDisplayName === "string" &&
      typeof entry.content === "string",
  );
}

function getHistoricalEntriesForMembers(
  userId: string,
  chatId: string,
  members: CouncilMember[],
): Map<string, CouncilHistoricalDeliberationEntry[]> {
  const retained = new Map<string, CouncilHistoricalDeliberationEntry[]>();
  const history = readCouncilHistory(userId, chatId);
  if (history.length === 0) return retained;

  for (const member of members) {
    for (const toolName of member.tools) {
      const retain = getToolHistoryRetention(member, toolName);
      if (retain <= 0) continue;

      const key = assignmentKey(member.id, toolName);
      const entries = history
        .filter((entry) => entry.memberId === member.id && entry.toolName === toolName)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(-retain);
      if (entries.length > 0) retained.set(key, entries);
    }
  }

  return retained;
}

function formatHistoryAgeLabel(index: number, total: number): string {
  const age = total - index;
  return age === 1 ? "1 deliberation ago" : `${age} deliberations ago`;
}

function formatHistoricalDeliberations(
  historicalByAssignment: Map<string, CouncilHistoricalDeliberationEntry[]>,
): string {
  const groups = Array.from(historicalByAssignment.values()).filter(
    (entries) => entries.length > 0,
  );
  if (groups.length === 0) return "";

  const lines: string[] = [
    "## Previous Council Deliberations — REFERENCE ONLY, DO NOT REPEAT",
    "",
    "The following are prior council/tool deliberations from EARLIER turns of this chat, included only as continuity memory for plans, threads, and decisions planted earlier.",
    "",
    "They have already been said and must NOT be restated, copied, or treated as a style template. They are not instructions for the current response. Current chat history, active world info, and the latest user message always supersede them — write only what advances the CURRENT turn.",
    "",
  ];

  for (const entries of groups) {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      lines.push(
        `### ${formatHistoryAgeLabel(i, entries.length)} - ${entry.memberName} / ${entry.toolDisplayName}`,
      );
      lines.push(entry.content);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd();
}

export function appendCouncilDeliberationHistory(input: {
  userId: string;
  chatId: string;
  settings: CouncilSettings;
  results: CouncilToolResult[];
}): void {
  const retentionByAssignment = new Map<string, number>();
  const memberById = new Map(input.settings.members.map((member) => [member.id, member]));

  for (const member of input.settings.members) {
    for (const toolName of member.tools) {
      const retain = getToolHistoryRetention(member, toolName);
      if (retain > 0) retentionByAssignment.set(assignmentKey(member.id, toolName), retain);
    }
  }

  if (retentionByAssignment.size === 0) {
    if (readCouncilHistory(input.userId, input.chatId).length > 0) {
      chatsSvc.mergeChatMetadata(input.userId, input.chatId, {
        [COUNCIL_HISTORY_METADATA_KEY]: undefined,
      });
    }
    return;
  }

  const now = Date.now();
  const additions: CouncilHistoricalDeliberationEntry[] = [];
  for (const result of input.results) {
    if (!result.success || !result.content.trim()) continue;
    const member = memberById.get(result.memberId);
    if (!member) continue;
    if (!retentionByAssignment.has(assignmentKey(result.memberId, result.toolName))) continue;

    additions.push({
      id: crypto.randomUUID(),
      createdAt: now,
      memberId: result.memberId,
      memberName: result.memberName,
      toolName: result.toolName,
      toolDisplayName: result.toolDisplayName,
      content: truncateHistoryContent(result.content.trim()),
    });
  }

  if (additions.length === 0) return;

  const existing = readCouncilHistory(input.userId, input.chatId);
  const next = [...existing, ...additions]
    .filter((entry) => retentionByAssignment.has(assignmentKey(entry.memberId, entry.toolName)))
    .sort((a, b) => a.createdAt - b.createdAt);

  const byAssignment = new Map<string, CouncilHistoricalDeliberationEntry[]>();
  for (const entry of next) {
    const key = assignmentKey(entry.memberId, entry.toolName);
    const entries = byAssignment.get(key) ?? [];
    entries.push(entry);
    byAssignment.set(key, entries);
  }

  const pruned: CouncilHistoricalDeliberationEntry[] = [];
  for (const [key, entries] of byAssignment) {
    const retain = retentionByAssignment.get(key) ?? 0;
    pruned.push(...entries.slice(-retain));
  }
  pruned.sort((a, b) => a.createdAt - b.createdAt);

  chatsSvc.mergeChatMetadata(input.userId, input.chatId, {
    [COUNCIL_HISTORY_METADATA_KEY]: {
      version: 1,
      entries: pruned.slice(-MAX_HISTORY_TOTAL_ENTRIES),
    },
  });
}

/**
 * Route a tool call to the extension worker that registered it. We never
 * forward the authenticated userId — extensions run in their own user-scoped
 * worker and reach back via the RPC bridge under that identity. Passing the
 * raw userId to the tool handler would let a malicious extension impersonate
 * the user via its own internal state, defeating the worker boundary.
 *
 * `councilMember` is a trusted host-built snapshot of the assigned member's
 * identity/personality fields — delivered to the extension handler alongside
 * the invocation args so the tool can tailor its output to that member.
 */
/** Call the sidecar LLM for a single tool. */
async function invokeSidecarTool(
  userId: string,
  sidecar: SidecarConfig,
  tool: RuntimeCouncilToolDefinition,
  member: CouncilMember,
  identityMsg: string,
  contextMessages: LlmMessage[],
  toolsSettings: { maxWordsPerTool: number; timeoutMs: number; allowUserControl?: boolean },
  signal?: AbortSignal,
  enrichment?: CouncilEnrichment
): Promise<string> {
  if (!tool.prompt) {
    throw new Error(`LLM council tool \"${tool.displayName}\" is missing a prompt`);
  }

  const brevityNote =
    toolsSettings.maxWordsPerTool > 0
      ? `\n\nIMPORTANT — BREVITY REQUIREMENT: Keep each tool response field under ${toolsSettings.maxWordsPerTool} words. Be direct, specific, and actionable. No preamble, filler, or repetition. Every word must earn its place.`
      : "";

  const roleNote = member.role
    ? `\nYour role on the council is: ${member.role}\nWhen using your tools, consider how your role influences your perspective and recommendations. Draw upon your expertise as ${member.role} to provide valuable insights.`
    : "";

  const userControlNote = toolsSettings.allowUserControl
    ? `\n\n### User Character Guidance ###\nYou may plan and suggest actions, dialogue, thoughts, and development for ALL characters in the story, including the user's character. Treat all participants — including the user — as characters whose arcs, actions, and dialogue you can direct and shape.`
    : `\n\n### User Character Guidance ###\nIMPORTANT: Do NOT plan actions, dialogue, thoughts, or decisions for the user's character. Focus exclusively on how the story's non-player characters should react, behave, and develop in response to the user's input. Your suggestions should only concern the characters, world, and narrative elements — never dictate what the user's character does, says, thinks, or feels.`;

  // Dynamic enrichment for expression detector — inject available labels
  let dynamicSuffix = "";
  if (tool.name === "detect_expression" && enrichment?.character) {
    const labels = getExpressionLabels(userId, enrichment.character.id);
    if (labels.length > 0) {
      dynamicSuffix = `\n\n## Available Expression Labels\n${labels.join(", ")}`;
    }
  }

  const systemPrompt = `${identityMsg}${roleNote}

You are being asked to use the following analysis tool. Respond with your analysis directly — do not use JSON formatting.

## Tool: ${tool.displayName}
${tool.description}

${tool.prompt}${dynamicSuffix}${brevityNote}${userControlNote}`;

  const messages: LlmMessage[] = [
    { role: "system", content: systemPrompt },
    ...contextMessages,
    { role: "user", content: `Respond to the CURRENT latest message in the story context above with specific, actionable input from your unique perspective as ${member.itemName}, filtered through your personality, biases, and worldview. Produce a fresh contribution for this turn.` },
  ];

  // Resolve the connection to get the provider name
  const conn = connectionsSvc.getConnection(userId, sidecar.connectionProfileId);
  if (!conn) throw new Error("Sidecar connection not found");

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    messages,
    connection_id: sidecar.connectionProfileId,
    parameters: {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens,
    },
    signal,
  });

  return response.content || "";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();

  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  if (fenced) {
    const parsedFenced = tryParseJsonObject(fenced);
    if (parsedFenced) return parsedFenced;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const embedded = tryParseJsonObject(trimmed.slice(firstBrace, lastBrace + 1));
    if (embedded) return embedded;
  }

  return null;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function coerceScalarForSchema(value: string, schema: Record<string, unknown> | undefined): unknown {
  const type = typeof schema?.type === "string" ? schema.type : "string";
  if (type === "integer" || type === "number") {
    const num = Number(value.trim());
    return Number.isFinite(num) ? num : value.trim();
  }
  if (type === "boolean") {
    if (/^(true|yes|on)$/i.test(value.trim())) return true;
    if (/^(false|no|off)$/i.test(value.trim())) return false;
  }
  return value.trim();
}

function parseArgsFromTextFallback(
  text: string,
  schema: Record<string, unknown>,
): Record<string, unknown> | null {
  const properties = ((schema as any)?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const propertyNames = Object.keys(properties);
  if (propertyNames.length === 0) return null;

  const result: Record<string, unknown> = {};
  for (const key of propertyNames) {
    const pattern = new RegExp(`(?:^|\\n)\\s*${key}\\s*[:=]\\s*(.+)`, "i");
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const rawValue = match[1].split("\n")[0].trim();
    if (!rawValue) continue;
    result[key] = coerceScalarForSchema(rawValue, properties[key]);
  }

  if (Object.keys(result).length > 0) return result;

  const required = Array.isArray((schema as any)?.required) ? (schema as any).required as string[] : [];
  if (required.length === 1) {
    const [onlyRequired] = required;
    const prop = properties[onlyRequired];
    if (prop?.type === "string" || typeof prop?.type !== "string") {
      return { [onlyRequired]: text.trim() };
    }
  }

  return null;
}

function sanitizeTopLevelArgs(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = ((schema as any)?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args)) {
    const prop = properties[key];
    if (typeof value === "string") {
      sanitized[key] = coerceScalarForSchema(value, prop);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

function getInvalidRequiredFields(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string[] {
  const properties = ((schema as any)?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray((schema as any)?.required) ? (schema as any).required as string[] : [];
  const invalid: string[] = [];

  for (const key of required) {
    const value = args[key];
    const prop = properties[key] ?? {};
    const type = typeof prop.type === "string" ? prop.type : undefined;

    if (value === undefined || value === null) {
      invalid.push(key);
      continue;
    }
    if (type === "string" && (typeof value !== "string" || value.trim().length === 0)) {
      invalid.push(key);
    }
  }

  return invalid;
}

function normalizeWebSearchQueryText(text: string): string {
  let value = text.trim();
  if (!value) return "";

  const fenced = value.match(/^```(?:text|md|markdown)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  if (fenced) value = fenced;

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.replace(/^query\s*[:=-]\s*/i, "").trim())
    .map((line) => line.replace(/^['"`]+|['"`]+$/g, "").trim())
    .filter(Boolean);

  if (lines.length === 0) return "";

  const explanationLike = /^(because|based on|the user|this|i should|we should|use |search for )/i;
  const queryLines: string[] = [];

  for (const line of lines.slice(0, 3)) {
    if (queryLines.length > 0 && explanationLike.test(line)) break;
    queryLines.push(line);
  }

  return queryLines.join(" ").replace(/\s+/g, " ").trim();
}

async function planWebSearchArgs(
  userId: string,
  conn: ReturnType<typeof connectionsSvc.getConnection>,
  sidecar: SidecarConfig,
  tool: RuntimeCouncilToolDefinition,
  contextMessages: LlmMessage[],
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!conn) throw new Error("Sidecar connection not found");

  const guidanceBlock = tool.planningGuidance
    ? `\n## Search Guidance\n${tool.planningGuidance}`
    : "";

  const messages: LlmMessage[] = [
    {
      role: "system",
      content: `You are preparing a web search query.

## Tool
${tool.displayName}
${tool.description}${guidanceBlock}

Read the context and produce exactly one short search-engine query.

Rules:
- Return only the query text.
- No JSON.
- No explanation.
- No quotes.
- No prefixes like 'query:' or 'search for'.
- Keep it short, concrete, and keyword-heavy.
- Do not imitate any character, council member, narrator, or roleplay voice from the context.
- Ignore stylistic quirks in the chat history and extract only the factual subject that should be searched.`,
    },
    ...contextMessages,
    {
      role: "user",
      content: `Based on the context above, what should be searched on the web? Return only the query.`,
    },
  ];

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    connection_id: sidecar.connectionProfileId,
    messages,
    parameters: {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: sidecar.maxTokens,
    },
    signal,
  });

  const query = normalizeWebSearchQueryText(response.content || "");
  console.debug("[council] Web Search planner output raw=%j normalized=%j", response.content || "", query);
  if (!query) {
    throw new Error("Failed to plan web search query");
  }

  return { query };
}

async function repairCallableToolArgs(
  userId: string,
  conn: ReturnType<typeof connectionsSvc.getConnection>,
  sidecar: SidecarConfig,
  tool: RuntimeCouncilToolDefinition,
  planningMessages: LlmMessage[],
  argsSchema: Record<string, unknown>,
  invalidFields: string[],
  signal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  if (!conn) return null;

  const repairMessages: LlmMessage[] = [
    ...planningMessages,
    {
      role: "user",
      content: `The previous tool call was invalid because these required fields were missing or empty: ${invalidFields.join(", ")}.
Return only a JSON object that matches the schema exactly and ensures those fields are present and non-empty. Do not answer in prose.`,
    },
  ];

  const repairResponse = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    connection_id: sidecar.connectionProfileId,
    messages: repairMessages,
    parameters: {
      temperature: 0,
      top_p: sidecar.topP,
      max_tokens: Math.min(sidecar.maxTokens, 192),
    },
    signal,
  });

  const parsed = parseJsonObject(repairResponse.content);
  if (!parsed) return null;

  const sanitized = sanitizeTopLevelArgs(parsed, argsSchema);
  return getInvalidRequiredFields(sanitized, argsSchema).length === 0 ? sanitized : null;
}

function buildArgsSchemaGuide(schema: Record<string, unknown>): string {
  const properties = ((schema as any)?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray((schema as any)?.required) ? (schema as any).required as string[] : []);
  const names = Object.keys(properties);
  if (names.length === 0) return "";

  const lines = ["## Required Argument Contract"];
  lines.push("When you call the tool, fill the arguments using these exact field names:");
  for (const name of names) {
    const prop = properties[name] ?? {};
    const type = typeof prop.type === "string" ? prop.type : "any";
    const desc = typeof prop.description === "string" ? prop.description : "";
    lines.push(`- ${name}${required.has(name) ? " (required)" : ""} — ${type}${desc ? ` — ${desc}` : ""}`);
  }
  lines.push("Do not leave required string fields empty. Use concise JSON-style argument values, not narrative prose. Call the tool exactly once.");
  return lines.join("\n");
}

function buildInputExamplesGuide(examples: Array<Record<string, unknown>> | undefined): string {
  if (!examples || examples.length === 0) return "";

  const lines = ["## Valid Input Examples", "Use these as format examples when constructing the tool arguments:"];
  for (const example of examples.slice(0, 3)) {
    lines.push(JSON.stringify(example));
  }
  return lines.join("\n");
}

function toolSchemaRequiresArgs(userId: string, tool: RuntimeCouncilToolDefinition): boolean {
  const schema = getCouncilToolArgsSchema(userId, tool) ?? {};
  const required = Array.isArray((schema as any).required) ? (schema as any).required : [];
  const properties = (schema as any).properties;
  return required.length > 0 || (properties && Object.keys(properties).length > 0);
}

async function planCallableToolArgs(
  userId: string,
  sidecar: SidecarConfig,
  tool: RuntimeCouncilToolDefinition,
  member: CouncilMember,
  identityMsg: string,
  contextMessages: LlmMessage[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const argsSchema = getCouncilToolArgsSchema(userId, tool) ?? { type: "object", properties: {}, required: [] };
  if (!toolSchemaRequiresArgs(userId, tool)) {
    return {};
  }

  if (!sidecar.connectionProfileId || !sidecar.model) {
    throw new Error(`Sidecar connection is required to plan arguments for \"${tool.displayName}\"`);
  }

  const conn = connectionsSvc.getConnection(userId, sidecar.connectionProfileId);
  if (!conn) throw new Error("Sidecar connection not found");

  const roleNote = member.role
    ? `\nYour role on the council is: ${member.role}\nUse that perspective when selecting tool arguments.`
    : "";

  const execution = getCouncilToolExecution(userId, tool);
  const executionLabel = execution === "host"
    ? "host tool"
    : execution === "mcp"
      ? "MCP tool"
      : execution === "extension"
        ? "extension tool"
        : "tool";

  const planningTool = {
    name: "call_tool",
    description: `Prepare the arguments for the ${executionLabel} \"${tool.displayName}\". Return only a valid function call with complete, non-empty arguments that match the schema exactly.`,
    parameters: argsSchema,
    strict: true,
    inputExamples: tool.inputExamples,
  };

  const guidanceBlock = tool.planningGuidance
    ? `\n## Tool-Specific Guidance\n${tool.planningGuidance}`
    : "";
  const examplesBlock = buildInputExamplesGuide(tool.inputExamples);

  const instructionBlock = `${identityMsg}${roleNote}

You are preparing arguments for a tool call.

## Tool
${tool.displayName}
${tool.description}

${buildArgsSchemaGuide(argsSchema)}

${examplesBlock}${guidanceBlock}

Select the most appropriate arguments from the story context and call the provided tool exactly once. You are not answering the user or continuing the roleplay; you are only selecting tool arguments. Build arguments the way a careful operator would fill out a form for a downstream API. Prefer short, literal values over full sentences. Do not answer in prose.`;

  const planningMessages: LlmMessage[] = [
    {
      role: "system",
      content: instructionBlock,
    },
    ...contextMessages,
    {
      role: "user",
      content: `Review the story context above and prepare the arguments for ${tool.displayName}.`,
    },
  ];

  const planningParameters: Record<string, unknown> = {
    temperature: Math.min(sidecar.temperature, 0.2),
    top_p: sidecar.topP,
    max_tokens: Math.min(sidecar.maxTokens, Math.max(128, timeoutMs / 100)),
  };

  if (tool.name === "web_search") {
    return planWebSearchArgs(
      userId,
      conn,
      sidecar,
      tool,
      contextMessages,
      signal,
    );
  }

  if (GOOGLE_PLANNING_PROVIDERS.has(conn.provider)) {
    // Gemini's forced ANY mode is documented to be more brittle for argument
    // inference than AUTO. Keep the council tool mandatory at the host layer,
    // but let Google/Vertex use AUTO for the planner step so the model can
    // reason its way to better arguments before emitting the function call.
    planningParameters.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  } else {
    Object.assign(planningParameters, getToolChoiceParams(conn.provider));
  }

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    connection_id: sidecar.connectionProfileId,
    messages: planningMessages,
    parameters: planningParameters,
    tools: [planningTool],
    signal,
  });

  const plannedCall = response.tool_calls?.find((call) => call.name === planningTool.name);
  if (plannedCall) {
    const sanitized = sanitizeTopLevelArgs(plannedCall.args ?? {}, argsSchema);
    const invalidFields = getInvalidRequiredFields(sanitized, argsSchema);
    if (invalidFields.length === 0) {
      return sanitized;
    }
    console.warn("[council] Planner returned invalid required args for '%s': %s", tool.displayName, invalidFields.join(", "));
    const repaired = await repairCallableToolArgs(
      userId,
      conn,
      sidecar,
      tool,
      planningMessages,
      argsSchema,
      invalidFields,
      signal,
    );
    if (repaired) {
      return repaired;
    }
  }

  const parsed = parseJsonObject(response.content);
  if (parsed) {
    const sanitized = sanitizeTopLevelArgs(parsed, argsSchema);
    const invalidFields = getInvalidRequiredFields(sanitized, argsSchema);
    if (invalidFields.length === 0) {
      return sanitized;
    }
  }

  const textFallback = parseArgsFromTextFallback(response.content || "", argsSchema);
  if (textFallback) {
    const sanitized = sanitizeTopLevelArgs(textFallback, argsSchema);
    const invalidFields = getInvalidRequiredFields(sanitized, argsSchema);
    if (invalidFields.length === 0) {
      return sanitized;
    }
  }

  throw new Error(`Failed to plan arguments for tool \"${tool.displayName}\"`);
}

/** Build the shared context messages (chat history, character info, world info, etc.).
 *  When enrichment is provided via input.enrichment, pre-loaded data is used instead
 *  of independent lookups — this ensures council tools receive the same world info
 *  that was resolved at the top of the generation chain. */
function buildContextMessages(input: ExecuteInput, settings: CouncilSettings): LlmMessage[] {
  const msgs: LlmMessage[] = [];
  const ts = settings.toolsSettings;

  const chat = chatsSvc.getChat(input.userId, input.chatId);

  // Prefer pre-loaded enrichment data; fall back to independent lookups.
  // `includeUserPersona` is authoritative — enrichment may carry a persona
  // resolved by the main generation pipeline, but the council toggle overrides it.
  let character = input.enrichment?.character ?? null;
  const persona = ts.includeUserPersona
    ? (input.enrichment?.persona
        ?? personasSvc.resolvePersonaOrDefault(input.userId, input.personaId))
    : null;

  // Character info
  if (ts.includeCharacterInfo && chat) {
    if (!character && chat.character_id) character = charactersSvc.getCharacter(input.userId, chat.character_id);
    if (character) {
      const charInfo = [
        character.name && `Name: ${character.name}`,
        character.description && `Description: ${character.description}`,
        character.personality && `Personality: ${character.personality}`,
        character.scenario && `Scenario: ${character.scenario}`,
      ]
        .filter(Boolean)
        .join("\n");
      if (charInfo) {
        msgs.push({ role: "system", content: `## Character Information\n${charInfo}` });
      }
    }
  }

  // User persona
  if (persona) {
    msgs.push({
      role: "system",
      content: `## User Persona\nName: ${persona.name}\n${persona.description || ""}`,
    });
  }

  // World info — use pre-activated entries from enrichment when available,
  // otherwise run independent activation as a fallback.
  if (ts.includeWorldInfo && chat) {
    let activatedEntries: import("../../types/world-book").WorldBookEntry[] | null = null;

    if (input.enrichment) {
      // Use pre-activated entries from the generation chain (resolved at the
      // top of the pipeline with staged/excluded messages filtered out).
      activatedEntries = input.enrichment.activatedWorldInfoEntries;
      console.debug("[council] Using %d pre-activated world info entries from enrichment", activatedEntries.length);
    } else {
      // Fallback: independently activate WI (for callers without enrichment)
      if (!character && chat.character_id) character = charactersSvc.getCharacter(input.userId, chat.character_id);
      const { entries: wiEntries } = collectWorldInfoForCouncil(input.userId, character, persona, input.chatId);
      if (wiEntries.length > 0) {
        const allMsgs = chatsSvc.getMessages(input.userId, input.chatId);
        const wiResult = activateWorldInfo({
          entries: wiEntries,
          messages: allMsgs,
          chatTurn: allMsgs.length,
          wiState: {},
        });
        activatedEntries = wiResult.activatedEntries;
        console.debug("[council] Independently activated %d/%d world info entries", activatedEntries.length, wiEntries.length);
      } else {
        console.debug("[council] No world info entries found to activate");
      }
    }

    if (activatedEntries && activatedEntries.length > 0) {
      const wiContent = activatedEntries
        .map((e) => {
          const label = e.comment || e.key?.join(", ") || "entry";
          return `[${label}]: ${e.content}`;
        })
        .join("\n\n");
      msgs.push({ role: "system", content: `## Activated World Info\n${wiContent}` });
    }
  }

  // Recent chat history — prefer enrichment messages (which exclude
  // staged/regenerated messages) to avoid empty assistant turns.
  const allMessages = input.enrichment?.messages ?? chatsSvc.getMessages(input.userId, input.chatId);
  const recentMessages = allMessages.slice(-ts.sidecarContextWindow);
  for (const msg of recentMessages) {
    msgs.push({
      role: msg.is_user ? "user" : "assistant",
      content: msg.content,
    });
  }

  return msgs;
}

/** Build the identity/personality context for a Lumia council member. */
function buildMemberIdentity(
  member: CouncilMember,
  item: ReturnType<typeof packsSvc.getLumiaItem>
): string {
  let identity = `You are a council member named "${member.itemName}".`;

  if (item) {
    const parts: string[] = [];
    if (item.definition) parts.push(`### Your Physical Identity ###\n${item.definition}`);
    if (item.personality) parts.push(`### Your Personality ###\n${item.personality}`);
    if (item.behavior) parts.push(`### Your Behavioral Patterns ###\n${item.behavior}`);
    if (parts.length > 0) {
      identity += `\n\n### WHO YOU ARE ###\n\n${parts.join("\n\n")}`;
      identity += `\n\n### INSTRUCTION ###\nYou MUST answer ALL tool calls and contributions through the lens of your personality, behavior, and identity described above. Your biases, quirks, speech patterns, and perspective should color every observation and suggestion you make. Do NOT provide generic or neutral responses—filter everything through who you are. Your unique voice and worldview must be evident in every contribution.`;
    }
  }

  return identity;
}

/** Format tool results into the Markdown deliberation block. */
export function formatDeliberation(
  results: CouncilToolResult[],
  tools: Map<string, RuntimeCouncilToolDefinition>
): string {
  if (results.length === 0) {
    return "## Council Deliberation\n\nNo tools were executed for this generation.";
  }

  const lines: string[] = ["## Council Deliberation"];
  lines.push("");
  lines.push("The following contributions have been gathered from council members:");
  lines.push("");

  // Group results by member, excluding variable-only tools
  const byMember = new Map<string, CouncilToolResult[]>();
  for (const r of results) {
    if (!r.success) continue;
    const toolDef = tools.get(r.toolName);
    if (toolDef?.resultVariable && toolDef.storeInDeliberation === false) continue;

    const existing = byMember.get(r.memberName) || [];
    existing.push(r);
    byMember.set(r.memberName, existing);
  }

  for (const [memberName, memberResults] of byMember) {
    lines.push(`### **${memberName}** says:`);
    lines.push("");
    for (const r of memberResults) {
      lines.push(`**${r.toolDisplayName}:**`);
      lines.push(r.content);
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }

  // Append deliberation instructions
  lines.push(DELIBERATION_INSTRUCTIONS);

  return lines.join("\n");
}

/** Collect world book entries from character + persona + chat + global world books for council WI injection. */
export function collectWorldInfoForCouncil(
  userId: string,
  character: ReturnType<typeof charactersSvc.getCharacter>,
  persona: ReturnType<typeof personasSvc.resolvePersonaOrDefault>,
  chatId?: string,
): { entries: import("../../types/world-book").WorldBookEntry[]; worldBookIds: string[] } {
  const entries: import("../../types/world-book").WorldBookEntry[] = [];
  const seen = new Set<string>();

  const charBookIds = getCharacterWorldBookIds(character?.extensions);
  for (const charBookId of charBookIds) {
    if (seen.has(charBookId)) continue;
    seen.add(charBookId);
    entries.push(...worldBooksSvc.listEntries(userId, charBookId));
  }
  if (persona?.attached_world_book_id && !seen.has(persona.attached_world_book_id)) {
    seen.add(persona.attached_world_book_id);
    entries.push(...worldBooksSvc.listEntries(userId, persona.attached_world_book_id));
  }

  // Chat-scoped world books (active for this chat only)
  if (chatId) {
    const chat = chatsSvc.getChat(userId, chatId);
    const chatBookIds = (chat?.metadata?.chat_world_book_ids as string[] | undefined) ?? [];
    for (const cId of chatBookIds) {
      if (seen.has(cId)) continue;
      seen.add(cId);
      entries.push(...worldBooksSvc.listEntries(userId, cId));
    }
  }

  // Global world books (user-wide, always active)
  const globalWorldBooks = (settingsSvc.getSetting(userId, "globalWorldBooks")?.value as string[] | undefined) ?? [];
  for (const gId of globalWorldBooks) {
    if (seen.has(gId)) continue;
    seen.add(gId);
    entries.push(...worldBooksSvc.listEntries(userId, gId));
  }

  return { entries, worldBookIds: Array.from(seen) };
}

const DELIBERATION_INSTRUCTIONS = `## Council Deliberation Instructions

You have access to the contributions from your fellow council members above.

Your task:
1. Review each member's contributions carefully
2. Debate which suggestions have the most merit
3. Consider how different ideas might combine or conflict
4. Reach a consensus on the best path forward
5. In your OOC commentary, reflect this deliberation process

**CRITICAL - Chain of Thought for Deliberation:**
When reviewing suggestions, you MUST:
- **ALWAYS** attempt to integrate and accommodate ALL reasonable suggestions from council members
- Exhaustively consider how multiple ideas can coexist and complement each other
- Only reject or challenge a suggestion if it would create irreconcilable conflicts with established lore
- Default stance: "How can we make this work together?" rather than "Why won't this work?"
- If two suggestions seem to conflict, explore creative synthesis first before dismissing either

**Guidelines for Deliberation:**
- Reference specific contributions by name
- Build upon good ideas
- When challenging: only do so if the suggestion fundamentally breaks established lore beyond repair
- Find synthesis between competing ideas — this is the DEFAULT expectation
- Your final narrative output should reflect the consensus reached through generous integration

**Tone:** Professional but passionate. You are invested in telling the best possible story through collaborative synthesis.`;
