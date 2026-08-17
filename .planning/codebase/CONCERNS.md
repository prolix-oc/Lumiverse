# Codebase Concerns & Technical Debt

**Analysis Date:** 2026-08-17

This document provides an exhaustive audit of technical debt, known bugs, security considerations, performance bottlenecks, fragile areas, scaling limits, dependencies at risk, and test coverage gaps across the Lumiverse codebase (`src/`, `frontend/`, `scripts/`, `tests/`).

---

## 1. Executive Summary & Risk Heatmap

| Risk Category | Severity | Primary Areas Affected | Summary |
| :--- | :--- | :--- | :--- |
| **Cross-Tenant File Access** | **High** | `src/services/files.service.ts` | Fallback resolution in file retrieval and deletion allows path traversal across user upload directories if user IDs are known. |
| **Monolithic God Modules** | **High** | `src/services/prompt-assembly.service.ts`, `src/services/generate.service.ts`, `frontend/src/components/chat/InputArea.tsx` | Multiple core files exceed 4,000 to 8,000 lines of code, creating tight coupling, high regression risks, and slow developer onboarding. |
| **Extension Sandboxing Limits** | **Medium-High** | `src/spindle/manager.service.ts`, `src/spindle/worker-runtime.ts` | Backend Spindle extension isolation relies on static AST/regex scanning and cooperative in-worker speed bumps; native dynamic imports and process globals cannot be fully sealed without OS-level sandboxing. |
| **Test Suite Flakiness & State Bleed** | **Medium-High** | `tests/`, `frontend/src/` | 43 failing tests during full `bun test` execution due to shared SQLite DB mutation, persona/character schema collisions, `queueMicrotask` violations, and missing React 19 / i18next export bindings. |
| **Database Concurrency & SQLite Locks** | **Medium** | `src/db/connection.ts`, `src/db/maintenance.ts`, `src/db/migrate.ts` | Single SQLite database with 5000ms busy timeout can block during heavy operations (Cortex rebuilds, batch ZIP imports, full-text vacuuming). |
| **Vector Store Native Bindings & Drift** | **Medium** | `src/services/vector-store/providers/lancedb.ts`, `src/services/embeddings.service.ts` | LanceDB 0.29 / Arrow 18 native Rust bindings require platform-specific binaries; disk index directory leaks require scheduled garbage collection. |
| **Frontend CSS / SVG Injection Surface** | **Medium** | `frontend/src/lib/richHtmlSanitizer.ts`, `frontend/src/components/chat/MessageContent.tsx` | Character card HTML islands allow custom CSS `<style>` blocks and inline SVGs, introducing potential style bleed and UI redress risks if not strictly scoped. |
| **Single-Point-of-Failure Identity Key** | **Medium** | `src/crypto/identity.ts`, `src/crypto/credentials.ts`, `data/lumiverse.identity` | Master AES encryption key stored in plaintext identity file; loss or corruption results in irreversible loss of all stored API keys and connection credentials. |

---

## 2. Technical Debt & Monolithic Modules

### 2.1 Massive "God Files" and High Complexity

The codebase exhibits extreme concentration of business logic in a handful of oversized modules:

```
src/services/prompt-assembly.service.ts   8,092 lines (288 KB)
src/services/generate.service.ts          5,135 lines (211 KB)
src/spindle/worker-runtime.ts             4,892 lines (183 KB)
src/spindle/worker-host.ts                4,797 lines (182 KB)
src/services/embeddings.service.ts        4,513 lines (181 KB)
src/services/chats.service.ts             4,108 lines (176 KB)
src/services/memory-cortex/index.ts       3,582 lines (149 KB)
src/services/world-books.service.ts       2,364 lines (98 KB)
src/services/regex-scripts.service.ts     2,364 lines (89 KB)
src/services/user-data/import.service.ts  2,292 lines (90 KB)
src/spindle/manager.service.ts            2,223 lines (81 KB)
src/services/memory-cortex/entity-graph.ts 2,207 lines (95 KB)
src/services/image-gen.service.ts         2,163 lines (93 KB)
frontend/src/lib/generatedComponentProps.ts 9,778 lines (300 KB)
frontend/src/components/chat/InputArea.tsx  4,105 lines (150 KB)
frontend/src/components/modals/SettingsModal.tsx 3,692 lines (135 KB)
frontend/src/components/panels/LoomBuilder.tsx   2,889 lines (110 KB)
frontend/src/components/settings/OperatorPanel.tsx 2,799 lines (105 KB)
frontend/src/lib/spindle/loader.ts               2,541 lines (95 KB)
frontend/src/components/panels/character-browser/CharacterEditorPage.tsx 2,501 lines (92 KB)
frontend/src/components/shared/WorldBookEntriesSection.tsx 2,231 lines (85 KB)
frontend/src/ws/useWebSocket.ts                  2,085 lines (75 KB)
```

