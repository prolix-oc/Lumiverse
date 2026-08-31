import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeDatabase, getDb, initDatabase } from "../db/connection";
import type { Message } from "../types/message";
import type { WorldBook, WorldBookEntry } from "../types/world-book";
import type {
  AgentOwnedLoreReader,
  AgentSnapshotBook,
  AgentSnapshotEntry,
  AgentToolSnapshot,
} from "../types/agents";
import {
  CORE_AGENT_TOOL_CATALOG,
  createAgentToolSnapshot,
  executeCoreAgentTool,
  getCoreAgentToolDefinitions,
  renderAgentLoreText,
  safeToolInspectionValue,
} from "./agent-tools.service";
import * as worldBooksSvc from "./world-books.service";

const NAMES = {
  user: "Alice",
  char: "Aria",
  group: "Aria, Bea",
  groupNotMuted: "Aria, Bea",
  notChar: "Alice",
  charGroupFocused: "Aria",
  isGroupChat: "yes",
  groupOthers: "Bea",
  groupMemberCount: "2",
};

function entry(id: string, overrides: Partial<WorldBookEntry> = {}): WorldBookEntry {
  return {
    id,
    world_book_id: "book-a",
    uid: id,
    outlet_name: null,
    wi_marker: null,
    wi_marker_side: null,
    key: ["dragon"],
    keysecondary: [],
    content: "Original {{user}} {{time}}",
    comment: "Dragon",
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
    prevent_recursion: false,
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
    ...overrides,
  };
}

function message(
  id: string,
  content: string,
  options: { hidden?: boolean; injected?: boolean; isUser?: boolean; index?: number } = {},
): Message {
  return {
    id,
    chat_id: "chat-a",
    index_in_chat: options.index ?? 0,
    is_user: options.isUser ?? true,
    name: options.isUser === false ? "Aria" : "Alice",
    content,
    send_date: 0,
    swipe_id: 1,
    swipes: ["inactive secret", content],
    swipe_dates: [0, 0],
    extra: {
      ...(options.hidden ? { hidden: true } : {}),
      ...(options.injected ? { _loom_inject: { block_id: "hidden" } } : {}),
      private: "not projected",
    },
    parent_message_id: null,
    branch_id: null,
    created_at: 0,
  };
}

function snapshot(): AgentToolSnapshot {
  return createAgentToolSnapshot({
    rootUserId: "user-a",
    chatId: "chat-a",
    books: [{ id: "book-a", name: "Lore", source: "chat" }],
    entries: [entry("enabled"), entry("disabled", { disabled: true })],
    activatedEntries: [entry("enabled", { content: "Final {{user}} {{time}}" })],
    bookNames: new Map([["book-a", "Lore"]]),
    bookSources: new Map([["book-a", "chat" as const]]),
    messages: [
      message("visible-user", "Need dragon facts", { index: 1 }),
      message("visible-assistant", "A dragon appeared", { isUser: false, index: 2 }),
      message("hidden", "dragon secret", { hidden: true, index: 3 }),
      message("injected", "dragon injection", { injected: true, index: 4 }),
      message("excluded", "dragon staged", { index: 5 }),
      message("continue-target", "continue secret", { index: 6 }),
    ],

    excludedMessageIds: new Set(["excluded", "continue-target"]),
    names: NAMES,
  });
}
function ownedReader(userId: string): AgentOwnedLoreReader {
  const toBook = (book: WorldBook | null): AgentSnapshotBook | null =>
    book
      ? {
          id: book.id,
          name: book.name,
          description: book.description,
          folder: book.folder,
          source: "owned",
          active: false,
        }
      : null;
  const toEntry = (entry: WorldBookEntry | null): AgentSnapshotEntry | null => {
    if (!entry) return null;
    const book = toBook(worldBooksSvc.getOwnedAgentLoreBook(userId, entry.world_book_id));
    if (!book) return null;
    return {
      id: entry.id,
      bookId: entry.world_book_id,
      bookName: book.name,
      bookSource: "owned",
      comment: entry.comment,
      keys: entry.key,
      secondaryKeys: entry.keysecondary,
      content: entry.content,
      position: entry.position,
      depth: entry.depth,
      role: entry.role,
      activated: false,
    };
  };
  const toPage = <T, U>(
    page: { data: T[]; total: number; limit: number; offset: number },
    map: (value: T) => U | null,
  ) => {
    const data = page.data.map(map).filter((value): value is U => value !== null);
    return {
      data,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
      truncated: page.offset + data.length < page.total,
    };
  };
  return {
    listBooks: (options) =>
      toPage(
        worldBooksSvc.listOwnedAgentLoreBooks(userId, options),
        toBook,
      ),
    resolveBookName: (name) =>
      worldBooksSvc.resolveOwnedAgentLoreBookName(userId, name),
    getBook: (bookId) => toBook(worldBooksSvc.getOwnedAgentLoreBook(userId, bookId)),
    listEntries: (options) =>
      toPage(
        worldBooksSvc.listOwnedAgentLoreEntries(userId, options),
        toEntry,
      ),
    getEntry: (entryId) =>
      toEntry(worldBooksSvc.getOwnedAgentLoreEntry(userId, entryId)),
    searchEntries: (options) =>
      toPage(
        worldBooksSvc.searchOwnedAgentLoreEntries(userId, options),
        toEntry,
      ),
  };
}

