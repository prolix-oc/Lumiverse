import type { Message } from "../types/message";
import { createHash } from "node:crypto";
import type { PromptBlock } from "../types/preset";
import type { RegexScript } from "../types/regex-script";
import { matchPromptActivation, readPromptActivation, MAX_ACTIVATION_CONTENT_LENGTH } from "../utils/regex-prompt-activation";
import { resolveActivationFindPattern, type ActivationInputSnapshot } from "../utils/regex-activation-inputs";

type SourceMessage = Pick<Message, "id" | "content" | "is_user" | "extra">;
const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");

/** Stored per swipe. The hash invalidates preserved source when the user edits the message. */
export function makePromptActivationSource(content: string, presetId: string | undefined, complete: boolean, source?: string) {
  return {
    content_hash: contentHash(content),
    preset_id: presetId ?? null,
    complete,
    ...(source !== undefined && source !== content && source.length <= MAX_ACTIVATION_CONTENT_LENGTH ? { source } : {}),
  };
}

export function promptActivationSource(message: SourceMessage, presetId: string): string | null {
  if (message.is_user) return message.content;
  const record = message.extra?.promptActivation;
  if (record && record.content_hash === contentHash(message.content)) {
    if (record.complete !== true || record.preset_id !== presetId) return null;
    return typeof record.source === "string" ? record.source : message.content;
  }
  // Imported, manually written, or edited messages are evaluated from their current text.
  return message.content;
}

/** Category membership follows prompt order, matching the Loom's category normalization. */
export function expandActivationTargets(blocks: PromptBlock[], ids: string[]): string[] {
  const selected = new Set(ids);
  const targets = new Set<string>();
  let selectedCategory = false;
  for (const block of blocks) {
    if (block.marker === "category") selectedCategory = selected.has(block.id);
    if (selected.has(block.id) || selectedCategory) targets.add(block.id);
  }
  return [...targets];
}

export interface PromptActivationState {
  block_id: string;
  enabled: boolean;
  script_id: string;
  message_id?: string;
  value?: string;
}

/**
 * Replay selected history without writing chat/preset state. All mapped blocks start closed,
 * even if a profile enabled them. Message order, script order, then mapping order win conflicts.
 */
export async function applyPromptActivations(
  blocks: PromptBlock[],
  scripts: RegexScript[],
  messages: SourceMessage[],
  presetId: string,
  signal?: AbortSignal,
  inputs: ActivationInputSnapshot = {},
): Promise<{ states: PromptActivationState[]; errors: string[] }> {
  const rules = scripts.flatMap((script) => {
    const config = readPromptActivation(script.metadata);
    return config && !script.disabled && script.preset_id === presetId ? [{
      script, config,
      targets: config.mappings.map((mapping) => expandActivationTargets(blocks, mapping.block_ids)),
    }] : [];
  });
  if (rules.length === 0) return { states: [], errors: [] };
  const states = new Map<string, PromptActivationState>();
  for (const rule of rules) for (const ids of rule.targets) for (const id of ids) {
    states.set(id, { block_id: id, enabled: false, script_id: rule.script.id });
  }
  const visible = messages.filter((message) => !message.extra?.hidden && !message.extra?._loom_inject);
  const lastUser = visible.findLastIndex((message) => message.is_user);
  const lastAssistant = visible.findLastIndex((message) => !message.is_user);
  const errors: string[] = [];
  const failed = new Set<string>();
  // Resolve every rule once from the same pre-render snapshot, even with no history.
  const patterns = new Map<string, string>();
  for (const { script } of rules) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    try {
      patterns.set(script.id, resolveActivationFindPattern(script.find_regex, inputs));
    } catch (error) {
      failed.add(script.id);
      errors.push(`${script.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const radioPeers = new Map<string, string[]>();
  let children: string[] | null = null;
  for (const block of blocks) {
    if (block.marker === "category") children = block.categoryMode === "radio" ? [] : null;
    else if (children) {
      children.push(block.id);
      radioPeers.set(block.id, children);
    }
  }
  for (let index = 0; index < visible.length; index++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const message = visible[index];
    const depth = visible.length - 1 - index;
    for (const rule of rules) {
      const { script, config, targets } = rule;
      if (failed.has(script.id) || message.is_user !== (config.source === "user_input")) continue;
      if (config.lifetime === "latest" && index !== (message.is_user ? lastUser : lastAssistant)) continue;
      if (script.min_depth !== null && depth < script.min_depth) continue;
      if (script.max_depth !== null && depth > script.max_depth) continue;
      const source = promptActivationSource(message, presetId);
      if (source === null) continue;
      try {
        const matches = await matchPromptActivation({ ...script, find_regex: patterns.get(script.id)! }, config, source);
        for (const match of matches) {
          const mapping = config.mappings[match.mapping_index];
          const targetIds = targets[match.mapping_index];
          const selectedRadioPeers = new Set<string[]>();
          for (const id of targetIds) {
            const peers = radioPeers.get(id);
            // Blanket enable keeps the selected child, falling back to the first child.
            if (mapping.enabled && peers && peers.every((peer) => targetIds.includes(peer))) {
              if (selectedRadioPeers.has(peers)) continue;
              selectedRadioPeers.add(peers);
              const preferred = peers.find((peer) => states.get(peer)?.enabled)
                ?? peers.find((peer) => byId.get(peer)?.enabled) ?? peers[0];
              for (const peer of peers) states.set(peer, {
                block_id: peer, enabled: peer === preferred, script_id: script.id, message_id: message.id, value: match.value,
              });
              continue;
            }
            const state = { block_id: id, enabled: mapping.enabled, script_id: script.id, message_id: message.id, value: match.value };
            states.set(id, state);
            if (mapping.enabled) for (const peer of radioPeers.get(id) ?? []) {
              if (peer !== id) states.set(peer, { ...state, block_id: peer, enabled: false });
            }
          }
        }
      } catch (error) {
        failed.add(script.id);
        errors.push(`${script.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  for (const state of states.values()) {
    const block = byId.get(state.block_id);
    if (block) block.enabled = state.enabled;
  }
  return { states: [...states.values()], errors };
}
