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
}

const LIST_LIMIT_CONNECTIONS = 100;
const LIST_LIMIT_PACKS_PERSONAS = 200;
const LIST_LIMIT_REGEX = 1000;
const STARTUP_SETTINGS_KEYS = [
  "favorites",
  "filterTab",
  "sortField",
  "sortDirection",
  "viewMode",
  "charactersPerPage",
  "theme",
] as const;

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

  return startupSettings;
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
 * Assemble the full bootstrap payload in parallel. Every underlying service
 * call either reads from a cached prepared statement, an in-memory provider
 * registry, or an already-warm manifest cache — so the Promise.all is fan-out
 * over fast synchronous + a couple of async reads, not N sequential queries.
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

  const safe = async <T>(key: string, fn: () => Promise<T> | T, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (err: any) {
      errors[key] = err?.message || String(err);
      return fallback;
    }
  };

  const pagLargeConnections = { limit: LIST_LIMIT_CONNECTIONS, offset: 0 };
  const pagLargeMisc = { limit: LIST_LIMIT_PACKS_PERSONAS, offset: 0 };
  const pagLargeRegex = { limit: LIST_LIMIT_REGEX, offset: 0 };

  const emptyPage = <T>(limit: number): PaginatedResult<T> => ({
    data: [],
    total: 0,
    limit,
    offset: 0,
  });

  const [
    startupSettings,
    llmConnections, llmProviders,
    sttConnections, sttProviders,
    ttsConnections, ttsProviders,
    imageGenConnections, imageGenProviders,
    packs, personas, regexScripts,
    councilSettings, councilTools,
    spindle,
  ] = await Promise.all([
    safe("startupSettings", () => getStartupSettings(userId), {} as StartupSettings),
    safe("llm.connections", () => connectionsSvc.listConnections(userId, pagLargeConnections), emptyPage<ConnectionProfile>(LIST_LIMIT_CONNECTIONS)),
    safe("llm.providers", () => listLlmProviders(), [] as ProviderListEntry[]),
    safe("stt.connections", () => sttConnectionsSvc.listConnections(userId, pagLargeConnections), emptyPage<SttConnectionProfile>(LIST_LIMIT_CONNECTIONS)),
    safe("stt.providers", () => listSttProviders(), [] as ProviderSummaryEntry[]),
    safe("tts.connections", () => ttsConnectionsSvc.listConnections(userId, pagLargeConnections), emptyPage<TtsConnectionProfile>(LIST_LIMIT_CONNECTIONS)),
    safe("tts.providers", () => listTtsProviders(), [] as ProviderSummaryEntry[]),
    safe("imageGen.connections", () => imageGenConnectionsSvc.listConnections(userId, pagLargeConnections), emptyPage<ImageGenConnectionProfile>(LIST_LIMIT_CONNECTIONS)),
    safe("imageGen.providers", () => listImageGenProviders(), [] as ProviderSummaryEntry[]),
    safe("packs", () => packsSvc.listPacks(userId, pagLargeMisc), emptyPage<Pack>(LIST_LIMIT_PACKS_PERSONAS)),
    safe("personas", () => personasSvc.listPersonas(userId, pagLargeMisc), emptyPage<Persona>(LIST_LIMIT_PACKS_PERSONAS)),
    safe("regexScripts", () => regexSvc.listRegexScripts(userId, pagLargeRegex), emptyPage<RegexScript>(LIST_LIMIT_REGEX)),
    safe("council.settings", () => councilSvc.getCouncilSettings(userId), {} as CouncilSettings),
    safe("council.tools", () => councilSvc.getAvailableTools(userId), [] as RuntimeCouncilToolDefinition[]),
    safe("spindle", () => listSpindle(userId, role), { extensions: [], isPrivileged: false, tools: [] }),
  ]);

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
  };

  return { payload, errors };
}
