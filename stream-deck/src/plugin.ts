import streamDeck, {
  action,
  DeviceType,
  type DidReceiveSettingsEvent,
  type KeyAction,
  SingletonAction,
  type KeyDownEvent,
  type SendToPluginEvent,
  type WillAppearEvent,
} from "@elgato/streamdeck";
import {
  getCharacterImage,
  listCharacterPage,
  listCharacters,
  listRecentChats,
  openChat,
  openChatById,
  type CharacterSummary,
  type RecentChatSummary,
} from "./api.js";

type CharacterSettings = { characterId?: string; characterName?: string; characterImageUrl?: string };

async function applyCharacterAppearance(
  action: KeyAction<CharacterSettings>,
  settings: CharacterSettings,
): Promise<void> {
  if (settings.characterImageUrl) {
    try {
      streamDeck.logger.info("Loading selected character artwork");
      const image = await getCharacterImage(settings.characterImageUrl);
      streamDeck.logger.info(`Applying character artwork (${image.length} characters)`);
      await action.setImage(image);
      await action.setTitle("");
      streamDeck.logger.info("Character artwork command sent");
      return;
    } catch (error) {
      streamDeck.logger.error(`Failed to load character image: ${String(error)}`);
      await action.showAlert();
      return;
    }
  }
  await action.setImage();
  await action.setTitle(settings.characterName || "Choose\ncharacter");
}

@action({ UUID: "com.lumiverse.streamdeck.openrecent" })
class OpenRecentChat extends SingletonAction {
  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    try {
      if (!await openChat()) await event.action.showAlert();
    } catch (error) {
      streamDeck.logger.error(String(error));
      await event.action.showAlert();
    }
  }
}

@action({ UUID: "com.lumiverse.streamdeck.opencharacter" })
class OpenCharacterChat extends SingletonAction<CharacterSettings> {
  override async onWillAppear(event: WillAppearEvent<CharacterSettings>): Promise<void> {
    if (!event.action.isKey()) return;
    await applyCharacterAppearance(event.action, event.payload.settings);
  }

  override async onDidReceiveSettings(event: DidReceiveSettingsEvent<CharacterSettings>): Promise<void> {
    if (!event.action.isKey()) return;
    await applyCharacterAppearance(event.action, event.payload.settings);
  }

  override async onKeyDown(event: KeyDownEvent<CharacterSettings>): Promise<void> {
    try {
      if (event.action.isKey()) await applyCharacterAppearance(event.action, event.payload.settings);
      const { characterId } = event.payload.settings;
      if (!characterId || !await openChat(characterId)) await event.action.showAlert();
    } catch (error) {
      streamDeck.logger.error(String(error));
      await event.action.showAlert();
    }
  }

  override async onSendToPlugin(event: SendToPluginEvent<{
    request?: string;
    settings?: CharacterSettings;
  }, CharacterSettings>): Promise<void> {
    if (event.payload.request === "selectCharacter" && event.payload.settings) {
      await event.action.setSettings(event.payload.settings);
      if (event.action.isKey()) await applyCharacterAppearance(event.action, event.payload.settings);
      return;
    }
    if (event.payload.request !== "characters") return;
    try {
      await streamDeck.ui.sendToPropertyInspector({ characters: await listCharacters() });
    } catch (error) {
      await streamDeck.ui.sendToPropertyInspector({ error: String(error) });
    }
  }
}

type BrowserView = "characters" | "recent";
type BrowserItem = CharacterSummary | RecentChatSummary;
type BrowserSlotSettings = { slot?: number };
type BrowserControlSettings = { control?: "back" | "toggle" | "previous" | "next" };
type DeviceBrowserState = {
  view: BrowserView;
  page: number;
  total: number;
  items: BrowserItem[];
  slots: Map<number, KeyAction<BrowserSlotSettings>>;
  renderTimer?: ReturnType<typeof setTimeout>;
  generation: number;
};

const browserStates = new Map<string, DeviceBrowserState>();

function browserState(deviceId: string): DeviceBrowserState {
  let state = browserStates.get(deviceId);
  if (!state) {
    state = { view: "characters", page: 0, total: 0, items: [], slots: new Map(), generation: 0 };
    browserStates.set(deviceId, state);
  }
  return state;
}

function itemImageUrl(item: BrowserItem): string | null {
  return "image_url" in item ? item.image_url : null;
}

function itemTitle(item: BrowserItem): string {
  return "character_name" in item ? (item.character_name || item.name || "Recent chat") : item.name;
}

