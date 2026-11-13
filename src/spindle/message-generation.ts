import { isDeepStrictEqual } from "node:util";
import type { StreamChunk } from "../llm/types";
import { cloneEnv } from "../macros";
import { captureMessageLiterals } from "../macros/message-literals";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import * as chats from "../services/chats.service";
import * as pool from "../services/generation-pool.service";
import * as active from "../services/generation/active-generation-registry";
import { processResponseText, type PreparedResponseContext } from "../services/generation/response-processing";
import { applyDelimitedReasoningParsing, closeUnterminatedReasoningTags } from "../services/generation/reasoning";
import { resolveMessageMacroContent } from "../services/chat-macro-render.service";
import { getActiveScriptsForPreset, hasRegexMatchAction } from "../services/regex-scripts.service";
import { makePromptActivationSource } from "../services/prompt-activation.service";
import { trimIncompleteTrailingWord } from "../utils/trim-incomplete-word";
import { getActiveFrontendSession } from "./frontend-session";

export interface BeginMessageGenerationInput { chatId: string; messageId: string; responseContextIds: string[]; frontendSessionId?: string; userId?: string }
export interface MessageGenerationResult { messageId: string; completed: boolean }
interface Prepared { userId: string; chatId: string; context: PreparedResponseContext; at: number }
interface Slot {
  stateId: string; context: PreparedResponseContext; presetContext: any;
  content: string; reasoning: string; nativeReasoning: string; native: Partial<StreamChunk>;
  status: "waiting" | "running" | "done" | "stopped"; completion?: Promise<void>;
  waitingForInference?: boolean;
}
interface Session {
  id: string; userId: string; chatId: string; messageId: string; frontendSessionId?: string;
  controller: AbortController; slots: Slot[]; closing: boolean; terminal: boolean;
  terminalAt?: number;
  resolveCompletion(): void; finish?: Promise<MessageGenerationResult>; unsubscribe(): void;
}

/** A worker owns its handles; ordinary raw requests never enter the chat lifecycle. */
export class MessageGenerations {
  private prepared = new Map<string, Prepared>();
  private sessions = new Map<string, Session>();
  private finished = new Map<string, Promise<MessageGenerationResult>>();
  private sweep = setInterval(() => {
    for (const [id, value] of this.prepared) if (Date.now() - value.at > 120_000) this.prepared.delete(id);
    for (const [id, session] of this.sessions) if (session.terminalAt && Date.now() - session.terminalAt > 30_000 && !session.finish) {
      session.unsubscribe(); this.sessions.delete(id);
    }
  }, 30_000).unref();
  constructor(private extensionId: string) {}

  remember(userId: string, chatId: string, context: PreparedResponseContext): string {
    for (const [id, value] of this.prepared) if (Date.now() - value.at > 120_000) this.prepared.delete(id);
    if (this.prepared.size >= 100) throw new Error("Too many prepared response contexts");
    const id = crypto.randomUUID(); this.prepared.set(id, { userId, chatId, context, at: Date.now() }); return id;
  }