beforeEach(async () => {
  closeDatabase();
  initDatabase(":memory:");
  const db = getDb();
  db.run("PRAGMA foreign_keys = OFF");
  db.run(await Bun.file(join(import.meta.dir, "..", "db", "baseline.sql")).text());
});

afterEach(() => closeDatabase());

describe("agent core tools", () => {
  test("freezes the exact active lore/chat projection and keeps disallowed macros literal", async () => {
    const toolSnapshot = snapshot();
    expect(Object.isFrozen(toolSnapshot)).toBe(true);
    expect(toolSnapshot.entries.map((item) => item.id)).toEqual(["enabled"]);
    expect(toolSnapshot.chatMessages.map((item) => item.id)).toEqual([
      "visible-user",
      "visible-assistant",
    ]);
    expect(toolSnapshot.chatMessages[0]).not.toHaveProperty("extra");
    expect(toolSnapshot.chatMessages[0].content).toBe("Need dragon facts");
    expect(renderAgentLoreText("{{user}}/{{charName}}/{{chatId}}", toolSnapshot.names))
      .toBe("Alice/Aria/{{chatId}}");

    const lore = await executeCoreAgentTool("lore_search_entries", { query: "dragon" }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
    });
    expect(lore.status).toBe("success");
    expect(JSON.stringify(lore.data)).toContain("Final {{user}} {{time}}");
    const renderedLore = await executeCoreAgentTool("lore_search_entries", {
      query: "dragon",
      format: "text",
    }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
    });
    expect(renderedLore.status).toBe("success");
    expect(JSON.stringify(renderedLore.data)).toContain("Final Alice {{time}}");
    expect(JSON.stringify(lore.data)).not.toContain("Original");

    const chat = await executeCoreAgentTool("chat_search_history", {
      query: "dragon",
      role: "assistant",
    }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["chat_search_history"], loreScope: "active" },
    });
    expect(chat.status).toBe("success");
    expect(JSON.stringify(chat.data)).toContain("visible-assistant");
    expect(JSON.stringify(chat.data)).not.toContain("inactive secret");
  });
  test("orders active lore identity matches before broad content mentions", async () => {
    const toolSnapshot = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [
        { id: "book-a", name: "Lore", source: "chat" },
        { id: "book-inactive", name: "Inactive", source: "global", active: false },
      ],
      entries: [
        entry("content-mention", {
          comment: "Background",
          key: ["other"],
          content: "A long unrelated passage that mentions Clark once.",
        }),
        entry("title-match", {
          comment: "Clark",
          key: ["other"],
          content: "A title match.",
        }),
        entry("key-match", {
          comment: "Other",
          key: ["Clark"],
          content: "A primary-key match.",
        }),
        entry("secondary-match", {
          comment: "Other secondary",
          key: ["other"],
          keysecondary: ["Clark"],
          content: "A secondary-key match.",
        }),
        entry("disabled-match", {
          comment: "Clark",
          disabled: true,
        }),
        entry("inactive-book-match", {
          world_book_id: "book-inactive",
          comment: "Clark",
        }),
      ],
      messages: [],
      names: NAMES,
    });
    const result = await executeCoreAgentTool("lore_search_entries", {
      query: "Clark",
      limit: 1,
      offset: 0,
    }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
    });
    expect(result).toMatchObject({
      status: "success",
      data: {
        total: 4,
        limit: 1,
        offset: 0,
        truncated: true,
        data: [{ id: "title-match", activated: false }],
      },
    });

    const page = await executeCoreAgentTool("lore_search_entries", {
      query: "Clark",
      limit: 4,
    }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
    });
    expect(page).toMatchObject({
      status: "success",
      data: {
        total: 4,
        truncated: false,
        data: [
          { id: "title-match", activated: false },
          { id: "key-match", activated: false },
          { id: "secondary-match", activated: false },
          { id: "content-mention", activated: false },
        ],
      },
    });
  });

  test("Unicode-folds active identity matches before content mentions", async () => {
    const toolSnapshot = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [{ id: "book-a", name: "Lore", source: "chat" }],
      entries: [
        entry("content-mention", {
          comment: "Background",
          key: ["other"],
          content: "Åke",
        }),
        entry("identity-match", {
          comment: "åke",
          key: ["other"],
          content: "Identity entry.",
        }),
      ],
      messages: [],
      names: NAMES,
    });
    const result = await executeCoreAgentTool("lore_search_entries", {
      query: "Åke",
      limit: 50,
    }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
    });
    expect(result).toMatchObject({
      status: "success",
      data: {
        total: 2,
        data: [
          { id: "identity-match" },
          { id: "content-mention" },
        ],
      },
    });
  });

  test("projects the canonical active swipe instead of stale message content", () => {
    const stale = message("stale-column", "stale content", { index: 6 });
    stale.swipes = ["inactive secret", "canonical active"];
    const toolSnapshot = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [],
      entries: [],
      messages: [stale],
      names: NAMES,
    });
    expect(toolSnapshot.chatMessages[0]?.content).toBe("canonical active");

    stale.swipe_id = 99;
    const fallbackSnapshot = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [],
      entries: [],
      messages: [stale],
      names: NAMES,
    });
    expect(fallbackSnapshot.chatMessages[0]?.content).toBe("stale content");
  });


  test("strictly rejects unknown arguments and scope widening", async () => {
    const toolSnapshot = snapshot();
    const invalid = await executeCoreAgentTool("lore_list_books", { unknown: true }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_list_books"], loreScope: "active" },
    });
    expect(invalid).toMatchObject({ status: "error", errorCode: "invalid_arguments" });

    const widened = await executeCoreAgentTool("lore_list_books", { scope: "all_owned" }, {
      snapshot: toolSnapshot,
      grant: { toolIds: ["lore_list_books"], loreScope: "active" },
    });
    expect(widened).toMatchObject({ status: "error", errorCode: "unauthorized" });

    const denied = await executeCoreAgentTool("chat_search_history", { query: "dragon" }, {
      snapshot: toolSnapshot,
      grant: { toolIds: [], loreScope: "active" },
    });
    expect(denied).toMatchObject({ status: "error", errorCode: "unauthorized" });
  });

  test("all-owned queries are bounded, disabled-filtered, ambiguous, and owner-isolated", async () => {
    const duplicateA = worldBooksSvc.createWorldBook("user-a", { name: "Duplicate", folder: "Folder" });
    const duplicateB = worldBooksSvc.createWorldBook("user-a", { name: "Duplicate", folder: "Folder" });
    const foreign = worldBooksSvc.createWorldBook("user-b", { name: "Foreign", folder: "Folder" });
    worldBooksSvc.createEntry("user-a", duplicateA.id, {
      comment: "Dragon lore",
      content: "Owned dragon for {{user}}",
      disabled: false,
    });
    worldBooksSvc.createEntry("user-a", duplicateA.id, {
      comment: "Disabled dragon",
      content: "Never return",
      disabled: true,
    });
    worldBooksSvc.createEntry("user-b", foreign.id, {
      comment: "Foreign dragon",
      content: "Cross-user secret",
      disabled: false,
    });

    const toolSnapshot = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [],
      entries: [],
      messages: [],
      names: NAMES,
      ownedLore: ownedReader("user-a"),
    });
    worldBooksSvc.createEntry("user-a", duplicateA.id, {
      comment: "Late dragon",
      content: "Created after snapshot",
      order_value: 200,
      disabled: false,
    });
    const context = {
      snapshot: toolSnapshot,
      grant: {
        toolIds: ["lore_get_book", "lore_search_entries"] as const,
        loreScope: "all_owned" as const,
      },
    };
    const ambiguous = await executeCoreAgentTool("lore_get_book", {
      book_name: "Duplicate",
      scope: "all_owned",
    }, context);
    expect(ambiguous).toMatchObject({ status: "error", errorCode: "ambiguous" });
    expect(JSON.stringify(ambiguous.data)).toContain(duplicateA.id);
    expect(JSON.stringify(ambiguous.data)).toContain(duplicateB.id);

    const found = await executeCoreAgentTool("lore_search_entries", {
      query: "dragon",
      scope: "all_owned",
      book_id: duplicateA.id,
      limit: 1,
      offset: 0,
    }, context);
    expect(found.status).toBe("success");
    const serialized = JSON.stringify(found.data);
    expect(serialized).toContain("Owned dragon for {{user}}");
    expect(serialized).not.toContain("Never return");
    const rendered = await executeCoreAgentTool("lore_search_entries", {
      query: "dragon",
      scope: "all_owned",
      book_id: duplicateA.id,
      format: "text",
      limit: 1,
    }, context);
    expect(rendered.status).toBe("success");
    expect(JSON.stringify(rendered.data)).toContain("Owned dragon for Alice");
    expect(serialized).not.toContain("Cross-user secret");
    worldBooksSvc.createEntry("user-a", duplicateA.id, {
      comment: "Oversized dragon",
      content: "x".repeat(70 * 1024),
      disabled: false,
    });
    const oversizedOwned = await executeCoreAgentTool("lore_search_entries", {
      query: "Oversized dragon",
      scope: "all_owned",
      book_id: duplicateA.id,
    }, context);
    expect(oversizedOwned).toMatchObject({
      status: "error",
      errorCode: "limit_exceeded",
    });

    const late = await executeCoreAgentTool("lore_search_entries", {
      query: "Late dragon",
      scope: "all_owned",
    }, context);
    expect(late).toMatchObject({
      status: "success",
      data: { total: 1 },
    });
  });
  test("resolves exact owned names beyond the bounded substring page", async () => {
    const exact = worldBooksSvc.createWorldBook("user-a", { name: "Exact" });
    for (let index = 0; index < 60; index += 1) {
      worldBooksSvc.createWorldBook("user-a", { name: `A Exact decoy ${index}` });
    }
    const unique = worldBooksSvc.resolveOwnedAgentLoreBookName("user-a", "Exact");
    expect(unique).toEqual({
      candidates: [{ id: exact.id, name: "Exact" }],
      total: 1,
      truncated: false,
    });

    const toolSnapshot = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [],
      entries: [],
      messages: [],
      names: NAMES,
      ownedLore: ownedReader("user-a"),
    });
    const context = {
      snapshot: toolSnapshot,
      grant: {
        toolIds: ["lore_get_book"] as const,
        loreScope: "all_owned" as const,
      },
    };
    const found = await executeCoreAgentTool("lore_get_book", {
      book_name: "Exact",
      scope: "all_owned",
    }, context);
    expect(found).toMatchObject({
      status: "success",
      data: { book: { id: exact.id, name: "Exact" } },
    });

    for (let index = 0; index < 60; index += 1) {
      worldBooksSvc.createWorldBook("user-a", { name: "Duplicate exact" });
    }
    worldBooksSvc.createWorldBook("user-b", { name: "Duplicate exact" });
    const duplicates = worldBooksSvc.resolveOwnedAgentLoreBookName(
      "user-a",
      "Duplicate exact",
    );
    expect(duplicates.total).toBe(60);
    expect(duplicates.candidates).toHaveLength(2);
    expect(duplicates.truncated).toBe(true);
    expect(duplicates.candidates.map((candidate) => candidate.id)).toEqual(
      [...duplicates.candidates].map((candidate) => candidate.id).sort(),
    );

    const ambiguous = await executeCoreAgentTool("lore_get_book", {
      book_name: "Duplicate exact",
      scope: "all_owned",
    }, context);
    expect(ambiguous).toMatchObject({
      status: "error",
      errorCode: "ambiguous",
    });
  });


  test("rejects a serialized result above the per-call byte ceiling", async () => {
    const oversized = createAgentToolSnapshot({
      rootUserId: "user-a",
      chatId: "chat-a",
      books: [{ id: "book-a", name: "Lore", source: "chat" }],
      entries: [entry("large", { content: "x".repeat(70 * 1024) })],
      messages: [],
      names: NAMES,
    });

    const result = await executeCoreAgentTool(
      "lore_search_entries",
      { query: "dragon" },
      {
        snapshot: oversized,
        grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
      },
    );

    expect(result).toMatchObject({
      status: "error",
      errorCode: "limit_exceeded",
    });
  });

  test("removes nested credential fields from owner-visible inspection values", () => {
    const sanitized = safeToolInspectionValue({
      status: "success",
      nested: {
        apiKey: "must-not-leak",
        authorization: "Bearer must-not-leak",
        safe: "visible",
        rows: [{ private_key: "must-not-leak", value: "visible-row" }],
      },
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).toContain("visible");
    expect(serialized).toContain("visible-row");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("apiKey");
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("private_key");
  });

  test("every provider definition is strict and colon-free", () => {
    for (const [name, catalog] of Object.entries(CORE_AGENT_TOOL_CATALOG)) {
      expect(name).not.toContain(":");
      expect(catalog.definition.strict).toBe(true);
      expect(catalog.definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
    }
  });
  test("lore search schema and parser agree on optional book selector XOR", async () => {
    const parameters = CORE_AGENT_TOOL_CATALOG.lore_search_entries.definition
      .parameters as {
      oneOf?: Array<Record<string, unknown>>;
    };
    expect(parameters.oneOf).toEqual([
      {
        not: {
          anyOf: [
            { required: ["book_id"] },
            { required: ["book_name"] },
          ],
        },
      },
      { required: ["book_id"], not: { required: ["book_name"] } },
      { required: ["book_name"], not: { required: ["book_id"] } },
    ]);

    const toolSnapshot = snapshot();
    const withoutSelector = await executeCoreAgentTool(
      "lore_search_entries",
      { query: "dragon" },
      {
        snapshot: toolSnapshot,
        grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
      },
    );
    expect(withoutSelector.status).toBe("success");
    const bothSelectors = await executeCoreAgentTool(
      "lore_search_entries",
      { query: "dragon", book_id: "book-a", book_name: "Lore" },
      {
        snapshot: toolSnapshot,
        grant: { toolIds: ["lore_search_entries"], loreScope: "active" },
      },
    );
    expect(bothSelectors).toMatchObject({
      status: "error",
      errorCode: "invalid_arguments",
    });
  });
  test("keeps delegation and external tools outside the ordinary catalog boundary", async () => {
    const unsupported = ["agent_delegate", "council_call", "mcp_call", "spindle_tool"] as const;
    for (const name of unsupported) {
      expect(Object.keys(CORE_AGENT_TOOL_CATALOG)).not.toContain(name);
      await expect(
        executeCoreAgentTool(name as never, {}, {
          snapshot: snapshot(),
          grant: { toolIds: ["lore_list_books"], loreScope: "active" },
        }),
      ).resolves.toMatchObject({ status: "error", errorCode: "unauthorized" });
    }
    expect(() => getCoreAgentToolDefinitions(["agent_delegate"] as never)).toThrow(
      "tool_not_in_catalog",
    );
  });
});
