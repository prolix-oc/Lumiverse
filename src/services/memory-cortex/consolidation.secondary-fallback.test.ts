import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, getDb, initDatabase } from "../../db/connection";
import {
  decideMemorySummarizationFallback,
  generateConsolidationSummary,
  maybeConsolidate,
  runMemorySummarizationSidecar,
  type ConsolidationSidecarOptions,
} from "./consolidation";
import {
  DEFAULT_CONSOLIDATION_CONFIG,
  DEFAULT_CORTEX_CONFIG,
  type ConsolidationConfig,
} from "./config";

function sidecarOpts(overrides: Partial<ConsolidationSidecarOptions> = {}): ConsolidationSidecarOptions {
  return {
    memorySummarization: {
      primary: { connectionProfileId: "primary-conn", model: "primary-model" },
      secondary: { connectionProfileId: "secondary-conn", model: "secondary-model" },
    },
    sidecarReliability: {
      ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
      fallback: "heuristic",
      maxRetries: 1,
      retryDelayMs: 1,
    },
    sidecarTimeoutMs: 5_000,
    sidecar: {
      connectionProfileId: "primary-conn",
      model: "primary-model",
    },
    ...overrides,
  };
}

function consolidationConfig(): ConsolidationConfig {
  return {
    ...DEFAULT_CONSOLIDATION_CONFIG,
    enabled: true,
    chunkThreshold: 2,
    chunksPerConsolidation: 2,
    arcThreshold: 99,
    useSidecar: true,
    maxTokensPerSummary: 200,
  };
}

