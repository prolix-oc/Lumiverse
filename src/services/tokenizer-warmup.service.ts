import { canUsePromptAssemblyWorker, warmPromptAssemblyTokenizer } from "./prompt-assembly-worker-client";
import { warmTokenizerForModel } from "./tokenizer.service";

/** Warm the runtime that will assemble prompts; failures must not block selection. */
export function warmAssemblyTokenizer(modelId: string, chatId: string | null): void {
  if (canUsePromptAssemblyWorker()) warmPromptAssemblyTokenizer(modelId, chatId);
  else void warmTokenizerForModel(modelId);
}
