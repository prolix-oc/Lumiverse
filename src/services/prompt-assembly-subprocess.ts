import { runIsolateProcessEntrypoint } from "./isolate-process-entrypoint";
import { runAssemblyRequest } from "./prompt-assembly-worker";
import type { AssemblyContext } from "../llm/types";

type PromptAssemblySubprocessContext = Omit<
  AssemblyContext,
  "signal" | "prefetched" | "agentRuntimeOwner" | "createAgentRuntimeOwner"
>;

await runIsolateProcessEntrypoint({
  handlers: {
    assemble_prompt: (payload) => runAssemblyRequest(payload as PromptAssemblySubprocessContext),
  },
});
