import { getInferenceSchedulerConfig } from "./config";

export {
  INFERENCE_CLASS_PRIORITY,
  INFERENCE_REQUEST_CLASSES,
  InferencePreemptedError,
  InferenceQueueTimeoutError,
  type InferenceActiveLeaseSnapshot,
  type InferenceLease,
  type InferenceLeaseOptions,
  type InferenceRequestClass,
  type InferenceResourceGroup,
  type InferenceResourceSnapshot,
  type InferenceSchedulerConfig,
  type InferenceSchedulerStatus,
  type InferenceWaitingRequestSnapshot,
} from "./types";

export {
  DEFAULT_INFERENCE_SCHEDULER_CONFIG,
  INFERENCE_SCHEDULER_SETTINGS_KEY,
  getInferenceSchedulerConfig,
  invalidateInferenceSchedulerConfig,
  normalizeInferenceSchedulerConfig,
  putInferenceSchedulerConfig,
} from "./config";

/** Cheap guard for call sites that would otherwise load extra config to find an endpoint. */
export function isInferenceSchedulingEnabled(userId: string): boolean {
  return getInferenceSchedulerConfig(userId).enabled;
}

export {
  acquireInferenceLease,
  getInferenceSchedulerStatus,
  withInferenceLease,
  withInferenceLeaseStream,
  type LeaseHandoff,
} from "./scheduler";

export {
  formatOriginLabel,
  isLocalEndpointOrigin,
  normalizeEndpointOrigin,
} from "./origin";

export { resolveInferenceResource } from "./resources";
export { isInferenceSchedulerHost } from "./runtime";
export { withLeaseAbort } from "./signals";
