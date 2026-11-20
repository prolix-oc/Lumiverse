import { describe, expect, test } from "bun:test";
import type { WorldBookEntry } from "../types/world-book";
import { activateWorldInfo } from '../services/world-info-activation.service';
import { buildWorldInfoCaptureMap } from './world-info-capture';
import {
  WorldInfoInterceptorChain,
  worldInfoInterceptorChain,
  type WorldInfoInterceptor,
} from "./world-info-interceptor";

function makeEntry(id: string): WorldBookEntry {
  return {
    folder: "", tags: [],
    id,
    world_book_id: "book",
    uid: id,
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [id],
    keysecondary: [],
    content: `content-${id}`,
    comment: id,
    position: 0,
    depth: 4,
    role: null,
    order_value: 100,
    selective: false,
    constant: false,
    disabled: false,
    group_name: "",
    group_override: false,
    group_weight: 100,
    probability: 100,
    scan_depth: null,
    exclude_greeting: false,
    case_sensitive: false,
    match_whole_words: false,
    automation_id: null,
    use_regex: false,
    prevent_recursion: true,
    exclude_recursion: false,
    delay_until_recursion: false,
    priority: 10,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    selective_logic: 0,
    use_probability: true,
    vectorized: false,
    vector_index_status: "not_enabled",
    vector_indexed_at: null,
    vector_index_error: null,
    revision: 1,
    extensions: {},
    created_at: 0,
    updated_at: 0,
  };
}

const context = {
  chatId: "chat",
  characterId: "character",
  messages: [],
  chatTurn: 1,
  chatMetadata: {},
  activationSettings: {
    globalScanDepth: null,
    maxRecursionPasses: 3,
  },
};

describe('prompt-local world info candidates', () => {
  test('same-result decorations and captures resolve local IDs without changing raw capture contents', async () => {
    const chain = new WorldInfoInterceptorChain();
    chain.register({ extensionId: 'extension', priority: 100, handler: async () => ({
      additionalEntries: [{ ...makeEntry('local'), constant: true }],
      mutated: [{ id: 'local', content: 'decorated', selectionContent: 'selected', outputOrder: 'insertion' }],
      captured: ['local'],
    }) });
    const result = await chain.run([], context);
    const id = result.entries[0]!.id;
    expect(result.entries[0]!.content).toBe('decorated');
    expect(result.selectionContentByEntryId.get(id)).toBe('selected');
    expect(result.insertionOrderByEntryId.get(id)).toBe('extension');
    const raw = activateWorldInfo({ entries: [...(result.additionalEntries ?? [])], messages: [], chatTurn: 1, wiState: {} });
    expect(raw.activatedEntries[0]!.content).toBe('content-local');
    const captures = buildWorldInfoCaptureMap(result.captureRequests, raw.activatedEntries.map(entry => ({
      id: entry.id, comment: entry.comment, keys: entry.key, source: 'keyword' as const,
    })));
    expect(captures.extension.map(entry => entry.id)).toEqual([id]);
  });
  test('scopes candidates by extension and chat and applies later interceptors before activation', async () => {
    const chain = new WorldInfoInterceptorChain();
    chain.register({ extensionId: 'first', userId: 'owner', priority: 0, handler: async () => ({
      additionalEntries: [{ ...makeEntry('local'), constant: true }],
    }) });
    chain.register({ extensionId: 'second', userId: 'owner', priority: 1, handler: async ctx => {
      expect(ctx.entries[0]?.book_source).toBe('chat');
      return { mutated: [{ id: ctx.entries[0]!.id, content: 'resolved content' }] };
    } });
    const result = await chain.run([], context, 'owner');
    const activated = activateWorldInfo({ entries: result.entries, messages: [], chatTurn: 1, wiState: {} });
    expect(activated.activatedEntries.map(entry => entry.content)).toEqual(['resolved content']);
    expect(result.entries[0]!.id).toBe(JSON.stringify(['spindle', 'first', 'chat', 'local']));
    const otherChat = await chain.run([], { ...context, chatId: 'other' }, 'owner');
    expect(otherChat.entries[0]!.id).not.toBe(result.entries[0]!.id);
    expect((await chain.run([], context, 'unrelated')).entries).toEqual([]);
  });

  test('native activation excludes unmatched and disabled local candidates', async () => {
    const chain = new WorldInfoInterceptorChain();
    chain.register({ extensionId: 'extension', priority: 0, handler: async () => ({ additionalEntries: [
      makeEntry('unmatched'), { ...makeEntry('disabled'), constant: true, disabled: true },
    ] }) });
    const result = await chain.run([], context);
    expect(activateWorldInfo({ entries: result.entries, messages: [], chatTurn: 1, wiState: {} }).activatedEntries).toEqual([]);
  });

  test('invalid candidate batches fail without mutating stored entries', async () => {
    const chain = new WorldInfoInterceptorChain();
    const original = [makeEntry('stored')];
    const before = structuredClone(original);
    chain.register({ extensionId: 'extension', priority: 0, handler: async () => ({ additionalEntries: [makeEntry('same'), makeEntry('same')] }) });
    await expect(chain.run(original, context)).rejects.toThrow('duplicate id');
    expect(original).toEqual(before);
  });
});

