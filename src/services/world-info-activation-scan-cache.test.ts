import { describe, expect, test } from "bun:test";
import type { Message } from "../types/message";
import type { WorldBookEntry } from "../types/world-book";
import {
  activateWorldInfo,
  createWorldInfoActivationScanCache,
  primeWorldInfoActivationScanCache,
} from "./world-info-activation.service";

function entry(overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  const id = crypto.randomUUID();
  return {
    folder: "", tags: [],
    id,
    uid: id,
    world_book_id: "book",
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: [],
    keysecondary: [],
    content: "memory",
    comment: "",
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
    extensions: {},
    created_at: 0,
    updated_at: 0,
    ...overrides,
    revision: overrides.revision ?? 1,
  };
}

function message(content: () => string): Message {
  const value = {
    id: crypto.randomUUID(),
    chat_id: "chat",
    index_in_chat: 0,
    is_user: true,
    name: "User",
    send_date: 0,
    swipe_id: 0,
    swipes: [],
    swipe_dates: [],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  } as unknown as Message;
  Object.defineProperty(value, "content", { enumerable: true, get: content });
  return value;
}

function messages(prefix: string, contents: string[]): Message[] {
  return contents.map((content, index) => ({
    id: `${prefix}-message-${index}`,
    chat_id: "chat",
    index_in_chat: index,
    is_user: true,
    name: "User",
    content,
    send_date: 0,
    swipe_id: 0,
    swipes: [],
    swipe_dates: [],
    extra: {},
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  })) as Message[];
}

function labels(result: ReturnType<typeof activateWorldInfo>): string[] {
  return result.activatedEntries.map((item) => item.comment).sort();
}

function differingViews(prefix: string): {
  native: WorldBookEntry[];
  raw: WorldBookEntry[];
} {
  const make = (
    name: string,
    overrides: Partial<WorldBookEntry> = {},
  ): WorldBookEntry =>
    entry({
      id: `${prefix}-${name}`,
      uid: `${prefix}-${name}`,
      comment: name,
      ...overrides,
      exclude_greeting: overrides.exclude_greeting ?? false,
      revision: overrides.revision ?? 1,
    });
  const regexDeep = make("regex-deep", {
    key: ["^old code\\d+"],
    use_regex: true,
    scan_depth: 2,
  });
  const regexShallow = make("regex-shallow", {
    key: ["^old code\\d+"],
    use_regex: true,
    scan_depth: 1,
  });
  const selective = make("selective", {
    key: ["primary"],
    keysecondary: ["secondary", "absent"],
    selective: true,
    selective_logic: 2,
  });
  const forced = make("forced", { key: ["missing"] });
  const enabled = make("enabled", {
    key: ["primary"],
    disabled: true,
  });
  const constant = make("constant", {
    constant: true,
    content: "raw-trigger",
    prevent_recursion: false,
  });
  const nativeTarget = make("native-target", { key: ["native-trigger"] });
  const rawTarget = make("raw-target", { key: ["raw-trigger"] });
  const wholeWord = make("whole-word", { key: ["cat"] });
  const caseSensitive = make("case-sensitive", { key: ["Needle"] });
  const raw = [
    regexDeep,
    regexShallow,
    selective,
    forced,
    enabled,
    constant,
    nativeTarget,
    rawTarget,
    wholeWord,
    caseSensitive,
  ];
  return {
    raw,
    native: raw.map((item) => {
      if (item === regexDeep) return { ...item, disabled: true };
      if (item === forced) return { ...item, constant: true };
      if (item === enabled) return { ...item, disabled: false };
      if (item === constant) return { ...item, content: "native-trigger" };
      return item;
    }),
  };
}