async function renderBrowser(deviceId: string): Promise<void> {
  const state = browserState(deviceId);
  const slots = [...state.slots.entries()].sort(([a], [b]) => a - b);
  if (slots.length === 0) return;
  const generation = ++state.generation;
  const offset = state.page * slots.length;

  try {
    const result = state.view === "characters"
      ? await listCharacterPage(slots.length, offset)
      : await listRecentChats(slots.length, offset);
    if (generation !== state.generation) return;
    state.items = result.data;
    state.total = result.total;

    await Promise.all(slots.map(async ([slot, key]) => {
      const item = state.items[slot];
      if (!item) {
        await key.setImage();
        await key.setTitle("");
        return;
      }
      const imageUrl = itemImageUrl(item);
      if (imageUrl) {
        try {
          await key.setImage(await getCharacterImage(imageUrl));
        } catch (error) {
          streamDeck.logger.warn(`Browser artwork failed: ${String(error)}`);
          await key.setImage();
        }
      } else {
        await key.setImage();
      }
      await key.setTitle(itemTitle(item));
    }));
  } catch (error) {
    streamDeck.logger.error(`Lumiverse browser failed: ${String(error)}`);
    await Promise.all(slots.map(async ([, key]) => {
      await key.setImage();
      await key.setTitle("Load\nfailed");
    }));
  }
}

function scheduleBrowserRender(deviceId: string): void {
  const state = browserState(deviceId);
  if (state.renderTimer) clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(() => void renderBrowser(deviceId), 75);
}

@action({ UUID: "com.lumiverse.streamdeck.browser" })
class OpenLumiverseBrowser extends SingletonAction {
  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    const profiles: Partial<Record<DeviceType, string>> = {
      [DeviceType.StreamDeck]: "profiles/Lumiverse Browser",
      [DeviceType.StreamDeckMini]: "profiles/Lumiverse Browser Mini",
      [DeviceType.StreamDeckXL]: "profiles/Lumiverse Browser XL",
      [DeviceType.StreamDeckPlus]: "profiles/Lumiverse Browser Plus",
    };
    const profile = profiles[event.action.device.type];
    if (!profile) {
      await event.action.showAlert();
      return;
    }
    const state = browserState(event.action.device.id);
    state.page = 0;
    await streamDeck.profiles.switchToProfile(event.action.device.id, profile, 0);
  }
}

@action({ UUID: "com.lumiverse.streamdeck.browserslot" })
class LumiverseBrowserSlot extends SingletonAction<BrowserSlotSettings> {
  override async onWillAppear(event: WillAppearEvent<BrowserSlotSettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const slot = event.payload.settings.slot ?? 0;
    browserState(event.action.device.id).slots.set(slot, event.action);
    scheduleBrowserRender(event.action.device.id);
  }

  override async onKeyDown(event: KeyDownEvent<BrowserSlotSettings>): Promise<void> {
    const state = browserState(event.action.device.id);
    const item = state.items[event.payload.settings.slot ?? 0];
    if (!item) return;
    try {
      if ("character_name" in item) await openChatById(item.id);
      else if (!await openChat(item.id)) await event.action.showAlert();
    } catch (error) {
      streamDeck.logger.error(String(error));
      await event.action.showAlert();
    }
  }
}

@action({ UUID: "com.lumiverse.streamdeck.browsercontrol" })
class LumiverseBrowserControl extends SingletonAction<BrowserControlSettings> {
  override async onWillAppear(event: WillAppearEvent<BrowserControlSettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const labels = { back: "Back", toggle: "Characters\n/ Recent", previous: "Previous", next: "Next" };
    await event.action.setTitle(labels[event.payload.settings.control ?? "toggle"]);
  }

  override async onKeyDown(event: KeyDownEvent<BrowserControlSettings>): Promise<void> {
    const control = event.payload.settings.control ?? "toggle";
    const deviceId = event.action.device.id;
    const state = browserState(deviceId);
    if (control === "back") {
      await streamDeck.profiles.switchToProfile(deviceId);
      return;
    }
    if (control === "toggle") {
      state.view = state.view === "characters" ? "recent" : "characters";
      state.page = 0;
    } else if (control === "previous") {
      state.page = Math.max(0, state.page - 1);
    } else {
      const pageSize = Math.max(1, state.slots.size);
      if ((state.page + 1) * pageSize < state.total) state.page += 1;
    }
    await renderBrowser(deviceId);
  }
}

streamDeck.actions.registerAction(new OpenRecentChat());
streamDeck.actions.registerAction(new OpenCharacterChat());
streamDeck.actions.registerAction(new OpenLumiverseBrowser());
streamDeck.actions.registerAction(new LumiverseBrowserSlot());
streamDeck.actions.registerAction(new LumiverseBrowserControl());
streamDeck.connect();