#### Key Architecture Risks in These Modules:
1. **`src/services/prompt-assembly.service.ts`**:
   - Central clearinghouse for every generation request.
   - Manages token counters, Lorebook activation scans, Spindle block injection, Memory Cortex retrieval formatting, macro resolution, author's notes, user personas, chat history pruning, and regex pre/post rules.
   - Modifying any single prompt block behavior risks cascading side-effects across all character types, council members, and Weaver flows.
2. **`src/services/generate.service.ts`**:
   - Manages SSE streams, multi-participant turns, tool execution loops, thinking/reasoning delimiters, abort controller signal bridging, retries, and fallback provider failover in a single massive execution graph.
3. **`src/spindle/worker-host.ts` and `src/spindle/worker-runtime.ts`**:
   - Implements a bi-directional RPC bridge over Worker threads with dozens of APIs (Content, Storage, Memory, ImageGen, Presentation, Interaction, State, Process).
   - Serializing complex DTO structures across threads introduces latency and marshaling bugs.
4. **`frontend/src/components/chat/InputArea.tsx`**:
   - Contains input text parsing, slash command autocomplete, mention dropdowns, STT voice recording, image attachments, LoRA sliders, macro live previews, and token estimation in one gigantic React component.

### 2.2 Architectural Drift & Code Style Inconsistencies

1. **Forbidden `queueMicrotask` Usage:**
   - Architectural rule strictly forbids bare `queueMicrotask()` in favor of explicit low-priority schedulers.
   - Violations found in `frontend/src/hooks/useFolders.ts` (lines 66, 82, 93), causing `tests/no-queue-microtask.test.ts` to fail.
2. **Duplicate Migration Sequence Numbers:**
   - Duplicate prefix `048`: `src/db/migrations/048_chat_memory_cache.sql` and `src/db/migrations/048_dream_weaver_sessions.sql`.
   - Duplicate prefix `056`: `src/db/migrations/056_global_addons.sql` and `src/db/migrations/056_saved_prompts.sql`.
   - While SQLite applies migrations by filename sort order, duplicate prefixes indicate divergent branches merged without canonical renumbering.
3. **Migration Squash vs Prune Logic:**
   - `src/db/migrate.ts` contains hardcoded drift recovery functions (`repairDreamWeaverBaselineDrift`, `isBaselineDriftAlreadyApplied`) and an explicit foreign key toggle exception for `078_chats_character_id_nullable.sql`.
   - Incomplete cleanup logic exists for pruned SQL files in non-git environments.

---

## 3. Known Bugs & Test Suite Health

### 3.1 Test Suite Status (Executed: `bun test`)
During full test execution across 132 files (676 tests):
- **Passing:** 631
- **Skipped:** 2 (Large benchmark tests requiring `BENCHMARK=1`)
- **Failing:** 43 tests
- **Errors:** 1 uncaught syntax error

```
Failures Summary:
- tests/temporary-chats.test.ts (5 failures): Foreign key and persona binding errors when characters/personas are seeded concurrently without isolated DB teardowns.
- tests/multiplayer.test.ts (26 failures): Multiplayer turn engine and WS relay tests fail due to shared SQLite DB state and uncleaned room tokens across test iterations.
- tests/no-queue-microtask.test.ts (1 failure): queueMicrotask used in frontend/src/hooks/useFolders.ts.
- tests/dockerfile-runtime-layout.test.ts (1 failure): Missing frontend version metadata asset assertion.
- tests/landing-page.test.ts (1 failure): landingPageTabs selector test expectation failure.
- tests/moonshot-interleaved-thinking.test.ts & tests/anthropic-interleaved-thinking.test.ts (2 failures): Provider reasoning content token stream mismatch on plain non-tool assistant turns.
- frontend/src/components/panels/imageGenLoraEditor.test.tsx (1 error): SyntaxError: Export named 'I18nextProvider' not found in module 'react-i18next' under React 19 / Vite bundler.
```

### 3.2 Specific Fragile Behaviors

