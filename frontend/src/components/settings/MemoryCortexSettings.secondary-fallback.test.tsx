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
  replaceConsolidatedMessagesInContext: false,
  replaceArcSummariesInContext: false,
  contextTokenBudget: 600,
  retrievalTimeoutMs: 60000,
  sidecarTimeoutMs: 60000,
  sidecarReliability: {
    fallback: "heuristic" as const,
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
  extensions: [{ identifier: "lumiverse_suite", enabled: true, has_frontend: true }],
  profiles: [{ id: "primary-conn", name: "Primary", metadata: {} }],
  decisionProfiles: [] as Array<{ id: string; name: string; model: string; is_default: boolean }>,
  activeChatId: "chat-1",
};

const useStore = Object.assign(
  (selector: (value: typeof storeState) => unknown) => selector(storeState),
  { getState: () => storeState },
);

mock.module("@/store", () => ({ useStore }));
const translate = (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key;
mock.module("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));
// Literal endpoint payloads written through the API surface the component calls.
const patches: Array<Record<string, unknown>> = [];

// Mirrors the real API: updateConfig persists the patch, returns the full merged
// config, and getConfig reads back that persisted state rather than the pristine base.
let persistedConfig: typeof config = structuredClone(config);
const resetPersistedConfig = () => { persistedConfig = structuredClone(config); };

const memoryCortexApi = {
  getConfig: async () => structuredClone(persistedConfig),
  updateConfig: async (patch: Record<string, unknown>) => {
    patches.push(patch);
    persistedConfig = { ...persistedConfig, ...patch };
    return structuredClone(persistedConfig);
  },
  applyPreset: async () => structuredClone(persistedConfig),
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
  get: async () => structuredClone(persistedConfig),
  put: async (_url: string, body: unknown) => body,
  post: async () => ({}),
  del: async () => ({}),
  patch: async () => ({}),
}));
mock.module("../../api/client", () => ({
  get: async () => structuredClone(persistedConfig),
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
  default: ({ value, ariaLabel, onChange, kind, modelValue, seedDefaultModel }: {
    value: string;
    kind?: string;
    ariaLabel?: string;
    onChange: (id: string) => void;
    modelValue?: string;
    seedDefaultModel?: boolean;
  }) =>
    createElement("select", {
      "aria-label": ariaLabel,
      "data-kind": kind,
      "data-model-value": modelValue,
      "data-seed-model": String(seedDefaultModel),
      value,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    },
      createElement("option", { value: "" }, "none"),
      createElement("option", { value: "primary-conn" }, "primary"),
      createElement("option", { value: "secondary-conn" }, "secondary"),
      createElement("option", { value: "decision-conn" }, "decision"),
    ),
}));
mock.module("@/components/shared/NumericInput", () => ({
  default: ({ value, onChange, integer: _integer, commitOnBlur: _commit, ...props }: any) => createElement("input", {
    ...props, type: "number", defaultValue: String(value),
    onInput: (event: any) => onChange(event.currentTarget.valueAsNumber),
  }),
}));
mock.module("@/components/shared/Toggle", () => ({
  Toggle: { Checkbox: ({ checked, disabled, label, hint, onChange }: {
    checked: boolean; disabled?: boolean; label?: string; hint?: string; onChange: (value: boolean) => void;
  }) => createElement("input", { type: "checkbox", checked, disabled, "aria-label": label, title: hint,
    onChange: (event: { target: { checked: boolean } }) => onChange(event.target.checked) }) },
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

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    host?.remove();
    root = null;
    host = null;
    patches.length = 0;
    resetPersistedConfig();
    storeState.decisionProfiles = [];
  });

  // Waits for a condition to hold while letting pending async work settle inside
  // the act scope, so every state update it drives is flushed by the time it returns.
  const waitFor = async (condition: () => boolean, timeoutMs = 1500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (condition()) return;
      await act(async () => {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
        await Promise.resolve();
      });
    }
    if (!condition()) {
      throw new Error("waitFor timed out waiting for the expected DOM condition");
    }
  };

  const mount = async (): Promise<HTMLDivElement> => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    host = el;
    root = createRoot(el);
    await act(async () => {
      root!.render(createElement(MemoryCortexSettings));
      await Promise.resolve();
    });
    await waitFor(() => el.querySelector('[data-testid="cortex-query-add-fallback"]') !== null || el.querySelector('[aria-label="memoryCortex.decisionConnection"]') !== null);
    return el;
  };

  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  };

  const changeSelect = async (select: HTMLSelectElement, value: string) => {
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  };

  // Counts picker rows via the field testid that only a row carries:
  // `<prefix>-secondary-connection` for the first row, `<prefix>-fallback-<n>`
  // for the rest. Remove controls and the Add button never match.
  const count = (h: HTMLDivElement, prefix: string) =>
    [...h.querySelectorAll("[data-testid]")]
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => new RegExp(`^${prefix}-(secondary-connection|fallback-[1-9][0-9]*)$`).test(id)).length;

  const picker = (h: HTMLDivElement, testId: string) =>
    h.querySelector(`[data-testid="${testId}"]`);

  const removeBtn = (h: HTMLDivElement, testId: string) =>
    h.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

  const selectIn = (h: HTMLDivElement, testId: string) =>
    h.querySelector<HTMLSelectElement>(`[data-testid="${testId}"] select`);

  test("Decision review is configurable without a generative sidecar", async () => {
    storeState.decisionProfiles = [{ id: "decision-conn", name: "Decision", model: "decision-model", is_default: true }];
    persistedConfig = { ...structuredClone(config), sidecar: { ...config.sidecar, connectionProfileId: null },
      sidecarReliability: { ...config.sidecarReliability, arbitratesHeuristics: true },
      arbitration: { backend: "decision", connectionProfileId: null, model: null, timeoutMs: 30000, requestsPerMinute: 0, minConfidence: 0.8 },
    } as typeof config;
    const h = await mount();
    const select = h.querySelector<HTMLSelectElement>('[aria-label="memoryCortex.decisionConnection"]');
    expect(select?.getAttribute("data-kind")).toBe("decision");
    await changeSelect(select!, "decision-conn");
    expect(patches.at(-1)).toMatchObject({ arbitration: { backend: "decision", connectionProfileId: "decision-conn", minConfidence: 0.8 } });
  });

  test("consolidation intervals are visible and persist independently with their units", async () => {
    const h = await mount();
    await click(h.querySelector('[aria-label="memoryCortex.enableConsolidation"]'));
    for (const [field, initial, value] of [["chunkThreshold", 40, 12], ["chunksPerConsolidation", 10, 6], ["arcThreshold", 5, 3]] as const) {
      const input = h.querySelector<HTMLInputElement>(`[data-testid="cortex-consolidation-${field}"]`)!;
      expect(input).not.toBeNull();
      expect(input.value).toBe(String(initial));
      expect(input.min).toBe("1");
      await act(async () => {
        input.value = String(value);
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(persistedConfig.consolidation).toEqual({ ...config.consolidation,
      enabled: true, chunkThreshold: 12, chunksPerConsolidation: 6, arcThreshold: 3,
    });
    expect(h.textContent).toContain("memoryCortex.consolidationIntervalHint");
  });

  test("history replacement toggles persist independently of consolidation generation", async () => {
    const h = await mount();
    const scene = h.querySelector<HTMLInputElement>('[aria-label="memoryCortex.replaceConsolidatedMessagesInContext"]');
    const arc = h.querySelector<HTMLInputElement>('[aria-label="memoryCortex.replaceArcSummariesInContext"]');
    expect(scene?.checked).toBe(false);
    expect(arc?.checked).toBe(false);
    await click(scene);
    expect(patches.at(-1)).toEqual({ replaceConsolidatedMessagesInContext: true });
    await click(arc);
    expect(patches.at(-1)).toEqual({ replaceArcSummariesInContext: true });
    expect(persistedConfig.replaceConsolidatedMessagesInContext).toBe(true);
    expect(persistedConfig.replaceArcSummariesInContext).toBe(true);
    expect(persistedConfig.consolidation.enabled).toBe(false);
    await click(scene);
    expect(persistedConfig.replaceConsolidatedMessagesInContext).toBe(false);
    expect(persistedConfig.replaceArcSummariesInContext).toBe(true);
  });

  test("candidate review cannot be enabled without a Decision connection", async () => {
    const h = await mount();
    const toggle = h.querySelector<HTMLInputElement>('[aria-label="memoryCortex.arbitratesHeuristics"]');
    expect(toggle?.disabled).toBe(true);
    expect(toggle?.checked).toBe(false);
    expect(toggle?.title).toBe("memoryCortex.arbitrationNeedsConnection");
    expect(h.querySelector('[aria-label="memoryCortex.arbitrationBackend"]')).toBeNull();
    expect(h.querySelector('[aria-label="memoryCortex.decisionConnection"]')).toBeNull();
  });

  test("enabling review leaves even the default Decision connection and model unselected", async () => {
    storeState.decisionProfiles = [{ id: "decision-conn", name: "Decision", model: "decision-model", is_default: true }];
    const h = await mount();
    const toggle = h.querySelector<HTMLInputElement>('[aria-label="memoryCortex.arbitratesHeuristics"]');
    expect(toggle?.disabled).toBe(false);
    expect(patches).toEqual([]);
    await click(toggle);
    const select = h.querySelector<HTMLSelectElement>('[aria-label="memoryCortex.decisionConnection"]');
    expect(select?.value).toBe("");
    expect(select?.getAttribute("data-model-value")).toBe("");
    expect(select?.getAttribute("data-seed-model")).toBe("false");
    expect(patches).toEqual([{ sidecarReliability: { ...config.sidecarReliability, arbitratesHeuristics: true } }]);
    expect(h.querySelector('[aria-label="memoryCortex.arbitrationBackend"]')).toBeNull();
    await changeSelect(select!, "decision-conn");
    expect(patches.at(-1)).toMatchObject({ arbitration: { backend: "decision", connectionProfileId: "decision-conn", model: null } });
    await changeSelect(select!, "");
    expect(patches.at(-1)).toMatchObject({ arbitration: { connectionProfileId: null, model: null } });
  });

  test("renders secondary profile controls and unavailable state", async () => {
    const h = await mount();

    expect(h.querySelector('[data-testid="cortex-query-secondary-connection"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="cortex-query-fallback-1"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="cortex-summary-secondary-connection"]')).toBeNull();
    expect(h.querySelector('[data-testid="cortex-query-add-fallback"]')).not.toBeNull();
    expect(h.querySelector('[data-testid="cortex-summary-add-fallback"]')).not.toBeNull();
    expect(h.querySelector('[data-cortex-sidecar-state="unavailable"]')).not.toBeNull();
  });

  test("empty list renders no placeholder picker but keeps Add", async () => {
    const h = await mount();

    expect(picker(h, "cortex-summary-secondary-connection")).toBeNull();
    expect(picker(h, "cortex-summary-fallback-1")).toBeNull();
    expect(picker(h, "cortex-summary-fallback-remove")).toBeNull();
    expect(picker(h, "cortex-query-fallback-2")).toBeNull();
    expect(picker(h, "cortex-summary-add-fallback")).not.toBeNull();
    expect(count(h, "cortex-summary")).toBe(0);
  });

  test("each Add creates exactly one empty draft row", async () => {
    const h = await mount();

    await click(removeBtn(h, "cortex-summary-add-fallback"));
    expect(picker(h, "cortex-summary-secondary-connection")).not.toBeNull();
    expect(picker(h, "cortex-summary-fallback-1")).toBeNull();
    expect(count(h, "cortex-summary")).toBe(1);

    await click(removeBtn(h, "cortex-summary-add-fallback"));
    expect(picker(h, "cortex-summary-fallback-1")).not.toBeNull();
    expect(picker(h, "cortex-summary-fallback-2")).toBeNull();
    expect(count(h, "cortex-summary")).toBe(2);
  });

  test("cancel removes the sole empty draft and leaves no rebuilt ghost row", async () => {
    const h = await mount();

    await click(removeBtn(h, "cortex-summary-add-fallback"));
    const cancel = removeBtn(h, "cortex-summary-fallback-remove");
    expect(cancel).not.toBeNull();
    expect(cancel!.getAttribute("aria-label")).toBe("Remove fallback");

    await click(cancel);
    expect(picker(h, "cortex-summary-secondary-connection")).toBeNull();
    expect(picker(h, "cortex-summary-fallback-remove")).toBeNull();
    expect(count(h, "cortex-summary")).toBe(0);
    expect(picker(h, "cortex-summary-add-fallback")).not.toBeNull();
  });

  test("with two drafts each row keeps its own accessible remove control", async () => {
    const h = await mount();

    await click(removeBtn(h, "cortex-summary-add-fallback"));
    await click(removeBtn(h, "cortex-summary-add-fallback"));

    const first = removeBtn(h, "cortex-summary-fallback-remove");
    const second = removeBtn(h, "cortex-summary-fallback-remove-1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.getAttribute("aria-label")).toBe("Remove fallback");
    expect(second!.getAttribute("aria-label")).toBe("Remove fallback");

    await click(second);
    expect(picker(h, "cortex-summary-secondary-connection")).not.toBeNull();
    expect(picker(h, "cortex-summary-fallback-1")).toBeNull();
    expect(count(h, "cortex-summary")).toBe(1);
  });

  test("removing a configured row preserves primary, survivor and ordering", async () => {
    const h = await mount();
    patches.length = 0;

    const first = removeBtn(h, "cortex-query-fallback-remove");
    const second = removeBtn(h, "cortex-query-fallback-remove-1");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    await click(first);
    expect(picker(h, "cortex-query-secondary-connection")).not.toBeNull();
    expect(picker(h, "cortex-query-fallback-1")).toBeNull();

    expect(patches).toEqual([
      {
        queryGeneration: {
          primary: { connectionProfileId: "primary-conn", model: "primary-model" },
          secondary: { connectionProfileId: "tertiary-conn", model: "tertiary-model" },
        },
      },
    ]);

    await click(second);
    expect(picker(h, "cortex-query-secondary-connection")).toBeNull();
    expect(count(h, "cortex-query")).toBe(0);

    expect(patches[patches.length - 1]).toEqual({
      queryGeneration: {
        primary: { connectionProfileId: "primary-conn", model: "primary-model" },
        secondary: null,
      },
    });
  });

  test("saving an empty draft persists the configured primary without inventing a fallback", async () => {
    const h = await mount();
    patches.length = 0;

    await click(removeBtn(h, "cortex-summary-add-fallback"));
    const draftSelect = selectIn(h, "cortex-summary-secondary-connection");
    expect(draftSelect).not.toBeNull();
    expect(draftSelect!.value).toBe("");

    await changeSelect(draftSelect!, "primary-conn");

    // The draft becomes a real endpoint: primary is carried through from the pair,
    // the chosen connection lands in secondary, and no fallback entry is fabricated.
    expect(patches).toEqual([
      {
        memorySummarization: {
          primary: { connectionProfileId: "primary-conn", model: "primary-model" },
          secondary: { connectionProfileId: "primary-conn", model: null },
        },
      },
    ]);
    expect(patches[0]).not.toHaveProperty("memorySummarization.fallbacks");
    expect(count(h, "cortex-summary")).toBe(1);
  });

  test("clearing back to no connection keeps the primary and writes no fallback entry", async () => {
    const h = await mount();

    // The summary list is unbound, so the first bound row is created via Add.
    await click(removeBtn(h, "cortex-summary-add-fallback"));
    const rowSelect = selectIn(h, "cortex-summary-secondary-connection");
    expect(rowSelect).not.toBeNull();
    expect(rowSelect!.value).toBe("");

    // Bind it to a real connection first, then reset the log so the clear is the only write.
    await changeSelect(rowSelect!, "secondary-conn");
    patches.length = 0;

    const boundSelect = selectIn(h, "cortex-summary-secondary-connection");
    expect(boundSelect).not.toBeNull();
    expect(boundSelect!.value).toBe("secondary-conn");

    // The empty ID is the clear/none path through the wired select.
    await changeSelect(boundSelect!, "");

    expect(patches).toEqual([
      {
        memorySummarization: {
          primary: { connectionProfileId: "primary-conn", model: "primary-model" },
          secondary: null,
        },
      },
    ]);
    expect(patches[0]).not.toHaveProperty("memorySummarization.fallbacks");

    const cleared = selectIn(h, "cortex-summary-secondary-connection");
    expect(cleared).not.toBeNull();
    expect(cleared!.value).toBe("");
  });

  test("editing one list leaves the other list and its primary untouched", async () => {
    const h = await mount();

    // Give the OTHER list a selected draft so it carries observable state to preserve.
    await click(removeBtn(h, "cortex-summary-add-fallback"));
    const otherDraft = selectIn(h, "cortex-summary-secondary-connection");
    expect(otherDraft).not.toBeNull();
    await changeSelect(otherDraft!, "secondary-conn");
    expect(count(h, "cortex-summary")).toBe(1);

    patches.length = 0;

    // The target list is the query list; its fallbacks are configured from the fixture.
    expect(picker(h, "cortex-query-secondary-connection")).not.toBeNull();
    expect(picker(h, "cortex-query-fallback-1")).not.toBeNull();
    expect(picker(h, "cortex-query-fallback-remove-1")).not.toBeNull();

    // Remove the target list's fallback (the only removable query row).
    await click(removeBtn(h, "cortex-query-fallback-remove-1"));

    expect(patches).toEqual([
      {
        queryGeneration: {
          primary: { connectionProfileId: "primary-conn", model: "primary-model" },
          secondary: { connectionProfileId: "secondary-conn", model: "secondary-model" },
        },
      },
    ]);

    // The other list keeps its own selected draft and row count.
    const otherAfter = selectIn(h, "cortex-summary-secondary-connection");
    expect(otherAfter).not.toBeNull();
    expect(otherAfter!.value).toBe("secondary-conn");
    expect(count(h, "cortex-summary")).toBe(1);

    // The target list keeps its own primary untouched by editing the extras.
    const queryPrimaryAfter = selectIn(h, "cortex-query-secondary-connection");
    expect(queryPrimaryAfter).not.toBeNull();
    expect(queryPrimaryAfter!.value).toBe("secondary-conn");
    expect(patches[0]).not.toHaveProperty("queryGeneration.fallbacks");
  });
});