  begin(userId: string, input: BeginMessageGenerationInput): { id: string } {
    if (!input || !Array.isArray(input.responseContextIds) || !input.responseContextIds.length || new Set(input.responseContextIds).size !== input.responseContextIds.length)
      throw new Error("Distinct prepared response contexts are required");
    if (active.getActiveChatGeneration(userId, input.chatId)) throw new Error("This chat is already generating");
    if (input.frontendSessionId && input.frontendSessionId !== getActiveFrontendSession(userId)) throw new Error("The generating browser is no longer active");
    const message = chats.getMessage(userId, input.messageId);
    if (message?.chat_id !== input.chatId || message.is_user || chats.getLastAssistantMessage(userId, input.chatId)?.id !== message.id ||
        message.swipes.length !== input.responseContextIds.length || message.swipes.some(Boolean)) throw new Error("A blank latest assistant reply with one swipe per context is required");
    const prepared = input.responseContextIds.map(id => {
      const entry = this.prepared.get(id);
      if (!entry || entry.userId !== userId || entry.chatId !== input.chatId || Date.now() - entry.at > 120_000) throw new Error("The prepared response context expired or belongs to another chat");
      return entry.context;
    });
    if (prepared.some(value => !value.presetId || !value.env)) throw new Error("Message generation requires a prepared preset");
    const first = prepared[0]!;
    if (prepared.some(value => value.revision !== first.revision || !isDeepStrictEqual(value.before, first.before))) throw new Error("Prepared prompts have different variable baselines");
    if (prepared.some((context, index) => message.extra.spindle_metadata?.preset_contexts?.[index]?.preset_id !== context.presetId))
      throw new Error("The message's presets do not match its prepared prompts");
    const values = prepared.map(value => ({ global: Object.fromEntries(value.env!.variables.global), chat: Object.fromEntries(value.env!.variables.chat) }));
    if (!message.extra.variableStateBySwipe?.some(Boolean)) {
      if (!chats.setSwipeVariables(userId, input.chatId, message.id, { expected_variables: first.before, expected_revision: first.revision,
        expected_swipes: message.swipes, variables: values })) throw new Error("Chat variables changed while preparing");
    }
    const current = chats.getMessage(userId, message.id)!;
    const slots = prepared.map((context, index): Slot => {
      const state = current.extra.variableStateBySwipe?.[index];
      const presetContext = current.extra.spindle_metadata?.preset_contexts?.[index];
      if (!state?.id || !isDeepStrictEqual(state.values, values[index]) || presetContext?.preset_id !== context.presetId)
        throw new Error("The message's preset and variable snapshots do not match its prepared prompts");
      return { stateId: state.id, context, presetContext: structuredClone(presetContext), content: context.prefill,
        reasoning: "", nativeReasoning: "", native: {}, status: "waiting" };
    });
    const id = crypto.randomUUID(), controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    const session: Session = { id, userId, chatId: input.chatId, messageId: message.id, frontendSessionId: input.frontendSessionId,
      controller, slots, closing: false, terminal: false, resolveCompletion, unsubscribe: () => {} };
    session.unsubscribe = eventBus.on(EventType.MESSAGE_DELETED, event => {
      if (event.userId === userId && event.payload.messageId === message.id) controller.abort();
    });
    controller.signal.addEventListener("abort", () => {
      session.closing = true;
      this.end(session, false);
    }, { once: true });
    this.sessions.set(id, session);
    for (const contextId of input.responseContextIds) this.prepared.delete(contextId);
    active.registerActiveGeneration(id, { userId, chatId: input.chatId, controller, startedAt: Date.now(), lastTokenAt: Date.now(), completion });
    active.setActiveChatGeneration(userId, input.chatId, id);
    pool.createPoolEntry({ generationId: id, userId, chatId: input.chatId, generationType: "normal", characterName: message.name,
      characterId: first.characterId, model: first.model ?? "", targetMessageId: message.id, frontendSessionId: input.frontendSessionId,
      renderMode: "persisted-message" });
    pool.setPoolStatus(id, "streaming");
    const payload = { generationId: id, chatId: input.chatId, targetMessageId: message.id, generationType: "normal",
      characterName: message.name, characterId: first.characterId, model: first.model ?? "", frontendSessionId: input.frontendSessionId,
      renderMode: "persisted-message", extensionId: this.extensionId };
    eventBus.emit(EventType.GENERATION_STARTED, payload, userId);
    eventBus.emit(EventType.GENERATION_IN_PROGRESS, payload, userId);
    return { id };
  }