1. **Test DB State Bleed:**
   - Tests run in-process using `bun:sqlite` against either a shared test DB or file path without complete table isolation or rollback transactions between test files.
2. **LanceDB Index Directory Leaks:**
   - LanceDB leaves orphaned index directories on disk during frequent vector table creation/deletion in tests, triggering explicit runtime sweeping (`[embeddings] Reclaimed 18 empty LanceDB index directories`).
3. **Windows Bun Stream Abort Handling:**
   - `src/llm/stream-utils.ts` documents a known runtime bug in Bun v1.3.x on Windows where passing `AbortSignal` directly to fetch causes process crashes, requiring manual controller wrapping.

---

## 4. Security Considerations & Attack Surface

### 4.1 Cross-Tenant File Traversal in `files.service.ts`

**Location:** `src/services/files.service.ts` (lines 53-91) and `src/routes/files.routes.ts`

```typescript
// src/services/files.service.ts
export async function getFilePath(userId: string, filename: string, subdir: string = "uploads"): Promise<string | null> {
  const scopedBase = resolve(env.dataDir, subdir, userId);
  const scopedPath = resolve(scopedBase, filename);
  if ((scopedPath.startsWith(scopedBase + sep) || scopedPath === scopedBase) && (await Bun.file(scopedPath).exists())) {
    return scopedPath;
  }

  // Vulnerability: Fallback allows accessing other users' files if filename is "victim_user_id/file.png"
  const legacyBase = resolve(env.dataDir, subdir);
  const legacyPath = resolve(legacyBase, filename);
  if (!legacyPath.startsWith(legacyBase + sep) && legacyPath !== legacyBase) return null;
  if (!(await Bun.file(legacyPath).exists())) return null;
  return legacyPath;
}
```

- **Impact:** An authenticated user who knows or guesses another user's UUID can pass `filename = "<target_user_id>/<file_uuid>.png"` to `GET /api/v1/files/:filename` or `DELETE /api/v1/files/:filename`.
- **Root Cause:** The legacy fallback path checks `legacyPath.startsWith(legacyBase + sep)`, which is satisfied for any path inside `data/uploads/`, even inside another user's subfolder.
- **Remediation Required:** Sanitize `filename` with `basename(filename)` to disallow directory separators entirely, or enforce that `legacyPath` is strictly in the root `uploads/` directory without nested user folders.

### 4.2 Spindle Extension Sandboxing Boundary

**Location:** `src/spindle/manager.service.ts` and `src/spindle/worker-runtime.ts`

- Spindle backend extensions run in Bun Worker threads.
- Security enforcement relies on:
  1. Static regex/AST scanning (`DANGEROUS_BACKEND_CHECKS` checking for `fs`, `child_process`, `net`, `tls`, `bun:sqlite`, `Bun.spawn`, `process.env`).
  2. In-worker `initializeSandbox()` patching `eval`, `Function`, and global properties.
- **Weakness:** As acknowledged in `src/spindle/worker-runtime.ts` (lines 4220-4228), dynamic `import()` and native Bun internals cannot be fully intercepted in JavaScript runtime code. Static regex filters can theoretically be bypassed via dynamic code construction (`globalThis["pro" + "cess"]`, `import("node:" + "fs")`).
- **Remediation:** Extensions should be executed in true OS-isolated sandbox environments (e.g. gVisor, WebAssembly / WASI, or containerized runners) for multi-tenant or untrusted third-party extensions.

### 4.3 MCP Stdio Local Process Execution

**Location:** `src/services/mcp-stdio-policy.ts` and `src/services/mcp-client-manager.ts`

- Stdio MCP servers spawn local system processes (`node`, `bun`, `deno`, `python`, `python3`).
- Policy checks command base names and flags (`-e`, `-c`, `eval`), and requires package whitelisting for `npx`/`uvx`.
- **Risk:** If an administrator or operator configures a malicious local script path or an overly broad `MCP_STDIO_ALLOWED_COMMANDS`, child processes inherit server privileges.

### 4.4 HTML Island Rendering & CSS Injection in Frontend

**Location:** `frontend/src/lib/richHtmlSanitizer.ts` and `frontend/src/components/chat/MessageContent.tsx`

