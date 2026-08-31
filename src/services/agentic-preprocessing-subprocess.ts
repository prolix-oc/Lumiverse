import { runIsolateProcessEntrypoint } from "./isolate-process-entrypoint";
import { handleCompileAgentAssembly } from "./agentic-assembly-compiler";
import { prepareAgentRenderV1 } from "./agentic-render-preparation.service";
import type { RenderPreparationInputV1 } from "../types/agent-preprocessing";

await runIsolateProcessEntrypoint({
  handlers: {
    compile_agent_assembly: (payload) => handleCompileAgentAssembly(payload),
    prepare_agent_render: (payload) => prepareAgentRenderV1(payload as RenderPreparationInputV1),
  },
});
