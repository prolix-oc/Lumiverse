import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import type { ExtensionInfo, SpindleManifest } from "lumiverse-spindle-types";
import { WorkerHost } from "./worker-host";
import { eventBus } from "../ws/bus";
import { EventType, type EventMessage } from "../ws/events";

const AGENT_RUN_CHANGED = "AGENT_RUN_CHANGED" as EventType;

const OWNER = "agent-event-owner";
const OTHER_USER = "agent-event-other";

type WorkerHostInternals = {
  handleSubscribeEvent: (event: string) => void;
  hasPermission: (permission: string) => boolean;
  postToWorker: (message: unknown) => void;
};

function makeHost(generation: boolean): { internals: WorkerHostInternals; messages: unknown[] } {
  const identifier = generation ? "agent_event_generation" : "agent_event_no_generation";
  const permissions = generation ? ["generation" as const] : [];
  const manifest = {
    version: "1.0.0",
    name: identifier,
    identifier,
    author: "test",
    github: "https://example.test/agent-events",
    homepage: "https://example.test/agent-events",
    permissions,
  } satisfies SpindleManifest;
  const extensionInfo = {
    id: `${identifier}-id`,
    identifier,
    name: identifier,
    version: manifest.version,
    author: manifest.author,
    description: "",
    github: manifest.github,
    homepage: manifest.homepage,
    permissions: [...permissions],
    granted_permissions: [...permissions],
    enabled: true,
    installed_at: 0,
    updated_at: 0,
    has_frontend: false,
    has_backend: true,
    status: "stopped" as const,
    metadata: { install_scope: "user", installed_by_user_id: OWNER },
  } satisfies ExtensionInfo;
  const host = new WorkerHost(extensionInfo.id, manifest, extensionInfo);
  const messages: unknown[] = [];
  const internals = host as unknown as WorkerHostInternals;
  internals.hasPermission = (permission) => generation && permission === "generation";
  internals.postToWorker = (message) => messages.push(message);
  return { internals, messages };
}

function redactedProjection(): Record<string, unknown> {
  return {
    version: 2,
    chatId: "agent-event-chat",
    sequence: 4,
    run: {
      version: 2,
      runId: "agent-event-turn",
      turnId: "agent-event-turn",
      generationId: "agent-event-generation",
      chatId: "agent-event-chat",
      generationType: "normal",
      target: null,
      status: "WORK",
      phase: "WORK",
      revision: 2,
      sequence: 4,
      startedAt: 1,
      updatedAt: 2,
      activity: [{
        version: 2,
        id: "root",
        parentId: null,
        kind: "root",
        actor: "root",
        phase: "WORK",
        status: "running",
        startedAt: 1,
        elapsedMs: 1,
      }],
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1, toolCalls: 0, childInvocations: 0 },
      omission: {
        omittedNodeCount: 0,
        omittedEventCount: 0,
        firstOmittedSequence: null,
        lastOmittedSequence: null,
      },
    },
    omission: {
      omittedNodeCount: 0,
      omittedEventCount: 0,
      firstOmittedSequence: null,
      lastOmittedSequence: null,
    },
  };
}

function browserSocket(subscriptions: Set<string>): ServerWebSocket<unknown> {
  return {
    readyState: 1,
    subscribe(topic: string) { subscriptions.add(topic); },
    unsubscribe(topic: string) { subscriptions.delete(topic); },
  } as unknown as ServerWebSocket<unknown>;
}
describe("Agentic projection EventBus/Spindle boundary", () => {
  test.each([false, true])("does not enter an extension worker (generation=%s)", (generation) => {
    const { internals, messages } = makeHost(generation);
    internals.handleSubscribeEvent(AGENT_RUN_CHANGED);

    eventBus.emit(AGENT_RUN_CHANGED, redactedProjection(), OWNER);

    expect(messages).toEqual([{
      type: "permission_denied",
      permission: "client_only",
      operation: "subscribe_event:AGENT_RUN_CHANGED",
    }]);
  });

  test("publishes a redacted projection only on the authenticated owner's browser topic", () => {
    const subscriptions = new Set<string>();
    const browserEvents: EventMessage[] = [];
    const server = {
      publish(topic: string, data: string): number {
        if (subscriptions.has(topic)) browserEvents.push(JSON.parse(data) as EventMessage);
        return subscriptions.has(topic) ? 1 : 0;
      },
    };
    const socket = browserSocket(subscriptions);
    const payload = redactedProjection();

    eventBus.setServer(server as Parameters<typeof eventBus.setServer>[0]);
    eventBus.addClient(socket, OWNER, "agent-event-session");
    try {
      expect(eventBus.emit(AGENT_RUN_CHANGED, payload, OWNER)).toBe(true);
      expect(eventBus.emit(AGENT_RUN_CHANGED, payload, OWNER, { topic: "system" })).toBe(true);
      expect(eventBus.emit(AGENT_RUN_CHANGED, payload)).toBe(false);
      expect(eventBus.emit(AGENT_RUN_CHANGED, payload, OTHER_USER)).toBe(false);
      expect(browserEvents).toHaveLength(2);
      expect(browserEvents[0]).toMatchObject({
        event: AGENT_RUN_CHANGED,
        userId: OWNER,
        payload,
      });
      expect(JSON.stringify(browserEvents[0])).not.toContain("private work prose");
      expect(JSON.stringify(browserEvents[0])).not.toContain("private args");
      expect(JSON.stringify(browserEvents[0])).not.toContain("private result");
      expect(subscriptions).toContain(`user:${OWNER}`);
      expect(subscriptions).not.toContain(`user:${OTHER_USER}`);
    } finally {
      eventBus.removeClient(socket);
      eventBus.setServer(null as unknown as Parameters<typeof eventBus.setServer>[0]);
    }
  });

  test("generic in-process listeners cannot subscribe while trusted observers remain available", async () => {
    const genericEvents: EventMessage[] = [];
    const trustedEvents: EventMessage[] = [];
    const trustedSignal = Promise.withResolvers<void>();
    const removeGeneric = eventBus.on(AGENT_RUN_CHANGED, (event) => genericEvents.push(event));
    const removeTrusted = eventBus.onInternal(AGENT_RUN_CHANGED, (event) => {
      trustedEvents.push(event);
      trustedSignal.resolve();
    });
    try {
      eventBus.emit(AGENT_RUN_CHANGED, redactedProjection(), OWNER);
      await trustedSignal.promise;
      expect(genericEvents).toHaveLength(0);
      expect(trustedEvents).toHaveLength(1);
    } finally {
      removeGeneric();
      removeTrusted();
    }
  });
});
