import { afterEach, describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { JSDOM } from "jsdom";

const config = {
  enabled: true,
  autoWarmup: false,
  presetMode: "advanced" as const,
  entityTracking: true,
  entityExtractionMode: "sidecar" as const,
  thoughtMarkers: { prefix: "", suffix: "" },
  salienceScoring: true,
  salienceScoringMode: "sidecar" as const,
  queryGeneration: {
    primary: { connectionProfileId: "primary-conn", model: "primary-model" },
    secondary: { connectionProfileId: "secondary-conn", model: "secondary-model" },
    fallbacks: [{ connectionProfileId: "tertiary-conn", model: "tertiary-model" }],
  },
  memorySummarization: {
    primary: { connectionProfileId: "primary-conn", model: "primary-model" },
    secondary: null,
  },
  sidecar: {
    connectionProfileId: "primary-conn",
    model: "primary-model",
    temperature: 0.1,
    topP: 1,
    maxTokens: 4096,
    chunkBatchSize: 5,
    rebuildConcurrency: 3,
    requestsPerMinute: 0,
  },
  formatterMode: "shadow" as const,
  useChatMemoryFormatting: true,
  contextTokenBudget: 600,
  retrievalTimeoutMs: 60000,
  sidecarTimeoutMs: 60000,
  sidecarReliability: {
    fallback: "heuristic" as const,
    maxRetries: 0,
    retryDelayMs: 500,
    arbitratesHeuristics: false,
    gradesExistingRecords: false,
  },
  consolidation: {
    enabled: false,
    chunkThreshold: 40,
    chunksPerConsolidation: 10,
    arcThreshold: 5,
    useSidecar: false,
    maxTokensPerSummary: 300,
  },
  retrieval: {
    useFusedScoring: true,
    emotionalResonance: true,
    diversitySelection: true,
    entityContextInjection: true,
    relationshipInjection: false,
    arcInjection: false,
    maxEntitySnapshots: 8,
    maxRelationships: 12,
  },
  decay: {
    halfLifeTurns: 500,
    reinforcementWeight: 0.1,
    coreMemoryThreshold: 0.7,
    coreMemoryFlags: [],
  },
  entityPruning: {
    enabled: true,
    staleAfterMessages: 200,
    minConfidence: 0.4,
  },
  entityWhitelist: [],
  nonProseScaffoldTags: [],
  entityExtractionFilters: {
    character: { protectedTerms: [], rejectedTerms: [], cleanupPatterns: [] },
    location: { protectedTerms: [], rejectedTerms: [], cleanupPatterns: [] },
    item: { protectedTerms: [], rejectedTerms: [], cleanupPatterns: [] },
    faction: { protectedTerms: [], rejectedTerms: [], cleanupPatterns: [] },
    concept: { protectedTerms: [], rejectedTerms: [], cleanupPatterns: [] },
    event: { protectedTerms: [], rejectedTerms: [], cleanupPatterns: [] },
  },
};

const storeState = {
  addToast: () => undefined,
  openModal: () => undefined,
  profiles: [{ id: "primary-conn", name: "Primary", metadata: {} }],
  activeChatId: "chat-1",
};

const useStore = Object.assign(
  (selector: (value: typeof storeState) => unknown) => selector(storeState),
  { getState: () => storeState },
);

mock.module("@/store", () => ({ useStore }));
mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));
const memoryCortexApi = {
  getConfig: async () => structuredClone(config),
  updateConfig: async (patch: Record<string, unknown>) => ({ ...config, ...patch }),
  applyPreset: async () => structuredClone(config),
  getStats: async () => null,
  getRebuildStatus: async () => ({ status: "idle" }),
  getHealth: async () => ({
    sidecar: {
      required: true,
      configured: true,
      ready: false,
      availability: "unavailable",
      connectivity: { attempted: false, success: null, message: "", timedOut: false },
    },
  }),
  getIngestionStatus: async () => ({ sidecarState: "unavailable" }),
  rebuild: async () => ({ status: "started" }),
};

