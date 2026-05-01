import type { ToolDefinition } from "../../llm/types";
import type { MemoryCortexConfig } from "./config";
import { getToolChoiceParams } from "./salience-sidecar";
import { waitForCortexSidecarRpmSlot } from "./sidecar-rpm-gate";

export type CortexGenerateRawFn = (opts: {
  connectionId: string;
  messages: Array<{ role: string; content: string }>;
  parameters: Record<string, any>;
  tools?: ToolDefinition[];
  signal?: AbortSignal;
}) => Promise<{ content: string; tool_calls?: Array<{ name: string; args: Record<string, unknown> }> }>;

export function createCortexSidecarGenerateRawAdapter(options: {
  userId: string;
  sidecarProvider: string;
  cortexConfig: MemoryCortexConfig;
}): CortexGenerateRawFn {
  const { userId, sidecarProvider, cortexConfig } = options;

  return async (opts) => {
    await waitForCortexSidecarRpmSlot({
      userId,
      provider: sidecarProvider,
      requestsPerMinute: cortexConfig.sidecar?.requestsPerMinute,
      signal: opts.signal,
    });

    const { quietGenerate } = await import("../generate.service");
    const toolChoiceParams = opts.tools?.length
      ? getToolChoiceParams(sidecarProvider)
      : {};
    const sidecarParams: Record<string, any> = {
      temperature: cortexConfig.sidecar?.temperature ?? 0.1,
      top_p: cortexConfig.sidecar?.topP ?? 1.0,
      max_tokens: cortexConfig.sidecar?.maxTokens ?? 4096,
      ...toolChoiceParams,
      ...opts.parameters,
    };
    if (cortexConfig.sidecar?.model) sidecarParams.model = cortexConfig.sidecar.model;

    const result = await quietGenerate(userId, {
      connection_id: opts.connectionId,
      messages: opts.messages as any,
      parameters: sidecarParams,
      tools: opts.tools,
      signal: opts.signal,
    });

    return {
      content: typeof result.content === "string" ? result.content : "",
      tool_calls: result.tool_calls,
    };
  };
}