describe("world-info activation scan reuse", () => {
  test("constant-only activation does not read chat content", () => {
    let reads = 0;
    const messages = [message(() => {
      reads++;
      return "large chat";
    })];

    const result = activateWorldInfo({
      entries: [entry({ constant: true })],
      messages,
      chatTurn: 1,
      wiState: {},
    });

    expect(result.activatedEntries).toHaveLength(1);
    expect(reads).toBe(0);
  });

  test("two activation views reuse the message signature and base scan", () => {
    let reads = 0;
    const messages = [message(() => {
      reads++;
      return "needle";
    })];
    const conditional = entry({ key: ["needle"] });
    const constant = entry({ constant: true });
    const scanCache = createWorldInfoActivationScanCache();

    const native = activateWorldInfo({
      entries: [conditional],
      messages,
      chatTurn: 1,
      wiState: {},
      scanCache,
    });
    const readsAfterNative = reads;
    const raw = activateWorldInfo({
      entries: [constant, conditional],
      messages,
      chatTurn: 1,
      wiState: {},
      scanCache,
    });

    expect(native.activatedEntries.map((item) => item.id)).toEqual([
      conditional.id,
    ]);
    expect(raw.activatedEntries.map((item) => item.id).sort()).toEqual(
      [constant.id, conditional.id].sort(),
    );
    expect(readsAfterNative).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterNative);
  });

  test("different conditional views share one union scan", () => {
    let reads = 0;
    const messages = [message(() => {
      reads++;
      return "needle and second";
    })];
    const first = entry({ key: ["needle"] });
    const second = entry({ key: ["second"] });
    const nativeEntries = [first];
    const rawEntries = [first, second];
    const scanCache = createWorldInfoActivationScanCache();
    primeWorldInfoActivationScanCache(
      scanCache,
      [nativeEntries, rawEntries],
    );

    const native = activateWorldInfo({
      entries: nativeEntries,
      messages,
      chatTurn: 1,
      wiState: {},
      scanCache,
    });
    const readsAfterNative = reads;
    const raw = activateWorldInfo({
      entries: rawEntries,
      messages,
      chatTurn: 1,
      wiState: {},
      scanCache,
    });

    expect(native.activatedEntries.map((item) => item.id)).toEqual([first.id]);
    expect(raw.activatedEntries.map((item) => item.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(readsAfterNative).toBeGreaterThan(0);
    expect(reads).toBe(readsAfterNative);
  });

  test("primed native and raw views match uncached activation", () => {
    const settings = {
      forceCaseSensitive: true,
      forceMatchWholeWords: true,
      maxRecursionPasses: 3,
    };
    const cachedViews = differingViews("cached");
    const scanCache = createWorldInfoActivationScanCache();
    primeWorldInfoActivationScanCache(
      scanCache,
      [cachedViews.native, cachedViews.raw],
      settings,
    );
    const cachedNative = activateWorldInfo({
      entries: cachedViews.native,
      messages: messages("cached", [
        "old code42",
        "recent catapult needle primary secondary",
      ]),
      chatTurn: 2,
      wiState: {},
      settings,
      scanCache,
    });
    const cachedRaw = activateWorldInfo({
      entries: cachedViews.raw,
      messages: messages("cached", [
        "old code42",
        "recent catapult needle primary secondary",
      ]),
      chatTurn: 2,
      wiState: {},
      settings,
      scanCache,
    });

    const directViews = differingViews("direct");
    const directNative = activateWorldInfo({
      entries: directViews.native,
      messages: messages("direct", [
        "old code42",
        "recent catapult needle primary secondary",
      ]),
      chatTurn: 2,
      wiState: {},
      settings,
    });
    const directRaw = activateWorldInfo({
      entries: directViews.raw,
      messages: messages("direct", [
        "old code42",
        "recent catapult needle primary secondary",
      ]),
      chatTurn: 2,
      wiState: {},
      settings,
    });

    expect(labels(cachedNative)).toEqual(labels(directNative));
    expect(labels(cachedRaw)).toEqual(labels(directRaw));
    expect(labels(cachedNative)).toEqual([
      "constant",
      "enabled",
      "forced",
      "native-target",
      "selective",
    ]);
    expect(labels(cachedRaw)).toEqual([
      "constant",
      "raw-target",
      "regex-deep",
      "selective",
    ]);
    expect(cachedNative.stats).toEqual(directNative.stats);
    expect(cachedRaw.stats).toEqual(directRaw.stats);
  });

  test("same uid with different scan plans stays view-local", () => {
    const cachedShallow = entry({
      id: "cached-shared",
      uid: "cached-shared",
      comment: "shared",
      key: ["needle"],
      scan_depth: 1,
    });
    const cachedDeep = { ...cachedShallow, scan_depth: 2 };
    const scanCache = createWorldInfoActivationScanCache();
    primeWorldInfoActivationScanCache(
      scanCache,
      [[cachedShallow], [cachedDeep]],
    );

    const cachedShallowResult = activateWorldInfo({
      entries: [cachedShallow],
      messages: messages("cached-shared", ["needle", "recent"]),
      chatTurn: 2,
      wiState: {},
      scanCache,
    });
    const cachedDeepResult = activateWorldInfo({
      entries: [cachedDeep],
      messages: messages("cached-shared", ["needle", "recent"]),
      chatTurn: 2,
      wiState: {},
      scanCache,
    });
    const directDeep = entry({
      id: "direct-shared",
      uid: "direct-shared",
      comment: "shared",
      key: ["needle"],
      scan_depth: 2,
    });
    const directDeepResult = activateWorldInfo({
      entries: [directDeep],
      messages: messages("direct-shared", ["needle", "recent"]),
      chatTurn: 2,
      wiState: {},
    });

    expect(labels(cachedShallowResult)).toEqual([]);
    expect(labels(cachedDeepResult)).toEqual(labels(directDeepResult));
  });

  test("different message snapshots invalidate cached scan state", () => {
    const conditional = entry({
      id: "snapshot-entry",
      uid: "snapshot-entry",
      key: ["needle"],
    });
    const scanCache = createWorldInfoActivationScanCache();
    primeWorldInfoActivationScanCache(
      scanCache,
      [[conditional], [conditional]],
    );

    const first = activateWorldInfo({
      entries: [conditional],
      messages: messages("snapshot-first", ["needle"]),
      chatTurn: 1,
      wiState: {},
      scanCache,
    });
    const second = activateWorldInfo({
      entries: [conditional],
      messages: messages("snapshot-second", ["absent"]),
      chatTurn: 1,
      wiState: {},
      scanCache,
    });

    expect(first.activatedEntries.map((item) => item.id)).toEqual([
      conditional.id,
    ]);
    expect(second.activatedEntries).toEqual([]);
  });

  test("saturates repeated shared-key outputs after their first match", () => {
    const entries = Array.from({ length: 1_000 }, (_, index) =>
      entry({
        id: `shared-${index}`,
        uid: `shared-${index}`,
        key: ["needle"],
      })
    );
    const chat = messages("shared", ["needle ".repeat(100_000)]);
    const startedAt = performance.now();
    const result = activateWorldInfo({
      entries,
      messages: chat,
      chatTurn: 1,
      wiState: {},
    });
    const elapsedMs = performance.now() - startedAt;

    expect(result.activatedEntries).toHaveLength(entries.length);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
