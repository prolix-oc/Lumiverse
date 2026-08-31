import type { GenerationRequest, GenerationResponse, StreamChunk } from "./types";
import type { ProviderCapabilities } from "./param-schema";

export interface LlmProvider {
  readonly name: string;
  readonly displayName: string;
  readonly defaultUrl: string;
  readonly capabilities: ProviderCapabilities;

  generate(apiKey: string, apiUrl: string, request: GenerationRequest): Promise<GenerationResponse>;

  generateStream(
    apiKey: string,
    apiUrl: string,
    request: GenerationRequest
  ): AsyncGenerator<StreamChunk, void, unknown>;

  validateKey(apiKey: string, apiUrl: string): Promise<boolean>;

  listModels(apiKey: string, apiUrl: string): Promise<string[]>;
}

export type AgentToolCapabilityErrorCode =
  | "provider_tool_calling_unsupported"
  | "provider_tool_continuation_unsupported"
  | "provider_tool_finalization_unsupported";

/** Stable, provider-name-free failure for a feature-active tool preflight. */
export class AgentToolCapabilityError extends Error {
  readonly code: AgentToolCapabilityErrorCode;

  constructor(code: AgentToolCapabilityErrorCode) {
    super(code);
    this.name = "AgentToolCapabilityError";
    this.code = code;
  }
}

/**
 * Feature-active agent loops require the adapter's tool parser and explicit
 * tools-disabled finalization evidence. Native and legacy continuation modes
 * are both valid here; the mode selects the bounded carrier used by the loop.
 * Council's existing path does not use this gate.
 */
export function assertAgentToolCapability(
  provider: Pick<LlmProvider, "capabilities">,
): void {
  const { capabilities } = provider;
  if (!capabilities.toolCalling) {
    throw new AgentToolCapabilityError("provider_tool_calling_unsupported");
  }
  if (capabilities.toolContinuationMode === "unsupported") {
    throw new AgentToolCapabilityError("provider_tool_continuation_unsupported");
  }
  if (!capabilities.toolsDisabledFinalization) {
    throw new AgentToolCapabilityError("provider_tool_finalization_unsupported");
  }
}

/** Existing feature-inactive Council tooling may use either explicit mode. */
export function supportsLegacyCouncilTools(
  capabilities: Pick<ProviderCapabilities, "toolCalling" | "toolContinuationMode">,
): boolean {
  return capabilities.toolCalling && capabilities.toolContinuationMode !== "unsupported";
}