  bind(userId: string, id: string, index: number) {
    const session = this.sessions.get(id);
    if (!session || session.userId !== userId || session.closing || !Number.isSafeInteger(index)) throw new Error("Message generation is unavailable");
    const slot = session.slots[index];
    if (!slot || slot.status !== "waiting") throw new Error("This swipe already has a request");
    slot.status = "running";
    let resolve!: () => void;
    slot.completion = new Promise<void>(done => { resolve = done; });
    return {
      signal: session.controller.signal,
      reasoningPrefill: slot.context.reasoningPrefill,
      waiting: (waiting: boolean) => {
        slot.waitingForInference = waiting;
        const running = session.slots.filter(value => value.status === "running");
        active.setActiveGenerationWaitingForInference(id, running.length > 0 && running.every(value => value.waitingForInference));
      },
      observe: (chunk: StreamChunk) => {
        if (session.terminal || session.controller.signal.aborted) return;
        slot.content += chunk.token || ""; slot.reasoning += chunk.reasoning || "";
        active.touchActiveGeneration(id); pool.setPoolStatus(id, "streaming");
      },
      native: (chunk: StreamChunk) => {
        if (session.terminal || session.controller.signal.aborted) return;
        slot.nativeReasoning += chunk.reasoning || "";
        for (const key of ["thinking_blocks", "reasoning_details", "thought_signature", "usage", "finish_reason", "stop_details", "stop_sequence"] as const)
          if (chunk[key] !== undefined) (slot.native as any)[key] = chunk[key];
      },
      end: (success: boolean) => {
        slot.status = success && !session.controller.signal.aborted ? "done" : "stopped";
        const running = session.slots.filter(value => value.status === "running");
        active.setActiveGenerationWaitingForInference(id, running.length > 0 && running.every(value => value.waitingForInference));
        resolve();
      },
    };
  }

  async finish(id: string): Promise<MessageGenerationResult> {
    const finished = this.finished.get(id); if (finished) return finished;
    const session = this.sessions.get(id); if (!session) throw new Error("Unknown message generation");
    session.closing = true;
    session.finish ??= this.finalize(session).finally(() => {
      session.unsubscribe(); this.sessions.delete(id);
    });
    this.finished.set(id, session.finish);
    if (this.finished.size > 64) this.finished.delete(this.finished.keys().next().value!);
    return session.finish;
  }

  abort(id: string): void {
    const session = this.sessions.get(id);
    if (!session && !this.finished.has(id)) throw new Error("Unknown message generation");
    session?.controller.abort();
  }

  dispose(): void {
    clearInterval(this.sweep);
    for (const session of this.sessions.values()) { session.controller.abort(); session.unsubscribe(); }
    this.sessions.clear(); this.prepared.clear(); this.finished.clear();
  }

  private end(session: Session, completed: boolean): void {
    if (session.terminal) return;
    session.terminal = true;
    session.terminalAt = Date.now();
    const message = chats.getMessage(session.userId, session.messageId);
    if (completed) pool.completePool(session.id, session.messageId); else pool.stopPool(session.id);
    void Promise.all(session.slots.map(slot => slot.completion)).then(() => {
      active.removeActiveGeneration(session.id);
      active.clearActiveChatGeneration(session.userId, session.chatId, session.id);
      session.resolveCompletion();
    });
    eventBus.emit(completed ? EventType.GENERATION_ENDED : EventType.GENERATION_STOPPED, {
      generationId: session.id, chatId: session.chatId, ...(completed ? { messageId: session.messageId } : {}),
      content: message?.content ?? "", generationType: "normal", frontendSessionId: session.frontendSessionId,
      renderMode: "persisted-message", extensionId: this.extensionId,
    }, session.userId);
  }

