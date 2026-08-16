# Specification: Spindle Extensibility V2, Universal UI Dives, Toolbar Dynamics, Connection Picker Modernization, and Settings/Editing Modernization

## 1. Overview & Strategic Intent
This track modernizes the Lumiverse extension architecture and user experience across two core repositories:
- **`lumiverse-spindle-types`**: The public SDK providing canonical TypeScript definitions for third-party and first-party Spindle extensions.
- **`Lumiverse`**: The host application containing the frontend runtime, UI components, backend services, and the first-party `lumiverse_suite` extension.

The goal is to elevate Spindle extensions to first-class citizens capable of extending and modifying every part of the Lumiverse UI (toolbars, action bars, settings panels, connections, model lists, message edit flows, custom embedding/TTS/STT/sidecar drivers) in a secure, type-safe, and decoupled manner—eliminating the need for ad-hoc monkey patching, brittle `MutationObserver` DOM scraping, and core source modifications.

---

## 2. Functional Requirements

### 2.1 Spindle Types & Runtime Extensibility (`lumiverse-spindle-types` & Host Runtime)
- **Host Surfaces & Component Mounting**:
  - Export `SpindleHostSurfaceHandle` (`update`, `destroy`, `on`) and `mountHostSurface(target, surfaceId, props)` in `SpindleComponentsHelper`.
- **Frontend Settings Bridge**:
  - Export `SpindleSettingsAPI` (`get`, `set`, `remove`, `watch`, `core.get`, `core.watch`, `core.list`, `core.isReady`) on `SpindleFrontendContext.settings`.
  - Expose `ctx.ui.registerSettingsTab(options)` returning `SpindleSettingsTabHandle` with dynamic sidebar tab insertion in `SettingsModal.tsx`.
- **Domain API Contracts**:
  - Export frontend domain methods on `SpindleFrontendContext`:
    - `worldBooks`: `entries(bookId)`, `list()`, `get(bookId)`, `registerEntryDecorator(decorator)`.
    - `tokens`: `countText(text, options)`, `countTextBatch(texts, options)`, `countMessages(messages, options)`.
    - `connections`: `list()`, `get(connectionId)`, `listModels(connectionId)`, `getActive()`, `setActive(connectionId)`.
    - `chats`: `list(characterId)`, `getActive()`, `listForCharacter(characterId)`, `getMessages(chatId, options)`.
    - `messages`: `getContent(id)`, `getRecent(limit)`.
- **Reactive State Selectors & Scale Geometry**:
  - Export `SpindleStateSelectors` (`get(selectorId)`, `subscribe(selectorId, handler)`) on `SpindleFrontendContext.state`.
  - Export `SpindleGeometryAPI` (`getUiScale`, `toLayoutPx`, `layoutViewportSize`, `layoutElementRect`, `createResizeController`) on `SpindleFrontendContext.ui.geometry`.
  - Export `SpindleHostSurfaceAPI` (`list`, `subscribe`, `invoke`, `registerDeepLinkTarget`) on `SpindleFrontendContext.host.surfaces`.
- **Universal Component Overrides & Host Component Wiring**:
  - Expose typed `registerComponentOverride` on `SpindleFrontendContext.ui` allowing third-party extensions to wrap or replace core components across the entire app.
  - Wire the Spindle override adapter across 11 logical host components: `BubbleMessage`, `MinimalMessage`, `MessageEditArea`, `InputArea`, `PortraitPanel`, `QuickToolbar`, `ConnectionsPicker`, `CharacterCard`, `LoomBuilder`, the current `LandingPage` implementation (the LandingPageShell contract), and `CommandPalette`.
- **Declarative DOM Decorators & Central Host Service**:
  - Expose typed `registerDomDecorator` on `SpindleFrontendContext.ui` allowing declarative injection into any DOM slot or selector.
  - Implement a central `DomDecoratorService` in `frontend/src/lib/spindle/` that safely mounts and manages decorator lifecycles on `[data-spindle-mount="..."]` elements without third-party extensions needing raw `MutationObserver` code.