function initConsolidationTestDb(): void {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run(`CREATE TABLE chat_chunks (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    consolidation_id TEXT,
    entity_ids TEXT,
    emotional_tags TEXT
  )`);
  db.run(`CREATE TABLE memory_salience (
    chunk_id TEXT PRIMARY KEY,
    score REAL,
    emotional_tags TEXT
  )`);
  db.run(`CREATE TABLE memory_consolidations (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    tier INTEGER NOT NULL DEFAULT 1,
    title TEXT,
    summary TEXT NOT NULL,
    source_chunk_ids TEXT DEFAULT '[]',
    source_consolidation_ids TEXT DEFAULT '[]',
    entity_ids TEXT DEFAULT '[]',
    message_range_start INTEGER,
    message_range_end INTEGER,
    time_range_start INTEGER,
    time_range_end INTEGER,
    salience_avg REAL DEFAULT 0.0,
    emotional_tags TEXT DEFAULT '[]',
    token_count INTEGER DEFAULT 0,
    vectorized_at INTEGER,
    vector_model TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

function seedChunks(chatId: string, count: number): void {
  const db = getDb();
  for (let i = 0; i < count; i++) {
    db.query(
      `INSERT INTO chat_chunks (id, chat_id, content, created_at, consolidation_id, entity_ids, emotional_tags)
       VALUES (?, ?, ?, ?, NULL, '[]', '[]')`,
    ).run(
      `chunk-${i}`,
      chatId,
      `Elena opened the iron gate and walked into the courtyard ${i}. The lanterns were already lit along the wall.`,
      1_000 + i,
    );
  }
}

function listConsolidations(): Array<{ summary: string; title: string | null }> {
  return getDb()
    .query("SELECT summary, title FROM memory_consolidations")
    .all() as Array<{ summary: string; title: string | null }>;
}

describe("generateConsolidationSummary secondary fallback", () => {
  test("uses primary when the first generate succeeds", async () => {
    const calls: string[] = [];
    const decision = await generateConsolidationSummary(
      [{ content: "Alice crossed the river and told Bob the news." }],
      async (opts) => {
        calls.push(`${opts.connectionId}:${opts.parameters.model ?? ""}`);
        return { content: JSON.stringify({ title: "River Crossing", summary: "Alice told Bob after crossing." }) };
      },
      "primary-conn",
      200,
      undefined,
      undefined,
      sidecarOpts(),
    );

    expect(decision.status).toBe("ok");
    expect(decision.role).toBe("primary");
    expect(decision.persist).toBe(true);
    expect(decision.useExtractive).toBe(false);
    expect(decision.result?.title).toBe("River Crossing");
    expect(calls).toEqual(["primary-conn:primary-model"]);
  });

  test("fails over to secondary after primary retries exhaust", async () => {
    const calls: string[] = [];
    const decision = await generateConsolidationSummary(
      [{ content: "Alice crossed the river and told Bob the news." }],
      async (opts) => {
        calls.push(`${opts.connectionId}:${opts.parameters.model ?? ""}`);
        if (opts.connectionId === "primary-conn") throw new Error("503 upstream");
        return { content: JSON.stringify({ title: "Secondary Scene", summary: "Bob heard Alice at the river." }) };
      },
      "primary-conn",
      200,
      undefined,
      undefined,
      sidecarOpts(),
    );

    expect(decision.status).toBe("ok");
    expect(decision.role).toBe("secondary");
    expect(decision.persist).toBe(true);
    expect(decision.useExtractive).toBe(false);
    expect(decision.result?.summary).toBe("Bob heard Alice at the river.");
    expect(calls).toEqual([
      "primary-conn:primary-model",
      "primary-conn:primary-model",
      "secondary-conn:secondary-model",
    ]);
  });

  test("falls back to extractive after primary and secondary fail", async () => {
    const decision = await generateConsolidationSummary(
      [{ content: "Alice crossed the river and told Bob the news." }],
      async () => {
        throw new Error("503 upstream");
      },
      "primary-conn",
      200,
      undefined,
      undefined,
      sidecarOpts({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
    );

    expect(decision.status).toBe("exhausted");
    expect(decision.persist).toBe(true);
    expect(decision.useExtractive).toBe(true);
    expect(decision.result).toBeNull();
  });

  test("skips persistence when fallback is skip", async () => {
    const decision = await generateConsolidationSummary(
      [{ content: "Alice crossed the river and told Bob the news." }],
      async () => {
        throw new Error("503 upstream");
      },
      "primary-conn",
      200,
      undefined,
      undefined,
      sidecarOpts({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "skip",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
    );

    expect(decision.status).toBe("exhausted");
    expect(decision.persist).toBe(false);
    expect(decision.useExtractive).toBe(false);
  });

  test("caller cancellation during primary stops the chain without extractive fallback", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const decision = await generateConsolidationSummary(
      [{ content: "Alice crossed the river and told Bob the news." }],
      async (opts) => {
        calls.push(opts.connectionId);
        controller.abort();
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      },
      "primary-conn",
      200,
      undefined,
      undefined,
      sidecarOpts({ signal: controller.signal }),
    );

    expect(decision.status).toBe("aborted");
    expect(decision.persist).toBe(false);
    expect(decision.useExtractive).toBe(false);
    expect(calls).toEqual(["primary-conn"]);
  });

  test("caller cancellation during secondary stops the chain without extractive fallback", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const decision = await generateConsolidationSummary(
      [{ content: "Alice crossed the river and told Bob the news." }],
      async (opts) => {
        calls.push(opts.connectionId);
        if (opts.connectionId === "secondary-conn") {
          controller.abort();
          throw Object.assign(new Error("Aborted"), { name: "AbortError" });
        }
        throw new Error("503 upstream");
      },
      "primary-conn",
      200,
      undefined,
      undefined,
      sidecarOpts({
        signal: controller.signal,
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
    );

    expect(decision.status).toBe("aborted");
    expect(decision.persist).toBe(false);
    expect(decision.useExtractive).toBe(false);
    expect(calls).toEqual(["primary-conn", "secondary-conn"]);
  });

  test("does not invoke extractive fallback after caller abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const extract = async () => {
      throw new Error("should not run");
    };
    const decision = await runMemorySummarizationSidecar({
      ...sidecarOpts({ signal: controller.signal }),
      sidecarConnectionId: "primary-conn",
      extract,
    });

    expect(decision.status).toBe("aborted");
    expect(decision.useExtractive).toBe(false);
    expect(decideMemorySummarizationFallback(decision.status, "heuristic")).toEqual({
      persist: false,
      useExtractive: false,
    });
  });
});

describe("maybeConsolidate secondary fallback writes", () => {
  beforeEach(() => {
    initConsolidationTestDb();
    seedChunks("chat-1", 2);
  });

  afterEach(() => {
    closeDatabase();
  });

  test("writes the secondary summary after primary generate fails", async () => {
    const calls: string[] = [];
    await maybeConsolidate(
      "user-1",
      "chat-1",
      consolidationConfig(),
      async (opts) => {
        calls.push(opts.connectionId);
        if (opts.connectionId === "primary-conn") throw new Error("503 upstream");
        return { content: JSON.stringify({ title: "Courtyard Arrival", summary: "Elena entered the lantern-lit courtyard." }) };
      },
      "primary-conn",
      5_000,
      undefined,
      undefined,
      sidecarOpts({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
    );

    const rows = listConsolidations();
    expect(calls).toEqual(["primary-conn", "secondary-conn"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Courtyard Arrival");
    expect(rows[0].summary).toBe("Elena entered the lantern-lit courtyard.");
  });

  test("does not write when fallback is skip", async () => {
    await maybeConsolidate(
      "user-1",
      "chat-1",
      consolidationConfig(),
      async () => {
        throw new Error("503 upstream");
      },
      "primary-conn",
      5_000,
      undefined,
      undefined,
      sidecarOpts({
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "skip",
          maxRetries: 0,
          retryDelayMs: 0,
        },
      }),
    );

    expect(listConsolidations()).toHaveLength(0);
    const leftover = getDb()
      .query("SELECT COUNT(*) as count FROM chat_chunks WHERE consolidation_id IS NULL")
      .get() as { count: number };
    expect(leftover.count).toBe(2);
  });

  test("does not write after caller abort and does not extractive-fallback", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    await maybeConsolidate(
      "user-1",
      "chat-1",
      consolidationConfig(),
      async (opts) => {
        calls.push(opts.connectionId);
        controller.abort();
        throw Object.assign(new Error("Aborted"), { name: "AbortError" });
      },
      "primary-conn",
      5_000,
      undefined,
      undefined,
      sidecarOpts({
        signal: controller.signal,
        sidecarReliability: {
          ...DEFAULT_CORTEX_CONFIG.sidecarReliability,
          fallback: "heuristic",
          maxRetries: 1,
          retryDelayMs: 30,
        },
      }),
    );

    expect(calls).toEqual(["primary-conn"]);
    expect(listConsolidations()).toHaveLength(0);
  });

  test("pre-aborted signal skips generate and does not write", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await maybeConsolidate(
      "user-1",
      "chat-1",
      consolidationConfig(),
      async () => {
        called = true;
        throw new Error("should not run");
      },
      "primary-conn",
      5_000,
      undefined,
      undefined,
      sidecarOpts({ signal: controller.signal }),
    );

    expect(called).toBe(false);
    expect(listConsolidations()).toHaveLength(0);
  });
});
