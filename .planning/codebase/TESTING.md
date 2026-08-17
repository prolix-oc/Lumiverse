# Testing Patterns & Architecture

**Analysis Date:** 2026-08-17

This document details the test framework, file organization, testing patterns, mocking strategies, test fixtures, and common testing recipes utilized across the Lumiverse codebase (`tests/`, `src/`, `frontend/src/`, and `spindle-extensions/`).

---

## 1. Test Framework & Runner Architecture

- **Primary Test Runner:** Native Bun test runner (`bun:test`).
- **Configuration Files:**
  - `bunfig.toml` (root): Configures test exclusion patterns:
    ```toml
    [test]
    pathIgnorePatterns = "vendor/**"
    ```
  - `frontend/bunfig.toml` (frontend): Configures test preloads for browser global shimming:
    ```toml
    [test]
    preload = ["./bun-test-setup.ts"]
    ```
- **DOM & Environment Shims:** `frontend/bun-test-setup.ts` shims DOM globals (`window`, `document`, `localStorage`, `CustomEvent`) at test startup so frontend hooks, placement helpers, and storage modules can load safely in Bun's headless runtime without requiring full JSDOM overhead for non-rendering unit tests.

---

## 2. Test File Organization & Locations

The test suite is structured across multiple layers:

| Layer | Directory / Pattern | Purpose | Examples |
| :--- | :--- | :--- | :--- |
| **Backend Integration Tests** | `tests/*.test.ts` | End-to-end service testing, streaming generation, prompt assembly, multiplayer WS, memory cortex, and export/import roundtrips | `tests/generation-stop.test.ts`, `tests/temporary-chats.test.ts`, `tests/user-data-export-roundtrip.test.ts` |
| **Backend Service Unit Tests** | `src/**/*.test.ts` | Unit tests co-located next to service implementations and migrations | `src/services/vector-store-config.service.test.ts`, `src/migration/st-connections-migration.test.ts` |
| **Frontend Store Slice Tests** | `frontend/src/store/slices/*.test.ts` | State machine transitions, async race ordering, persistence hydration, and multi-profile resets | `frontend/src/store/slices/auth.test.ts`, `frontend/src/store/slices/connections-order-setters.test.ts` |
| **Frontend Component & API Tests** | `frontend/src/**/*.test.ts(x)` | Co-located unit and contract tests for API clients, hooks, and React UI components | `frontend/src/api/chats.edit-and-send.test.ts`, `frontend/src/components/chat/InputArea.edit-and-send.test.tsx` |
| **Frontend Tooling Tests** | `frontend/scripts/*.test.ts` | Build scripts, Termux runtime detection, and atomic directory promotion verification | `frontend/scripts/build-frontend.test.ts` |
| **Spindle Extension Tests** | `spindle-extensions/*/tests/**/*.test.ts` | Extension lifecycle, quick toolbar rendering, lore indicators, and host surface contracts | `data/extensions/lumiverse_suite/repo/tests/modules/quick-toolbar.test.ts` |

---

## 3. Test Structure & BDD Syntax

Tests use standard BDD constructs imported directly from `"bun:test"`:

```typescript
import { describe, test, expect, beforeAll, beforeEach, afterAll, afterEach, mock } from "bun:test";

describe("temporary character-less chats", () => {
  beforeEach(async () => {
    closeDatabase();
    initDatabase(":memory:");
    await applyBaseline();
  });

  test("createChat accepts a null character_id and skips the greeting", () => {
    const chat = createTempChat();

    expect(chat.character_id).toBeNull();
    expect(chat.metadata.temporary).toBe(true);
    expect(chat.name).toBe("Temporary Chat");
    expect(chatsSvc.getMessages(USER_ID, chat.id)).toHaveLength(0);
  });
});
```

### 3.1 Common Assertion Matchers
- Strict equality: `expect(actual).toBe(expected)`
- Deep equality: `expect(actual).toEqual(expected)`
- Partial shape matching: `expect(actual).toMatchObject({ imported: 6, skipped: 0 })`
- String & Array containment: `expect(serialized).toContain("Hello there")`, `expect(list).toHaveLength(0)`
- Promise resolution / rejection:
  ```typescript
  await expect(chatsApi.editAndSend('chat-1', input)).resolves.toEqual(response);
  await expect(chatsApi.editAndSend('chat-1', badInput)).rejects.toThrow('conflict');
  ```
- Negations: `expect(state.cancelled).toBe(false)`, `expect(fn).not.toHaveBeenCalled()`

---

## 4. Mocking Strategies & Isolation

### 4.1 Module Mocking (`mock.module`)
Used extensively in frontend API and store tests to isolate dependencies:
```typescript
import { mock } from "bun:test";

const post = mock((..._args: unknown[]) => Promise.resolve(undefined));

mock.module("./client", () => ({
  del: mock(),
  get: mock(),
  post,
  put: mock(),
  patch: mock(),
  upload: mock(),
}));

const { chatsApi } = await import("./chats");
```

### 4.2 Live Ephemeral HTTP/SSE Servers (`Bun.serve`)
For integration testing streaming LLM completions, stop generation semantics, and token backpressure, tests spin up real local HTTP servers on port `0` (dynamic port assignment):
```typescript
server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(req) {
    if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    const stream = new ReadableStream({
      start(controller) {
        timer = setInterval(() => {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }, 10);
      },
      cancel() {
        state.cancelled = true;
        if (timer) clearInterval(timer);
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  },
});
```

