export { evaluate } from "./MacroEvaluator";
export { buildEnv, resolveGroupCharacterNames, type BuildEnvContext } from "./MacroEnv";
export { registry } from "./MacroRegistry";
export type {
  MacroEnv,
  MacroHandler,
  MacroDefinition,
  MacroExecContext,
  MacroDiagnostic,
  EvaluateResult,
  AstNode,
} from "./types";

// Definition registrations
import { registerCoreMacros } from "./definitions/primitives";
import { registerNamesMacros } from "./definitions/identity";
import { registerCharacterMacros } from "./definitions/persona-card";
import { registerChatMacros } from "./definitions/conversation";
import { registerTimeMacros } from "./definitions/temporal";
import { registerRandomMacros } from "./definitions/entropy";
import { registerVariableMacros } from "./definitions/vars";
import { registerStateMacros } from "./definitions/runtime";
import { registerReasoningMacros } from "./definitions/cot";
import { registerLumiaMacros } from "./definitions/lumia";
import { registerLoomMacros } from "./definitions/loom";
import { registerLumiEngineMacros } from "./definitions/lumi-engine";
import { registerMemoryMacros } from "./definitions/memory";
import { registerCortexMacros } from "./definitions/cortex";

let initialized = false;

/**
 * Register all built-in macros. Safe to call multiple times — only runs once.
 */
export function initMacros(): void {
  if (initialized) return;
  initialized = true;

  registerCoreMacros();
  registerNamesMacros();
  registerCharacterMacros();
  registerChatMacros();
  registerTimeMacros();
  registerRandomMacros();
  registerVariableMacros();
  registerStateMacros();
  registerReasoningMacros();
  registerLumiaMacros();
  registerLoomMacros();
  registerLumiEngineMacros();
  registerMemoryMacros();
  registerCortexMacros();
}
