import type { MacroEnv } from "../macros/types";
import type { MessagePresetContext } from "../types/preset-context";
import { getPreset } from "./presets.service";
import { resolvePromptVariables } from "./prompt-assembly.service";
import { getMessage } from "./chats.service";
import { readMessagePresetContext } from "../types/preset-context";

export function getMessagePresetContext(userId: string, chatId: string, messageId: string, swipeIndex?: number) {
  const message = getMessage(userId, messageId);
  if (message?.chat_id !== chatId) return null;
  const context = readMessagePresetContext(message.extra, swipeIndex === undefined ? message.swipe_id : swipeIndex);
  return context && getPreset(userId, context.preset_id) ? context : null;
}

/** All preset lookups remain scoped to the message owner. Rendering never commits variables. */
export function applyMessagePresetContext(
  env: MacroEnv, userId: string, context: MessagePresetContext, loadPreset = getPreset,
): boolean {
  const preset = loadPreset(userId, context.preset_id);
  if (!preset) return false;
  env.commit = false;
  env.extra.presetId = preset.id;
  env.extra.presetMetadata = preset.metadata;
  resolvePromptVariables(env, preset.prompt_order, preset);
  const variables = context.variables;
  for (const scope of ["local", "global", "chat"] as const) {
    const values = variables?.[scope];
    if (values && typeof values === "object" && !Array.isArray(values)) {
      env.variables[scope] = new Map(Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    }
  }
  if (variables?.prompt_selections) env.extra.promptVariableSelections = variables.prompt_selections;
  if (variables?.prompt_defaults) env.extra.promptVariableDefaults = variables.prompt_defaults;
  return true;
}
