import * as chatsSvc from "./chats.service";
import * as connectionsSvc from "./connections.service";
import * as sttConnectionsSvc from "./stt-connections.service";
import * as ttsConnectionsSvc from "./tts-connections.service";
import * as imageGenConnectionsSvc from "./image-gen-connections.service";
import * as packsSvc from "./packs.service";
import * as personasSvc from "./personas.service";
import * as regexSvc from "./regex-scripts.service";
import * as councilSvc from "./council/council-settings.service";
import * as settingsSvc from "./settings.service";
import type { RuntimeCouncilToolDefinition } from "./council/tool-runtime";
import * as managerSvc from "../spindle/manager.service";
import * as lifecycle from "../spindle/lifecycle";
import { toolRegistry } from "../spindle/tool-registry";
import { getProviderList } from "../llm/registry";
import { getTtsProviderList } from "../tts/registry";
import { getImageProviderList } from "../image-gen/registry";
import type { ConnectionProfile } from "../types/connection-profile";
import type { SttConnectionProfile } from "../types/stt-connection";
import type { TtsConnectionProfile } from "../types/tts-connection";
import type { ImageGenConnectionProfile } from "../types/image-gen-connection";
import type { GroupedRecentChat } from "../types/chat";
import type { Pack } from "../types/pack";
import type { Persona } from "../types/persona";
import type { RegexScript } from "../types/regex-script";
import type { PaginatedResult } from "../types/pagination";
import type { CouncilSettings, ExtensionInfo, ToolRegistration } from "lumiverse-spindle-types";

// Side-effect imports mirror the per-endpoint routes: ensure the TTS and
// image-gen provider registries are populated before we call their list
// accessors. The LLM registry self-registers at module load, so importing
// `./registry` above is enough for LLM providers.
import "../tts/index";
import "../image-gen/index";

/**
 * Shape returned by GET /api/v1/bootstrap. Each field mirrors the response
 * shape of the underlying per-endpoint route so the frontend can fan the
 * payload out to its existing store setters without any translation layer.
 */
export interface BootstrapPayload {
  startupSettings: StartupSettings;
  llm: {
    connections: PaginatedResult<ConnectionProfile>;
    providers: ProviderListEntry[];
  };
  tts: {
    connections: PaginatedResult<TtsConnectionProfile>;
    providers: ProviderSummaryEntry[];
  };
  stt: {
    connections: PaginatedResult<SttConnectionProfile>;
    providers: ProviderSummaryEntry[];
  };
  imageGen: {
    connections: PaginatedResult<ImageGenConnectionProfile>;
    providers: ProviderSummaryEntry[];
  };
  packs: PaginatedResult<Pack>;
  personas: PaginatedResult<Persona>;
  regexScripts: PaginatedResult<RegexScript>;
  council: {
    settings: CouncilSettings;
    tools: RuntimeCouncilToolDefinition[];
  };
  spindle: {
    extensions: Array<ExtensionInfo & { status: string }>;
    isPrivileged: boolean;
    tools: ToolRegistration[];
  };
  /** Retained for response-shape stability; the split landing bootstrap owns recent-chat preload. */
  recentChats: PaginatedResult<GroupedRecentChat>;
}

export interface LandingBootstrapPayload {
  startupSettings: StartupSettings;
  recentChats: PaginatedResult<GroupedRecentChat>;
}

interface ProviderListEntry {
  id: string;
  name: string;
  default_url: string;
  capabilities: unknown;
}

interface ProviderSummaryEntry {
  id: string;
  name: string;
  capabilities: unknown;
}

interface StartupSettings {
  favorites?: string[];
  filterTab?: "characters" | "favorites" | "groups";
  sortField?: "name" | "recent" | "created" | "shuffle";
  sortDirection?: "asc" | "desc";
  viewMode?: "grid" | "single" | "list";
  charactersPerPage?: number;
  theme?: unknown;
  landingPageChatsDisplayed?: number;
  landingPageLayoutMode?: "cards" | "compact";
  wallpaper?: unknown;
  drawerSettings?: unknown;
}

const LIST_LIMIT_CONNECTIONS = 100;
const LIST_LIMIT_PACKS_PERSONAS = 200;
const LIST_LIMIT_REGEX = 1000;
const LANDING_CHATS_DEFAULT_LIMIT = 12;
const LANDING_CHATS_MAX_LIMIT = 100;
const STARTUP_SETTINGS_KEYS = [
  "favorites",
  "filterTab",
  "sortField",
  "sortDirection",
  "viewMode",
  "charactersPerPage",
  "theme",
  "landingPageChatsDisplayed",
  "landingPageLayoutMode",
  "wallpaper",
  "drawerSettings",
] as const;

/**
 * Page connection lists to exhaustion: the client treats bootstrap's lists as
 * complete, so a truncated page silently hides connections.
 */