- **Exhaustive Standardized Mount Points (`SpindleMountPoint`)**:
  - **Chat & Conversation**: `chat_header_left`, `chat_header_center`, `chat_header_right`, `chat_top_dock`, `chat_bottom_dock`, `chat_surface_side`, `chat_sidebar_left`, `chat_sidebar_right`, `chat_stream_before`, `chat_stream_after`, `chat_empty_state`, `chat_composer_above`, `chat_composer_below`, `chat_input_tools_left`, `chat_input_tools_right`, `chat_actions`, `chat_toolbar`
  - **Messages & Interactivity**: `message_header`, `message_body_before`, `message_body_after`, `message_footer`, `message_actions`, `message_edit_actions`, `message_context_menu`, `message_swipe_indicators`
  - **Landing & Navigation**: `landing_header`, `landing_hero`, `landing_characters`, `landing_recent_chats`, `landing_footer`, `sidebar_top`, `sidebar_bottom`
  - **Drawers & Editors**: `drawer_tab`, `drawer_header_actions`, `drawer_footer`, `character_editor_tab`, `character_browser_card_actions`, `preset_editor_tab`, `preset_editor_toolbar`, `persona_editor_tab`, `world_book_entry_table`, `world_book_entry_row`, `world_book_entry_editor`, `world_book_entry_toolbar`, `lorebook_workspace`, `lorebook_half_workspace`, `loom_builder_toolbar`, `loom_builder_inspector`, `regex_entry_row`
  - **Settings & Modals**: `settings_tab`, `settings_section`, `settings_card_actions`, `settings_extensions`, `modal_header_actions`, `modal_footer_actions`, `command_palette_actions`, `manage_chats_actions`, `prompt_variables_toolbar`
- **Dynamic Provider & Driver Registries**:
  - Expose backend and frontend registration APIs:
    - `registerEmbeddingDriver(id, driver)` in `src/services/embeddings.service.ts`
    - `registerTtsEngine(id, engine)` through the existing TTS registry in `src/tts/registry.ts` and its service adapter.
    - `registerSttEngine(id, engine)` through the existing STT connection/service layer in `src/services/stt-connections.service.ts` and `src/services/stt.service.ts`.
    - `registerSidecarEndpoint(id, endpoint)` through `src/services/memory-cortex/sidecar-adapter.ts`, with retry orchestration in `src/services/memory-cortex/index.ts` and persisted shape in `src/services/memory-cortex/config.ts`.
  - Ensure dynamic drivers appear in host selection menus (Embeddings Settings, Voice Settings, Memory Cortex).
- **`lumiverse_suite` Refactor**:
  - Refactor `lumiverse_suite` as an exemplary consumer demonstrating that 100% of its features run on public SDK types without module augmentation hacks or direct DOM scraping.

### 2.2 Toolbar Overhaul & Docking Systems
- **V1 Free Toolbar Auto-Resize Bug Fix**:
  - Prevent pinned width/height in `quickToolbarSettings.rect` from overriding natural dimensions when `iconSize`, `labelTextSize`, or `labelVisible` changes.
  - Auto-recalibrate bounds when sizing preferences change, and add a setting: *"Auto-fit toolbar bounds to content"*.
- **Toolbar Zero Dead Space & Sizing Freedom**:
  - Adjust item flex sizing (`flex: 0 0 auto` with configurable gap/padding) so the V1 toolbar can be shrunk or expanded without dead space gaps.
  - Remove artificial minimum drag bounds that prevent shrinking to content size.
- **Extension Action Icons in Customizer**:
  - Replace hardcoded `Puzzle` fallback in `useQuickToolbarActions.ts`, `drawer-tab-registry.tsx`, and `QuickToolbarCustomizeModal.tsx` with a sanitized `DynamicExtensionIcon` rendering SVG (`iconSvg`) or image (`iconUrl`).
- **Top Bar Snapping & Docking**:
  - Add option in Productivity Settings to glue/dock the Quick Toolbar into the stable `chat_top_dock` mount or magnetically snap to its bottom edge; generated CSS-module class names are not part of the contract.
- **Toolbar Drag-and-Drop Reordering**:
  - Add inline drag-and-drop support on both V1 and V2 toolbars with pointer hold constraint (e.g. 2-second hold or drag handle mode) to preserve instant-click responsiveness.
  - Ensure drag-and-drop ordering is fully functional in Productivity Settings customizer.
- **V2 Card Strip Icon-Only Mode**:
  - Add setting to hide all text labels and context subtitles completely, rendering compact square icon-only cards.
- **Surfacing Chat Docker Popover Actions on Toolbar**:
  - Register the 8 chat docker tools (`Manage Chats`, `New Chat`, `Chat Settings`, `Prompt Variables`, `Convert to Group Chat`, `New Group Chat`, `Author's Note`, `Recompile Memories`) in `commands.ts` (`group: 'actions'`) so they can be toggled on/off in the Quick Toolbar.