- Lumiverse character cards and messages support rich HTML and "HTML Islands" with embedded `<style>` blocks and SVG graphics.
- DOMPurify is used with custom configurations. `sanitizeHtmlIsland()` allows `<style>` tags after stripping `@import` and `expression()`.
- **Risk:** Embedded CSS in character cards can override application styling, hide UI warning banners, construct CSS-based clickjacking overlays (`position: fixed; width: 100vw; height: 100vh; opacity: 0;`), or trigger asset-based data exfiltration via background image URLs in CSS selectors.

### 4.5 Master Identity & Encryption Key Protection

**Location:** `src/crypto/identity.ts` and `src/crypto/credentials.ts`

- Master AES-256-GCM encryption key is stored in `data/lumiverse.identity`.
- All LLM connection API keys, image generation secrets, and STT/TTS credentials in SQLite are encrypted with this key.
- `AUTH_SECRET` for BetterAuth session validation is derived from this key if not specified in `.env`.
- **Risk:** If `data/lumiverse.identity` is deleted or corrupted without a backup, all encrypted secrets in the database are permanently unrecoverable.

### 4.6 Unauthenticated Endpoints & OAuth Landings

**Location:** `src/app.ts` (lines 320-442)

- `/api/v1/image-gen/results/:id`: Publicly accessible without authentication for push notification embeds. An attacker enumerating UUIDs could view generated image assets.
- `/api/v1/openrouter/oauth-landing` & `/api/v1/nanogpt/oauth-landing`: Unauthenticated OAuth popup redirect receivers using `postMessage`. Origin checking is performed against allowlisted origins, but relies on accurate `opener_origin` query parameter validation.

---

## 5. Performance Bottlenecks

### 5.1 Prompt Assembly Pipeline Latency

**Location:** `src/services/prompt-assembly.service.ts`

For every chat generation, the prompt assembly pipeline executes:
1. Message history truncation and branching path resolution from SQLite.
2. Tokenization passes using `@lenml/tokenizers`, `gpt-tokenizer`, or `js-tiktoken`.
3. Lorebook activation scan (secondary keywords, regex matching, constant entries, token limits).
4. Memory Cortex dual-pass retrieval (heuristic salience + LanceDB vector similarity + shadow prompt generation).
5. Spindle interceptor pipeline execution (synchronous / asynchronous extension hooks).
6. Regex script transformation (pre-prompt, post-prompt, display filters).
7. Macro evaluation (`MacroEvaluator.ts`) across all prompt blocks.

**Bottleneck:** In long conversations (100+ turns) with multiple large Lorebooks (1,000+ entries) and Memory Cortex enabled, prompt assembly can take hundreds of milliseconds before the first LLM token stream request is dispatched.

### 5.2 LanceDB Vector Search & Locking Contention

**Location:** `src/services/vector-store/providers/lancedb.ts`

- LanceDB operations require a cross-process lock (`shouldUseCrossProcessWriteLock`).
- Simultaneous background ingestion of chat chunks, Databank indexing, and query retrieval serialize through table write gates.
- On non-POSIX or network-mounted storage, lock acquisition can introduce latency spikes during active conversation streams.

### 5.3 On-the-Fly Image Processing & Video Normalization

**Location:** `src/services/images.service.ts` and `src/services/silent-video.service.ts`

- High-resolution user avatars, character gallery images, and generated images are resized into WebP thumbnails (`sm`, `lg`) using `sharp`.
- Video uploads trigger FFmpeg transcoding to strip audio and normalize codecs (`h264`, `hevc`).
- Executing FFmpeg and Sharp within the main Bun process can cause event-loop lag during concurrent multi-user media uploads.

### 5.4 SQLite Write Concurrency & VACUUM Locks

**Location:** `src/db/connection.ts` and `src/db/maintenance.ts`

- SQLite operates in WAL mode with a busy timeout of 5,000ms.
- Operations like `runDatabaseMaintenance` (VACUUM, REINDEX, PRAGMA optimize), Memory Cortex rebuilds, or SillyTavern bulk imports hold exclusive write locks, causing concurrent HTTP requests to throw `SQLITE_BUSY` if they exceed the 5s window.

---

## 6. Fragile Areas & Architectural Traps

### 6.1 Bun / Node Platform Quirks on Windows & Android (Termux)

1. **`bun:sqlite` Prepared Statement Invalidation:**
   - As documented in `src/db/connection.ts` (`_generation`), when the underlying database is reset or closed during migrations or testing, cached prepared statements fail silently in Bun.
2. **Memory-Mapped I/O Disabled on Windows:**
   - In `src/db/maintenance.ts`, `mmap` is explicitly disabled on Windows because Windows file locking prevents truncating or checkpointing memory-mapped files, causing uncatchable crash faults.
