import { getProvider } from "../llm/registry";
import type {
  GenerationParameters,
  GenerationRequest,
  LlmMessage,
  ToolDefinition,
} from "../llm/types";
import { connectionSecretKey } from "../services/connections.service";
import {
  DispatchStateError,
  resolveDispatchDescriptor,
  resolveDispatchForSource,
  resolveMainDispatchSnapshot,
  resolveSlotDispatch,
} from "../services/dispatch-state.service";
import { getSecret } from "../services/secrets.service";
import {
  applyProviderReasoningOffSwitch,
  assembleBoundParentPrompt,
  injectReasoningParams,
} from "../services/prompt-assembly.service";
import {
  BoundProviderPreflightError,
  isHostContainmentFatal,
} from "./bound-generation-types";
import type {
  BoundGenerationCallbacks,
  BoundDispatchResolver,
} from "./bound-generation";
import type {
  BoundDispatchProviderResult,
  BoundDispatchResolution,
  BoundPromptBlockDTO,
  ConnectionDispatchDescriptorDTO,
  ParentGenerationSnapshot,
} from "./bound-generation-types";
import type { EffectiveDispatchContext } from "../services/dispatch-state.service";

interface SignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

/** Host-owned inputs for one authenticated callback invocation. */
export interface HostBoundGenerationCallbacksInput {
  readonly parent: ParentGenerationSnapshot;
  readonly extensionIdentifier: string;
  readonly signal: AbortSignal;
  /** Already-resolved Main credential; empty is valid for keyless providers. */
  readonly mainApiKey: string;
}

export interface HostBoundGenerationCallbacks extends BoundGenerationCallbacks {
  readonly inspectDispatch: (connectionId: string) => Promise<ConnectionDispatchDescriptorDTO | null>;
}