- **Customizable Chat Docker Action Bar**:
  - Allow adding, removing, and reordering buttons in the chat input action bar from built-in actions, chat docker tools, and Spindle extension actions.

### 2.3 Connection Picker & Model Selector Modernization
- **Provider Reset Fix**:
  - Hydrate `activeProfileId` in `store.hydrateStartupSettings` to eliminate cold-start race on page reload.
  - Fix object-reference churn in `selectedProfile` during model selection to prevent unmounting the model grid and showing loading spinners.
- **Grid vs List Dropdown View Mode**:
  - Add `modelLayout: 'grid' | 'list'` in `ConnectionsPickerSettings` with UI toggle in Productivity Settings.
  - Render a vertical scrollable list when `'list'` is active; render a balanced multi-column grid when `'grid'` is active.
- **Model Refresh Button**:
  - Add a dedicated refresh button (`RefreshCw`) in the Models panel header with client-side cache busting.
- **Provider-Scoped Model Search Field**:
  - Add an in-panel search field that filters models specifically for the selected connection profile.

### 2.4 Settings & Message Editing Extensibility
- **Embedding Settings Modernization**:
  - Support selecting from saved Connection Profiles (or dedicated embedding profiles) via `ConnectionSelect`.
  - Add Fallback / Backup Provider configuration for embeddings.
  - Add UI controls for Google Vertex embedding provider.
- **Memory Cortex Fallback Provider**:
  - Support secondary LLM Connection Profile failover before heuristic degradation.
- **Message Editing "Edit and Send" Action**:
  - Add "Edit and Send" button in `MessageEditArea`.
  - If a subsequent assistant message exists, initiate a swipe generation; if not, initiate a standard new generation.
- **Secure Spindle Mounts & Settings Integration**:
  - Expose `settings_section` in `SettingsModal.tsx` and `ProductivitySettings.tsx` to allow third-party extension cards to be mounted into core settings tabs.
  - Render dynamically registered extension tabs in `SettingsModal.tsx` via `settingsTabRegistry`.
  - Expose `message_actions` and `message_edit_actions` in `BubbleActions.tsx` and `MessageEditArea.tsx`.

---

## 3. Non-Functional Requirements & Security Boundaries
- **Zero Core Modification Requirement for Extensions**: Any third-party extension should be able to create custom toolbars, action bar buttons, settings cards, message actions, and decorators using only the Spindle SDK.
- **Security & Enclave Isolation**: All extension DOM mounts remain sandboxed or scoped with `data-spindle-extension-root`, SVG icons are sanitized with `DOMPurify`, and backend permissions are strictly enforced.
- **Performance & Zero Regression**: Instant click handlers must not lag due to drag listeners, model lists must use client-side caching to avoid unnecessary API calls, and build bundle sizes must stay optimal.

---

## 4. Contract, Compatibility, and Lifecycle Constraints

### 4.1 Public SDK Additivity
- Existing exported types and the four legacy mount literals remain source-compatible.
- New frontend context capabilities use optional capability-gated members or a new V2 context interface. Existing consumers are not forced to implement new required properties.
- The host advertises the V2 capability before extensions use settings, state, geometry, surfaces, decorators, overrides, or provider registration.
- Every new registration returns an idempotent handle or disposer and is owned by extension identity plus activation generation. Unload, reload, permission revocation, duplicate IDs, and failed registration are deterministic.
- SDK declaration output, package exports, host dependencies, and first-party consumer dependencies resolve the same SDK revision. A package-root legacy fixture and packed-package fixture are required.

### 4.2 Mount and Decorator Contract
- The 58 literals listed in section 2.1 are the canonical inventory. The implementation plan maps every literal to an exact host file, render anchor, cardinality, virtualization behavior, and teardown rule.
- Repeated message, row, card, and settings-section anchors support multiple live instances. A single document query or one-root-per-literal implementation is insufficient.
- DomDecoratorService is the single host-owned orchestration layer. It reuses existing sanitization, extension-root stamping, DOM-injection replay, cooperative scheduling, and loader cleanup. Extensions do not create raw document-wide MutationObservers.
- Decorated nodes use host-owned data-spindle-extension-root metadata; extension markup cannot forge ownership or bypass DOMPurify.

