import type {
  CouncilSettings,
  CouncilMember,
  CouncilMemberContext,
  CouncilToolResult,
  CouncilExecutionResult,
  CouncilToolDefinition,
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
import { BUILTIN_TOOLS_MAP } from "./builtin-tools";
import { parseMcpToolName } from "./mcp-tools";
import { getMcpClientManager } from "../mcp-client-manager";
import { toolRegistry } from "../../spindle/tool-registry";
import { getWorkerHost } from "../../spindle/lifecycle";
import { getExpressionLabels, hasExpressions } from "../expressions.service";
import { getSidecarSettings } from "../sidecar-settings.service";
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

interface ExecuteInput {
  userId: string;
  chatId: string;
  personaId?: string;
  connectionId?: string;
  /** Pre-resolved settings — avoids re-fetching and ensures consistency with caller. */
  settings?: CouncilSettings;
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

/**
 * Execute the full council cycle: roll dice per member, invoke sidecar LLM
 * for each tool, collect results, format deliberation block.
 */
export async function executeCouncil(
  input: ExecuteInput
): Promise<CouncilExecutionResult | null> {
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
  const sidecar = getSidecarSettings(input.userId);
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
  const availableTools = new Map<string, CouncilToolDefinition>();
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
      namedResults
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
  const totalDurationMs = Date.now() - startTime;

  const result: CouncilExecutionResult = {
    results: allResults,
    deliberationBlock,
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
  tools: Map<string, CouncilToolDefinition>,
  contextMessages: LlmMessage[],
  namedResults: Map<string, string>
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

  const memberContext = buildMemberContext(member, lumiaItem);

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

    // Check if this tool belongs to an extension (route to worker instead of sidecar)
    const extToolReg = toolRegistry.getTool(toolName);
    const isExtensionTool = !!extToolReg?.extension_id;

    // Check if this is an MCP tool (route to connected MCP server)
    const mcpMatch = !isExtensionTool ? parseMcpToolName(input.userId, toolName) : null;
    const isMcpTool = !!mcpMatch;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        if (isMcpTool) {
          const plannedArgs = await planMcpToolArgs(
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
        } else if (isExtensionTool) {
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

          content = await invokeExtensionToolViaWorker(
            input.userId,
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
        if (isExtensionTool || isMcpTool) break;
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
async function invokeExtensionToolViaWorker(
  userId: string,
  extensionId: string,
  toolName: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  councilMember?: CouncilMemberContext,
  contextMessages?: LlmMessage[]
): Promise<string> {
  const host = getWorkerHost(extensionId);
  if (!host) {
    throw new Error(`Extension worker '${extensionId}' is not running`);
  }
  return host.invokeExtensionTool(toolName, args, timeoutMs, councilMember, contextMessages);
}

/**
 * Build the CouncilMemberContext snapshot passed to extension tool invocations.
 * Sourced from the member's council-settings row plus (when available) the
 * backing Lumia item's personality fields. Missing item => personality fields
 * are empty strings, avatar is null, packName falls back to member.packName.
 */
function buildMemberContext(
  member: CouncilMember,
  item: ReturnType<typeof packsSvc.getLumiaItem>
): CouncilMemberContext {
  return {
    memberId: member.id,
    itemId: member.itemId,
    packId: member.packId,
    packName: member.packName,
    name: member.itemName,
    role: member.role ?? "",
    chance: member.chance,
    avatarUrl: item?.avatar_url ?? null,
    definition: item?.definition ?? "",
    personality: item?.personality ?? "",
    behavior: item?.behavior ?? "",
    genderIdentity: item?.gender_identity ?? 0,
  };
}

/** Call the sidecar LLM for a single tool. */
async function invokeSidecarTool(
  userId: string,
  sidecar: SidecarConfig,
  tool: CouncilToolDefinition,
  member: CouncilMember,
  identityMsg: string,
  contextMessages: LlmMessage[],
  toolsSettings: { maxWordsPerTool: number; timeoutMs: number; allowUserControl?: boolean },
  signal?: AbortSignal,
  enrichment?: CouncilEnrichment
): Promise<string> {
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
    { role: "user", content: `Review the story context above. Provide specific, actionable input from your unique perspective as ${member.itemName}. Filter every contribution through your personality, biases, and worldview.` },
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
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function toolSchemaRequiresArgs(tool: CouncilToolDefinition): boolean {
  const schema = tool.inputSchema ?? {};
  const required = Array.isArray((schema as any).required) ? (schema as any).required : [];
  const properties = (schema as any).properties;
  return required.length > 0 || (properties && Object.keys(properties).length > 0);
}

async function planMcpToolArgs(
  userId: string,
  sidecar: SidecarConfig,
  tool: CouncilToolDefinition,
  member: CouncilMember,
  identityMsg: string,
  contextMessages: LlmMessage[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!toolSchemaRequiresArgs(tool)) {
    return {};
  }

  if (!sidecar.connectionProfileId || !sidecar.model) {
    throw new Error(`Sidecar connection is required to plan MCP tool arguments for "${tool.displayName}"`);
  }

  const conn = connectionsSvc.getConnection(userId, sidecar.connectionProfileId);
  if (!conn) throw new Error("Sidecar connection not found");

  const roleNote = member.role
    ? `\nYour role on the council is: ${member.role}\nUse that perspective when selecting tool arguments.`
    : "";

  const planningTool = {
    name: "call_mcp_tool",
    description: `Prepare the arguments for the MCP tool \"${tool.displayName}\".`,
    parameters: tool.inputSchema ?? { type: "object", properties: {}, required: [] },
  };

  const response = await rawGenerate(userId, {
    provider: conn.provider,
    model: sidecar.model,
    connection_id: sidecar.connectionProfileId,
    messages: [
      {
        role: "system",
        content: `${identityMsg}${roleNote}

You are preparing arguments for an MCP tool call.

## MCP Tool
${tool.displayName}
${tool.description}

Select the most appropriate arguments from the story context and call the provided tool exactly once. If the schema allows an empty object, use it when no arguments are needed. Do not answer in prose.`,
      },
      ...contextMessages,
      {
        role: "user",
        content: `Review the story context above and prepare the arguments for ${tool.displayName}.`,
      },
    ],
    parameters: {
      temperature: sidecar.temperature,
      top_p: sidecar.topP,
      max_tokens: Math.min(sidecar.maxTokens, Math.max(128, timeoutMs / 100)),
      ...getToolChoiceParams(conn.provider),
    },
    tools: [planningTool],
    signal,
  });

  const plannedCall = response.tool_calls?.find((call) => call.name === planningTool.name);
  if (plannedCall) {
    return plannedCall.args ?? {};
  }

  const parsed = parseJsonObject(response.content);
  if (parsed) {
    return parsed;
  }

  throw new Error(`Failed to plan arguments for MCP tool "${tool.displayName}"`);
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
  let character = input.enrichment?.character ?? null;
  const persona = input.enrichment?.persona ?? (
    ts.includeUserPersona
      ? personasSvc.resolvePersonaOrDefault(input.userId, input.personaId)
      : null
  );

  // Character info
  if (ts.includeCharacterInfo && chat) {
    if (!character) character = charactersSvc.getCharacter(input.userId, chat.character_id);
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
      if (!character) character = charactersSvc.getCharacter(input.userId, chat.character_id);
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
  tools: Map<string, CouncilToolDefinition>
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