describe("world info output ordering", () => {
  test("keeps ordering prompt-local and attributes it to the registering extension", async () => {
    const chain = new WorldInfoInterceptorChain();
    const entries = [makeEntry("a"), makeEntry("b")];
    chain.register({ extensionId: "first", priority: 0, handler: async () => ({
      mutated: [{ id: "a", outputOrder: "insertion" }, { id: "missing", outputOrder: "insertion" }],
    }) });
    chain.register({ extensionId: "second", priority: 1, handler: async (ctx) => {
      expect(ctx.entries[0]?.outputOrder).toBe("insertion");
      return { mutated: [{ id: "b", outputOrder: "insertion" }] };
    } });
    const result = await chain.run(entries, context);
    expect([...result.insertionOrderByEntryId]).toEqual([["a", "first"], ["b", "second"]]);
    expect(result.entries).toEqual(entries);
    expect(result.entries[0]).toBe(entries[0]);
    expect(entries[0]).not.toHaveProperty("outputOrder");
  });

  test("last valid request wins; selection resets; invalid and foreign-user requests do not apply", async () => {
    const chain = new WorldInfoInterceptorChain();
    chain.register({ extensionId: "first", priority: 0, handler: async () => ({
      mutated: ["a", "b", "c"].map(id => ({ id, outputOrder: "insertion" as const })),
    }) });
    chain.register({ extensionId: "second", priority: 1, handler: async () => ({ mutated: [
      { id: "a", outputOrder: "selection" },
      { id: "b", outputOrder: "insertion" },
      { id: "c", outputOrder: "unknown" as never },
    ] }) });
    chain.register({ extensionId: "foreign", userId: "other", priority: 2, handler: async () => ({
      mutated: [{ id: "c", outputOrder: "selection" }],
    }) });
    const result = await chain.run([makeEntry("a"), makeEntry("b"), makeEntry("c")], context, "user");
    expect([...result.insertionOrderByEntryId]).toEqual([["b", "second"], ["c", "first"]]);
    expect((await chain.run([], context, "user")).insertionOrderByEntryId.size).toBe(0);
    expect((await new WorldInfoInterceptorChain().run([], context)).insertionOrderByEntryId.size).toBe(0);
  });
});

describe("WorldInfoInterceptorChain activation capture", () => {
  test("collects raw capture requests per extension without changing vote behavior", async () => {
    const chain = new WorldInfoInterceptorChain();
    chain.register({
      extensionId: "one",
      priority: 0,
      handler: async () => ({
        captured: ["a", "missing"],
        disabled: ["a"],
      }),
    });
    chain.register({
      extensionId: "two",
      priority: 1,
      handler: async () => ({
        captured: ["a", "b"],
      }),
    });

    const result = await chain.run(
      [makeEntry("a"), makeEntry("b")],
      context,
    );

    expect(result.entries.map(({ id, disabled }) => ({ id, disabled }))).toEqual([
      { id: "a", disabled: true },
      { id: "b", disabled: false },
    ]);
    expect([...result.captureRequests.get("one")!]).toEqual(["a"]);
    expect([...result.captureRequests.get("two")!]).toEqual(["a", "b"]);
  });

  test("retains an explicit empty request", async () => {
    const chain = new WorldInfoInterceptorChain();
    chain.register({
      extensionId: "empty",
      priority: 0,
      handler: async () => ({ captured: [] }),
    });

    const result = await chain.run([makeEntry("a")], context);

    expect(result.captureRequests.has("empty")).toBe(true);
    expect([...result.captureRequests.get("empty")!]).toEqual([]);
    expect(result.entries[0].disabled).toBe(false);
  });
});

describe("world info interceptor activation settings", () => {
  test("passes the normalized global scan depth to each handler", async () => {
    const seen: Array<number | null> = [];
    const interceptor: WorldInfoInterceptor = {
      extensionId: "world-info-settings-test",
      priority: 0,
      handler: async (ctx) => {
        seen.push(ctx.activationSettings.globalScanDepth);
      },
    };
    const unregister = worldInfoInterceptorChain.register(interceptor);

    try {
      await worldInfoInterceptorChain.run(
        [],
        {
          chatId: "chat-1",
          characterId: "character-1",
          messages: [],
          chatTurn: 0,
          chatMetadata: {},
          activationSettings: {
            globalScanDepth: null,
            maxRecursionPasses: 3,
          },
        },
      );
      await worldInfoInterceptorChain.run(
        [],
        {
          chatId: "chat-1",
          characterId: "character-1",
          messages: [],
          chatTurn: 0,
          chatMetadata: {},
          activationSettings: {
            globalScanDepth: 7,
            maxRecursionPasses: 3,
          },
        },
      );
    } finally {
      unregister();
    }

    expect(seen).toEqual([null, 7]);
  });
});

describe("world info interceptor runtime placement", () => {
  test("chains validated prompt-local placement without changing stored rows", async () => {
    const chain = new WorldInfoInterceptorChain();
    let placementSeenBySecondHandler: unknown;
    chain.register({
      extensionId: "first",
      priority: 0,
      handler: async () => ({
        mutated: [{
          id: "a",
          placement: {
            type: "chat_depth",
            role: "assistant",
            depth: 3,
            direction: "from_start",
          },
        }],
      }),
    });
    chain.register({
      extensionId: "second",
      priority: 1,
      handler: async (ctx) => {
        placementSeenBySecondHandler = ctx.entries[0]?.placement;
        return {
          mutated: [{
            id: "b",
            placement: {
              type: "chat_depth",
              role: "system",
              depth: -1,
              direction: "from_end",
            },
          }],
        };
      },
    });

    const result = await chain.run(
      [makeEntry("a"), makeEntry("b")],
      context,
    );

    expect(placementSeenBySecondHandler).toEqual({
      type: "chat_depth",
      role: "assistant",
      depth: 3,
      direction: "from_start",
    });
    expect([...result.placementByEntryId]).toEqual([[
      "a",
      {
        type: "chat_depth",
        role: "assistant",
        depth: 3,
        direction: "from_start",
      },
    ]]);
    expect(result.entries[0]?.position).toBe(0);
  });
});