### 4.3 Provider Registry Trust Boundary
- Driver registrations are validated at the worker/host boundary and again at the consumer boundary. IDs, schemas, capabilities, endpoint URLs, timeouts, quotas, duplicate ownership, and failure isolation are explicit.
- Provider registration requires a declared permission. Worker-host enforcement, revocation, cleanup, and registry-change notifications are covered by tests.
- Embeddings Settings, Voice Settings, and Memory Cortex consume the same registry and respond to registration and de-registration without a page reload.

### 4.4 Required State and Failure Semantics
- activeProfileId is transported in both backend and frontend bootstrap settings, hydrated before the picker renders, and preserved through connection/model switches.
- Embedding fallback order, profile/secret resolution, unknown-provider preservation, and dimension compatibility are persisted and tested.
- Memory Cortex follows primary retries, secondary-profile retries, then configured heuristic/skip behavior. The retry orchestration, not only the adapter, owns this policy.
- Edit and Send updates the edited user message, creates a conversation branch at that history point, and targets the immediate subsequent assistant for swipe generation when one exists; otherwise it starts normal generation. Existing later history is preserved as the prior branch. Tail, historical, empty, cancellation, and failure cases are tested.

## 5. Invariant Traceability

| Invariant | Required implementation and proof |
|---|---|
| A. Public Types SDK non-breaking additivity | Phase 0 and Phase 1 compatibility policy, version alignment, legacy/consumer/packed fixtures, declaration build. |
| B. Universal UI extensibility | Phase 2 complete 58-anchor matrix, repeated-anchor DomDecoratorService, 11-host override matrix, settings/message mounts, teardown/security tests. |
| C. Dynamic provider and driver registries | Phase 3 worker/host permissions, schemas, owner-scoped handles, consumer wiring, change notifications, unload/revocation tests. |
| D. Toolbar geometry and docker actions | Phase 4 state schema, geometry, stable mounts, shared eight-action catalog, docking, drag, icon, and action-bar tests. |
| E. Connection picker persistence and usability | Phase 4 backend/frontend bootstrap, primitive-ID stability, cache, grid/list, search, refresh, and cold-start tests. |
| F. Embedding and Memory Cortex fallback chains | Phase 5 profile schemas, provider ordering, Cortex retry orchestration, and Edit and Send branch tests. |

---

## 6. Acceptance Criteria
1. lumiverse-spindle-types has an executable npm run build declaration script, passes npm run build:consumer against package-root fixtures, and exports all new surface types, dynamic driver contracts, and APIs without breaking existing definitions.
2. lumiverse_suite compiles without TypeScript module augmentation or missing type errors against the aligned SDK package.
3. All 11 logical host components yield to registered component overrides with safe fallback and unload behavior.
4. DomDecoratorService mounts decorators into all 58 canonical anchors, including repeated and virtualized nodes, with idempotent teardown and extension-root ownership.
5. Dynamic Provider and Driver Registries allow permission-checked custom embedding, TTS, STT, and sidecar registrations, list them in all three consumers, and remove them on unload.
6. SettingsModal renders dynamically registered extension tabs and sections without duplicating the existing settings-tab bridge.
7. Quick Toolbar V1 auto-resizes immediately when icon/label size sliders move.
8. Quick Toolbar V1 can be resized to content bounds without dead-space gaps.
9. Quick Toolbar can be docked/snapped to the stable chat_top_dock mount through Productivity Settings in both V1 and V2.
10. Extension actions show sanitized real SVG/image icons in every toolbar and customizer consumer.
11. Toolbar items can be reordered in both V1 and V2 via drag-and-drop with a two-second hold or explicit drag mode while clicks before the threshold remain immediate.
12. V2 card strip icon-only mode removes visible labels, subtitles, and chevrons while retaining accessible names.
13. All eight chat docker actions can be placed on the Quick Toolbar and retain their existing behavior.
14. The chat docker action bar at the stable chat_actions mount can be customized with built-in actions, all eight docker actions, and extensions.
15. Backend and frontend bootstrap hydration retain the active provider across reloads and model picks without flickering.
16. Connection Picker supports persisted Grid and List layouts.
17. Connection Picker has cache-busting refresh and selected-profile model search.
18. Embedding settings support saved/dedicated profile selection, secret resolution, Vertex controls, unknown-provider preservation, dimension-compatible fallback chaining, and failure recovery.
19. Memory Cortex supports primary retries, secondary LLM connection-profile fallback, and configured heuristic/skip degradation.
20. User message editing provides Edit and Send with the specified conversation-branch, swipe, and new-generation behavior.
21. Frontend passes npm --prefix frontend run typecheck, bun test frontend/src, and npm --prefix frontend run build:checked.