  private async finalize(session: Session): Promise<MessageGenerationResult> {
    try {
      await Promise.all(session.slots.map(slot => slot.completion));
      const succeeded = new Map<string, { content: string; reasoning: string; context: unknown }>();
      for (const slot of session.slots) {
        if (slot.status === "waiting") continue;
        const message = chats.getMessage(session.userId, session.messageId);
        const index = message?.extra.variableStateBySwipe?.findIndex((state: any) => state?.id === slot.stateId) ?? -1;
        if (!message || index < 0 || message.swipes[index] !== slot.content ||
            (message.extra.reasoningBySwipe?.[index] ?? "") !== slot.reasoning) {
          if (session.controller.signal.aborted || slot.status === "stopped") continue;
          throw new Error("The generated reply changed before completion");
        }
        const env = cloneEnv(slot.context.env!);
        env.commit = false;
        env.signal = session.controller.signal.aborted ? AbortSignal.timeout(5_000) : session.controller.signal;
        const complete = slot.status === "done" && !session.controller.signal.aborted;
        let content = complete ? slot.content : closeUnterminatedReasoningTags(session.userId, slot.content);
        if (slot.context.trimIncompleteWords) content = content.slice(0, slot.context.prefill.length) + trimIncompleteTrailingWord(content.slice(slot.context.prefill.length));
        const parsed = applyDelimitedReasoningParsing(session.userId, { content, reasoning: slot.reasoning, finish_reason: "stop" });
        const activationSource = parsed.content;
        const scripts = getActiveScriptsForPreset(session.userId, { presetId: slot.context.presetId!, characterId: slot.context.characterId,
          chatId: session.chatId, target: "response" });
        const processed = await processResponseText(parsed.content, parsed.reasoning ?? "", scripts, env, { source: "response_backend",
          ...(hasRegexMatchAction(scripts, "repeat_back") ? { previousContent: chats.getPreviousSameRoleContent(session.userId, session.chatId, false, session.messageId) } : {}) });
        const rendered = complete ? await resolveMessageMacroContent(processed.content, env) : captureMessageLiterals(processed.content);
        env.signal.throwIfAborted();
        const native = slot.native;
        const carrier = native.thinking_blocks?.length ? { type: "thinking_blocks", blocks: native.thinking_blocks }
          : native.reasoning_details?.length ? { type: "reasoning_details", details: native.reasoning_details }
          : native.thought_signature ? { type: "gemini_thought_signature", signature: native.thought_signature }
          : slot.nativeReasoning ? { type: "reasoning_content", content: slot.nativeReasoning } : null;
        const variables = { global: Object.fromEntries(env.variables.global), chat: Object.fromEntries(env.variables.chat) };
        const presetContext = { ...slot.presetContext, variables: { ...slot.presetContext.variables, ...variables, local: Object.fromEntries(env.variables.local) } };
        if (!chats.commitGeneratedSwipe(session.userId, session.chatId, session.messageId, {
          stateId: slot.stateId, expectedContent: slot.content, expectedReasoning: slot.reasoning, expectedContext: slot.presetContext,
          rendered, ...(complete ? { variables, presetContext } : {}),
          fields: { reasoning: processed.reasoning || null, reasoningCarrier: carrier,
            ...(native.usage ? { usage: native.usage } : {}),
            promptActivation: makePromptActivationSource(rendered.content, slot.context.presetId, complete, complete ? activationSource : undefined),
            generationOutcome: native.finish_reason ? { finish_reason: native.finish_reason, stop_details: native.stop_details, stop_sequence: native.stop_sequence } : null },
        })) throw new Error("The generated reply changed during response processing");
        if (complete) succeeded.set(slot.stateId, { content: rendered.content, reasoning: processed.reasoning, context: presetContext });
      }
      const selected = chats.getMessage(session.userId, session.messageId);
      const result = selected && succeeded.get(selected.extra.variableStateBySwipe?.[selected.swipe_id]?.id);
      const completed = !session.terminal && !session.controller.signal.aborted && !!selected && !!result &&
        selected.content === result.content && (selected.extra.reasoning ?? "") === result.reasoning &&
        isDeepStrictEqual(selected.extra.spindle_metadata?.preset_contexts?.[selected.swipe_id], result.context);
      this.end(session, completed);
      return { messageId: session.messageId, completed };
    } catch (error) {
      this.end(session, false);
      if (session.controller.signal.aborted) return { messageId: session.messageId, completed: false };
      throw error;
    }
  }
}