const resolveCortexSidecarVisibility = (options: {
  health?: { availability?: string; ready?: boolean; connectivity?: { timedOut?: boolean } } | null;
  ingestion?: { sidecarState?: string | null } | null;
  profileMissing?: boolean;
}) => {
  if (options.health?.availability === "timeout" || options.health?.connectivity?.timedOut || options.ingestion?.sidecarState === "timeout") {
    return "timeout";
  }
  if (options.profileMissing || options.health?.availability === "unavailable" || options.health?.ready === false || options.ingestion?.sidecarState === "unavailable") {
    return "unavailable";
  }
  return options.health?.availability === "ok" ? "ok" : null;
};

mock.module("@/api/memory-cortex", () => ({ memoryCortexApi, resolveCortexSidecarVisibility }));
mock.module("../../api/memory-cortex", () => ({ memoryCortexApi, resolveCortexSidecarVisibility }));
mock.module("@/api/client", () => ({
  get: async () => structuredClone(config),
  put: async (_url: string, body: unknown) => body,
  post: async () => ({}),
  del: async () => ({}),
  patch: async () => ({}),
}));
mock.module("../../api/client", () => ({
  get: async () => structuredClone(config),
  put: async (_url: string, body: unknown) => body,
  post: async () => ({}),
  del: async () => ({}),
  patch: async () => ({}),
}));
mock.module("@/api/connectionModels", () => ({
  fetchConnectionModels: async () => ({ models: ["primary-model", "secondary-model"], labels: {} }),
}));
mock.module("../../api/connectionModels", () => ({
  fetchConnectionModels: async () => ({ models: ["primary-model", "secondary-model"], labels: {} }),
}));
mock.module("@/components/panels/connection-manager/ModelCombobox", () => ({
  default: ({ value, placeholder }: { value: string; placeholder?: string }) =>
    createElement("input", { defaultValue: value, placeholder }),
}));
mock.module("@/components/shared/ConnectionSelect", () => ({
  default: ({ value, ariaLabel }: { value: string; ariaLabel?: string }) =>
    createElement("select", { "aria-label": ariaLabel, defaultValue: value },
      createElement("option", { value: "" }, "none"),
      createElement("option", { value: "primary-conn" }, "primary"),
      createElement("option", { value: "secondary-conn" }, "secondary"),
    ),
}));
mock.module("@/components/shared/NumericInput", () => ({
  default: ({ value }: { value: number }) => createElement("input", { defaultValue: String(value) }),
}));
mock.module("@/components/shared/Toggle", () => ({
  Toggle: { Checkbox: () => createElement("input", { type: "checkbox" }) },
}));
mock.module("@/lib/reasoning-binding", () => ({ getReasoningBindingSummary: () => "" }));
mock.module("@/ws/client", () => ({ wsClient: { on: () => () => undefined } }));
mock.module("@/ws/events", () => ({ EventType: { CORTEX_REBUILD_PROGRESS: "cortex_rebuild_progress" } }));
mock.module("./MemoryCortexSettings.module.css", () => ({
  default: new Proxy({}, { get: (_t, key) => String(key) }),
}));

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://lumiverse.test/" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { default: MemoryCortexSettings } = await import("./MemoryCortexSettings");

describe("MemoryCortexSettings secondary fallback", () => {
  let root: Root | null = null;
  let host: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => { root?.unmount(); });
    host?.remove();
    root = null;
    host = null;
  });

  test("renders secondary profile controls and unavailable state", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(createElement(MemoryCortexSettings));
    });

    const deadline = Date.now() + 1500;
    while (Date.now() < deadline && !host.querySelector('[data-testid="cortex-query-secondary-connection"]')) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(host.querySelector('[data-testid="cortex-query-secondary-connection"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cortex-query-fallback-1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cortex-summary-secondary-connection"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cortex-query-add-fallback"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="cortex-summary-add-fallback"]')).not.toBeNull();
    expect(host.querySelector('[data-cortex-sidecar-state="unavailable"]')).not.toBeNull();
  });
});
