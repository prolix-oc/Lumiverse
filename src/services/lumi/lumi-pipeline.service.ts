import type { LumiPipelineInput, LumiPipelineResult, LumiModuleResult } from "../../types/lumi-engine";
import type { LlmMessage } from "../../llm/types";
import { rawGenerate } from "../generate.service";
import * as connectionsSvc from "../connections.service";
import { evaluate, buildEnv, registry, initMacros } from "../../macros";
import { eventBus } from "../../ws/bus";
import { EventType } from "../../ws/events";

/**
 * Execute all enabled pipelines sequentially via a sidecar LLM.
 * Reads from grouped pipelines[] and per-preset sidecar config.
 */
export async function executeLumiPipeline(
  input: LumiPipelineInput,
): Promise<LumiPipelineResult> {
  const results: LumiPipelineResult = new Map();

  // Flatten enabled modules
  const enabledModules = input.pipelines
    .filter((p) => p.enabled)
    .flatMap((p) => p.modules.filter((m) => m.enabled));

  eventBus.emit(EventType.LUMI_PIPELINE_STARTED, {
    chatId: input.chatId,
    moduleCount: enabledModules.length,
  }, input.userId);

  if (enabledModules.length === 0) {
    eventBus.emit(EventType.LUMI_PIPELINE_COMPLETED, {
      chatId: input.chatId,
      status: "skipped",
      reason: "No enabled modules in this Lumi preset.",
    }, input.userId);
    return results;
  }

  const { sidecar } = input;

  if (!sidecar.connectionProfileId) {
    console.warn("[lumi-pipeline] Skipped: no sidecar connection configured");
    eventBus.emit(EventType.LUMI_PIPELINE_COMPLETED, {
      chatId: input.chatId,
      status: "skipped",
      reason: "No sidecar connection profile configured. Configure it in the Lumi tab.",
    }, input.userId);
    return results;
  }

  // connection exists?
  const conn = connectionsSvc.getConnection(input.userId, sidecar.connectionProfileId);
  if (!conn) {
    console.warn("[lumi-pipeline] Skipped: sidecar connection '%s' not found", sidecar.connectionProfileId);
    eventBus.emit(EventType.LUMI_PIPELINE_COMPLETED, {
      chatId: input.chatId,
      status: "error",
      reason: `Sidecar connection profile '${sidecar.connectionProfileId}' not found.`,
    }, input.userId);
    return results;
  }

  const model = sidecar.model || conn.model;
  if (!model) {
    console.warn("[lumi-pipeline] Skipped: no model configured for sidecar");
    eventBus.emit(EventType.LUMI_PIPELINE_COMPLETED, {
      chatId: input.chatId,
      status: "error",
      reason: "No model configured for sidecar connection.",
    }, input.userId);
    return results;
  }

  // Build macro env for resolving prompts
  initMacros();
  const macroEnv = buildEnv({
    character: input.character,
    persona: input.persona,
    chat: input.chat,
    messages: input.messages,
    generationType: "normal",
  });

  // Trim chat history to fit sidecar context window
  const contextMessages = buildContextMessages(input);

  const startTime = Date.now();

  for (const module of enabledModules) {
    if (input.signal?.aborted) break;

    const moduleStart = Date.now();
    try {
      // Resolve macros
      const { text: resolvedPrompt } = await evaluate(module.prompt, macroEnv, registry);

      const messages: LlmMessage[] = [
        { role: "system", content: resolvedPrompt },
        ...contextMessages,
      ];

      console.debug("[lumi-pipeline] Running module '%s' (%s)", module.name, module.key);

      const response = await rawGenerate(input.userId, {
        provider: conn.provider,
        model,
        messages,
        connection_id: sidecar.connectionProfileId,
        parameters: {
          temperature: sidecar.temperature,
          top_p: sidecar.topP,
          max_tokens: sidecar.maxTokensPerModule,
        },
        signal: input.signal,
      });

      const content = response.content || "";
      const usage = response.usage;
      results.set(module.key, { content, usage });

      eventBus.emit(EventType.LUMI_MODULE_DONE, {
        chatId: input.chatId,
        moduleKey: module.key,
        moduleName: module.name,
        success: true,
        content,
        usage,
        durationMs: Date.now() - moduleStart,
      }, input.userId);
    } catch (err: any) {
      if (err?.name === "AbortError" || input.signal?.aborted) break;
      console.error("[lumi-pipeline] Module '%s' failed:", module.key, err.message);
      results.set(module.key, { content: `[Error: ${err.message}]` });

      eventBus.emit(EventType.LUMI_MODULE_DONE, {
        chatId: input.chatId,
        moduleKey: module.key,
        moduleName: module.name,
        success: false,
        error: err.message,
        durationMs: Date.now() - moduleStart,
      }, input.userId);
    }
  }

  // Compute total usage across all modules
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  for (const [, result] of results) {
    if (result.usage) {
      totalPromptTokens += result.usage.prompt_tokens;
      totalCompletionTokens += result.usage.completion_tokens;
    }
  }
  const totalUsage = totalPromptTokens > 0 || totalCompletionTokens > 0
    ? { prompt_tokens: totalPromptTokens, completion_tokens: totalCompletionTokens, total_tokens: totalPromptTokens + totalCompletionTokens }
    : undefined;

  eventBus.emit(EventType.LUMI_PIPELINE_COMPLETED, {
    chatId: input.chatId,
    status: input.signal?.aborted ? "aborted" : "success",
    totalDurationMs: Date.now() - startTime,
    totalUsage,
  }, input.userId);

  return results;
}

/**
 * Build chat context messages for the sidecar, trimmed to the context window.
 */
function buildContextMessages(input: LumiPipelineInput): LlmMessage[] {
  const { messages, character, persona, sidecar } = input;

  // Budget ~1 char per 4 tokens, capped at reasonable field maximums.
  // contextWindow / 8 gives each field a slice of the total budget.
  const fieldBudget = Math.min(400, Math.floor(sidecar.contextWindow / 8));
  const clip = (text: string) =>
    text.length <= fieldBudget ? text : text.slice(0, fieldBudget) + "…";

  const charContext: string[] = [];
  if (character.description) charContext.push(clip(character.description));
  if (character.personality) charContext.push(`Personality: ${clip(character.personality)}`);
  if (character.scenario) charContext.push(`Scenario: ${clip(character.scenario)}`);

  const contextParts: LlmMessage[] = [];

  if (charContext.length > 0) {
    contextParts.push({
      role: "system",
      content: `[Character: ${character.name}]\n${charContext.join("\n")}`,
    });
  }

  if (persona?.description) {
    contextParts.push({
      role: "system",
      content: `[User Persona: ${persona.name}]\n${clip(persona.description)}`,
    });
  }

  // Trim chat history to fit context window (rough estimate: last N messages)
  const maxMessages = Math.max(1, Math.floor(sidecar.contextWindow / 200));
  const recentMessages = messages.slice(-maxMessages);

  for (const msg of recentMessages) {
    contextParts.push({
      role: msg.is_user ? "user" : "assistant",
      content: msg.content,
    });
  }

  return contextParts;
}
