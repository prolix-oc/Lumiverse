# Coding Conventions & Guidelines

**Analysis Date:** 2026-08-17

This document outlines the coding standards, style guidelines, import conventions, error handling architectures, logging practices, and Zustand state management patterns adopted across the Lumiverse codebase (`src/`, `frontend/`, `tests/`, `scripts/`, `desktop/`, and `spindle-extensions/`).

---

## 1. Architectural & Language Foundations

- **Runtime & Package Manager:** Bun (`bun run`, `bun test`, `bun.lock`, `bunfig.toml`) across backend services, frontend tooling, and utility scripts.
- **Language:** 100% TypeScript across backend (`src/`), frontend (`frontend/src/`), desktop wrapper (`desktop/src/`), and test suites.
- **Backend Architecture:** Modular HTTP/WebSocket framework built on [Hono](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/src/app.ts) (`hono`), SQLite via `bun:sqlite` in `src/db/connection.ts`, vector storage via LanceDB / Milvus, and custom LLM inference orchestrators.
- **Frontend Architecture:** [React 19](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/package.json) with React Compiler (`eslint-plugin-react-compiler`), [Zustand 5](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/src/store/index.ts) sliced state management, [Vite 8](file:///G:/AI/All%20lumiverse%20repos/Lumiverse/frontend/vite.config.ts), `@tabler/icons-react` / `lucide-react`, CodeMirror 6, and `i18next`.

---

## 2. Naming Conventions

### 2.1 File & Directory Names

| Entity Type | Convention | Examples |
| :--- | :--- | :--- |
| **Backend Services** | kebab-case with `.service.ts` suffix | `src/services/chats.service.ts`, `src/services/prompt-assembly.service.ts` |
| **Backend Routes** | kebab-case with `.routes.ts` suffix | `src/routes/chats.routes.ts`, `src/routes/characters.routes.ts` |
| **Database Migrations** | 3-digit numeric prefix + snake_case + `.sql` | `src/db/migrations/078_chats_character_id_nullable.sql` |
| **React Components** | PascalCase with `.tsx` extension | `frontend/src/components/chat/ChatView.tsx`, `frontend/src/components/chat/InputArea.tsx` |
| **Zustand Slices** | kebab-case in `slices/` directory | `frontend/src/store/slices/chat.ts`, `frontend/src/store/slices/spindle-placement.ts` |
| **Frontend API Modules** | kebab-case in `api/` directory | `frontend/src/api/chats.ts`, `frontend/src/api/client.ts`, `frontend/src/api/weaver.ts` |
| **Test Files** | Match target filename + `.test.ts` or `.test.tsx` (or feature-specific suffix) | `tests/generation-stop.test.ts`, `frontend/src/components/chat/InputArea.edit-and-send.test.tsx` |
| **Utility Scripts** | kebab-case with `.ts` extension | `scripts/runner.ts`, `scripts/setup-wizard.ts`, `scripts/build-frontend.ts` |

### 2.2 Identifiers & Symbols

| Identifier Type | Convention | Examples |
| :--- | :--- | :--- |
| **Variables & Functions** | `camelCase` | `assemblePrompt`, `handleResponse`, `activeChatId`, `isStreaming` |
| **Types & Interfaces** | `PascalCase` | `Chat`, `Message`, `AuthUser`, `ConnectionProfile`, `AppStore`, `ChatSlice` |
| **React Components** | `PascalCase` | `ChatView`, `InputArea`, `ConnectionsPicker`, `AvatarSwitcherPopover` |
| **React Custom Hooks** | `camelCase` starting with `use` | `useMessageCard`, `useSwipeAction`, `useStore` |
| **Global / Static Constants** | `UPPER_SNAKE_CASE` | `BASE_URL`, `DEFAULT_TIMEOUT_MS`, `HIDDEN_FROM_RECENT_KEY`, `MAX_IMAGE_UPLOAD_BYTES` |
| **TypeScript Enums / Event Names** | `PascalCase` or `UPPER_SNAKE_CASE` | `EventType.GENERATION_STARTED`, `EventType.CHAT_MESSAGE_CREATED` |
| **Service Parameter Scoping** | First parameter is consistently `userId` | `createChat(userId, input)`, `getMessages(userId, chatId)`, `listRecentChats(userId, pagination)` |

---

## 3. Code Style & Formatting

### 3.1 Indentation & Spacing
- **Indentation:** Exactly **2 spaces** (no tabs) across all TypeScript, TSX, JSON, and SQL files.
- **Line Length:** Generally kept within readable 80–120 character limits; long method signatures or SQL queries wrap cleanly.
- **Blank Lines:** Single blank line between logically distinct function declarations or block statements; double blank lines avoid clutter.

### 3.2 Quotes & Semicolons
- **Backend (`src/`, `scripts/`, `tests/`):**
  - Uses double quotes (`"..."`) for string literals and import specifiers:
    ```typescript
    import { getDb } from "../db/connection";
    import * as chatsSvc from "../services/chats.service";
    ```
  - Semicolons are consistently included at statement terminations.
- **Frontend (`frontend/src/`):**
  - Uses single quotes (`'...'`) for string literals and import paths:
    ```typescript
    import { create } from 'zustand'
    import type { AppStore } from '@/types/store'
    ```
  - Semicolons are omitted in modern frontend components, hooks, and store slices.

### 3.3 TypeScript Configuration & Strictness
- **Backend `tsconfig.json`:**
  - `target`: `"ESNext"`
  - `module`: `"ESNext"`
  - `moduleResolution`: `"bundler"`
  - `strict`: `true`
  - `skipLibCheck`: `true`
  - Path mapping: `"@/*": ["./src/*"]`
- **Frontend `frontend/tsconfig.json`:**
  - `target`: `"ES2022"`
  - `lib`: `["ES2023", "DOM"]`
  - `module`: `"ESNext"`
  - `moduleResolution`: `"bundler"`
  - `allowImportingTsExtensions`: `true`
  - `isolatedModules`: `true`
  - `noEmit`: `true`
  - `jsx`: `"react-jsx"`
  - Path mapping: `"@/*": ["./src/*"]`

### 3.4 ESLint & React Compiler Rules
Configured in `frontend/eslint.config.js`:
- Uses flat ESLint 10 configuration with `@typescript-eslint/parser`.
- **React Compiler Plugin:** `'react-compiler/react-compiler': 'error'` enforces memoization and pure component rendering compliant with the React 19 compiler.
- **React Hooks:**
  - `'react-hooks/rules-of-hooks': 'error'`
  - `'react-hooks/exhaustive-deps': 'warn'`

---

## 4. Import & Module Organization

### 4.1 Import Grouping Order
Files follow a strict 5-tier import structure separated by blank lines:

1. **Runtime / Built-in Node / Bun modules:**
   ```typescript
   import { createHash } from "node:crypto";
   import { join, dirname } from "node:path";
   import { describe, expect, test, mock } from "bun:test";
   ```
2. **Third-party npm packages:**
   ```typescript
   import { Hono } from "hono";
   import { create } from "zustand";
   import { LucideIcon, Sparkles } from "lucide-react";
   ```
3. **Internal Path-Aliased Modules (`@/...`):**
   ```typescript
   import { useStore } from "@/store";
   import { toast } from "@/lib/toast";
   import { post, get } from "@/api/client";
   ```
4. **Internal Relative Modules (`./...` / `../...`):**
   ```typescript
   import { getDb } from "../db/connection";
   import * as chatsSvc from "./chats.service";
   ```
5. **Explicit Type-Only Imports:**
   ```typescript
   import type { StateCreator } from "zustand";
   import type { Chat, Message } from "@/types/store";
   ```

### 4.2 Module Export Strategy
- **Services (`src/services/`):** Export individual named functions (`export function createChat(...)`, `export async function assemblePrompt(...)`). Namespaced wildcards (`import * as chatsSvc from "..."`) are standard when consuming services.
- **Routes (`src/routes/`):** Export a single named Hono sub-app router (`export const chatsRoutes = new Hono<Env>();`).
- **React Components:** Use named exports or default exports for top-level views (`export function ChatView()`, `export default app`).
- **Store Slices (`frontend/src/store/slices/`):** Export named slice creator functions (`export const createChatSlice: StateCreator<ChatSlice> = (set, getState) => ({ ... })`).

---

## 5. Error Handling Patterns

### 5.1 Backend Route Error Handling
- Routes validate incoming payload shapes and scope parameters early, returning explicit JSON error envelopes:
  ```typescript
  if (!characterId) return c.json({ error: "characterId is required" }, 400);
  if (!existing) return c.json({ error: "Not found" }, 404);
  ```
- **Service Exception Catching:** Try/catch blocks in routes translate service-thrown errors into proper HTTP status codes:
  ```typescript
  try {
    const result = await chatsSvc.createMessage(...);
    return c.json(result, 201);
  } catch (err: any) {
    if (err?.message === "Character not found") return c.json({ error: err.message }, 404);
    return c.json({ error: err?.message || "Failed to create message" }, 400);
  }
  ```

### 5.2 Backend Global Error Handling
In `src/app.ts`, global fallback handlers ensure that uncaught exceptions never leak raw server dumps:
- `app.notFound((c) => c.json({ error: "Not found" }, 404));`
- `app.onError((err, c) => ...)`:
  - Identifies `DOMException` / `AbortError` (client disconnects during streaming LLM generations) and returns HTTP 499 (`"Client disconnected"`).
  - Logs unhandled exceptions with full stack traces: `console.error(`[onError] ${path}:`, err)`.
  - Returns clean `{ error: "Internal server error" }` with HTTP 500.

### 5.3 Frontend API Client Error Architecture
Defined in `frontend/src/api/client.ts`:
- **`ApiError`:** Custom error class encapsulating `status`, `statusText`, and parsed response `body`.
- **`RequestTimeoutError`:** Dispatched when a request exceeds `DEFAULT_TIMEOUT_MS` (30 seconds default), preventing UI deadlock during long-running embedding or inference operations.
- **AbortSignal Interoperability:** All HTTP methods (`get`, `post`, `put`, `del`, `patch`, `upload`) accept `{ signal, timeout }` in `RequestOptions`.

### 5.4 Frontend UI Error Notification
Defined in `frontend/src/lib/toast.ts`:
- Toast notifications provide non-blocking feedback:
  ```typescript
  toast.error(err?.body?.error || err?.message || t('toast.defaultError'));
  toast.success(t('toast.savedSuccessfully'));
  toast.warning(t('toast.limitExceeded'));
  toast.info(t('toast.generatingResponse'));
  ```
- Uses `i18next` translation keys (`t('toast.message')`) rather than hardcoded user-facing strings.

---

## 6. Logging & Diagnostics Patterns

### 6.1 Domain Prefix Convention
All system messages use standardized, bracketed domain identifiers to provide rapid diagnostic filtering:

| Prefix | Domain / Subsystem | Example |
| :--- | :--- | :--- |
| `[Auth]` | User authentication, session validation, SSO | `console.log("[Auth] Seeding owner account: admin")` |
| `[db]` | SQLite migrations, connection pool, repair | `console.warn("[db] Automatic maintenance tick failed:", err)` |
| `[runner]` | Desktop runner process orchestration | `console.log("[runner] Spawning backend child process")` |
| `[mcp]` | Model Context Protocol client/server | `console.error("[mcp] Stdio transport disconnected:", err)` |
| `[weaver]` | Memory Cortex / narrative extractor | `console.debug("[weaver] Synthesizing memory chunks")` |
| `[abort]` | Request cancellation / stream aborts | `console.warn(`[abort] ${path}: ${err.message}`)` |
| `[onError]` | Uncaught application route exceptions | `console.error(`[onError] ${path}:`, err.stack)` |

### 6.2 Structured Migration Logger
For database and export/import operations (`src/migration/`), functions accept a structured `MigrationLogger`:
```typescript
export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  progress(stage: string, current: number, total: number): void;
}
```

---

## 7. Comments & Documentation Standards

### 7.1 Section Dividers
Major functional divisions within long service files and entry points use horizontal box-drawing dividers:
```typescript
// ── Transpiler cache pinning ────────────────────────────────────────────────
// Bun mmap's its transpiler cache files. If the cache lives in /tmp and gets
// cleaned by systemd-tmpfiles, stale mmap triggers SIGBUS...
```
or lighter ASCII section headers:
```typescript
// --- Chat helpers ---
```

### 7.2 Multi-line Invariant Comments
Complex invariants, concurrency races, streaming buffer offsets, and fallback semantics require explicit multi-line explanation preceding the code block:
```typescript
/**
 * Monotonic stream reconciliation: snapshots race live WS tokens.
 * Slices off overlap when the segment start position is covered;
 * signals gap when tokens were dropped so caller can re-poll the pool.
 */
```

### 7.3 Type Annotations & Property Comments
All core domain models in `src/types/` and `frontend/src/types/store.ts` include inline documentation for optional or non-obvious properties:
```typescript
export interface ChatSlice {
  /** Active avatar image_id override from chat metadata */
  activeChatAvatarId: string | null;
  /** Index of the swipe the active generation streams into */
  streamingSwipeId: number | null;
}
```

---

## 8. Function & Module Design

1. **Strict Service / Route Boundary:** Routes handle request unpacking, validation, cookie/auth session verification, and JSON serialization. Business logic, database queries, crypto operations, and file storage reside exclusively in `src/services/`.
2. **Multi-Tenant User Scoping:** Every data manipulation and retrieval function in `src/services/` requires an explicit `userId: string` parameter. Database queries enforce `WHERE user_id = ?` (or appropriate relational join) on every query.
3. **Immutability & Pure Helpers:** Pure helper functions (parsing JSON metadata, calculating token budgets, formatting color pickers) are extracted as top-level private functions within their respective service or utility module.
4. **Defensive Parameter Normalization:** Helper functions normalize nullable parameters (e.g., `parseMetadataObject(raw)` ensuring an object is returned even on malformed or empty database cells).

---

## 9. Zustand State Management Conventions

### 9.1 Sliced Architecture
The frontend global state in `frontend/src/store/index.ts` aggregates modular slices defined in `frontend/src/store/slices/`:
```typescript
export const useStore = create<AppStore>()((...a) => ({
  ...createChatSlice(...a),
  ...createCharactersSlice(...a),
  ...createPersonasSlice(...a),
  ...createUISlice(...a),
  ...createSettingsSlice(...a),
  // ...other slices
}))
```

### 9.2 Atomic Component Selectors
React components **must** select state atomically with fine-grained selector callbacks to prevent unnecessary re-render cascades:
```typescript
// ✅ RECOMMENDED: Fine-grained atomic selection
const activeChatId = useStore((s) => s.activeChatId)
const isStreaming = useStore((s) => s.isStreaming)
const addMessage = useStore((s) => s.addMessage)

// ❌ DISCOURAGED: Destructuring whole store triggers re-renders on any store update
const { activeChatId, isStreaming } = useStore()
```

### 9.3 Imperative State Access (`useStore.getState()`)
For callbacks outside React render cycles (event listeners, WebSocket handlers, coordinators, API response handlers):
```typescript
const { activeLoomPresetId } = useStore.getState()
useStore.getState().updateCharacter(characterId, updatedFields)
```

### 9.4 User-Scoped Reset & Session Invalidation
When users log out or switch accounts, state must be cleanly wiped to prevent data leakage across sessions:
- Store instances register with `registerUserScopedResetStore(useStore, useStore.getState())`.
- On login/logout, `resetUserScopedStoreState()` restores all slices to their pristine initial states.

### 9.5 Asynchronous Race Condition Guards
Async store operations utilize generation counters to discard outdated responses from overlapping requests:
```typescript
let authMutationGeneration = 0

export const createAuthSlice: StateCreator<AuthSlice> = (set, getState) => ({
  login: async (username, password) => {
    const mutationGeneration = ++authMutationGeneration
    // ...await network response
    if (mutationGeneration !== authMutationGeneration) return // Stale response discarded
    // ...commit state
  }
})
```

---

*Convention analysis: 2026-08-17*