const CONNECTIONS_PAGE = 200;
function collectAll<T>(
  fetchPage: (
    pagination: { limit: number; offset: number },
  ) => PaginatedResult<T>,
): PaginatedResult<T> {
  const data: T[] = [];
  let offset = 0;
  for (;;) {
    let page: PaginatedResult<T>;
    try {
      page = fetchPage({ limit: CONNECTIONS_PAGE, offset });
    } catch (err) {
      // Rethrow a first-page failure for the caller's `safe()` fallback; once
      // pages are in hand, keep them rather than discarding.
      if (data.length === 0) throw err;
      console.warn(
        `[bootstrap] connection pagination failed at offset ${offset}; returning ${data.length} already collected`,
        err,
      );
      break;
    }
    data.push(...page.data);
    offset += page.data.length;
    if (page.data.length === 0 || offset >= page.total) break;
  }
  return { data, total: data.length, limit: data.length, offset: 0 };
}

function getStartupSettings(userId: string): StartupSettings {
  const rows = settingsSvc.getSettingsByKeys(userId, [...STARTUP_SETTINGS_KEYS]);
  const startupSettings: StartupSettings = {};

  const favorites = rows.get("favorites");
  if (Array.isArray(favorites)) startupSettings.favorites = favorites;

  const filterTab = rows.get("filterTab");
  if (filterTab === "characters" || filterTab === "favorites" || filterTab === "groups") {
    startupSettings.filterTab = filterTab;
  } else if (filterTab === "all") {
    startupSettings.filterTab = "characters";
  }

  const sortField = rows.get("sortField");
  if (sortField === "name" || sortField === "recent" || sortField === "created" || sortField === "shuffle") {
    startupSettings.sortField = sortField;
  }

  const sortDirection = rows.get("sortDirection");
  if (sortDirection === "asc" || sortDirection === "desc") {
    startupSettings.sortDirection = sortDirection;
  }

  const viewMode = rows.get("viewMode");
  if (viewMode === "grid" || viewMode === "single" || viewMode === "list") {
    startupSettings.viewMode = viewMode;
  }

  const charactersPerPage = rows.get("charactersPerPage");
  if (typeof charactersPerPage === "number" && Number.isFinite(charactersPerPage)) {
    startupSettings.charactersPerPage = charactersPerPage;
  }

  if (rows.has("theme")) {
    startupSettings.theme = rows.get("theme");
  }

  const landingPageChatsDisplayed = rows.get("landingPageChatsDisplayed");
  if (typeof landingPageChatsDisplayed === "number" && Number.isFinite(landingPageChatsDisplayed)) {
    startupSettings.landingPageChatsDisplayed = landingPageChatsDisplayed;
  }

  const landingPageLayoutMode = rows.get("landingPageLayoutMode");
  if (landingPageLayoutMode === "cards" || landingPageLayoutMode === "compact") {
    startupSettings.landingPageLayoutMode = landingPageLayoutMode;
  }

  if (rows.has("wallpaper")) {
    startupSettings.wallpaper = rows.get("wallpaper");
  }

  if (rows.has("drawerSettings")) {
    startupSettings.drawerSettings = rows.get("drawerSettings");
  }

  return startupSettings;
}

/** First recent-chats page for the landing view, sized by the user's setting. */
function getLandingRecentChats(userId: string): PaginatedResult<GroupedRecentChat> {
  const stored = settingsSvc
    .getSettingsByKeys(userId, ["landingPageChatsDisplayed"])
    .get("landingPageChatsDisplayed");
  const limit =
    typeof stored === "number" && Number.isFinite(stored)
      ? Math.min(Math.max(Math.floor(stored), 1), LANDING_CHATS_MAX_LIMIT)
      : LANDING_CHATS_DEFAULT_LIMIT;
  return chatsSvc.listRecentChatsGrouped(userId, { limit, offset: 0 });
}

export function buildLandingBootstrapPayload(
  userId: string,
): { payload: LandingBootstrapPayload; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const emptyRecentChats: PaginatedResult<GroupedRecentChat> = {
    data: [],
    total: 0,
    limit: LANDING_CHATS_DEFAULT_LIMIT,
    offset: 0,
  };

  const safe = <T>(key: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err: any) {
      errors[key] = err?.message || String(err);
      return fallback;
    }
  };

  // Keep the landing bootstrap synchronous and sequential. These are fast
  // bun:sqlite reads; Promise fan-out only creates extra interleaving points
  // under rapid refresh churn without making the queries run faster.
  const startupSettings = safe("startupSettings", () => getStartupSettings(userId), {} as StartupSettings);
  const recentChats = safe("recentChats", () => getLandingRecentChats(userId), emptyRecentChats);

  return {
    payload: { startupSettings, recentChats },
    errors,
  };
}

function listLlmProviders(): ProviderListEntry[] {
  return getProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    default_url: p.defaultUrl,
    capabilities: p.capabilities,
  }));
}

function listTtsProviders(): ProviderSummaryEntry[] {
  return getTtsProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
}

function listSttProviders(): ProviderSummaryEntry[] {
  return sttConnectionsSvc.listProviders().map((p) => ({
    id: p.id,
    name: p.name,
    capabilities: p.capabilities,
  }));
}

function listImageGenProviders(): ProviderSummaryEntry[] {
  return getImageProviderList().map((p) => ({
    id: p.name,
    name: p.displayName,
    capabilities: p.capabilities,
  }));
}

