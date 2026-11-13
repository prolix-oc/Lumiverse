import type { ProviderRequestObserver, ProviderRequestSnapshot, ProviderResponseObserver, RequestOrigin } from "../llm/request-observer";
import { collectRequestCredentials } from "../utils/redact-request";
import { omitCaptureMedia } from "../utils/omit-capture-media";
import { SYSTEM_SECRET_PRINCIPAL } from "./secrets.service";
import { getSetting, putSetting } from "./settings.service";
import { REQUEST_HISTORY_LIMIT, REQUEST_HISTORY_MAX_BODY_BYTES, REQUEST_HISTORY_MAX_CAPTURE_SNAPSHOT_BYTES, REQUEST_HISTORY_SETTING, requestHistoryStore, type RequestHistoryContext } from "./request-history-store";

function enabled(userId: string): boolean {
  const active = getSetting(userId, REQUEST_HISTORY_SETTING)?.value === true;
  if (!active) requestHistoryStore.clear(userId);
  return active;
}

export function getRequestHistory(userId: string) {
  return { enabled: enabled(userId), limit: REQUEST_HISTORY_LIMIT, entries: requestHistoryStore.list(userId) };
}

export function getRequestHistoryEntry(userId: string, id: string) {
  return enabled(userId) ? requestHistoryStore.get(userId, id) : null;
}

export function setRequestHistoryTracking(userId: string, active: boolean) {
  putSetting(userId, REQUEST_HISTORY_SETTING, active);
  if (!active) requestHistoryStore.clear(userId);
  return getRequestHistory(userId);
}

export function clearRequestHistory(userId: string) {
  requestHistoryStore.clear(userId);
  return getRequestHistory(userId);
}

export function createRequestObserver(
  userId: string,
  origin: RequestOrigin,
  context: Omit<RequestHistoryContext, "origin"> = {},
  credentials: readonly string[] = [],
): ProviderRequestObserver {
  return (snapshot) => {
    // Check at dispatch rather than at assembly time.
    if (!enabled(userId)) return;
    let secrets = [...credentials, ...snapshot.credentials];
    const id = requestHistoryStore.record(userId, { ...context, origin }, { ...snapshot, credentials: secrets });
    if (!id) return;
    if (typeof snapshot.body === "string" && Buffer.byteLength(snapshot.body) <= (origin.sensitiveMedia ? REQUEST_HISTORY_MAX_CAPTURE_SNAPSHOT_BYTES : REQUEST_HISTORY_MAX_BODY_BYTES)) {
      try {
        const body: unknown = JSON.parse(snapshot.body);
        secrets = collectRequestCredentials(origin.sensitiveMedia ? omitCaptureMedia(body) : body, secrets);
      } catch { /* Resolved transport credentials still apply. */ }
    }
    let settled = false;
    const isActive = () => {
      const active = !settled && requestHistoryStore.has(userId, id) && enabled(userId);
      if (!active) secrets = [];
      return active;
    };
    return {
      isActive,
      headers: (status) => { if (isActive()) requestHistoryStore.responseHeaders(userId, id, status); },
      complete: (response) => {
        try { if (isActive()) requestHistoryStore.completeResponse(userId, id, response, secrets); }
        finally { settled = true; secrets = []; }
      },
    };
  };
}

export function observeSidecarBrokerRequest(
  broker: { authenticatedSubject: string; installationId: string; correlationId: string; providerId?: string },
  snapshot: ProviderRequestSnapshot,
): ProviderResponseObserver | void {
  // A system-owned broker has no authenticated human to attribute a record to.
  if (!broker.authenticatedSubject || broker.authenticatedSubject === SYSTEM_SECRET_PRINCIPAL) return;
  return createRequestObserver(broker.authenticatedSubject, {
    kind: "extension", name: `Sidecar · ${broker.providerId ?? broker.installationId}`,
    operation: "broker", extensionId: broker.installationId,
  }, { generationId: broker.correlationId })(snapshot);
}
