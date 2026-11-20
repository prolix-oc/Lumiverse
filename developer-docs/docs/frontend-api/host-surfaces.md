# Host Navigation and Actions

`ctx.host.surfaces` lists the places and actions of the Lumiverse UI and runs them for the current user: drawer tabs, settings tabs, command palette commands, routes, editors, input bar actions, extension commands, and entity actions.

```ts
const surfaces = ctx.host.surfaces;
if (!surfaces) return; // older hosts

const commands = surfaces.list(['command']);
const stop = commands.find((surface) => surface.id === 'action-stop-generation');
if (stop) await surfaces.invoke({ kind: 'command', id: stop.id });
```

| Method | Behavior |
| --- | --- |
| `list(kinds?)` | Returns the entries the current user can see. Each entry has `kind`, `id`, `label`, and optional `description`, `keywords`, `scope`, `role`, `owner`, `invocable`, and `params`. |
| `subscribe(listener)` | Calls `listener` with a fresh list when the catalog changes (for example when an extension tab is added). Returns an unsubscribe function. |
| `invoke(ref, params?)` | Runs one entry. Throws when the entry is unknown, not in the current list, not invocable, or the extension lacks the entry's permission. Async actions return a promise. |

`scope` is a hint (`global`, `chat`, `chat-idle`, `landing`, `character`); `invoke` does not check it. Check the current state first, for example with `ctx.state.get('chat.active')`.

## Kinds and params

| Kind | Params | Notes |
| --- | --- | --- |
| `drawer_tab` | `{ target? }` | Opens a drawer tab. |
| `settings_tab` | `{ anchorId? }` | Opens a settings tab. `anchorId` scrolls to a section heading (`setsec-<tabId>-<sectionKey>`). |
| `command` | none | Runs a command palette entry. |
| `route` | `/chat/:chatId` takes `{ chatId }`, `/characters/:id` takes `{ id }` | Navigates in the app. |
| `modal` | `character_editor` takes `{ id }`, `world_book_editor` takes `{ id, entryId? }` | Opens a host editor. |
| `input_bar_action`, `ext_command` | none | Another extension's entry needs `app_manipulation`; your own entries are free. |
| `entity_action` | see below; `params` in `list()` has the schema | Acts on a persona, preset, theme, or character. |

Ids in params must match `^[A-Za-z0-9_-]{1,64}$`. Unknown params throw `HOST_ACTION_INVALID_PARAMS:<name>`, bad ids throw `HOST_ACTION_INVALID_ID:<name>`.

## Generation commands

| Command | Permission | Behavior |
| --- | --- | --- |
| `action-regenerate` | `generation` | Generates a new swipe for the last AI reply. |
| `action-background-swipe` | `generation` | Generates a new swipe of the final assistant reply while keeping its current swipe selected. Does nothing while generation runs or the chat ends with a user message. |
| `action-continue` | `generation` | Continues the last reply. |
| `action-stop-generation` | `generation` | Stops every generation of the active chat. Does nothing for a multiplayer room guest. |
| `action-swipe-left` | `chats` | Shows the previous swipe of the last AI reply. |
| `action-swipe-right` | `generation` | Shows the next swipe of the last AI reply. After the last swipe of the last message it generates a new swipe (not while a generation runs), like the ArrowRight shortcut. |

## Entity actions

Each `entity_action` entry carries `params`, a JSON Schema object (`type`, `properties`, `required`, `additionalProperties: false`). Every param is a string.

| Id | Params | Permission | Behavior |
| --- | --- | --- | --- |
| `switch_persona` | `{ personaId }` | `personas` | Makes the persona active, like picking it in the persona manager. In a saved chat the choice is stored on that chat. Unknown ids throw `HOST_ACTION_NOT_FOUND:personaId`. |
| `switch_preset` | `{ presetId }` | `presets` | Makes the Loom preset active. Pending edits of the previous preset are saved first. Unknown ids reject. |
| `apply_theme` | `{ themeId }` | `app_manipulation` | Applies a built-in theme preset or a saved theme, like the Theme panel. A built-in preset also clears extension theme overrides. `params.properties.themeId.oneOf` lists the ids with their names. Unknown ids throw `HOST_ACTION_NOT_FOUND:themeId`. |
| `character_chat` | `{ characterId, mode }` | `chats` | `mode: 'latest'` opens the character's most recently updated chat, or starts a chat when there is none. `mode: 'new'` always starts a chat. Characters with alternate greetings show the greeting picker first. Unknown ids reject. |

Await `invoke()` to observe failures. A saved-chat persona switch resolves after its metadata is saved and rejects if saving fails. A preset switch rejects with `HOST_ACTION_UNAVAILABLE:entity_action:switch_preset` if a newer selection supersedes it or preset recovery cannot select the requested preset.

```ts
const themeAction = surfaces.list(['entity_action']).find((surface) => surface.id === 'apply_theme');
const choice = themeAction?.params?.properties.themeId.oneOf?.find((option) => option.title === 'Emerald');
if (choice) await surfaces.invoke({ kind: 'entity_action', id: 'apply_theme' }, { themeId: choice.const });

await surfaces.invoke({ kind: 'entity_action', id: 'character_chat' }, { characterId, mode: 'new' });
```

Personas, presets, and characters are not listed in the schema. Look them up with the backend APIs (`spindle.personas.list()`, `spindle.presets.list()`, `spindle.characters.list()`) or the frontend state (`ctx.state.get('persona.activeId')`, `ctx.state.get('loom.activePresetId')`).

Feature-detect an action by finding it in `list(['entity_action'])`. Older hosts return no entries of this kind.