async function listSpindle(userId: string, role: string): Promise<BootstrapPayload["spindle"]> {
  const extensionRows = await managerSvc.listForUser(userId, role);
  const extensions = extensionRows.map((ext): ExtensionInfo & { status: string } => ({
    ...ext,
    status: lifecycle.isRunning(ext.id) ? "running" : "stopped",
  }));
  const visibleIds = new Set(extensionRows.map((ext) => ext.id));
  const isPrivileged = role === "owner" || role === "admin";
  const tools = toolRegistry.getTools().filter((t) => visibleIds.has(t.extension_id));
  return { extensions, isPrivileged, tools };
}

/**
 * Assemble the full bootstrap payload. Synchronous bun:sqlite sections run
 * sequentially to avoid unnecessary async handoffs while rapid refreshes can
 * leave split landing/full bootstrap requests in flight.
 *
 * Failures inside any single section are caught and surfaced as a structured
 * `errors` entry so the frontend can fall back to the per-endpoint fetch for
 * just the missing section(s) instead of losing the whole bootstrap.
 */
export async function buildBootstrapPayload(
  userId: string,
  role: string
): Promise<{ payload: BootstrapPayload; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};

  const safeSync = <T>(key: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err: any) {
      errors[key] = err?.message || String(err);
      return fallback;
    }
  };

  const safeAsync = async <T>(key: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err: any) {
      errors[key] = err?.message || String(err);
      return fallback;
    }
  };

  const pagLargeMisc = { limit: LIST_LIMIT_PACKS_PERSONAS, offset: 0 };
  const pagLargeRegex = { limit: LIST_LIMIT_REGEX, offset: 0 };

  const emptyPage = <T>(limit: number): PaginatedResult<T> => ({
    data: [],
    total: 0,
    limit,
    offset: 0,
  });

  // Run the synchronous DB-heavy reads in one sequential pass. The previous
  // Promise.all form did not make bun:sqlite reads parallel, but it did create
  // more async handoff points while a split landing/full bootstrap pair was in
  // flight during refresh churn.
  const startupSettings = safeSync("startupSettings", () => getStartupSettings(userId), {} as StartupSettings);
  const llmConnections = safeSync("llm.connections", () => collectAll((p) => connectionsSvc.listConnections(userId, p)), emptyPage<ConnectionProfile>(LIST_LIMIT_CONNECTIONS));
  const llmProviders = safeSync("llm.providers", () => listLlmProviders(), [] as ProviderListEntry[]);
  const sttConnections = safeSync("stt.connections", () => collectAll((p) => sttConnectionsSvc.listConnections(userId, p)), emptyPage<SttConnectionProfile>(LIST_LIMIT_CONNECTIONS));
  const sttProviders = safeSync("stt.providers", () => listSttProviders(), [] as ProviderSummaryEntry[]);
  const ttsConnections = safeSync("tts.connections", () => collectAll((p) => ttsConnectionsSvc.listConnections(userId, p)), emptyPage<TtsConnectionProfile>(LIST_LIMIT_CONNECTIONS));
  const ttsProviders = safeSync("tts.providers", () => listTtsProviders(), [] as ProviderSummaryEntry[]);
  const imageGenConnections = safeSync("imageGen.connections", () => collectAll((p) => imageGenConnectionsSvc.listConnections(userId, p)), emptyPage<ImageGenConnectionProfile>(LIST_LIMIT_CONNECTIONS));
  const imageGenProviders = safeSync("imageGen.providers", () => listImageGenProviders(), [] as ProviderSummaryEntry[]);
  const packs = safeSync("packs", () => packsSvc.listPacks(userId, pagLargeMisc), emptyPage<Pack>(LIST_LIMIT_PACKS_PERSONAS));
  const personas = safeSync("personas", () => personasSvc.listPersonas(userId, pagLargeMisc), emptyPage<Persona>(LIST_LIMIT_PACKS_PERSONAS));
  const regexScripts = safeSync("regexScripts", () => regexSvc.listRegexScripts(userId, pagLargeRegex), emptyPage<RegexScript>(LIST_LIMIT_REGEX));
  const councilSettings = safeSync("council.settings", () => councilSvc.getCouncilSettings(userId), {} as CouncilSettings);

  const councilTools = await safeAsync("council.tools", () => councilSvc.getAvailableTools(userId), [] as RuntimeCouncilToolDefinition[]);
  const spindle = await safeAsync("spindle", () => listSpindle(userId, role), { extensions: [], isPrivileged: false, tools: [] });
  const recentChats = emptyPage<GroupedRecentChat>(LANDING_CHATS_DEFAULT_LIMIT);

  const payload: BootstrapPayload = {
    startupSettings,
    llm: { connections: llmConnections, providers: llmProviders },
    stt: { connections: sttConnections, providers: sttProviders },
    tts: { connections: ttsConnections, providers: ttsProviders },
    imageGen: { connections: imageGenConnections, providers: imageGenProviders },
    packs,
    personas,
    regexScripts,
    council: { settings: councilSettings, tools: councilTools },
    spindle,
    recentChats,
  };

  return { payload, errors };
}