### 4.3 In-Memory SQLite Isolation (`:memory:`)
Backend integration tests avoid touching disk by using dedicated in-memory SQLite instances:
```typescript
closeDatabase();
initDatabase(":memory:");
const db = getDb();
db.run("PRAGMA foreign_keys = OFF");
db.run(await Bun.file(join(import.meta.dir, "..", "src", "db", "baseline.sql")).text());
```

### 4.4 Static Contract & AST-like Source Assertions
Component contract tests inspect source code via `node:fs` `readFileSync` to enforce architectural boundaries and prevent accidental regressions or circular imports:
```typescript
test("edit-and-send lane does not import InputArea or call startGeneration", () => {
  const card = readFileSync(join(here, "../../hooks/useMessageCard.ts"), "utf8");
  const inputArea = readFileSync(join(here, "InputArea.tsx"), "utf8");

  expect(card).not.toMatch(/startGeneration/);
  expect(card).not.toMatch(/from ['"]@\/components\/chat\/InputArea['"]/);
  expect(inputArea).not.toMatch(/editAndSend|edit-and-send/);
});
```

---

## 5. Fixtures & Test Data Management

### 5.1 Deterministic User Scoping
Tests declare static user constants to ensure clean isolation across concurrent assertions:
```typescript
const USER_ID = "stop-test-user";
const OTHER_USER_ID = "other-user";
```

### 5.2 Factory Helper Functions
Tests define lightweight builder functions to create domain objects with sensible defaults while allowing per-test overrides:
```typescript
function createTempChat(overrides: Record<string, any> = {}) {
  return chatsSvc.createChat(USER_ID, {
    character_id: null,
    name: "Temporary Chat",
    metadata: { temporary: true, ...overrides },
  });
}

const block = (overrides: Record<string, any>) => ({
  id: crypto.randomUUID(),
  name: "block",
  content: "",
  role: "system",
  enabled: true,
  position: "pre_history",
  depth: 0,
  marker: null,
  isLocked: false,
  color: null,
  injectionTrigger: [],
  group: null,
  ...overrides,
});
```

---

## 6. Store & Async Race Testing Patterns

### 6.1 Isolated Store Harness (`createStore`)
Store slice tests instantiate isolated state instances rather than mutating the global singleton:
```typescript
function createStore(): AuthSlice {
  const state = {} as AuthSlice;
  const set = (partial: Partial<AuthSlice> | ((current: AuthSlice) => Partial<AuthSlice>)) => {
    Object.assign(state, typeof partial === "function" ? partial(state) : partial);
  };
  const get = () => state;
  Object.assign(state, createAuthSlice(set as never, get as never, {} as never));
  return state;
}
```

### 6.2 Deferred Promises for Race Conditions
To test out-of-order responses and race conditions, tests construct manual promise deferrals:
```typescript
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("ignores an earlier unauthenticated session response after login succeeds", async () => {
  const store = createStore();
  const staleSession = createDeferred<{ data: null }>();
  authClientMock.getSession = () => staleSession.promise;

  const checking = store.checkSession();
  await store.login("user-b", "password");

  staleSession.resolve({ data: null });
  await checking;

  expect(store.isAuthenticated).toBe(true);
  expect(store.user?.id).toBe("user-b");
});
```

---

## 7. Common Testing Patterns & Recipes

### 7.1 Polling Async State (`waitFor`)
Used when awaiting asynchronous side effects or stream cancellations:
```typescript
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

test("stopGeneration aborts upstream server connection", async () => {
  const { chatId, generationId, state } = await startStreamingGeneration();
  expect(genSvc.stopGeneration(USER_ID, generationId)).toBe(true);
  expect(await waitFor(() => state.cancelled, 2000)).toBe(true);
});
```

### 7.2 Time Travel & Inactivity Sweeps
For testing timeouts and cleanup sweeps without running actual clock delays:
```typescript
const realNow = Date.now;
const currentTime = realNow();
Date.now = () => currentTime + 10 * 60 * 1000 + 1; // Fast-forward 10 minutes

try {
  genSvc.sweepInactiveGenerations();
  expect(state.cancelled).toBe(true);
} finally {
  Date.now = realNow; // Always restore in finally block
}
```

### 7.3 Multi-Tenant Isolation Testing
Explicit verification that user A cannot access, mutate, or stop resources owned by user B:
```typescript
test("deleteTemporaryChats only touches the requesting user's chats", () => {
  const mine = createTempChat();
  const theirs = chatsSvc.createChat("other-user", { character_id: null, metadata: { temporary: true } });

  expect(chatsSvc.deleteTemporaryChats(USER_ID)).toBe(1);
  expect(chatsSvc.getChat(USER_ID, mine.id)).toBeNull();
  expect(chatsSvc.getChat("other-user", theirs.id)).not.toBeNull();
});
```

---

## 8. Test Execution Commands

| Target | Command | Description |
| :--- | :--- | :--- |
| **All Repository Tests** | `bun test` | Runs all backend, integration, and co-located tests |
| **Backend Integration Tests** | `bun test tests/` | Runs backend suite in `tests/` directory |
| **Specific Backend Test** | `bun test tests/generation-stop.test.ts` | Runs a single backend integration test file |
| **Frontend Tests** | `cd frontend && bun test` | Runs all frontend unit, slice, and component tests |
| **Specific Frontend Test** | `bun test frontend/src/store/slices/auth.test.ts` | Runs a specific frontend slice test |
| **Frontend Typecheck** | `cd frontend && bun run typecheck` | Validates TypeScript types across frontend |
| **Frontend Lint** | `cd frontend && bun run lint` | Runs ESLint and React Compiler checks |

---

*Testing analysis: 2026-08-17*