3. **Termux / Android Proot Path Translations:**
   - `src/services/vector-store/providers/lancedb.ts` includes dedicated workarounds for broken Termux mirror paths and missing POSIX symlinks.

### 6.2 Frontend Zustand Store Synchronization

**Location:** `frontend/src/types/store.ts` (1,796 lines), `frontend/src/store/slices/settings.ts`

- State is distributed across massive slices with complex optimistic updates (chat branches, swipe variations, character folders, world book entries, Spindle extensions).
- Preset save coordination (`frontend/src/lib/loom/preset-save-coordinator.ts`) requires complex conflict resolution and rebase logic to prevent stale reads from overwriting concurrent UI edits.

---

## 7. Scaling Limits & Operational Boundaries

| Dimension | Current Limit / Behavior | Scaling Concern |
| :--- | :--- | :--- |
| **Multi-Tenancy** | Single SQLite file (`data/lumiverse.db`) with user_id scoping | Cannot scale horizontally across multiple application servers; write throughput bounded by single-file SQLite lock. |
| **Max Upload Size** | 10 MB default API cap, 100 MB for ZIP/charx imports, 512 MB Bun server cap | Large batch imports (4–6 GiB) stream to disk but require high memory headroom during ZIP64 central directory traversal. |
| **Vector Store Size** | Single local LanceDB directory (`data/lancedb`) | Tables grow linearly on disk; fragmentation requires periodic compaction and empty index directory cleanups. |
| **WebSocket Concurrency** | In-memory EventEmitter (`src/ws/bus.ts`) | Broadcasts cannot cross multiple process instances without an external pub/sub layer (e.g. Redis). |
| **Spindle Worker Threads** | 1 Worker thread per active extension | Multiple active extensions running complex AST parses or regex filters can exhaust CPU cores. |

---

## 8. Dependencies at Risk

### 8.1 Pinned Native Binaries
- **`@lancedb/lancedb` (`0.29.0`) & `apache-arrow` (`18.1.0`):** Pinned exact versions due to binary ABI compatibility requirements across Linux, macOS, Windows, and Android ARM64. Upgrading requires rebuilding and testing native Rust bindings.
- **`sharp` (`^0.34.5`) & `ffmpeg-static` (`^5.3.0`):** Heavy native binaries; platform mismatch can fail on stripped environments.

### 8.2 Rapidly Evolving Core Libraries
- **`better-auth` (`^1.5.3`):** Auth library undergoing active schema changes and feature additions; requires tight synchronization with custom `account` and `session` SQLite tables.
- **`@modelcontextprotocol/sdk` (`^1.29.0`):** MCP specification is evolving rapidly; transport and tool calling semantics may change across minor releases.

### 8.3 Pinned Overrides in `package.json`
- `lru-cache`: `11.2.7`
- `kysely`: `0.28.15`
- `protobufjs`: `8.7.0`
Overrides are required to force dependency sub-trees to avoid known security issues and memory leaks.

---

## 9. Test Coverage Gaps

### 9.1 Areas with Zero or Minimal Automated Coverage

1. **Frontend UI Components:**
   - While `frontend/src/lib/` has good coverage for helper utilities, large visual components (`InputArea.tsx`, `SettingsModal.tsx`, `LoomBuilder.tsx`, `CharacterEditorPage.tsx`) have no unit or snapshot tests.
   - `frontend/src/components/panels/imageGenLoraEditor.test.tsx` currently crashes on import due to missing i18n mocks.
2. **End-to-End User Journeys:**
   - No automated Playwright or Cypress tests verifying full browser workflows (e.g. login -> create character -> upload avatar -> send chat message -> stream completion -> switch branch).
3. **Database Migration Rollback Tests:**
   - All 108 migrations in `src/db/migrations/` are forward-only. There are no automated tests verifying schema downgrade or rollback integrity.
4. **Real Provider SSE Stream Edge Cases:**
   - LLM stream tests primarily use mock responses. Transient network failures, malformed SSE chunks, and mid-stream HTTP 429 retries are not covered under automated integration tests.
5. **Multiplayer Concurrency Race Conditions:**
   - Multiplayer room turn-passing, simultaneous WebSocket token joins, and concurrent lorebook relays suffer from test isolation failures and lack high-concurrency stress testing.

---

*Concerns audit: 2026-08-17*