interface SignalLease {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSignalLike(value: unknown): value is SignalLike {
  return typeof value === "object" && value !== null &&
    typeof (value as SignalLike).aborted === "boolean" &&
    typeof (value as SignalLike).addEventListener === "function" &&
    typeof (value as SignalLike).removeEventListener === "function";
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function assertFactoryInput(input: HostBoundGenerationCallbacksInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new TypeError("Bound generation callback input is required");
  if (typeof input.parent !== "object" || input.parent === null || input.parent.kind !== "parent-generation") throw new TypeError("Bound generation callbacks require a parent snapshot");
  requireText(input.extensionIdentifier, "extensionIdentifier");
  if (!isSignalLike(input.signal)) throw new TypeError("signal must be an AbortSignal");
  if (typeof input.mainApiKey !== "string") throw new TypeError("mainApiKey must be a string");
}

function abortError(): Error {
  const error = new Error("Bound generation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/** Compose one request signal under the authoritative callback signal. */
function leaseSignal(hostSignal: AbortSignal, requestSignal: AbortSignal): SignalLease {
  if (hostSignal === requestSignal) {
    throwIfAborted(hostSignal);
    return { signal: hostSignal, dispose: () => {} };
  }
  if (!isSignalLike(requestSignal)) throw new TypeError("request signal must be an AbortSignal");
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort((source as AbortSignal & { reason?: unknown }).reason);
  };
  const onHostAbort = (): void => abortFrom(hostSignal);
  const onRequestAbort = (): void => abortFrom(requestSignal);
  if (hostSignal.aborted) abortFrom(hostSignal);
  else if (requestSignal.aborted) abortFrom(requestSignal);
  else {
    hostSignal.addEventListener("abort", onHostAbort, { once: true });
    requestSignal.addEventListener("abort", onRequestAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      hostSignal.removeEventListener("abort", onHostAbort);
      requestSignal.removeEventListener("abort", onRequestAbort);
    },
  };
}

function parentDispatchContext(parent: ParentGenerationSnapshot): EffectiveDispatchContext & { readonly connectionId?: string } {
  const context = parent.main.authoritativeContext;
  const connectionId = typeof context.connectionId === "string" ? context.connectionId : undefined;
  const presetId = typeof context.presetId === "string" ? context.presetId : undefined;
  return {
    ...(connectionId === undefined ? {} : { connectionId }),
    ...(presetId === undefined ? {} : { presetId }),
    reasoning: parent.main.reasoning,
    settings: context.settings,
  };
}

function sameDescriptor(left: ConnectionDispatchDescriptorDTO, right: ConnectionDispatchDescriptorDTO): boolean {
  return left.connectionId === right.connectionId &&
    left.connectionName === right.connectionName &&
    left.provider === right.provider &&
    left.model === right.model &&
    left.endpointOrigin === right.endpointOrigin &&
    left.dispatchKind === right.dispatchKind &&
    left.connectionDispatchRevision === right.connectionDispatchRevision;
}

function requireConcreteResolution(parent: ParentGenerationSnapshot, resolution: BoundDispatchResolution): BoundDispatchResolution {
  if (!isRecord(resolution)) throw new Error("Bound dispatch resolution is invalid");
  if (resolution.source === "main") {
    if (resolution.connectionId !== parent.main.descriptor.connectionId ||
      resolution.dispatchRevision !== parent.main.dispatchRevision ||
      !sameDescriptor(resolution.descriptor, parent.main.descriptor)) {
      throw new Error("Bound Main dispatch resolution does not match the parent snapshot");
    }
    return resolution;
  }
  if (resolution.source !== "slot" || typeof resolution.connectionId !== "string" || resolution.connectionId.trim().length === 0 ||
    resolution.descriptor.dispatchKind !== "concrete" || resolution.descriptor.connectionId !== resolution.connectionId ||
    resolution.descriptor.connectionDispatchRevision !== resolution.dispatchRevision) {
    throw new Error("Bound slot dispatch resolution is invalid");
  }
  return resolution;
}

function normalizeReasoning(
  parameters: Readonly<Record<string, unknown>>,
  reasoning: Readonly<Record<string, unknown>>,
  providerName: string,
  model: string,
  parentReasoning: Readonly<Record<string, unknown>>,
): GenerationParameters {
  const output = { ...parameters } as GenerationParameters;
  const source = typeof reasoning.source === "string" ? reasoning.source : undefined;
  const effective = source === "inherit" ? parentReasoning : reasoning;
  if (source === "off") {
    applyProviderReasoningOffSwitch(output, providerName, model);
    return output;
  }
  if (effective.apiReasoning === true) {
    const effort = typeof effective.reasoningEffort === "string" ? effective.reasoningEffort : typeof effective.effort === "string" ? effective.effort : "auto";
    const thinkingDisplay = typeof effective.thinkingDisplay === "string" ? effective.thinkingDisplay : undefined;
    if (effort !== "auto" || providerName === "moonshot" || providerName === "zai") injectReasoningParams(output, providerName, effort, model, thinkingDisplay);
  } else if (effective.apiReasoning === false) {
    applyProviderReasoningOffSwitch(output, providerName, model);
  }
  return output;
}


function mapResolution(resolved: {
  readonly source: "main" | "slot";
  readonly connectionId: string;
  readonly descriptor: ConnectionDispatchDescriptorDTO;
  readonly dispatchRevision: string;
}): BoundDispatchResolution {
  return {
    source: resolved.source,
    connectionId: resolved.connectionId,
    descriptor: resolved.descriptor,
    dispatchRevision: resolved.dispatchRevision,
  };
}

/** Dispatch resolution always consults the current host authority. */
function makeDispatchResolver(parent: ParentGenerationSnapshot, hostSignal: AbortSignal): BoundDispatchResolver {
  return async ({ source }): Promise<BoundDispatchResolution> => {
    throwIfAborted(hostSignal);
    const context = parentDispatchContext(parent);
    if (source.source === "main") {
      if (source.expectedConnectionDispatchRevision !== parent.main.dispatchRevision) throw new Error("Bound Main dispatch revision is stale");
      const current = resolveMainDispatchSnapshot(parent.userId, context);
      if (current.source !== "main" || current.dispatchRevision !== source.expectedConnectionDispatchRevision || !sameDescriptor(current.descriptor, parent.main.descriptor)) throw new Error("Bound Main dispatch changed before work");
      return mapResolution(current);
    }
    if (source.source !== "slot") throw new Error("Bound dispatch source is invalid");
    requireText(source.connectionId, "connectionId");
    requireText(source.expectedConnectionDispatchRevision, "connectionDispatchRevision");
    const current = resolveSlotDispatch(parent.userId, source.connectionId, source.expectedConnectionDispatchRevision, context);
    throwIfAborted(hostSignal);
    return mapResolution(current);
  };
}

/**
 * Create the host-owned callback set for one authenticated invocation. Worker
 * payloads supply only prompt data and revision/source selectors; user/chat,
 * credentials, current records, and cancellation remain host-owned.
 */
export function createHostBoundGenerationCallbacks(input: HostBoundGenerationCallbacksInput): HostBoundGenerationCallbacks {
  assertFactoryInput(input);
  const parent = input.parent;
  const hostSignal = input.signal;
  const mainApiKey = input.mainApiKey;
  const resolveDispatch = makeDispatchResolver(parent, hostSignal);

  const inspectDispatch: HostBoundGenerationCallbacks["inspectDispatch"] = async (connectionId) => {
    throwIfAborted(hostSignal);
    const id = requireText(connectionId, "connectionId");
    try {
      const resolved = resolveDispatchDescriptor(parent.userId, {
        source: "slot",
        connectionId: id,
      });
      throwIfAborted(hostSignal);
      return resolved.descriptor;
    } catch (error) {
      if (error instanceof DispatchStateError && (error.code === "DISPATCH_CONNECTION_NOT_FOUND" || error.code === "DISPATCH_CONNECTION_ROULETTE_UNSUPPORTED")) return null;
      throw error;
    }
  };

  const assemble: BoundGenerationCallbacks["assemble"] = async ({ blocks, promptVariableValues, signal: requestSignal, hookFailureMode, macroFailureMode }) => {
    throwIfAborted(hostSignal);
    const leased = leaseSignal(hostSignal, requestSignal);
    try {
      throwIfAborted(leased.signal);
      return await assembleBoundParentPrompt({
        snapshot: parent,
        blocks: blocks as readonly BoundPromptBlockDTO[],
        promptVariableValues,
        signal: leased.signal,
        hookFailureMode,
        macroFailureMode,
      });
    } finally {
      leased.dispose();
    }
  };

  const provider: BoundGenerationCallbacks["provider"] = async ({ resolution, messages, parameters, reasoning, tools, signal: requestSignal }) => {
    const checked = requireConcreteResolution(parent, resolution);
    throwIfAborted(hostSignal);
    const leased = leaseSignal(hostSignal, requestSignal);
    let providerInvoked = false;
    try {
      throwIfAborted(leased.signal);
      const context = parentDispatchContext(parent);
      let current = checked.source === "main"
        ? resolveDispatchForSource(parent.userId, {
            source: "main",
            expectedConnectionDispatchRevision: checked.dispatchRevision,
            ...context,
          })
        : resolveSlotDispatch(parent.userId, checked.connectionId, checked.dispatchRevision, context);
      if (current.source !== checked.source || current.connectionId !== checked.connectionId || current.dispatchRevision !== checked.dispatchRevision || !sameDescriptor(current.descriptor, checked.descriptor)) throw new Error("Bound dispatch changed before provider invocation");
      throwIfAborted(leased.signal);
      let apiKey = mainApiKey;
      if (checked.source === "slot") {
        apiKey = (await getSecret(parent.userId, connectionSecretKey(checked.connectionId))) ?? "";
        throwIfAborted(leased.signal);
        current = resolveSlotDispatch(parent.userId, checked.connectionId, checked.dispatchRevision, context);
        if (current.source !== "slot" || current.connectionId !== checked.connectionId || current.dispatchRevision !== checked.dispatchRevision || !sameDescriptor(current.descriptor, checked.descriptor)) throw new Error("Bound slot dispatch changed before provider invocation");
      }
      const adapter = getProvider(checked.descriptor.provider);
      if (!adapter) throw new Error(`Unknown provider: ${checked.descriptor.provider}`);
      const outboundParameters = normalizeReasoning(parameters, reasoning, checked.descriptor.provider, checked.descriptor.model, parent.main.reasoning);
      const request: GenerationRequest = {
        messages: messages as unknown as LlmMessage[],
        model: checked.descriptor.model,
        parameters: outboundParameters,
        tools: tools as unknown as ToolDefinition[],
        signal: leased.signal,
      };
      providerInvoked = true;
      const response = await adapter.generate(apiKey, checked.descriptor.endpointOrigin, request);
      throwIfAborted(leased.signal);
      return {
        response,
        terminalResponse: true,
        usage: response.usage,
      } satisfies BoundDispatchProviderResult;
    } catch (error) {
      if (!providerInvoked && !isHostContainmentFatal(error)) throw new BoundProviderPreflightError(error);
      throw error;
    } finally {
      leased.dispose();
    }
  };

  return Object.freeze({
    resolveDispatch,
    assemble,
    provider,
    inspectDispatch,
  });
}
