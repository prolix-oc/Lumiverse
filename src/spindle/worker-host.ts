import type {
  SpindleManifest,
  WorkerToHost,
  HostToWorker,
  LlmMessageDTO,
  InterceptorBreakdownEntryDTO,
  ToolRegistration,
  ExtensionInfo,
  ConnectionProfileDTO,
  CharacterDTO,
  CharacterAvatarUploadDTO,
  ChatDTO,
  WorldBookDTO,
  WorldBookEntryDTO,
  RegexScriptDTO,
  RegexScopeDTO,
  RegexTargetDTO,
  DatabankDTO,
  DatabankDocumentDTO,
  DatabankDocumentCreateDTO,
  PersonaDTO,
  ActivatedWorldInfoEntryDTO,
  DryRunResultDTO,
  ChatMemoryResultDTO,
  ThemeOverrideDTO,
  SpindleCommandDTO,
  SpindleCommandContextDTO,
  CouncilMemberContext,
  ImageDTO,
  ImageUploadDTO,
} from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import { createOAuthState } from "./oauth-state";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { registry as macroRegistry } from "../macros";
import { interceptorPipeline, type InterceptorResult } from "./interceptor-pipeline";
import { contextHandlerChain } from "./context-handler";
import {
  messageContentProcessorChain,
  type MessageContentProcessorCtx,
  type MessageContentProcessorResult,
} from "./message-content-processor";
import {
  macroInterceptorChain,
  type MacroInterceptorCtx,
  type MacroInterceptorResult,
} from "./macro-interceptor";
import {
  worldInfoInterceptorChain,
  type WorldInfoInterceptorCtxDTO,
  type WorldInfoInterceptorResultDTO,
} from "./world-info-interceptor";
import { toolRegistry } from "./tool-registry";
import * as managerSvc from "./manager.service";
import * as generateSvc from "../services/generate.service";
import * as connectionsSvc from "../services/connections.service";
import * as charactersSvc from "../services/characters.service";
import * as chatsSvc from "../services/chats.service";
import {
  getCharacterWorldBookIds,
  setCharacterWorldBookIds,
} from "../utils/character-world-books";
import * as worldBooksSvc from "../services/world-books.service";
import * as regexScriptsSvc from "../services/regex-scripts.service";
import * as databanksSvc from "../services/databank";
import * as filesSvc from "../services/files.service";
import * as personasSvc from "../services/personas.service";
import * as settingsSvc from "../services/settings.service";
import * as councilSettingsSvc from "../services/council/council-settings.service";
import * as packsSvc from "../services/packs.service";
import { buildCouncilMemberContext } from "../services/council/tool-runtime";
import { resolveInterceptorTimeout } from "../services/spindle-settings.service";
import { getSidecarSettings } from "../services/sidecar-settings.service";
import * as colorExtractionSvc from "../services/color-extraction.service";
import { generateThemeVariables as generateThemeVariablesFn } from "../utils/theme-engine";
import * as promptAssemblySvc from "../services/prompt-assembly.service";
import * as embeddingsSvc from "../services/embeddings.service";
import * as tokenizerSvc from "../services/tokenizer.service";
import * as imageGenConnSvc from "../services/image-gen-connections.service";
import * as imagesSvc from "../services/images.service";
import { spawnAsync } from "./spawn-async";
import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import "../image-gen/index";
import { getEphemeralPoolConfig } from "./ephemeral-pool.service";
import { createRuntimeTransport, type RuntimeTransport } from "./runtime-transport";
import {
  readSharedRpcEndpoint,
  registerSharedRpcRequestEndpoint,
  syncSharedRpcEndpoint,
  unregisterSharedRpcEndpoint,
  unregisterSharedRpcEndpointsByOwner,
} from "./shared-rpc-pool.service";
import { getTextContent, type LlmMessage } from "../llm/types";
import { getDb } from "../db/connection";
import { normalizeSpindleAppNavigationPath } from "./url-safety";
import {
  getMessages as getChatMessages,
  createMessage as createChatMessage,
  updateMessage as updateChatMessage,
  deleteMessage as deleteChatMessage,
  getMessage as getChatMessage,
} from "../services/chats.service";
import {
  putSecret,
  getSecret,
  deleteSecret,
  listSecretKeys,
  validateSecret,
} from "../services/secrets.service";
import { getUserExtensionPath } from "../auth/provision";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  statSync,
  renameSync,
} from "fs";
import http from "node:http";
import https from "node:https";
import { createHash } from "crypto";
import { join, resolve, relative, sep } from "path";

const EPHEMERAL_MAX_FILES = 250;

type TokenModelSource = "main" | "sidecar" | "explicit";

type TokenCountResult = {
  total_tokens: number;
  model: string;
  modelSource: TokenModelSource;
  tokenizer_id: string | null;
  tokenizer_name: string;
  approximate: boolean;
};

type FrontendProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed"
  | "timed_out";

type FrontendProcessExitReason =
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "frontend_unloaded"
  | "backend_unloaded"
  | "replaced";

type FrontendProcessInfo = {
  processId: string;
  kind: string;
  key?: string;
  state: FrontendProcessState;
  userId?: string;
  metadata?: Record<string, unknown>;
  startedAt: string;
  readyAt?: string;
  lastHeartbeatAt?: string;
  endedAt?: string;
  exitReason?: FrontendProcessExitReason;
  error?: string;
};

type FrontendProcessLifecycleEvent = {
  processId: string;
  kind: string;
  key?: string;
  userId?: string;
  state: FrontendProcessState;
  previousState?: FrontendProcessState;
  at: string;
  exitReason?: FrontendProcessExitReason;
  error?: string;
  metadata?: Record<string, unknown>;
};

type FrontendProcessRecord = FrontendProcessInfo & {
  requestId: string;
  startupTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  startupTimeoutMs: number;
  heartbeatTimeoutMs: number;
  stopReason?: string;
};

type BackendProcessState =
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "completed"
  | "failed"
  | "timed_out";

type BackendProcessExitReason =
  | "completed"
  | "failed"
  | "stopped"
  | "timed_out"
  | "backend_unloaded"
  | "replaced";

type BackendProcessInfo = {
  processId: string;
  entry: string;
  kind: string;
  key?: string;
  state: BackendProcessState;
  userId?: string;
  metadata?: Record<string, unknown>;
  startedAt: string;
  readyAt?: string;
  lastHeartbeatAt?: string;
  endedAt?: string;
  exitReason?: BackendProcessExitReason;
  error?: string;
};

type BackendProcessLifecycleEvent = {
  processId: string;
  entry: string;
  kind: string;
  key?: string;
  userId?: string;
  state: BackendProcessState;
  previousState?: BackendProcessState;
  at: string;
  exitReason?: BackendProcessExitReason;
  error?: string;
  metadata?: Record<string, unknown>;
};

type BackendProcessRecord = BackendProcessInfo & {
  requestId: string;
  runtime: RuntimeTransport;
  startupTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setTimeout> | null;
  stopTimer: ReturnType<typeof setTimeout> | null;
  startupTimeoutMs: number;
  heartbeatTimeoutMs: number;
  stopReason?: string;
};

type BackendProcessRuntimeInit = {
  processId: string;
  entry: string;
  entryPath: string;
  kind: string;
  key?: string;
  payload?: unknown;
  metadata?: Record<string, unknown>;
  userId?: string;
};

type HostToBackendProcessRuntime =
  | { type: "init"; process: BackendProcessRuntimeInit }
  | { type: "stop"; reason?: string }
  | { type: "message"; payload: unknown };

type BackendProcessRuntimeToHost =
  | { type: "ready" }
  | { type: "heartbeat" }
  | { type: "message"; payload: unknown }
  | { type: "complete" }
  | { type: "fail"; error: string }
  | { type: "stopped" };

type RuntimeWorkerToHost =
  | WorkerToHost
  | { type: "rpc_pool_sync"; endpoint: string; value: unknown }
  | { type: "rpc_pool_register_handler"; endpoint: string }
  | { type: "rpc_pool_unregister"; endpoint: string }
  | { type: "rpc_pool_read"; requestId: string; endpoint: string }
  | {
      type: "rpc_pool_handler_result";
      requestId: string;
      result?: unknown;
      error?: string;
    }
  | { type: "toast_show"; toastType: "success" | "warning" | "error" | "info"; message: string; title?: string; duration?: number; userId?: string }
  | { type: "user_storage_read_binary"; requestId: string; path: string; userId?: string }
  | {
      type: "user_storage_write_binary";
      requestId: string;
      path: string;
      data: Uint8Array;
      userId?: string;
    }
  | { type: "user_storage_move"; requestId: string; from: string; to: string; userId?: string }
  | { type: "user_storage_stat"; requestId: string; path: string; userId?: string }
  | {
      type: "tokens_count_text";
      requestId: string;
      text: string;
      model?: string;
      modelSource?: TokenModelSource;
      userId?: string;
    }
  | {
      type: "tokens_count_messages";
      requestId: string;
      messages: Array<Pick<LlmMessageDTO, "role" | "content">>;
      model?: string;
      modelSource?: TokenModelSource;
      userId?: string;
    }
  | {
      type: "tokens_count_chat";
      requestId: string;
      chatId: string;
      model?: string;
      modelSource?: TokenModelSource;
      userId?: string;
    }
  | {
      type: "databanks_list";
      requestId: string;
      limit?: number;
      offset?: number;
      scope?: "global" | "character" | "chat";
      scopeId?: string | null;
      userId?: string;
    }
  | { type: "databanks_get"; requestId: string; databankId: string; userId?: string }
  | { type: "databanks_create"; requestId: string; input: import("lumiverse-spindle-types").DatabankCreateDTO; userId?: string }
  | { type: "databanks_update"; requestId: string; databankId: string; input: import("lumiverse-spindle-types").DatabankUpdateDTO; userId?: string }
  | { type: "databanks_delete"; requestId: string; databankId: string; userId?: string }
  | {
      type: "databank_documents_list";
      requestId: string;
      databankId: string;
      limit?: number;
      offset?: number;
      userId?: string;
    }
  | { type: "databank_documents_get"; requestId: string; documentId: string; userId?: string }
  | {
      type: "databank_documents_create";
      requestId: string;
      databankId: string;
      input: DatabankDocumentCreateDTO;
      userId?: string;
    }
  | {
      type: "databank_documents_update";
      requestId: string;
      documentId: string;
      input: import("lumiverse-spindle-types").DatabankDocumentUpdateDTO;
      userId?: string;
    }
  | { type: "databank_documents_delete"; requestId: string; documentId: string; userId?: string }
  | { type: "databank_documents_get_content"; requestId: string; documentId: string; userId?: string }
  | { type: "databank_documents_reprocess"; requestId: string; documentId: string; userId?: string }
  | {
      type: "images_list";
      requestId: string;
      limit?: number;
      offset?: number;
      specificity?: imagesSvc.ImageSpecificity;
      onlyOwned?: boolean;
      characterId?: string;
      chatId?: string;
      userId?: string;
    }
  | {
      type: "images_get";
      requestId: string;
      imageId: string;
      specificity?: imagesSvc.ImageSpecificity;
      onlyOwned?: boolean;
      characterId?: string;
      chatId?: string;
      userId?: string;
    }
  | { type: "images_upload"; requestId: string; input: ImageUploadDTO; userId?: string }
  | {
      type: "images_upload_from_data_url";
      requestId: string;
      dataUrl: string;
      originalFilename?: string;
      owner_character_id?: string;
      owner_chat_id?: string;
      userId?: string;
    }
  | { type: "images_delete"; requestId: string; imageId: string; userId?: string }
  | { type: "register_message_content_processor"; priority?: number }
  | {
      type: "message_content_processor_result";
      requestId: string;
      result: unknown;
    }
  | { type: "register_macro_interceptor"; priority?: number }
  | {
      type: "macro_interceptor_result";
      requestId: string;
      result: unknown;
    }
  | { type: "register_world_info_interceptor"; priority?: number }
  | {
      type: "world_info_interceptor_result";
      requestId: string;
      result: unknown;
    }
  | {
      type: "frontend_process_spawn";
      requestId: string;
      options: {
        kind: string;
        key?: string;
        payload?: unknown;
        metadata?: Record<string, unknown>;
        userId?: string;
        startupTimeoutMs?: number;
        heartbeatTimeoutMs?: number;
        replaceExisting?: boolean;
      };
    }
  | {
      type: "frontend_process_list";
      requestId: string;
      filter?: {
        userId?: string;
        kind?: string;
        key?: string;
        state?: FrontendProcessState;
      };
    }
  | { type: "frontend_process_get"; requestId: string; processId: string }
  | {
      type: "frontend_process_stop";
      requestId: string;
      processId: string;
      options?: { userId?: string; reason?: string };
    }
  | { type: "frontend_process_send"; processId: string; payload: unknown; userId?: string }
  | {
      type: "backend_process_spawn";
      requestId: string;
      options: {
        entry: string;
        kind?: string;
        key?: string;
        payload?: unknown;
        metadata?: Record<string, unknown>;
        userId?: string;
        startupTimeoutMs?: number;
        heartbeatTimeoutMs?: number;
        replaceExisting?: boolean;
      };
    }
  | {
      type: "backend_process_list";
      requestId: string;
      filter?: {
        userId?: string;
        kind?: string;
        key?: string;
        state?: BackendProcessState;
      };
    }
  | { type: "backend_process_get"; requestId: string; processId: string }
  | {
      type: "backend_process_stop";
      requestId: string;
      processId: string;
      options?: { userId?: string; reason?: string };
    }
  | { type: "backend_process_send"; processId: string; payload: unknown; userId?: string };

type RuntimeHostToWorker =
  | HostToWorker
  | {
      type: "rpc_pool_request";
      requestId: string;
      endpoint: string;
      requesterExtensionId: string;
    }
  | {
      type: "message_content_processor_request";
      requestId: string;
      ctx: MessageContentProcessorCtx;
    }
  | {
      type: "macro_interceptor_request";
      requestId: string;
      ctx: MacroInterceptorCtx;
    }
  | {
      type: "world_info_interceptor_request";
      requestId: string;
      ctx: WorldInfoInterceptorCtxDTO;
    }
  | { type: "frontend_process_lifecycle"; event: FrontendProcessLifecycleEvent }
  | { type: "frontend_process_message"; processId: string; payload: unknown; userId: string }
  | { type: "backend_process_lifecycle"; event: BackendProcessLifecycleEvent }
  | { type: "backend_process_message"; processId: string; payload: unknown; userId: string };

let cachedBackendVersion: string | null = null;
let cachedFrontendVersion: string | null = null;

async function readPackageVersion(relativePath: string): Promise<string> {
  const raw = await Bun.file(join(import.meta.dir, relativePath)).text();
  const pkg = JSON.parse(raw);
  const version = typeof pkg.version === "string" ? pkg.version : null;
  if (!version) throw new Error(`No version field in ${relativePath}`);
  return version;
}

async function getBackendVersion(): Promise<string> {
  if (cachedBackendVersion) return cachedBackendVersion;
  cachedBackendVersion = await readPackageVersion("../../package.json");
  return cachedBackendVersion;
}

async function getFrontendVersion(): Promise<string> {
  if (cachedFrontendVersion) return cachedFrontendVersion;
  cachedFrontendVersion = await readPackageVersion("../../frontend/package.json");
  return cachedFrontendVersion;
}

const CORS_PROXY_TIMEOUT_MS = 30_000;
const CORS_PROXY_MAX_BODY_BYTES = 25 * 1024 * 1024; // 25 MB

const MAX_CSS_VALUE_LENGTH = 1024;

/**
 * Reject CSS variable values that could exfiltrate data, deface the UI in
 * surprising ways, or chain into a CSS-injection attack. We accept ordinary
 * literals (colors, lengths, shadows, gradients, font lists, transforms) and
 * reject things like `url(javascript:...)`, `expression(...)`, `@import`, and
 * embedded HTML/JS — everything you'd expect a Lumiverse theme variable to
 * never contain.
 */
function validateCssValue(value: unknown): string | null {
  if (value === undefined || value === null) return "value must be a string";
  if (typeof value !== "string") return "value must be a string";
  if (value.length > MAX_CSS_VALUE_LENGTH) return `value exceeds ${MAX_CSS_VALUE_LENGTH} characters`;
  if (value.length === 0) return null; // empty string clears the var, which is fine

  const trimmed = value.trim();
  // Strip any backslash escapes so attackers can't smuggle disallowed tokens
  // like `expr\ession(...)`. We're checking the literal characters the browser
  // would interpret.
  const lowered = trimmed.toLowerCase().replace(/\\/g, "");

  // Disallow control characters and unbalanced delimiters.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) return "control characters not allowed";
  if (/[<>]/.test(value)) return "angle brackets not allowed";
  if (value.includes("{") || value.includes("}") || value.includes(";")) {
    return "must be a single property value (no { } ; )";
  }

  // Block CSS sinks that can execute or exfiltrate.
  if (lowered.includes("javascript:")) return "javascript: URLs not allowed";
  if (lowered.includes("vbscript:")) return "vbscript: URLs not allowed";
  if (lowered.includes("data:text/html")) return "data:text/html URLs not allowed";
  if (lowered.includes("expression(")) return "CSS expression() not allowed";
  if (lowered.startsWith("@")) return "at-rules not allowed in variable values";
  if (/^url\(\s*['"]?\s*(?!https?:|data:image\/)/i.test(trimmed)) {
    return "url() must point to https: or a data:image/* payload";
  }
  // Block image-attribute selector exfil patterns (`image-set("https://...")`)
  // unless they are HTTPS or safe data: image URLs — same rule as url().
  if (/image-set\(/i.test(trimmed)) {
    if (!/image-set\(\s*['"]?\s*(https?:|data:image\/)/i.test(trimmed)) {
      return "image-set() must point to https: or a data:image/* payload";
    }
  }
  return null;
}

/**
 * Drain a fetch response body up to `maxBytes`, throwing if the cap is hit.
 * Using `.text()` would buffer the entire body unconditionally, so an attacker
 * could ship a multi-GB response and exhaust process memory.
 */
async function readResponseBodyCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(
        `CORS proxy response exceeded ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(concatChunks(chunks, total));
}

/**
 * Same as `readResponseBodyCapped` but returns raw bytes instead of decoding
 * as UTF-8. Used when the CORS proxy must serve binary assets (e.g. images).
 */
async function readResponseBodyBinaryCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error(
        `CORS proxy response exceeded ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }
  return concatChunks(chunks, total);
}

/**
 * Validate that raw bytes begin with a known image format signature.
 * SVG is validated separately by inspecting the text preamble.
 */
function validateImageMagicBytes(data: Uint8Array, contentType: string): boolean {
  if (data.length < 2) return false;

  // SVG is text-based; validate by Content-Type and XML preamble
  if (contentType.includes("svg")) {
    const header = new TextDecoder("utf-8", { fatal: false }).decode(data.slice(0, 256));
    const trimmed = header.trimStart();
    return trimmed.startsWith("<svg") || trimmed.startsWith("<?xml");
  }

  if (data.length < 4) return false;

  // PNG: 89 50 4E 47
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) return true;
  // GIF: 47 49 46 38
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return true;
  // BMP: 42 4D
  if (data[0] === 0x42 && data[1] === 0x4D) return true;
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    if (data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return true;
  }

  return false;
}

/** Validate common browser-playable audio containers before proxying to widgets. */
function validateAudioMagicBytes(data: Uint8Array, contentType: string): boolean {
  if (data.length < 4) return false;

  // MP3: ID3 tag or MPEG frame sync.
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return true;
  if (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0) return true;

  // WAV: RIFF....WAVE.
  if (data.length >= 12 && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) {
    if (data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45) return true;
  }

  // Ogg / Opus / Vorbis.
  if (data[0] === 0x4F && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) return true;

  // FLAC.
  if (data[0] === 0x66 && data[1] === 0x4C && data[2] === 0x61 && data[3] === 0x43) return true;

  // MP4/M4A: ISO BMFF ftyp box.
  if (data.length >= 12 && data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) return true;

  // WebM/Matroska: EBML header.
  if (data[0] === 0x1A && data[1] === 0x45 && data[2] === 0xDF && data[3] === 0xA3) return true;

  // MIDI.
  if (contentType.includes("midi") && data[0] === 0x4D && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64) return true;

  return false;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function requestWithAddressFamily(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  family: 4 | 6
): Promise<{
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = (parsed.protocol === "https:" ? https : http).request(
      parsed,
      {
        method: options.method || "GET",
        headers: options.headers,
        family,
        timeout: CORS_PROXY_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(", ") : String(value ?? ""),
              ])
            ),
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error(`CORS proxy request timed out after ${CORS_PROXY_TIMEOUT_MS}ms`));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export class WorkerHost {
  private static readonly FULL_THEME_SENTINEL_KEYS = [
    "--lumiverse-primary",
    "--lumiverse-bg",
    "--lumiverse-text",
    "--lumiverse-border",
    "--lumiverse-fill",
    "--lcs-glass-bg",
  ] as const;
  private static readonly FULL_THEME_MIN_KEYS = 40;

  /** Keys that represent user preferences, not theme colors.
   *  applyPalette strips these so it only changes colors — glass, radii,
   *  fonts, scale, and transitions are always owned by the user's config. */
  private static readonly USER_PREFERENCE_KEYS = new Set([
    "--lcs-glass-blur",
    "--lcs-glass-soft-blur",
    "--lcs-glass-strong-blur",
    "--lcs-radius",
    "--lcs-radius-sm",
    "--lcs-radius-xs",
    "--lcs-transition",
    "--lcs-transition-fast",
    "--lumiverse-radius",
    "--lumiverse-radius-sm",
    "--lumiverse-radius-md",
    "--lumiverse-radius-lg",
    "--lumiverse-radius-xl",
    "--lumiverse-font-family",
    "--lumiverse-font-mono",
    "--lumiverse-font-scale",
    "--lumiverse-ui-scale",
    "--lumiverse-transition",
    "--lumiverse-transition-fast",
  ]);
  private runtime: RuntimeTransport | null = null;
  private eventUnsubscribers = new Map<string, () => void>();
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  /**
   * AbortControllers for in-flight `request_generation` calls, keyed by the
   * worker-supplied `requestId`. The worker posts `cancel_generation` with the
   * same id when an extension's `AbortSignal` fires; the host calls
   * `controller.abort()` to tear down the upstream LLM request.
   */
  private generationAbortControllers = new Map<string, AbortController>();
  private interceptorUnregister: (() => void) | null = null;
  private contextHandlerUnregister: (() => void) | null = null;
  private messageContentProcessorUnregister: (() => void) | null = null;
  private macroInterceptorUnregister: (() => void) | null = null;
  private worldInfoInterceptorUnregister: (() => void) | null = null;
  private registeredMacroNames = new Set<string>();
  private macroValueCache = new Map<string, string>();
  private toastTimestamps: number[] = [];
  private static readonly TOAST_RATE_LIMIT = 5;
  private static readonly TOAST_RATE_WINDOW_MS = 10_000;
  private registeredCommands: SpindleCommandDTO[] = [];
  private static readonly MAX_COMMANDS_PER_EXTENSION = 20;
  private static readonly MAX_BACKEND_PROCESSES = 16;
  private static readonly SHARED_RPC_REQUEST_TIMEOUT_MS = 10_000;
  private commandInvokedHandlers = new Set<string>(); // tracked for cleanup only
  private onWorkerReady: (() => void) | null = null;
  private onWorkerShutdownAck: (() => void) | null = null;
  private onRuntimeExit: (() => void) | null = null;
  private runtimeExitPromise: Promise<void> | null = null;
  private runtimeStopping = false;
  private runtimeStatsInterval: ReturnType<typeof setInterval> | null = null;
  private readonly installScope: "operator" | "user";
  private readonly installedByUserId: string | null;
  private frontendProcesses = new Map<string, FrontendProcessRecord>();
  private frontendProcessKeyIndex = new Map<string, string>();
  private backendProcesses = new Map<string, BackendProcessRecord>();
  private backendProcessKeyIndex = new Map<string, string>();

  constructor(
    public readonly extensionId: string,
    public readonly manifest: SpindleManifest,
    extensionInfo: ExtensionInfo
  ) {
    const metadata = (extensionInfo.metadata || {}) as Record<string, unknown>;
    this.installScope = metadata.install_scope === "user" ? "user" : "operator";
    this.installedByUserId =
      typeof metadata.installed_by_user_id === "string" && metadata.installed_by_user_id.trim()
        ? metadata.installed_by_user_id
        : null;
  }

  private getScopedUserId(): string | null {
    if (this.installScope !== "user") return null;
    return this.installedByUserId;
  }

  private enforceScopedUser(userId: string | null | undefined): void {
    if (this.installScope !== "user") return;
    if (!this.installedByUserId) {
      throw new Error("Extension owner is not set");
    }
    if (!userId || userId !== this.installedByUserId) {
      throw new Error("Extension is user-scoped and cannot access this user context");
    }
  }

  private resolveFrontendProcessUserId(userId?: string): string {
    if (this.installScope === "user") {
      if (!this.installedByUserId) {
        throw new Error("Extension owner is not set");
      }
      return this.installedByUserId;
    }

    if (typeof userId !== "string" || !userId.trim()) {
      throw new Error("userId is required when spawning a managed process");
    }

    return userId.trim();
  }

  private buildFrontendProcessKey(userId: string, kind: string, key: string): string {
    return `${userId}:${kind}:${key}`;
  }

  private snapshotFrontendProcess(record: FrontendProcessRecord): FrontendProcessInfo {
    return {
      processId: record.processId,
      kind: record.kind,
      ...(record.key ? { key: record.key } : {}),
      state: record.state,
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      startedAt: record.startedAt,
      ...(record.readyAt ? { readyAt: record.readyAt } : {}),
      ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(record.exitReason ? { exitReason: record.exitReason } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private clearFrontendProcessTimers(record: FrontendProcessRecord): void {
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record.heartbeatTimer) {
      clearTimeout(record.heartbeatTimer);
      record.heartbeatTimer = null;
    }
  }

  private emitFrontendProcessLifecycle(
    record: FrontendProcessRecord,
    previousState?: FrontendProcessState
  ): void {
    this.postToWorker({
      type: "frontend_process_lifecycle",
      event: {
        processId: record.processId,
        kind: record.kind,
        ...(record.key ? { key: record.key } : {}),
        ...(record.userId ? { userId: record.userId } : {}),
        state: record.state,
        ...(previousState ? { previousState } : {}),
        at: record.endedAt ?? record.lastHeartbeatAt ?? record.readyAt ?? record.startedAt,
        ...(record.exitReason ? { exitReason: record.exitReason } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      },
    });
  }

  private armFrontendHeartbeatTimer(record: FrontendProcessRecord): void {
    if (record.heartbeatTimeoutMs <= 0) return;
    if (record.heartbeatTimer) clearTimeout(record.heartbeatTimer);
    record.heartbeatTimer = setTimeout(() => {
      const latest = this.frontendProcesses.get(record.processId);
      if (!latest) return;
      this.requestFrontendProcessStop(latest, "timed_out");
      this.finalizeFrontendProcess(latest, "timed_out", "timed_out", "Frontend process heartbeat timed out");
    }, record.heartbeatTimeoutMs);
  }

  private requestFrontendProcessStop(record: FrontendProcessRecord, reason?: string): void {
    eventBus.emit(
      EventType.SPINDLE_FRONTEND_PROCESS,
      {
        extensionId: this.extensionId,
        identifier: this.manifest.identifier,
        action: "stop",
        processId: record.processId,
        ...(reason ? { reason } : {}),
      },
      record.userId,
    );
  }

  private transitionFrontendProcess(
    record: FrontendProcessRecord,
    nextState: FrontendProcessState,
    extras?: { readyAt?: string; lastHeartbeatAt?: string; endedAt?: string; exitReason?: FrontendProcessExitReason; error?: string }
  ): void {
    if (record.state === nextState && !extras) return;
    const previousState = record.state;
    record.state = nextState;
    if (extras?.readyAt) record.readyAt = extras.readyAt;
    if (extras?.lastHeartbeatAt) record.lastHeartbeatAt = extras.lastHeartbeatAt;
    if (extras?.endedAt) record.endedAt = extras.endedAt;
    if (extras?.exitReason) record.exitReason = extras.exitReason;
    if (extras && "error" in extras) {
      record.error = extras.error;
    }
    this.emitFrontendProcessLifecycle(record, previousState);
  }

  private finalizeFrontendProcess(
    record: FrontendProcessRecord,
    state: Extract<FrontendProcessState, "stopped" | "completed" | "failed" | "timed_out">,
    exitReason: FrontendProcessExitReason,
    error?: string,
  ): void {
    this.clearFrontendProcessTimers(record);
    this.transitionFrontendProcess(record, state, {
      endedAt: new Date().toISOString(),
      exitReason,
      ...(error ? { error } : { error: undefined }),
    });
    this.frontendProcesses.delete(record.processId);
    if (record.key) {
      this.frontendProcessKeyIndex.delete(
        this.buildFrontendProcessKey(record.userId ?? "", record.kind, record.key)
      );
    }
  }

  private getFrontendProcessRecord(processId: string): FrontendProcessRecord | null {
    return this.frontendProcesses.get(processId) ?? null;
  }

  private getFrontendProcessForUser(processId: string, userId: string): FrontendProcessRecord | null {
    const record = this.frontendProcesses.get(processId);
    if (!record) return null;
    if (record.userId && record.userId !== userId) return null;
    return record;
  }

  private stopAllFrontendProcesses(exitReason: FrontendProcessExitReason): void {
    for (const record of Array.from(this.frontendProcesses.values())) {
      this.requestFrontendProcessStop(record, exitReason);
      this.clearFrontendProcessTimers(record);
      this.frontendProcesses.delete(record.processId);
      if (record.key) {
        this.frontendProcessKeyIndex.delete(
          this.buildFrontendProcessKey(record.userId ?? "", record.kind, record.key)
        );
      }
    }
  }

  private getBackendProcessRuntimeMode(): Extract<import("./runtime-transport").RuntimeTransportMode, "process" | "sandbox"> {
    const raw = process.env.LUMIVERSE_SPINDLE_RUNTIME_MODE?.trim().toLowerCase();
    return raw === "sandbox" ? "sandbox" : "process";
  }

  private buildBackendProcessKey(userId: string, kind: string, key: string): string {
    return `${userId}:${kind}:${key}`;
  }

  private snapshotBackendProcess(record: BackendProcessRecord): BackendProcessInfo {
    return {
      processId: record.processId,
      entry: record.entry,
      kind: record.kind,
      ...(record.key ? { key: record.key } : {}),
      state: record.state,
      ...(record.userId ? { userId: record.userId } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      startedAt: record.startedAt,
      ...(record.readyAt ? { readyAt: record.readyAt } : {}),
      ...(record.lastHeartbeatAt ? { lastHeartbeatAt: record.lastHeartbeatAt } : {}),
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      ...(record.exitReason ? { exitReason: record.exitReason } : {}),
      ...(record.error ? { error: record.error } : {}),
    };
  }

  private clearBackendProcessTimers(record: BackendProcessRecord): void {
    if (record.startupTimer) {
      clearTimeout(record.startupTimer);
      record.startupTimer = null;
    }
    if (record.heartbeatTimer) {
      clearTimeout(record.heartbeatTimer);
      record.heartbeatTimer = null;
    }
    if (record.stopTimer) {
      clearTimeout(record.stopTimer);
      record.stopTimer = null;
    }
  }

  private emitBackendProcessLifecycle(
    record: BackendProcessRecord,
    previousState?: BackendProcessState
  ): void {
    this.postToWorker({
      type: "backend_process_lifecycle",
      event: {
        processId: record.processId,
        entry: record.entry,
        kind: record.kind,
        ...(record.key ? { key: record.key } : {}),
        ...(record.userId ? { userId: record.userId } : {}),
        state: record.state,
        ...(previousState ? { previousState } : {}),
        at: record.endedAt ?? record.lastHeartbeatAt ?? record.readyAt ?? record.startedAt,
        ...(record.exitReason ? { exitReason: record.exitReason } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      },
    });
  }

  private armBackendHeartbeatTimer(record: BackendProcessRecord): void {
    if (record.heartbeatTimeoutMs <= 0) return;
    if (record.heartbeatTimer) clearTimeout(record.heartbeatTimer);
    record.heartbeatTimer = setTimeout(() => {
      const latest = this.backendProcesses.get(record.processId);
      if (!latest) return;
      try {
        latest.runtime.terminate(true);
      } catch {
        // ignore
      }
      this.finalizeBackendProcess(latest, "timed_out", "timed_out", "Backend process heartbeat timed out");
    }, record.heartbeatTimeoutMs);
  }

  private armBackendStopTimer(record: BackendProcessRecord): void {
    if (record.stopTimer) clearTimeout(record.stopTimer);
    record.stopTimer = setTimeout(() => {
      const latest = this.backendProcesses.get(record.processId);
      if (!latest) return;
      try {
        latest.runtime.terminate(true);
      } catch {
        // ignore
      }
      this.finalizeBackendProcess(latest, "stopped", "stopped", "Backend process force-stopped after stop timeout");
    }, 5_000);
  }

  private transitionBackendProcess(
    record: BackendProcessRecord,
    nextState: BackendProcessState,
    extras?: { readyAt?: string; lastHeartbeatAt?: string; endedAt?: string; exitReason?: BackendProcessExitReason; error?: string }
  ): void {
    if (record.state === nextState && !extras) return;
    const previousState = record.state;
    record.state = nextState;
    if (extras?.readyAt) record.readyAt = extras.readyAt;
    if (extras?.lastHeartbeatAt) record.lastHeartbeatAt = extras.lastHeartbeatAt;
    if (extras?.endedAt) record.endedAt = extras.endedAt;
    if (extras?.exitReason) record.exitReason = extras.exitReason;
    if (extras && "error" in extras) {
      record.error = extras.error;
    }
    this.emitBackendProcessLifecycle(record, previousState);
  }

  private finalizeBackendProcess(
    record: BackendProcessRecord,
    state: Extract<BackendProcessState, "stopped" | "completed" | "failed" | "timed_out">,
    exitReason: BackendProcessExitReason,
    error?: string,
  ): void {
    this.clearBackendProcessTimers(record);
    this.transitionBackendProcess(record, state, {
      endedAt: new Date().toISOString(),
      exitReason,
      ...(error ? { error } : { error: undefined }),
    });
    this.backendProcesses.delete(record.processId);
    if (record.key) {
      this.backendProcessKeyIndex.delete(
        this.buildBackendProcessKey(record.userId ?? "", record.kind, record.key)
      );
    }
  }

  private getBackendProcessRecord(processId: string): BackendProcessRecord | null {
    return this.backendProcesses.get(processId) ?? null;
  }

  private async resolveBackendProcessEntryPath(entry: string): Promise<string> {
    const normalized = typeof entry === "string" ? entry.trim().replace(/\\/g, "/") : "";
    if (!normalized) throw new Error("entry is required");
    if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
      throw new Error("entry must be a relative path inside the extension repo");
    }
    if (!normalized.startsWith("dist/")) {
      throw new Error("backend process entries must live under dist/");
    }
    if (!/\.(?:cjs|mjs|js)$/.test(normalized)) {
      throw new Error("backend process entry must be a built JavaScript file");
    }

    const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
    const repoAbs = resolve(repoPath);
    const entryPath = resolve(repoAbs, normalized);
    const insideRepo = entryPath === repoAbs || entryPath.startsWith(`${repoAbs}${sep}`);
    if (!insideRepo) {
      throw new Error(`Path traversal detected in backend process entry: ${entry}`);
    }
    if (!(await Bun.file(entryPath).exists())) {
      throw new Error(`Backend process entry not found: ${normalized}`);
    }

    const blocked = managerSvc.detectDangerousBackendCapabilities(await Bun.file(entryPath).text());
    if (blocked.length > 0) {
      throw new Error(
        `Backend process entry \"${normalized}\" uses blocked backend capabilities: ${blocked.join(", ")}`
      );
    }

    return entryPath;
  }

  private handleBackendProcessRuntimeMessage(
    processId: string,
    message: BackendProcessRuntimeToHost
  ): void {
    const record = this.backendProcesses.get(processId);
    if (!record) return;

    switch (message.type) {
      case "ready": {
        if (record.state !== "starting") return;
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        const now = new Date().toISOString();
        this.transitionBackendProcess(record, "running", {
          readyAt: now,
          lastHeartbeatAt: now,
        });
        this.armBackendHeartbeatTimer(record);
        this.postToWorker({
          type: "response",
          requestId: record.requestId,
          result: this.snapshotBackendProcess(record),
        });
        return;
      }

      case "heartbeat": {
        if (record.state !== "running") return;
        const now = new Date().toISOString();
        this.transitionBackendProcess(record, "running", { lastHeartbeatAt: now });
        this.armBackendHeartbeatTimer(record);
        return;
      }

      case "message": {
        this.postToWorker({
          type: "backend_process_message",
          processId: record.processId,
          payload: message.payload,
          userId: record.userId ?? "",
        });
        return;
      }

      case "complete": {
        if (record.state === "starting") {
          this.rejectRequest(record.requestId, new Error("Backend process completed before it became ready"));
        }
        this.finalizeBackendProcess(record, "completed", "completed");
        return;
      }

      case "fail": {
        const error = message.error?.trim() || "Backend process failed";
        if (record.state === "starting") {
          this.rejectRequest(record.requestId, new Error(error));
        }
        this.finalizeBackendProcess(record, "failed", "failed", error);
        return;
      }

      case "stopped": {
        if (record.state === "starting") {
          this.rejectRequest(record.requestId, new Error("Backend process stopped before it became ready"));
        }
        this.finalizeBackendProcess(record, "stopped", "stopped");
        return;
      }
    }
  }

  private handleBackendProcessRuntimeExit(
    processId: string,
    exitCode: number | null,
    signalCode: number | null,
    error?: Error,
  ): void {
    const record = this.backendProcesses.get(processId);
    if (!record) return;

    const details = error?.message || `Backend process exited (code=${exitCode ?? "null"}, signal=${signalCode ?? "null"})`;
    if (record.state === "starting") {
      this.rejectRequest(record.requestId, new Error(details));
      this.finalizeBackendProcess(record, "failed", "failed", details);
      return;
    }
    if (record.state === "stopping") {
      this.finalizeBackendProcess(record, "stopped", "stopped");
      return;
    }
    this.finalizeBackendProcess(record, "failed", "failed", details);
  }

  private stopAllBackendProcesses(exitReason: BackendProcessExitReason): void {
    for (const record of Array.from(this.backendProcesses.values())) {
      this.clearBackendProcessTimers(record);
      try {
        record.runtime.terminate(true);
      } catch {
        // ignore
      }
      this.transitionBackendProcess(record, "stopped", {
        endedAt: new Date().toISOString(),
        exitReason,
      });
      this.backendProcesses.delete(record.processId);
      if (record.key) {
        this.backendProcessKeyIndex.delete(
          this.buildBackendProcessKey(record.userId ?? "", record.kind, record.key)
        );
      }
    }
  }

  private getStorageRootPath(identifier: string = this.manifest.identifier): string {
    if (identifier === this.manifest.identifier && this.installScope === "user") {
      if (!this.installedByUserId) {
        throw new Error("Extension owner is not set");
      }
      return managerSvc.getUserExtensionStoragePath(identifier, this.installedByUserId);
    }
    return managerSvc.getStoragePath(identifier);
  }

  private getRuntimeSampleIntervalMs(): number {
    if (!this.isRuntimeStatsEnabled()) return 0;
    const raw = process.env.LUMIVERSE_SPINDLE_RUNTIME_SAMPLE_INTERVAL_MS?.trim();
    if (!raw) return 30_000;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private isRuntimeStatsEnabled(): boolean {
    const raw = process.env.LUMIVERSE_SPINDLE_RUNTIME_STATS?.trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  }

  private async sampleRuntimeRssKb(): Promise<number | null> {
    const pid = this.runtime?.pid;
    if (!pid || pid <= 0) return null;

    const sampled = await spawnAsync(["ps", "-o", "rss=", "-p", String(pid)], {
      timeoutMs: 1_500,
      ignoreStdout: false,
    });
    if (sampled.exitCode !== 0) return null;

    const rssKb = parseInt(sampled.stdout.trim(), 10);
    return Number.isFinite(rssKb) && rssKb > 0 ? rssKb : null;
  }

  private async emitRuntimeStats(phase: "startup" | "sample" | "shutdown", startupMs?: number): Promise<void> {
    if (!this.isRuntimeStatsEnabled()) return;

    const runtimeMode = this.runtime?.mode ?? "worker";
    const pid = this.runtime?.pid ?? null;
    const rssKb = runtimeMode === "worker" ? null : await this.sampleRuntimeRssKb();
    const payload = {
      extensionId: this.extensionId,
      identifier: this.manifest.identifier,
      name: this.manifest.name,
      runtimeMode,
      phase,
      pid,
      rssKb,
      ...(typeof startupMs === "number" ? { startupMs } : {}),
    };

    eventBus.emit(EventType.SPINDLE_RUNTIME_STATS, payload);

    const parts = [
      `mode=${runtimeMode}`,
      `phase=${phase}`,
      ...(pid ? [`pid=${pid}`] : []),
      ...(typeof startupMs === "number" ? [`startupMs=${startupMs.toFixed(2)}`] : []),
      ...(typeof rssKb === "number" ? [`rssKb=${rssKb}`] : []),
    ];
    console.info(`[Spindle:${this.manifest.identifier}] Runtime stats ${parts.join(" ")}`);
  }

  private startRuntimeStatsSampling(): void {
    if (!this.runtime || this.runtime.mode === "worker") return;
    const intervalMs = this.getRuntimeSampleIntervalMs();
    if (intervalMs <= 0) return;

    this.stopRuntimeStatsSampling();
    this.runtimeStatsInterval = setInterval(() => {
      void this.emitRuntimeStats("sample");
    }, intervalMs);
  }

  private stopRuntimeStatsSampling(): void {
    if (!this.runtimeStatsInterval) return;
    clearInterval(this.runtimeStatsInterval);
    this.runtimeStatsInterval = null;
  }

  async start(): Promise<void> {
    const entryPath = await managerSvc.getBackendEntryPath(this.manifest.identifier);
    if (!entryPath) {
      console.log(
        `[Spindle:${this.manifest.identifier}] No backend entry, skipping worker`
      );
      return;
    }

    const runtimePath = join(import.meta.dir, "worker-runtime.ts");
    const storagePath = this.getStorageRootPath(this.manifest.identifier);
    const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
    this.runtimeStopping = false;
    this.runtimeExitPromise = new Promise<void>((resolve) => {
      this.onRuntimeExit = resolve;
    });
    const startTime = performance.now();

    this.runtime = createRuntimeTransport({
      runtimePath,
      extensionIdentifier: this.manifest.identifier,
      repoPath,
      storagePath,
      onMessage: (message) => {
        this.handleMessage(message as RuntimeWorkerToHost);
      },
      onError: (message) => {
        console.error(
          `[Spindle:${this.manifest.identifier}] Worker error:`,
          message
        );
        eventBus.emit(EventType.SPINDLE_EXTENSION_ERROR, {
          extensionId: this.extensionId,
          identifier: this.manifest.identifier,
          error: message,
        });

        try {
          this.runtime?.postMessage({ type: "ping" } as any);
        } catch {
          console.warn(
            `[Spindle:${this.manifest.identifier}] Worker appears dead after error, cleaning up registrations`
          );
          this.cleanup();
        }
      },
      onExit: (exitCode, signalCode, error) => {
        const wasStopping = this.runtimeStopping;
        this.onWorkerShutdownAck?.();
        this.onWorkerShutdownAck = null;
        this.onRuntimeExit?.();
        this.onRuntimeExit = null;
        if (wasStopping) {
          this.cleanup();
          return;
        }
        const details = error?.message || `Runtime exited (code=${exitCode ?? "null"}, signal=${signalCode ?? "null"})`;
        console.error(`[Spindle:${this.manifest.identifier}] Runtime exited unexpectedly:`, details);
        eventBus.emit(EventType.SPINDLE_EXTENSION_ERROR, {
          extensionId: this.extensionId,
          identifier: this.manifest.identifier,
          error: details,
        });
        this.cleanup();
      },
    });

    // Wait for the worker to finish loading the extension and registering
    // all macros/interceptors before resolving, so callers know the
    // extension is ready.
    const readyPromise = new Promise<void>((resolve) => {
      const readyTimeout = setTimeout(() => {
        console.warn(
          `[Spindle:${this.manifest.identifier}] Worker ready timeout (10s) — proceeding`
        );
        resolve();
      }, 10_000);

      this.onWorkerReady = () => {
        clearTimeout(readyTimeout);
        resolve();
      };
    });

    // Send init message with the extension's backend entry path
    this.postToWorker({
      type: "init",
      manifest: { ...this.manifest, entry_backend: entryPath },
      storagePath,
    });

    await readyPromise;
    await this.emitRuntimeStats("startup", performance.now() - startTime);
    this.startRuntimeStatsSampling();
  }

  async stop(): Promise<void> {
    if (!this.runtime) return;
    const runtime = this.runtime;
    const runtimeExitPromise = this.runtimeExitPromise;
    this.runtimeStopping = true;
    this.stopRuntimeStatsSampling();
    this.stopAllFrontendProcesses("backend_unloaded");
    this.stopAllBackendProcesses("backend_unloaded");

    // Wait for the worker to acknowledge shutdown (posted right before
    // process.exit(0) in worker-runtime.ts) — or fall back to terminate()
    // after 5s if the worker is wedged. Resolving early is important for
    // the bulk-update path: without it, every extension stop burned the
    // full 5s fallback before the next step could run.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.onWorkerShutdownAck = null;
        resolve();
      };

      this.onWorkerShutdownAck = finish;

      const timer = setTimeout(() => {
        // Fallback: worker never acknowledged. Force-terminate.
        try {
          runtime.terminate();
        } catch {
          // ignore — terminate is best-effort
        }
        finish();
      }, 5000);

      // Actually send the shutdown after the listener is installed so we
      // can never miss the ack due to a fast worker exit.
      try {
        this.postToWorker({ type: "shutdown" });
      } catch {
        // Worker already gone — finish immediately.
        finish();
      }
    });

    if (runtime.mode === "worker") {
      await this.emitRuntimeStats("shutdown");
      this.cleanup();
      return;
    }

    if (runtimeExitPromise) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceKillTimer);
          clearTimeout(finalTimeout);
          resolve();
        };

        const forceKillTimer = setTimeout(() => {
          try {
            runtime.terminate(true);
          } catch {
            // ignore — SIGKILL is best-effort
          }
        }, 5_000);

        // Last-resort guard so update paths do not hang forever if Bun fails
        // to report subprocess exit after termination.
        const finalTimeout = setTimeout(finish, 7_500);

        void runtimeExitPromise.finally(finish);
      });
    }
  }

  private cleanup(): void {
    this.stopRuntimeStatsSampling();
    this.stopAllFrontendProcesses("backend_unloaded");
    this.stopAllBackendProcesses("backend_unloaded");
    this.onWorkerReady = null;
    this.onWorkerShutdownAck = null;
    this.onRuntimeExit?.();
    this.onRuntimeExit = null;
    this.runtimeExitPromise = null;
    // Unsubscribe from all events
    for (const unsub of this.eventUnsubscribers.values()) {
      unsub();
    }
    this.eventUnsubscribers.clear();

    // Unregister interceptor
    this.interceptorUnregister?.();
    this.interceptorUnregister = null;

    // Unregister context handler
    this.contextHandlerUnregister?.();
    this.contextHandlerUnregister = null;

    // Unregister message content processor
    this.messageContentProcessorUnregister?.();
    this.messageContentProcessorUnregister = null;

    this.macroInterceptorUnregister?.();
    this.macroInterceptorUnregister = null;

    this.worldInfoInterceptorUnregister?.();
    this.worldInfoInterceptorUnregister = null;

    // Unregister all tools for this extension
    toolRegistry.unregisterByExtension(this.extensionId);

    // Unregister all macros registered by this extension
    for (const macroName of this.registeredMacroNames) {
      macroRegistry.unregisterMacro(macroName);
    }
    this.registeredMacroNames.clear();
    this.macroValueCache.clear();
    this.toastTimestamps = [];

    // Clear commands and broadcast removal
    if (this.registeredCommands.length > 0) {
      this.registeredCommands = [];
      this.broadcastCommandsChanged();
    }

    // Clear theme overrides
    this.clearThemeOverrides();

    // Unregister interceptors and context handlers
    interceptorPipeline.unregisterByExtension(this.extensionId);
    contextHandlerChain.unregisterByExtension(this.extensionId);
    messageContentProcessorChain.unregisterByExtension(this.extensionId);
    macroInterceptorChain.unregisterByExtension(this.extensionId);
    worldInfoInterceptorChain.unregisterByExtension(this.extensionId);
    unregisterSharedRpcEndpointsByOwner(this.manifest.identifier);

    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Extension worker stopped"));
    }
    this.pendingRequests.clear();

    // Abort any in-flight generations so upstream HTTP requests don't leak
    // past the extension's lifetime.
    for (const controller of this.generationAbortControllers.values()) {
      controller.abort();
    }
    this.generationAbortControllers.clear();

    this.runtime = null;
    this.runtimeStopping = false;
  }

  private handleRuntimeTransportFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Spindle:${this.manifest.identifier}] Runtime transport failed, cleaning up: ${message}`
    );
    this.cleanup();
  }

  private postToWorker(msg: RuntimeHostToWorker): void {
    if (!this.runtime) return;
    try {
      this.runtime.postMessage(msg);
    } catch (error) {
      this.handleRuntimeTransportFailure(error);
    }
  }

  sendFrontendMessage(payload: unknown, userId: string): void {
    this.postToWorker({ type: "frontend_message", payload, userId });
  }

  private sendFrontendProcessEvent(
    userId: string,
    payload: Record<string, unknown>,
  ): void {
    eventBus.emit(
      EventType.SPINDLE_FRONTEND_PROCESS,
      {
        extensionId: this.extensionId,
        identifier: this.manifest.identifier,
        ...payload,
      },
      userId,
    );
  }

  handleFrontendProcessEvent(
    processId: string,
    userId: string,
    event: "ready" | "heartbeat" | "complete" | "fail" | "frontend_unloaded",
    error?: string,
  ): void {
    const record = this.getFrontendProcessForUser(processId, userId);
    if (!record) return;

    switch (event) {
      case "ready": {
        if (record.state !== "starting") return;
        const now = new Date().toISOString();
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        this.transitionFrontendProcess(record, "running", {
          readyAt: now,
          lastHeartbeatAt: now,
          error: undefined,
        });
        this.armFrontendHeartbeatTimer(record);
        this.resolveRequest(record.requestId, this.snapshotFrontendProcess(record));
        break;
      }
      case "heartbeat": {
        if (record.state !== "running" && record.state !== "stopping") return;
        const now = new Date().toISOString();
        record.lastHeartbeatAt = now;
        this.armFrontendHeartbeatTimer(record);
        break;
      }
      case "complete": {
        if (record.state === "completed" || record.state === "failed" || record.state === "timed_out" || record.state === "stopped") {
          return;
        }
        this.finalizeFrontendProcess(
          record,
          record.state === "stopping" ? "stopped" : "completed",
          record.state === "stopping" ? "stopped" : "completed",
        );
        break;
      }
      case "fail": {
        if (record.state === "completed" || record.state === "failed" || record.state === "timed_out" || record.state === "stopped") {
          return;
        }
        const message = error?.trim() || "Frontend process failed";
        if (record.state === "starting") {
          this.clearFrontendProcessTimers(record);
          this.finalizeFrontendProcess(record, "failed", "failed", message);
          this.rejectRequest(processId, new Error(message));
        } else {
          this.finalizeFrontendProcess(record, "failed", "failed", message);
        }
        break;
      }
      case "frontend_unloaded": {
        if (record.state === "starting") {
          const message = "Frontend extension unloaded before the process became ready";
          this.clearFrontendProcessTimers(record);
          this.finalizeFrontendProcess(record, "failed", "frontend_unloaded", message);
          this.rejectRequest(processId, new Error(message));
          return;
        }
        this.finalizeFrontendProcess(record, "stopped", "frontend_unloaded", error);
        break;
      }
    }
  }

  handleFrontendProcessMessage(processId: string, userId: string, payload: unknown): void {
    const record = this.getFrontendProcessForUser(processId, userId);
    if (!record) return;
    this.postToWorker({ type: "frontend_process_message", processId, payload, userId });
  }

  /**
   * Notify the worker that a permission was granted or revoked at runtime.
   * The worker updates its internal cache and fires onChanged handlers —
   * no restart needed.
   */
  notifyPermissionChanged(permission: string, granted: boolean, allGranted: string[]): void {
    this.postToWorker({ type: "permission_changed", permission, granted, allGranted });
  }

  /**
   * Invoke an extension-registered tool and wait for the result.
   * Used by council execution to route tool calls to the owning extension.
   *
   * `councilMember` — when provided by the council execution path — is a
   * trusted, host-built snapshot of the assigned member's identity and
   * personality fields. It is delivered alongside the invocation args so the
   * extension handler can personalise its tool output. The context is sourced
   * entirely server-side and kept on a separate top-level field so user-space
   * `args` cannot collide with or spoof it.
   *
   * `contextMessages` — when provided — are the structured chat messages that
   * were also flattened into `args.context` for backwards compatibility.
   * Forwarded on its own top-level field (same rationale as `councilMember`:
   * host-provided truth that must not collide with user-space `args`).
   * Multipart content is flattened to its text portion via `getTextContent`.
   */
  invokeExtensionTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000,
    councilMember?: CouncilMemberContext,
    contextMessages?: LlmMessage[]
  ): Promise<string> {
    const requestId = crypto.randomUUID();

    // Defensive strip: never forward authentication-style metadata to the
    // worker. Even if a caller leaks `__userId` or similar in args, the
    // extension handler must not see it — extensions identify themselves via
    // their worker context, not a string parameter they could exfiltrate.
    const sanitizedArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (key === "__userId" || key === "__user_id" || key === "userId") continue;
      sanitizedArgs[key] = value;
    }

    const contextMessagesDTO: LlmMessageDTO[] | undefined = contextMessages?.map(
      (m) => ({
        role: m.role,
        content: getTextContent(m),
        ...(m.name ? { name: m.name } : {}),
      })
    );

    this.postToWorker({
      type: "tool_invocation",
      requestId,
      toolName,
      args: sanitizedArgs,
      ...(councilMember ? { councilMember } : {}),
      ...(contextMessagesDTO ? { contextMessages: contextMessagesDTO } : {}),
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Tool invocation '${toolName}' timed out`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(String(value ?? ""));
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
    });
  }

  sendOAuthCallback(
    params: Record<string, string>
  ): Promise<{ html?: string; message?: string }> {
    const requestId = crypto.randomUUID();

    this.postToWorker({
      type: "oauth_callback",
      requestId,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error("OAuth callback handler timed out"));
      }, 30_000);

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as { html?: string; message?: string });
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
    });
  }

  private requestSharedRpcValue(
    endpoint: string,
    requesterExtensionId: string,
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();

    this.postToWorker({
      type: "rpc_pool_request",
      requestId,
      endpoint,
      requesterExtensionId,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Shared RPC endpoint "${endpoint}" timed out`));
      }, WorkerHost.SHARED_RPC_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      });
    });
  }

  private handleRpcPoolSync(endpoint: string, value: unknown): void {
    syncSharedRpcEndpoint(this.manifest.identifier, endpoint, value);
  }

  private handleRpcPoolRegisterHandler(endpoint: string): void {
    registerSharedRpcRequestEndpoint(
      this.manifest.identifier,
      endpoint,
      async (requesterExtensionId) => await this.requestSharedRpcValue(endpoint, requesterExtensionId),
    );
  }

  private handleRpcPoolUnregister(endpoint: string): void {
    unregisterSharedRpcEndpoint(this.manifest.identifier, endpoint);
  }

  private async handleRpcPoolRead(requestId: string, endpoint: string): Promise<void> {
    try {
      const result = await readSharedRpcEndpoint(endpoint, this.manifest.identifier);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
    }
  }

  private handleCreateOAuthState(requestId: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "oauth")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: "OAuth permission not granted",
      });
      return;
    }

    const state = createOAuthState(this.manifest.identifier);
    this.postToWorker({
      type: "response",
      requestId,
      result: state,
    });
  }

  private handleMessage(msg: RuntimeWorkerToHost): void {
    switch (msg.type) {
      case "subscribe_event":
        this.handleSubscribeEvent(msg.event);
        break;
      case "unsubscribe_event":
        this.handleUnsubscribeEvent(msg.event);
        break;
      case "register_macro":
        this.handleRegisterMacro(msg.definition);
        break;
      case "unregister_macro":
        this.handleUnregisterMacro(msg.name);
        break;
      case "update_macro_value":
        this.handleUpdateMacroValue(msg.name, msg.value);
        break;
      case "register_interceptor":
        this.handleRegisterInterceptor(msg.priority);
        break;
      case "intercept_result": {
        // Strip parameters if the extension lacks the generation_parameters permission
        let interceptParams = msg.parameters;
        if (interceptParams && Object.keys(interceptParams).length > 0) {
          if (!managerSvc.hasPermission(this.manifest.identifier, "generation_parameters")) {
            console.warn(
              `[Spindle:${this.manifest.identifier}] Stripping interceptor parameters — generation_parameters permission not granted`
            );
            interceptParams = undefined;
          }
        }
        const interceptBreakdown = Array.isArray(msg.breakdown)
          ? msg.breakdown
              .map((entry) => this.normalizeInterceptorBreakdownEntry(entry, msg.messages))
              .filter((entry): entry is NonNullable<typeof entry> => !!entry)
          : undefined;
        this.resolveRequest(msg.requestId, {
          messages: msg.messages,
          parameters: interceptParams,
          ...(interceptBreakdown && interceptBreakdown.length > 0 ? { breakdown: interceptBreakdown } : {}),
        });
        break;
      }
      case "register_tool":
        this.handleRegisterTool(msg.tool);
        break;
      case "unregister_tool":
        toolRegistry.unregister(msg.name, this.extensionId);
        break;
      case "request_generation":
        this.handleGeneration(msg.requestId, msg.input);
        break;
      case "request_generation_stream":
        this.handleGenerationStream(msg.requestId, msg.input);
        break;
      case "cancel_generation":
        this.handleCancelGeneration(msg.requestId);
        break;
      // ─── Dry Run (gated: "generation") ───────────────────────────────
      case "generate_dry_run":
        this.handleGenerateDryRun(msg.requestId, msg.input, msg.userId);
        break;
      case "storage_read":
        this.handleStorageRead(msg.requestId, msg.path);
        break;
      case "storage_write":
        this.handleStorageWrite(msg.requestId, msg.path, msg.data);
        break;
      case "storage_read_binary":
        this.handleStorageReadBinary(msg.requestId, msg.path);
        break;
      case "storage_write_binary":
        this.handleStorageWriteBinary(msg.requestId, msg.path, msg.data);
        break;
      case "storage_delete":
        this.handleStorageDelete(msg.requestId, msg.path);
        break;
      case "storage_list":
        this.handleStorageList(msg.requestId, msg.prefix);
        break;
      case "storage_exists":
        this.handleStorageExists(msg.requestId, msg.path);
        break;
      case "storage_mkdir":
        this.handleStorageMkdir(msg.requestId, msg.path);
        break;
      case "storage_move":
        this.handleStorageMove(msg.requestId, msg.from, msg.to);
        break;
      case "storage_stat":
        this.handleStorageStat(msg.requestId, msg.path);
        break;
      case "ephemeral_read":
        this.handleEphemeralRead(msg.requestId, msg.path);
        break;
      case "ephemeral_write":
        this.handleEphemeralWrite(
          msg.requestId,
          msg.path,
          msg.data,
          msg.ttlMs,
          msg.reservationId
        );
        break;
      case "ephemeral_read_binary":
        this.handleEphemeralReadBinary(msg.requestId, msg.path);
        break;
      case "ephemeral_write_binary":
        this.handleEphemeralWriteBinary(
          msg.requestId,
          msg.path,
          msg.data,
          msg.ttlMs,
          msg.reservationId
        );
        break;
      case "ephemeral_delete":
        this.handleEphemeralDelete(msg.requestId, msg.path);
        break;
      case "ephemeral_list":
        this.handleEphemeralList(msg.requestId, msg.prefix);
        break;
      case "ephemeral_stat":
        this.handleEphemeralStat(msg.requestId, msg.path);
        break;
      case "ephemeral_clear_expired":
        this.handleEphemeralClearExpired(msg.requestId);
        break;
      case "ephemeral_pool_status":
        this.handleEphemeralPoolStatus(msg.requestId);
        break;
      case "ephemeral_request_block":
        this.handleEphemeralRequestBlock(
          msg.requestId,
          msg.sizeBytes,
          msg.ttlMs,
          msg.reason
        );
        break;
      case "ephemeral_release_block":
        this.handleEphemeralReleaseBlock(msg.requestId, msg.reservationId);
        break;
      case "permissions_get_granted":
        this.handlePermissionsGetGranted(msg.requestId);
        break;
      case "rpc_pool_sync":
        this.handleRpcPoolSync(msg.endpoint, msg.value);
        break;
      case "rpc_pool_register_handler":
        this.handleRpcPoolRegisterHandler(msg.endpoint);
        break;
      case "rpc_pool_unregister":
        this.handleRpcPoolUnregister(msg.endpoint);
        break;
      case "rpc_pool_read":
        void this.handleRpcPoolRead(msg.requestId, msg.endpoint);
        break;
      case "rpc_pool_handler_result":
        if (msg.error) {
          this.rejectRequest(msg.requestId, new Error(msg.error));
        } else {
          this.resolveRequest(msg.requestId, msg.result);
        }
        break;
      case "connections_list":
        this.handleConnectionsList(msg.requestId, msg.userId);
        break;
      case "connections_get":
        this.handleConnectionsGet(msg.requestId, msg.connectionId, msg.userId);
        break;
      case "chat_get_messages":
        this.handleChatGetMessages(msg.requestId, msg.chatId);
        break;
      case "chat_append_message":
        this.handleChatAppendMessage(msg.requestId, msg.chatId, msg.message);
        break;
      case "chat_update_message":
        this.handleChatUpdateMessage(
          msg.requestId,
          msg.chatId,
          msg.messageId,
          msg.patch
        );
        break;
      case "chat_delete_message":
        this.handleChatDeleteMessage(msg.requestId, msg.chatId, msg.messageId);
        break;
      case "chat_set_message_hidden":
        this.handleChatSetMessageHidden(msg.requestId, msg.chatId, msg.messageId, msg.hidden);
        break;
      case "chat_set_messages_hidden":
        this.handleChatSetMessagesHidden(msg.requestId, msg.chatId, msg.messageIds, msg.hidden);
        break;
      case "chat_is_message_hidden":
        this.handleChatIsMessageHidden(msg.requestId, msg.chatId, msg.messageId);
        break;
      case "events_track":
        this.handleEventsTrack(msg.requestId, msg.eventName, msg.payload, msg.options);
        break;
      case "events_query":
        this.handleEventsQuery(msg.requestId, msg.filter);
        break;
      case "events_replay":
        this.handleEventsQuery(msg.requestId, msg.filter);
        break;
      case "events_get_latest_state":
        this.handleEventsGetLatestState(msg.requestId, msg.keys);
        break;
      case "cors_request":
        this.handleCorsRequest(msg.requestId, msg.url, msg.options);
        break;
      case "register_context_handler":
        this.handleRegisterContextHandler(msg.priority);
        break;
      case "context_handler_result":
        this.resolveRequest(msg.requestId, msg.context);
        break;
      case "register_message_content_processor":
        this.handleRegisterMessageContentProcessor(msg.priority);
        break;
      case "message_content_processor_result":
        this.resolveRequest(msg.requestId, msg.result);
        break;
      case "register_macro_interceptor":
        this.handleRegisterMacroInterceptor(msg.priority);
        break;
      case "macro_interceptor_result":
        this.resolveRequest(msg.requestId, msg.result);
        break;
      case "register_world_info_interceptor":
        this.handleRegisterWorldInfoInterceptor(msg.priority);
        break;
      case "world_info_interceptor_result":
        this.resolveRequest(msg.requestId, msg.result);
        break;
      case "tool_invocation_result":
        if (msg.error) {
          this.rejectRequest(msg.requestId, new Error(msg.error));
        } else {
          this.resolveRequest(msg.requestId, msg.result ?? "");
        }
        break;
      case "macro_result":
        if (msg.error) {
          this.rejectRequest(msg.requestId, new Error(msg.error));
        } else {
          this.resolveRequest(msg.requestId, msg.result ?? "");
        }
        break;
      case "user_storage_read":
        this.handleUserStorageRead(msg.requestId, msg.path, msg.userId);
        break;
      case "user_storage_write":
        this.handleUserStorageWrite(msg.requestId, msg.path, msg.data, msg.userId);
        break;
      case "user_storage_read_binary":
        this.handleUserStorageReadBinary(msg.requestId, msg.path, msg.userId);
        break;
      case "user_storage_write_binary":
        this.handleUserStorageWriteBinary(msg.requestId, msg.path, msg.data, msg.userId);
        break;
      case "user_storage_delete":
        this.handleUserStorageDelete(msg.requestId, msg.path, msg.userId);
        break;
      case "user_storage_list":
        this.handleUserStorageList(msg.requestId, msg.prefix, msg.userId);
        break;
      case "user_storage_exists":
        this.handleUserStorageExists(msg.requestId, msg.path, msg.userId);
        break;
      case "user_storage_mkdir":
        this.handleUserStorageMkdir(msg.requestId, msg.path, msg.userId);
        break;
      case "user_storage_move":
        this.handleUserStorageMove(msg.requestId, msg.from, msg.to, msg.userId);
        break;
      case "user_storage_stat":
        this.handleUserStorageStat(msg.requestId, msg.path, msg.userId);
        break;
      case "enclave_put":
        this.handleEnclavePut(msg.requestId, msg.key, msg.value, msg.userId);
        break;
      case "enclave_get":
        this.handleEnclaveGet(msg.requestId, msg.key, msg.userId);
        break;
      case "enclave_delete":
        this.handleEnclaveDelete(msg.requestId, msg.key, msg.userId);
        break;
      case "enclave_has":
        this.handleEnclaveHas(msg.requestId, msg.key, msg.userId);
        break;
      case "enclave_list":
        this.handleEnclaveList(msg.requestId, msg.userId);
        break;
      case "frontend_message": {
        // User-scoped extensions can only ever target their installer; the
        // worker-supplied userId is ignored to prevent cross-user delivery.
        // Operator-scoped extensions may pass an explicit userId to route the
        // message to a single connected user — when omitted we fall back to
        // the legacy broadcast behaviour for backwards compatibility.
        const targetUserId =
          this.installScope === "user"
            ? this.installedByUserId ?? undefined
            : typeof msg.userId === "string" && msg.userId.length > 0
              ? msg.userId
              : undefined;
        eventBus.emit(
          EventType.SPINDLE_FRONTEND_MSG,
          {
            extensionId: this.extensionId,
            identifier: this.manifest.identifier,
            data: msg.payload,
          },
          targetUserId
        );
        break;
      }
      case "oauth_callback_result":
        if (msg.error) {
          this.rejectRequest(msg.requestId, new Error(msg.error));
        } else {
          this.resolveRequest(msg.requestId, { html: msg.html });
        }
        break;
      case "create_oauth_state":
        this.handleCreateOAuthState(msg.requestId);
        break;
      // ─── Variables (free tier) ────────────────────────────────────────
      case "vars_get_local":
        this.handleVarsGetLocal(msg.requestId, msg.chatId, msg.key);
        break;
      case "vars_set_local":
        this.handleVarsSetLocal(msg.requestId, msg.chatId, msg.key, msg.value);
        break;
      case "vars_delete_local":
        this.handleVarsDeleteLocal(msg.requestId, msg.chatId, msg.key);
        break;
      case "vars_list_local":
        this.handleVarsListLocal(msg.requestId, msg.chatId);
        break;
      case "vars_has_local":
        this.handleVarsHasLocal(msg.requestId, msg.chatId, msg.key);
        break;
      case "vars_get_global":
        this.handleVarsGetGlobal(msg.requestId, msg.key, msg.userId);
        break;
      case "vars_set_global":
        this.handleVarsSetGlobal(msg.requestId, msg.key, msg.value, msg.userId);
        break;
      case "vars_delete_global":
        this.handleVarsDeleteGlobal(msg.requestId, msg.key, msg.userId);
        break;
      case "vars_list_global":
        this.handleVarsListGlobal(msg.requestId, msg.userId);
        break;
      case "vars_has_global":
        this.handleVarsHasGlobal(msg.requestId, msg.key, msg.userId);
        break;
      case "vars_get_chat":
        this.handleVarsGetChat(msg.requestId, msg.chatId, msg.key);
        break;
      case "vars_set_chat":
        this.handleVarsSetChat(msg.requestId, msg.chatId, msg.key, msg.value);
        break;
      case "vars_delete_chat":
        this.handleVarsDeleteChat(msg.requestId, msg.chatId, msg.key);
        break;
      case "vars_list_chat":
        this.handleVarsListChat(msg.requestId, msg.chatId);
        break;
      case "vars_has_chat":
        this.handleVarsHasChat(msg.requestId, msg.chatId, msg.key);
        break;
      // ─── Characters (gated: "characters") ─────────────────────────────
      case "characters_list":
        this.handleCharactersList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "characters_get":
        this.handleCharactersGet(msg.requestId, msg.characterId, msg.userId);
        break;
      case "characters_create":
        this.handleCharactersCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "characters_set_avatar":
        this.handleCharactersSetAvatar(msg.requestId, msg.characterId, msg.avatar, msg.userId);
        break;
      case "characters_update":
        this.handleCharactersUpdate(msg.requestId, msg.characterId, msg.input, msg.userId);
        break;
      case "characters_delete":
        this.handleCharactersDelete(msg.requestId, msg.characterId, msg.userId);
        break;
      // ─── Chats (gated: "chats") ───────────────────────────────────────
      case "chats_list":
        this.handleChatsList(msg.requestId, msg.characterId, msg.limit, msg.offset, msg.userId);
        break;
      case "chats_get":
        this.handleChatsGet(msg.requestId, msg.chatId, msg.userId);
        break;
      case "chats_get_active":
        this.handleChatsGetActive(msg.requestId, msg.userId);
        break;
      case "chats_update":
        this.handleChatsUpdate(msg.requestId, msg.chatId, msg.input, msg.userId);
        break;
      case "chats_delete":
        this.handleChatsDelete(msg.requestId, msg.chatId, msg.userId);
        break;
      // ─── Chat Memories (gated: "chats") ──────────────────────────────
      case "chats_get_memories":
        this.handleChatsGetMemories(msg.requestId, msg.chatId, msg.topK, msg.userId);
        break;
      // ─── World Books (gated: "world_books") ──────────────────────────
      case "world_books_list":
        this.handleWorldBooksList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "world_books_get":
        this.handleWorldBooksGet(msg.requestId, msg.worldBookId, msg.userId);
        break;
      case "world_books_create":
        this.handleWorldBooksCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "world_books_update":
        this.handleWorldBooksUpdate(msg.requestId, msg.worldBookId, msg.input, msg.userId);
        break;
      case "world_books_delete":
        this.handleWorldBooksDelete(msg.requestId, msg.worldBookId, msg.userId);
        break;
      // ─── World Book Entries (gated: "world_books") ────────────────────
      case "world_book_entries_list":
        this.handleWorldBookEntriesList(msg.requestId, msg.worldBookId, msg.limit, msg.offset, msg.userId);
        break;
      case "world_book_entries_get":
        this.handleWorldBookEntriesGet(msg.requestId, msg.entryId, msg.userId);
        break;
      case "world_book_entries_create":
        this.handleWorldBookEntriesCreate(msg.requestId, msg.worldBookId, msg.input, msg.userId);
        break;
      case "world_book_entries_update":
        this.handleWorldBookEntriesUpdate(msg.requestId, msg.entryId, msg.input, msg.userId);
        break;
      case "world_book_entries_delete":
        this.handleWorldBookEntriesDelete(msg.requestId, msg.entryId, msg.userId);
        break;
      // ─── Activated World Info (gated: "world_books") ─────────────────
      case "world_books_get_activated":
        this.handleWorldBooksGetActivated(msg.requestId, msg.chatId, msg.userId);
        break;
      // ─── Regex Scripts (gated: "regex_scripts") ──────────────────────
      case "regex_scripts_list":
        this.handleRegexScriptsList(
          msg.requestId,
          msg.scope,
          msg.scopeId,
          msg.target,
          msg.limit,
          msg.offset,
          msg.userId,
        );
        break;
      case "regex_scripts_get":
        this.handleRegexScriptsGet(msg.requestId, msg.scriptId, msg.userId);
        break;
      case "regex_scripts_get_active":
        this.handleRegexScriptsGetActive(
          msg.requestId,
          msg.target,
          msg.characterId,
          msg.chatId,
          msg.userId,
        );
        break;
      case "regex_scripts_create":
        this.handleRegexScriptsCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "regex_scripts_update":
        this.handleRegexScriptsUpdate(msg.requestId, msg.scriptId, msg.input, msg.userId);
        break;
      case "regex_scripts_delete":
        this.handleRegexScriptsDelete(msg.requestId, msg.scriptId, msg.userId);
        break;
      // ─── Databanks (gated: "databanks") ─────────────────────────────
      case "databanks_list":
        this.handleDatabanksList(msg.requestId, msg.limit, msg.offset, msg.scope, msg.scopeId, msg.userId);
        break;
      case "databanks_get":
        this.handleDatabanksGet(msg.requestId, msg.databankId, msg.userId);
        break;
      case "databanks_create":
        this.handleDatabanksCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "databanks_update":
        this.handleDatabanksUpdate(msg.requestId, msg.databankId, msg.input, msg.userId);
        break;
      case "databanks_delete":
        this.handleDatabanksDelete(msg.requestId, msg.databankId, msg.userId);
        break;
      // ─── Databank Documents (gated: "databanks") ───────────────────
      case "databank_documents_list":
        this.handleDatabankDocumentsList(msg.requestId, msg.databankId, msg.limit, msg.offset, msg.userId);
        break;
      case "databank_documents_get":
        this.handleDatabankDocumentsGet(msg.requestId, msg.documentId, msg.userId);
        break;
      case "databank_documents_create":
        this.handleDatabankDocumentsCreate(msg.requestId, msg.databankId, msg.input, msg.userId);
        break;
      case "databank_documents_update":
        this.handleDatabankDocumentsUpdate(msg.requestId, msg.documentId, msg.input, msg.userId);
        break;
      case "databank_documents_delete":
        this.handleDatabankDocumentsDelete(msg.requestId, msg.documentId, msg.userId);
        break;
      case "databank_documents_get_content":
        this.handleDatabankDocumentsGetContent(msg.requestId, msg.documentId, msg.userId);
        break;
      case "databank_documents_reprocess":
        this.handleDatabankDocumentsReprocess(msg.requestId, msg.documentId, msg.userId);
        break;
      // ─── Images (gated: "images") ──────────────────────────────────────
      case "images_list":
        this.handleImagesList(
          msg.requestId,
          msg.limit,
          msg.offset,
          msg.specificity,
          msg.onlyOwned,
          msg.characterId,
          msg.chatId,
          msg.userId,
        );
        break;
      case "images_get":
        this.handleImagesGet(
          msg.requestId,
          msg.imageId,
          msg.specificity,
          msg.onlyOwned,
          msg.characterId,
          msg.chatId,
          msg.userId,
        );
        break;
      case "images_upload":
        this.handleImagesUpload(msg.requestId, msg.input, msg.userId);
        break;
      case "images_upload_from_data_url":
        this.handleImagesUploadFromDataUrl(
          msg.requestId,
          msg.dataUrl,
          msg.originalFilename,
          msg.owner_character_id,
          msg.owner_chat_id,
          msg.userId,
        );
        break;
      case "images_delete":
        this.handleImagesDelete(msg.requestId, msg.imageId, msg.userId);
        break;
      // ─── Personas (gated: "personas") ──────────────────────────────────
      case "personas_list":
        this.handlePersonasList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "personas_get":
        this.handlePersonasGet(msg.requestId, msg.personaId, msg.userId);
        break;
      case "personas_get_default":
        this.handlePersonasGetDefault(msg.requestId, msg.userId);
        break;
      case "personas_get_active":
        this.handlePersonasGetActive(msg.requestId, msg.userId);
        break;
      case "personas_create":
        this.handlePersonasCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "personas_update":
        this.handlePersonasUpdate(msg.requestId, msg.personaId, msg.input, msg.userId);
        break;
      case "personas_delete":
        this.handlePersonasDelete(msg.requestId, msg.personaId, msg.userId);
        break;
      case "personas_switch":
        this.handlePersonasSwitch(msg.requestId, msg.personaId, msg.userId);
        break;
      case "personas_get_world_book":
        this.handlePersonasGetWorldBook(msg.requestId, msg.personaId, msg.userId);
        break;
      // ─── Council (free tier, read-only) ─────────────────────────────
      case "council_get_settings":
        this.handleCouncilGetSettings(msg.requestId, msg.userId);
        break;
      case "council_get_members":
        this.handleCouncilGetMembers(msg.requestId, msg.userId);
        break;
      case "council_get_available_lumia_items":
        this.handleCouncilGetAvailableLumiaItems(msg.requestId, msg.userId);
        break;
      // ─── Toast (free tier) ────────────────────────────────────────────
      case "toast_show":
        this.handleToastShow(
          msg.toastType,
          msg.message,
          msg.title,
          msg.duration,
          "userId" in msg ? msg.userId : undefined,
        );
        break;
      case "log":
        this.handleLog(msg.level, msg.message);
        break;
      // ─── Commands (free tier) ─────────────────────────────────────────
      case "commands_register":
        this.handleCommandsRegister(msg.commands);
        break;
      case "commands_unregister":
        this.handleCommandsUnregister(msg.commandIds);
        break;
      // ─── Version (free tier) ─────────────────────────────────────────
      case "version_get_backend":
        this.handleVersionGetBackend(msg.requestId);
        break;
      case "version_get_frontend":
        this.handleVersionGetFrontend(msg.requestId);
        break;
      // ─── Token Counting (free tier) ───────────────────────────────────
      case "tokens_count_text":
        this.handleTokensCountText(msg.requestId, msg.text, msg.model, msg.modelSource, msg.userId);
        break;
      case "tokens_count_messages":
        this.handleTokensCountMessages(msg.requestId, msg.messages, msg.model, msg.modelSource, msg.userId);
        break;
      case "tokens_count_chat":
        this.handleTokensCountChat(msg.requestId, msg.chatId, msg.model, msg.modelSource, msg.userId);
        break;
      // ─── Push Notifications (gated: "push_notification") ──────────────
      case "push_send":
        this.handlePushSend(msg.requestId, msg.title, msg.body, msg.tag, msg.url, msg.userId, msg.icon, msg.rawTitle, msg.image);
        break;
      case "push_get_status":
        this.handlePushGetStatus(msg.requestId, msg.userId);
        break;
      // ─── User Visibility (free tier — no permission needed) ─────────────
      case "user_is_visible":
        this.handleUserIsVisible(msg.requestId, msg.userId);
        break;
      // ─── Text Editor (free tier — no permission needed) ─────────────────
      case "text_editor_open":
        this.handleTextEditorOpen(msg.requestId, msg.title, msg.value, msg.placeholder, msg.userId);
        break;
      // ─── Modal (free tier — no permission needed) ─────────────────────
      case "modal_open":
        this.handleModalOpen(msg.requestId, msg.title, msg.items, msg.width, msg.maxHeight, msg.persistent, msg.userId, (msg as any).modalRequestId);
        break;
      case "modal_close":
        this.handleModalClose(msg.requestId, msg.openRequestId, msg.userId);
        break;
      case "confirm_open":
        this.handleConfirmOpen(msg.requestId, msg.title, msg.message, msg.variant, msg.confirmLabel, msg.cancelLabel, msg.userId);
        break;
      case "input_prompt_open":
        this.handleInputPromptOpen(msg.requestId, msg.title, msg.message, msg.placeholder, msg.defaultValue, msg.submitLabel, msg.cancelLabel, msg.multiline, msg.userId);
        break;
      // ─── Frontend Process Lifecycle (free tier) ───────────────────────
      case "frontend_process_spawn":
        this.handleFrontendProcessSpawn(msg.requestId, msg.options);
        break;
      case "frontend_process_list":
        this.handleFrontendProcessList(msg.requestId, msg.filter);
        break;
      case "frontend_process_get":
        this.handleFrontendProcessGet(msg.requestId, msg.processId);
        break;
      case "frontend_process_stop":
        this.handleFrontendProcessStop(msg.requestId, msg.processId, msg.options);
        break;
      case "frontend_process_send":
        this.handleFrontendProcessSend(msg.processId, msg.payload, msg.userId);
        break;
      case "backend_process_spawn":
        void this.handleBackendProcessSpawn(msg.requestId, msg.options);
        break;
      case "backend_process_list":
        this.handleBackendProcessList(msg.requestId, msg.filter);
        break;
      case "backend_process_get":
        this.handleBackendProcessGet(msg.requestId, msg.processId);
        break;
      case "backend_process_stop":
        this.handleBackendProcessStop(msg.requestId, msg.processId, msg.options);
        break;
      case "backend_process_send":
        this.handleBackendProcessSend(msg.processId, msg.payload, msg.userId);
        break;
      // ─── Macro Resolution (free tier — no permission needed) ────────────
      case "macros_resolve":
        this.handleMacrosResolve(
          msg.requestId,
          msg.template,
          msg.chatId,
          msg.characterId,
          msg.userId,
          (msg as any).commit !== false,
        );
        break;
      // ─── Image Generation (gated: "image_gen") ─────────────────────────
      case "image_gen_generate":
        this.handleImageGenGenerate(msg.requestId, msg.input);
        break;
      case "image_gen_providers":
        this.handleImageGenProviders(msg.requestId, msg.userId);
        break;
      case "image_gen_connections_list":
        this.handleImageGenConnectionsList(msg.requestId, msg.userId);
        break;
      case "image_gen_connections_get":
        this.handleImageGenConnectionsGet(msg.requestId, msg.connectionId, msg.userId);
        break;
      case "image_gen_models":
        this.handleImageGenModels(msg.requestId, msg.connectionId, msg.userId);
        break;
      // ─── Theme (gated: "app_manipulation") ──────────────────────────────
      case "theme_apply":
        this.handleThemeApply(msg.requestId, msg.overrides, msg.userId);
        break;
      case "theme_apply_palette":
        this.handleThemeApplyPalette((msg as any).requestId, (msg as any).palette, (msg as any).userId);
        break;
      case "theme_clear":
        this.handleThemeClear(msg.requestId, msg.userId);
        break;
      case "theme_get_current":
        this.handleThemeGetCurrent(msg.requestId, msg.userId);
        break;
      case "color_extract":
        this.handleColorExtract(msg.requestId, msg.imageId, msg.userId);
        break;
      case "theme_generate_variables":
        this.handleThemeGenerateVariables(msg.requestId, msg.config);
        break;
      default:
        // Fail fast for unrecognized message types so the worker's
        // await request(...) doesn't hang indefinitely.
        if ((msg as any).requestId) {
          this.postToWorker({
            type: "response",
            requestId: (msg as any).requestId,
            error: `Unrecognized message type: "${(msg as any).type}"`,
          });
        }
        break;
    }
  }

  // ─── Event subscription ──────────────────────────────────────────────

  /** Generation-related events that require the `generation` permission. */
  private static readonly GENERATION_EVENTS = new Set([
    EventType.GENERATION_STARTED,
    EventType.GENERATION_IN_PROGRESS,
    EventType.GENERATION_ENDED,
    EventType.GENERATION_STOPPED,
    EventType.STREAM_TOKEN_RECEIVED,
  ]);

  private handleSubscribeEvent(event: string): void {
    const eventType = (EventType as any)[event];
    if (!eventType) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Unknown event: ${event}`
      );
      return;
    }

    // Generation lifecycle/streaming events require the generation permission
    if (
      WorkerHost.GENERATION_EVENTS.has(eventType) &&
      !managerSvc.hasPermission(this.manifest.identifier, "generation")
    ) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Generation permission required for event: ${event}`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "generation",
        operation: `subscribe_event:${event}`,
      });
      return;
    }

    // Clean up any existing subscription for this event before adding a new one
    const existing = this.eventUnsubscribers.get(event);
    if (existing) {
      existing();
    }

    const scopedUserId = this.getScopedUserId();
    const unsub = eventBus.on(eventType, (msg) => {
      if (scopedUserId && msg.userId !== scopedUserId) {
        return;
      }
      this.postToWorker({
        type: "event",
        event,
        payload: msg.payload,
        userId: msg.userId,
      });
    });
    this.eventUnsubscribers.set(event, unsub);
  }

  private handleUnsubscribeEvent(event: string): void {
    const unsub = this.eventUnsubscribers.get(event);
    if (unsub) {
      unsub();
      this.eventUnsubscribers.delete(event);
    }
  }

  // ─── Macro registration ──────────────────────────────────────────────

  private handleRegisterMacro(definition: any): void {
    const macroName = String(definition.name || "").trim();
    if (!macroName) return;

    // Check if this would overwrite a built-in macro before registering
    const existing = macroRegistry.getMacro(macroName);
    if (existing?.builtIn) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Cannot override built-in macro: ${macroName}`
      );
      return;
    }

    this.registeredMacroNames.add(macroName);

    macroRegistry.registerMacro({
      name: macroName,
      category: definition.category || `extension:${this.manifest.identifier}`,
      description: definition.description || "",
      returnType: definition.returnType || "string",
      args: Array.isArray(definition.args)
        ? definition.args.map((arg: any) => ({
            name: String(arg.name || "arg"),
            description: arg.description ? String(arg.description) : undefined,
            optional: arg.required === false,
          }))
        : undefined,
      handler: async (ctx) => {
        // Bail immediately if the worker is not running — avoids a 5s timeout
        // that would stall prompt assembly for every extension macro.
        if (!this.runtime) {
          console.debug("[Spindle:%s] Macro '%s' skipped: worker not running", this.manifest.identifier, macroName);
          return "";
        }

        const chatId = ctx?.env?.chat?.id;
        const scopedUserId = this.getScopedUserId();
        if (scopedUserId && (typeof chatId !== "string" || !chatId)) {
          return "";
        }
        if (typeof chatId === "string" && chatId) {
          const ownerUserId = this.getChatOwnerId(chatId);
          this.enforceScopedUser(ownerUserId);
        }

        // Push model: if the extension has pushed a cached value via
        // updateMacroValue(), return it immediately — no RPC roundtrip.
        const cached = this.macroValueCache.get(macroName);
        if (cached !== undefined) return cached;

        // Pull model (legacy): RPC to the worker and await response
        const requestId = crypto.randomUUID();
        return await new Promise<string>((resolvePromise) => {
          // Set up a one-time listener for the response
          const timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            console.warn("[Spindle:%s] Macro '%s' timed out after 5s", this.manifest.identifier, macroName);
            resolvePromise(`[Spindle:${this.manifest.identifier}] Macro timeout`);
          }, 5000);

          this.pendingRequests.set(requestId, {
            resolve: (val) => {
              clearTimeout(timeout);
              resolvePromise(String(val ?? ""));
            },
            reject: (err) => {
              clearTimeout(timeout);
              console.warn("[Spindle:%s] Macro '%s' rejected: %s", this.manifest.identifier, macroName, err);
              resolvePromise("");
            },
          });

          // Sanitize env for structured cloning (strip non-serializable data).
          // Deep-clone extra defensively to avoid getters and non-clonable refs
          // from council/lumia context breaking the postMessage call.
          let safeExtra: Record<string, unknown> = {};
          try {
            safeExtra = JSON.parse(JSON.stringify(ctx.env.extra));
          } catch {
            // Non-serializable extra — pass an empty object rather than failing
            console.debug("[Spindle:%s] Macro '%s': env.extra not serializable, passing empty", this.manifest.identifier, macroName);
          }

          const safeEnv = {
            names: ctx.env.names,
            character: ctx.env.character,
            chat: ctx.env.chat,
            system: ctx.env.system,
            variables: {
              local: Object.fromEntries(ctx.env.variables.local),
              global: Object.fromEntries(ctx.env.variables.global),
              chat: Object.fromEntries(ctx.env.variables.chat),
            },
            dynamicMacros: Object.fromEntries(
              Object.entries(ctx.env.dynamicMacros).filter(
                ([, v]) => typeof v === "string"
              )
            ),
            extra: safeExtra,
          };

          try {
            this.postToWorker({
              type: "event",
              event: `__macro_invoke__`,
              payload: {
                requestId,
                name: macroName,
                context: {
                  name: ctx.name,
                  args: ctx.args,
                  flags: ctx.flags,
                  commit: ctx.commit !== false,
                  isScoped: ctx.isScoped,
                  body: ctx.body,
                  offset: ctx.offset,
                  globalOffset: ctx.globalOffset,
                  env: safeEnv,
                },
              },
            });
          } catch (err) {
            clearTimeout(timeout);
            this.pendingRequests.delete(requestId);
            console.warn("[Spindle:%s] Macro '%s' postToWorker failed: %s", this.manifest.identifier, macroName, err);
            // postMessage failure means the worker is dead — clean up to
            // prevent all subsequent extension macros from timing out (5s each).
            if (this.runtime) {
              console.warn("[Spindle:%s] Worker appears dead, cleaning up registrations", this.manifest.identifier);
              this.cleanup();
            }
            resolvePromise("");
          }
        });
      },
    });
  }

  private handleUnregisterMacro(name: string): void {
    const macroName = String(name || "").trim();
    if (!macroName) return;
    macroRegistry.unregisterMacro(macroName);
    this.registeredMacroNames.delete(macroName);
    this.macroValueCache.delete(macroName);
  }

  private handleUpdateMacroValue(name: string, value: string): void {
    const macroName = String(name || "").trim();
    if (!macroName) return;
    this.macroValueCache.set(macroName, String(value ?? ""));
  }

  // ─── Interceptor registration ────────────────────────────────────────

  private handleRegisterInterceptor(priority?: number): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "interceptor")) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Interceptor permission not granted`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "interceptor",
        operation: "registerInterceptor",
      });
      return;
    }

    const scopedUserId = this.getScopedUserId();
    // Resolve per-run so user-level spindleSettings changes (and any future
    // hot-reloaded manifest changes) propagate without requiring the
    // extension to tear down and re-register its interceptor.
    const resolveTimeoutMs = () =>
      resolveInterceptorTimeout(
        this.manifest.interceptorTimeoutMs,
        this.getScopedUserId(),
      );

    this.interceptorUnregister?.();
    this.interceptorUnregister = interceptorPipeline.register({
      extensionId: this.extensionId,
      extensionName: this.manifest.name || this.manifest.identifier,
      userId: scopedUserId,
      priority: priority ?? 100,
      resolveTimeoutMs,
      handler: async (messages, context) => {
        const requestId = crypto.randomUUID();
        const timeoutMs = resolveTimeoutMs();

        this.postToWorker({
          type: "intercept_request",
          requestId,
          messages,
          context,
        });

        return new Promise<InterceptorResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `Interceptor timeout from ${this.manifest.identifier} (${Math.round(timeoutMs / 1000)}s)`
              )
            );
          }, timeoutMs);

          this.pendingRequests.set(requestId, {
            resolve: (val) => {
              clearTimeout(timeout);
              resolve(val as InterceptorResult);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      },
    });
  }

  private normalizeInterceptorBreakdownEntry(
    entry: InterceptorBreakdownEntryDTO,
    messages: LlmMessageDTO[],
  ): NonNullable<InterceptorResult["breakdown"]>[number] | null {
    const messageIndex = Number(entry?.messageIndex);
    if (!Number.isInteger(messageIndex) || messageIndex < 0 || messageIndex >= messages.length) {
      return null;
    }
    const message = messages[messageIndex];
    const extensionName = String(this.manifest.name || this.manifest.identifier || this.extensionId).trim();
    const label = typeof entry?.name === "string" && entry.name.trim()
      ? entry.name.trim()
      : extensionName;
    return {
      messageIndex,
      name: label,
      role: message.role,
      content: message.content,
      extensionId: this.manifest.identifier,
      extensionName,
    };
  }

  // ─── Tool registration ───────────────────────────────────────────────

  private handleRegisterTool(toolDTO: any): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "tools")) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Tools permission not granted`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "tools",
        operation: "registerTool",
      });
      return;
    }

    const tool: ToolRegistration = {
      ...toolDTO,
      extension_id: this.extensionId,
    };
    toolRegistry.register(tool);
  }

  // ─── Generation ──────────────────────────────────────────────────────

  private async handleGeneration(
    requestId: string,
    input: any
  ): Promise<void> {
    if (!managerSvc.hasPermission(this.manifest.identifier, "generation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(input.userId);
    if (!resolvedUserId) {
      this.postToWorker({
        type: "response",
        requestId,
        error: "userId is required for operator-scoped extensions",
      });
      return;
    }
    this.enforceScopedUser(resolvedUserId);

    // Register an AbortController so the worker can cancel via
    // `cancel_generation` if the extension aborts its AbortSignal.
    const abortController = new AbortController();
    this.generationAbortControllers.set(requestId, abortController);

    try {
      let result: unknown;
      switch (input.type) {
        case "raw":
          result = await generateSvc.rawGenerate(resolvedUserId, {
            provider: input.provider || "",
            model: input.model || "",
            messages: input.messages || [],
            parameters: input.parameters,
            connection_id: input.connection_id,
            tools: input.tools,
            signal: abortController.signal,
          });
          break;
        case "quiet":
          result = await generateSvc.quietGenerate(resolvedUserId, {
            messages: input.messages || [],
            connection_id: input.connection_id,
            parameters: input.parameters,
            tools: input.tools,
            signal: abortController.signal,
          });
          break;
        case "batch":
          result = await generateSvc.batchGenerate(resolvedUserId, {
            requests: input.requests || [],
            concurrent: input.concurrent,
            signal: abortController.signal,
          });
          break;
        default:
          throw new Error(`Unknown generation type: ${input.type}`);
      }
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      // Surface aborts with a stable error name so the worker can synthesise
      // a real DOMException AbortError on the extension side.
      const aborted = abortController.signal.aborted || err?.name === "AbortError";
      this.postToWorker({
        type: "response",
        requestId,
        error: aborted ? "AbortError: Generation aborted" : err?.message ?? String(err),
      });
    } finally {
      this.generationAbortControllers.delete(requestId);
    }
  }

  private handleCancelGeneration(requestId: string): void {
    const controller = this.generationAbortControllers.get(requestId);
    if (!controller) return;
    controller.abort();
    // The map entry is cleared in handleGeneration / handleGenerationStream's
    // finally block once the awaited service call rejects.
  }

  /**
   * Streaming counterpart to {@link handleGeneration}. Forwards each chunk
   * from the upstream provider to the worker as a `generation_stream_chunk`
   * message, then emits a terminal `done` chunk built from the accumulator.
   * On abort/error, sends `generation_stream_error` instead.
   *
   * Only `raw` and `quiet` types are supported here — `batch` is a
   * convenience wrapper and intentionally not exposed for streaming.
   */
  private async handleGenerationStream(
    requestId: string,
    input: any
  ): Promise<void> {
    if (!managerSvc.hasPermission(this.manifest.identifier, "generation")) {
      this.postToWorker({
        type: "generation_stream_error",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(input.userId);
    if (!resolvedUserId) {
      this.postToWorker({
        type: "generation_stream_error",
        requestId,
        error: "userId is required for operator-scoped extensions",
      });
      return;
    }
    try {
      this.enforceScopedUser(resolvedUserId);
    } catch (err: any) {
      this.postToWorker({
        type: "generation_stream_error",
        requestId,
        error: err?.message ?? String(err),
      });
      return;
    }

    const abortController = new AbortController();
    this.generationAbortControllers.set(requestId, abortController);

    try {
      let stream: AsyncGenerator<import("../llm/types").StreamChunk, void, unknown>;
      switch (input.type) {
        case "raw":
          stream = await generateSvc.rawGenerateStream(resolvedUserId, {
            provider: input.provider || "",
            model: input.model || "",
            messages: input.messages || [],
            parameters: input.parameters,
            connection_id: input.connection_id,
            tools: input.tools,
            signal: abortController.signal,
          });
          break;
        case "quiet":
          stream = await generateSvc.quietGenerateStream(resolvedUserId, {
            messages: input.messages || [],
            connection_id: input.connection_id,
            parameters: input.parameters,
            tools: input.tools,
            signal: abortController.signal,
          });
          break;
        default:
          throw new Error(`Streaming is not supported for generation type: ${input.type}`);
      }

      let content = "";
      let reasoning = "";
      let finishReason = "stop";
      let toolCalls: import("../llm/types").ToolCallResult[] | undefined;
      let usage: import("../llm/types").GenerationResponse["usage"];

      for await (const chunk of stream) {
        if (abortController.signal.aborted) break;
        if (chunk.token) {
          content += chunk.token;
          this.postToWorker({
            type: "generation_stream_chunk",
            requestId,
            chunk: { type: "token", token: chunk.token },
          });
        }
        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
          this.postToWorker({
            type: "generation_stream_chunk",
            requestId,
            chunk: { type: "reasoning", token: chunk.reasoning },
          });
        }
        if (chunk.finish_reason) finishReason = chunk.finish_reason;
        if (chunk.tool_calls) toolCalls = chunk.tool_calls;
        if (chunk.usage) usage = chunk.usage;
      }

      if (abortController.signal.aborted) {
        this.postToWorker({
          type: "generation_stream_error",
          requestId,
          error: "AbortError: Generation aborted",
        });
        return;
      }

      this.postToWorker({
        type: "generation_stream_chunk",
        requestId,
        chunk: {
          type: "done",
          content,
          reasoning: reasoning || undefined,
          finish_reason: finishReason,
          tool_calls: toolCalls,
          usage,
        },
      });
    } catch (err: any) {
      const aborted = abortController.signal.aborted || err?.name === "AbortError";
      this.postToWorker({
        type: "generation_stream_error",
        requestId,
        error: aborted ? "AbortError: Generation aborted" : err?.message ?? String(err),
      });
    } finally {
      this.generationAbortControllers.delete(requestId);
    }
  }

  // ─── Image Generation (gated by "image_gen" permission) ────────────

  private async handleImageGenGenerate(requestId: string, input: any): Promise<void> {
    if (!managerSvc.hasPermission(this.manifest.identifier, "image_gen")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(input.userId);
    if (!resolvedUserId) {
      this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
      return;
    }
    this.enforceScopedUser(resolvedUserId);

    try {
      // Resolve connection
      const connectionId = input.connection_id || null;
      let connection = connectionId
        ? imageGenConnSvc.getConnection(resolvedUserId, connectionId)
        : imageGenConnSvc.getDefaultConnection(resolvedUserId);
      if (!connection) throw new Error(connectionId ? "Image gen connection not found" : "No default image gen connection configured");

      const provider = getImageProvider(connection.provider);
      if (!provider) throw new Error(`Unknown image gen provider: ${connection.provider}`);

      const { getSecret } = await import("../services/secrets.service");
      const apiKey = await getSecret(resolvedUserId, imageGenConnSvc.imageGenConnectionSecretKey(connection.id));
      if (!apiKey && provider.capabilities.apiKeyRequired) {
        throw new Error(`No API key for image gen connection "${connection.name}"`);
      }

      // Merge connection defaults with request parameters
      const mergedParams = { ...connection.default_parameters, ...(input.parameters || {}) };

      const response = await provider.generate(apiKey || "", connection.api_url || "", {
        prompt: input.prompt || "",
        negativePrompt: input.negativePrompt,
        model: input.model || connection.model,
        parameters: mergedParams,
      });

      // Persist image to the images table
      let imageId: string | undefined;
      let imageUrl: string | undefined;
      if (response.imageDataUrl) {
        try {
          const { saveImageFromDataUrl } = await import("../services/images.service");
          const image = await saveImageFromDataUrl(
            resolvedUserId,
            response.imageDataUrl,
            `image-gen-${connection.provider}-${Date.now()}.png`,
            {
              owner_extension_identifier: this.manifest.identifier,
              owner_character_id: typeof input?.owner_character_id === "string" && input.owner_character_id.trim()
                ? input.owner_character_id.trim()
                : undefined,
              owner_chat_id: typeof input?.owner_chat_id === "string" && input.owner_chat_id.trim()
                ? input.owner_chat_id.trim()
                : undefined,
            }
          );
          imageId = image.id;
          imageUrl = `/api/v1/image-gen/results/${image.id}`;
        } catch {
          // Persistence failure is non-fatal
        }
      }

      this.postToWorker({
        type: "response",
        requestId,
        result: { ...response, imageId, imageUrl },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleImageGenProviders(requestId: string, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "image_gen")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`,
      });
      return;
    }

    try {
      const providers = getImageProviderList().map((p) => ({
        id: p.name,
        name: p.displayName,
        capabilities: p.capabilities,
      }));
      this.postToWorker({ type: "response", requestId, result: providers });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleImageGenConnectionsList(requestId: string, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "image_gen")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) {
      this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
      return;
    }
    this.enforceScopedUser(resolvedUserId);

    try {
      const result = imageGenConnSvc.listConnections(resolvedUserId, { limit: 100, offset: 0 });
      this.postToWorker({ type: "response", requestId, result: result.data });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleImageGenConnectionsGet(requestId: string, connectionId: string, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "image_gen")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) {
      this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
      return;
    }
    this.enforceScopedUser(resolvedUserId);

    try {
      const conn = imageGenConnSvc.getConnection(resolvedUserId, connectionId);
      this.postToWorker({ type: "response", requestId, result: conn });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleImageGenModels(requestId: string, connectionId: string, userId?: string): Promise<void> {
    if (!managerSvc.hasPermission(this.manifest.identifier, "image_gen")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} image_gen — Image generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) {
      this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
      return;
    }
    this.enforceScopedUser(resolvedUserId);

    try {
      const result = await imageGenConnSvc.listConnectionModels(resolvedUserId, connectionId);
      if (result.error) throw new Error(result.error);
      this.postToWorker({ type: "response", requestId, result: result.models });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Connection Profiles (gated by "generation" permission) ─────────

  /**
   * Resolve the effective userId for per-user operations (connections,
   * generation, etc.).  User-scoped extensions always get their owner;
   * operator-scoped extensions must supply an explicit userId.
   */
  private resolveEffectiveUserId(requestUserId?: string): string {
    const scopedUserId = this.getScopedUserId();
    if (scopedUserId) {
      // User-scoped extension: always use the owner's userId
      return scopedUserId;
    }
    // Operator-scoped: use the provided userId
    return requestUserId || "";
  }

  private handleConnectionsList(requestId: string, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "generation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} generation — Connection profile access requires the generation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({
          type: "response",
          requestId,
          error: "userId is required for operator-scoped extensions",
        });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      const { data } = connectionsSvc.listConnections(resolvedUserId, { limit: 100, offset: 0 });
      const profiles: ConnectionProfileDTO[] = data.map((c) => ({
        id: c.id,
        name: c.name,
        provider: c.provider,
        api_url: c.api_url,
        model: c.model,
        preset_id: c.preset_id,
        is_default: c.is_default,
        has_api_key: c.has_api_key,
        metadata: c.metadata,
        created_at: c.created_at,
        updated_at: c.updated_at,
      }));
      this.postToWorker({ type: "response", requestId, result: profiles });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleConnectionsGet(
    requestId: string,
    connectionId: string,
    userId?: string
  ): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "generation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} generation — Connection profile access requires the generation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({
          type: "response",
          requestId,
          error: "userId is required for operator-scoped extensions",
        });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      const c = connectionsSvc.getConnection(resolvedUserId, connectionId);
      if (!c) {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }
      const profile: ConnectionProfileDTO = {
        id: c.id,
        name: c.name,
        provider: c.provider,
        api_url: c.api_url,
        model: c.model,
        preset_id: c.preset_id,
        is_default: c.is_default,
        has_api_key: c.has_api_key,
        metadata: c.metadata,
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
      this.postToWorker({ type: "response", requestId, result: profile });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Storage (scoped, path-traversal protected) ──────────────────────

  private resolveStoragePath(requestedPath: string): string {
    const base = resolve(this.getStorageRootPath(this.manifest.identifier));
    const resolved = resolve(base, requestedPath);

    // Path traversal protection
    if (!(resolved === base || resolved.startsWith(`${base}${sep}`))) {
      throw new Error("Path traversal detected");
    }

    return resolved;
  }

  private handleStorageRead(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const data = readFileSync(fullPath, "utf-8");
      this.postToWorker({ type: "response", requestId, result: data });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageWrite(
    requestId: string,
    path: string,
    data: string
  ): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      const dir = resolve(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, data, "utf-8");
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageReadBinary(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const data = readFileSync(fullPath);
      this.postToWorker({
        type: "response",
        requestId,
        result: new Uint8Array(data),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageWriteBinary(
    requestId: string,
    path: string,
    data: Uint8Array
  ): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      const dir = resolve(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, data);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageDelete(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (existsSync(fullPath)) unlinkSync(fullPath);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageList(requestId: string, prefix?: string): void {
    try {
      const base = this.getStorageRootPath(this.manifest.identifier);
      const searchDir = prefix ? this.resolveStoragePath(prefix) : base;

      if (!existsSync(searchDir)) {
        this.postToWorker({ type: "response", requestId, result: [] });
        return;
      }

      const entries = readdirSync(searchDir, { recursive: true });
      const files = entries
        .map((e) => (typeof e === "string" ? e : e.toString()))
        .filter((e) => {
          const full = join(searchDir, e);
          try {
            return Bun.file(full).size >= 0;
          } catch {
            return false;
          }
        });

      this.postToWorker({ type: "response", requestId, result: files });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageExists(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      this.postToWorker({ type: "response", requestId, result: existsSync(fullPath) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageMkdir(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      mkdirSync(fullPath, { recursive: true });
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageMove(requestId: string, from: string, to: string): void {
    try {
      const fromPath = this.resolveStoragePath(from);
      const toPath = this.resolveStoragePath(to);
      if (!existsSync(fromPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      mkdirSync(resolve(toPath, ".."), { recursive: true });
      renameSync(fromPath, toPath);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleStorageStat(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveStoragePath(path);
      if (!existsSync(fullPath)) {
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            exists: false,
            isFile: false,
            isDirectory: false,
            sizeBytes: 0,
            modifiedAt: new Date(0).toISOString(),
          },
        });
        return;
      }

      const stat = statSync(fullPath);
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          exists: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          sizeBytes: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── User-scoped storage (per-user isolated) ─────────────────────────

  private resolveUserScopedUserId(requestUserId?: string): string {
    const scopedUserId = this.getScopedUserId();
    if (scopedUserId) {
      // User-scoped extension: always use the owner's userId
      return scopedUserId;
    }
    // Operator-scoped: use the provided userId (required)
    if (!requestUserId) {
      throw new Error("userId is required for operator-scoped extensions");
    }
    return requestUserId;
  }

  private resolveUserStoragePath(requestedPath: string, userId: string): string {
    const base = resolve(getUserExtensionPath(userId, this.manifest.identifier));
    mkdirSync(base, { recursive: true });
    const resolved = resolve(base, requestedPath);

    // Path traversal protection
    if (!(resolved === base || resolved.startsWith(`${base}${sep}`))) {
      throw new Error("Path traversal detected");
    }

    return resolved;
  }

  private handleUserStorageRead(requestId: string, path: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const data = readFileSync(fullPath, "utf-8");
      this.postToWorker({ type: "response", requestId, result: data });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageWrite(requestId: string, path: string, data: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      const dir = resolve(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, data, "utf-8");
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageReadBinary(requestId: string, path: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const data = readFileSync(fullPath);
      this.postToWorker({
        type: "response",
        requestId,
        result: new Uint8Array(data),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageWriteBinary(
    requestId: string,
    path: string,
    data: Uint8Array,
    userId?: string
  ): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      const dir = resolve(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, data);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageDelete(requestId: string, path: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      if (existsSync(fullPath)) unlinkSync(fullPath);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageList(requestId: string, prefix?: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const base = resolve(getUserExtensionPath(resolvedUserId, this.manifest.identifier));
      mkdirSync(base, { recursive: true });
      const searchDir = prefix ? this.resolveUserStoragePath(prefix, resolvedUserId) : base;

      if (!existsSync(searchDir)) {
        this.postToWorker({ type: "response", requestId, result: [] });
        return;
      }

      const entries = readdirSync(searchDir, { recursive: true });
      const files = entries
        .map((e) => (typeof e === "string" ? e : e.toString()))
        .filter((e) => {
          const full = join(searchDir, e);
          try {
            return Bun.file(full).size >= 0;
          } catch {
            return false;
          }
        });

      this.postToWorker({ type: "response", requestId, result: files });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageExists(requestId: string, path: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: existsSync(fullPath) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageMkdir(requestId: string, path: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      mkdirSync(fullPath, { recursive: true });
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageMove(requestId: string, from: string, to: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fromPath = this.resolveUserStoragePath(from, resolvedUserId);
      const toPath = this.resolveUserStoragePath(to, resolvedUserId);
      if (!existsSync(fromPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      mkdirSync(resolve(toPath, ".."), { recursive: true });
      renameSync(fromPath, toPath);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleUserStorageStat(requestId: string, path: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const fullPath = this.resolveUserStoragePath(path, resolvedUserId);
      if (!existsSync(fullPath)) {
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            exists: false,
            isFile: false,
            isDirectory: false,
            sizeBytes: 0,
            modifiedAt: new Date(0).toISOString(),
          },
        });
        return;
      }

      const stat = statSync(fullPath);
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          exists: true,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
          sizeBytes: stat.size,
          modifiedAt: new Date(stat.mtimeMs).toISOString(),
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Secure enclave (encrypted secret storage) ─────────────────────

  private static readonly ENCLAVE_KEY_PATTERN = /^[a-zA-Z0-9_\-.]{1,128}$/;
  private static readonly ENCLAVE_MAX_VALUE_BYTES = 64 * 1024; // 64KB

  private validateEnclaveKey(key: string): void {
    if (!WorkerHost.ENCLAVE_KEY_PATTERN.test(key)) {
      throw new Error(
        "Invalid enclave key: must be 1-128 characters, alphanumeric/underscore/dash/dot only"
      );
    }
  }

  private validateEnclaveValue(value: string): void {
    if (typeof value !== "string") {
      throw new Error("Enclave value must be a string");
    }
    if (Buffer.byteLength(value, "utf-8") > WorkerHost.ENCLAVE_MAX_VALUE_BYTES) {
      throw new Error("Enclave value exceeds maximum size of 64KB");
    }
    // Only allow printable chars + whitespace (no binary/control chars)
    if (/[^\x20-\x7E\t\n\r]/.test(value)) {
      throw new Error("Enclave value contains invalid characters (binary/control chars not allowed)");
    }
  }

  private enclaveNamespacedKey(key: string): string {
    return `spindle:${this.manifest.identifier}:${key}`;
  }

  private async handleEnclavePut(requestId: string, key: string, value: string, userId?: string): Promise<void> {
    try {
      this.validateEnclaveKey(key);
      this.validateEnclaveValue(value);
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      await putSecret(resolvedUserId, this.enclaveNamespacedKey(key), value);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleEnclaveGet(requestId: string, key: string, userId?: string): Promise<void> {
    try {
      this.validateEnclaveKey(key);
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const value = await getSecret(resolvedUserId, this.enclaveNamespacedKey(key));
      this.postToWorker({ type: "response", requestId, result: value });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEnclaveDelete(requestId: string, key: string, userId?: string): void {
    try {
      this.validateEnclaveKey(key);
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const deleted = deleteSecret(resolvedUserId, this.enclaveNamespacedKey(key));
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleEnclaveHas(requestId: string, key: string, userId?: string): Promise<void> {
    try {
      this.validateEnclaveKey(key);
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const exists = await validateSecret(resolvedUserId, this.enclaveNamespacedKey(key));
      this.postToWorker({ type: "response", requestId, result: exists });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEnclaveList(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveUserScopedUserId(userId);
      const prefix = `spindle:${this.manifest.identifier}:`;
      const allKeys = listSecretKeys(resolvedUserId);
      const keys = allKeys
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
      this.postToWorker({ type: "response", requestId, result: keys });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Ephemeral storage ────────────────────────────────────────────────

  private getEphemeralBasePath(): string {
    if (!managerSvc.hasPermission(this.manifest.identifier, "ephemeral_storage")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} ephemeral_storage — Ephemeral storage permission not granted`);
    }
    const base = resolve(this.getStorageRootPath(this.manifest.identifier), ".ephemeral");
    mkdirSync(base, { recursive: true });
    return base;
  }

  private resolveEphemeralPath(requestedPath: string): string {
    const base = resolve(this.getEphemeralBasePath());
    const resolved = resolve(base, requestedPath);
    if (!(resolved === base || resolved.startsWith(`${base}${sep}`))) {
      throw new Error("Path traversal detected");
    }
    return resolved;
  }

  private getEphemeralIndexPath(): string {
    return join(this.getEphemeralBasePath(), ".index.json");
  }

  private getEphemeralReservationsPath(identifier: string = this.manifest.identifier): string {
    if (
      identifier === this.manifest.identifier &&
      !managerSvc.hasPermission(this.manifest.identifier, "ephemeral_storage")
    ) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} ephemeral_storage — Ephemeral storage permission not granted`);
    }
    const base = resolve(this.getStorageRootPath(identifier), ".ephemeral");
    mkdirSync(base, { recursive: true });
    return join(base, ".reservations.json");
  }

  private getEphemeralReservationsPathForStorage(storageRoot: string): string {
    const base = resolve(storageRoot, ".ephemeral");
    mkdirSync(base, { recursive: true });
    return join(base, ".reservations.json");
  }

  private readEphemeralReservations(
    identifier: string = this.manifest.identifier,
    storageRoot?: string
  ): Array<{
    id: string;
    sizeBytes: number;
    consumedBytes: number;
    createdAt: string;
    expiresAt: string;
    reason?: string;
  }> {
    const path = storageRoot
      ? this.getEphemeralReservationsPathForStorage(storageRoot)
      : this.getEphemeralReservationsPath(identifier);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((r) => {
        return (
          r &&
          typeof r.id === "string" &&
          typeof r.sizeBytes === "number" &&
          typeof r.consumedBytes === "number" &&
          typeof r.createdAt === "string" &&
          typeof r.expiresAt === "string"
        );
      });
    } catch {
      return [];
    }
  }

  private writeEphemeralReservations(
    reservations: Array<{
      id: string;
      sizeBytes: number;
      consumedBytes: number;
      createdAt: string;
      expiresAt: string;
      reason?: string;
    }>,
    identifier: string = this.manifest.identifier,
    storageRoot?: string
  ): void {
    const path = storageRoot
      ? this.getEphemeralReservationsPathForStorage(storageRoot)
      : this.getEphemeralReservationsPath(identifier);
    writeFileSync(path, JSON.stringify(reservations, null, 2), "utf-8");
  }

  private clearExpiredReservations(identifier: string = this.manifest.identifier): number {
    const now = Date.now();
    const existing = this.readEphemeralReservations(identifier);
    const kept = existing.filter((r) => {
      const expires = Date.parse(r.expiresAt);
      if (Number.isNaN(expires)) return false;
      return expires > now && r.consumedBytes < r.sizeBytes;
    });
    this.writeEphemeralReservations(kept, identifier);
    return existing.length - kept.length;
  }

  private async getExtensionEphemeralMaxBytes(identifier: string): Promise<number> {
    const cfg = await getEphemeralPoolConfig();
    return cfg.extensionMaxOverrides[identifier] ?? cfg.extensionDefaultMaxBytes;
  }

  private getEphemeralPathKey(fullPath: string): string {
    const base = this.getEphemeralBasePath();
    return relative(base, fullPath).replaceAll("\\", "/");
  }

  private readEphemeralIndex(): Record<string, { createdAt: string; expiresAt?: string; sizeBytes: number }> {
    const indexPath = this.getEphemeralIndexPath();
    if (!existsSync(indexPath)) return {};
    try {
      return JSON.parse(readFileSync(indexPath, "utf-8"));
    } catch {
      return {};
    }
  }

  private writeEphemeralIndex(index: Record<string, { createdAt: string; expiresAt?: string; sizeBytes: number }>): void {
    const indexPath = this.getEphemeralIndexPath();
    writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
  }

  private upsertEphemeralIndex(pathKey: string, sizeBytes: number, ttlMs?: number): void {
    const index = this.readEphemeralIndex();
    const nowIso = new Date().toISOString();
    const current = index[pathKey];
    index[pathKey] = {
      createdAt: current?.createdAt || nowIso,
      expiresAt: ttlMs && ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : undefined,
      sizeBytes,
    };
    this.writeEphemeralIndex(index);
  }

  private removeEphemeralIndex(pathKey: string): void {
    const index = this.readEphemeralIndex();
    delete index[pathKey];
    this.writeEphemeralIndex(index);
  }

  private collectEphemeralUsage(): {
    totalBytes: number;
    fileCount: number;
    filesByPath: Map<string, { sizeBytes: number }>;
    reservedBytes: number;
    reservations: Map<string, { sizeBytes: number; consumedBytes: number }>;
  } {
    const base = this.getEphemeralBasePath();
    const indexPath = this.getEphemeralIndexPath();
    const reservationsPath = this.getEphemeralReservationsPath();

    const filesByPath = new Map<string, { sizeBytes: number }>();
    if (existsSync(base)) {
      const entries = readdirSync(base, { recursive: true });
      for (const entry of entries) {
        const rel = typeof entry === "string" ? entry : entry.toString();
        const full = join(base, rel);
        if (full === indexPath || full === reservationsPath) continue;
        try {
          const stat = statSync(full);
          if (!stat.isFile()) continue;
          const pathKey = this.getEphemeralPathKey(full);
          filesByPath.set(pathKey, { sizeBytes: stat.size });
        } catch {
          // ignore unreadable entries
        }
      }
    }

    let totalBytes = 0;
    for (const file of filesByPath.values()) {
      totalBytes += file.sizeBytes;
    }

    const reservationsList = this.readEphemeralReservations();
    const reservations = new Map<string, { sizeBytes: number; consumedBytes: number }>();
    let reservedBytes = 0;
    for (const r of reservationsList) {
      const remaining = Math.max(0, r.sizeBytes - r.consumedBytes);
      if (remaining <= 0) continue;
      reservations.set(r.id, { sizeBytes: r.sizeBytes, consumedBytes: r.consumedBytes });
      reservedBytes += remaining;
    }

    return {
      totalBytes,
      fileCount: filesByPath.size,
      filesByPath,
      reservedBytes,
      reservations,
    };
  }

  private collectEphemeralUsageForExtension(extension: ExtensionInfo): {
    usedBytes: number;
    reservedBytes: number;
  } {
    const base = resolve(managerSvc.getStoragePathForExtension(extension), ".ephemeral");
    const indexPath = join(base, ".index.json");
    const reservationsPath = join(base, ".reservations.json");

    let usedBytes = 0;
    if (existsSync(base)) {
      const entries = readdirSync(base, { recursive: true });
      for (const entry of entries) {
        const rel = typeof entry === "string" ? entry : entry.toString();
        const full = join(base, rel);
        if (full === indexPath || full === reservationsPath) continue;
        try {
          const stat = statSync(full);
          if (!stat.isFile()) continue;
          usedBytes += stat.size;
        } catch {
          // ignore unreadable entries
        }
      }
    }

    const now = Date.now();
    const reservations = this.readEphemeralReservations(
      extension.identifier,
      managerSvc.getStoragePathForExtension(extension)
    );
    const reservedBytes = reservations.reduce((sum, r) => {
      const expires = Date.parse(r.expiresAt);
      if (Number.isNaN(expires) || expires <= now) return sum;
      return sum + Math.max(0, r.sizeBytes - r.consumedBytes);
    }, 0);

    return { usedBytes, reservedBytes };
  }

  private async getGlobalEphemeralPoolUsage(): Promise<{
    usedBytes: number;
    reservedBytes: number;
  }> {
    const extensions = await managerSvc.list();
    let usedBytes = 0;
    let reservedBytes = 0;

    for (const ext of extensions) {
      const usage = this.collectEphemeralUsageForExtension(ext);
      usedBytes += usage.usedBytes;
      reservedBytes += usage.reservedBytes;
    }

    return { usedBytes, reservedBytes };
  }

  private clearExpiredEphemeralEntriesInternal(): number {
    const now = Date.now();
    const base = this.getEphemeralBasePath();
    const index = this.readEphemeralIndex();
    let removed = 0;

    for (const [pathKey, meta] of Object.entries(index)) {
      if (!meta.expiresAt) continue;
      const expires = Date.parse(meta.expiresAt);
      if (!Number.isNaN(expires) && expires <= now) {
        const fullPath = resolve(base, pathKey);
        if (existsSync(fullPath)) unlinkSync(fullPath);
        delete index[pathKey];
        removed += 1;
      }
    }

    this.writeEphemeralIndex(index);
    return removed;
  }

  private async enforceEphemeralQuota(
    pathKey: string,
    incomingSizeBytes: number,
    reservationId?: string
  ): Promise<{ reservedConsumptionBytes: number }> {
    this.clearExpiredEphemeralEntriesInternal();
    this.clearExpiredReservations();

    const usage = this.collectEphemeralUsage();
    const global = await this.getGlobalEphemeralPoolUsage();
    const extensionMax = await this.getExtensionEphemeralMaxBytes(this.manifest.identifier);
    const globalMax = (await getEphemeralPoolConfig()).globalMaxBytes;

    const existingSize = usage.filesByPath.get(pathKey)?.sizeBytes || 0;
    const isNewFile = !usage.filesByPath.has(pathKey);
    const growthBytes = Math.max(0, incomingSizeBytes - existingSize);

    let reservedConsumptionBytes = 0;
    let reservationRemaining = 0;
    if (reservationId) {
      const reservation = usage.reservations.get(reservationId);
      if (!reservation) {
        throw new Error(`Reservation not found: ${reservationId}`);
      }
      reservationRemaining = Math.max(
        0,
        reservation.sizeBytes - reservation.consumedBytes
      );
      reservedConsumptionBytes = Math.min(reservationRemaining, growthBytes);
    }

    const extensionReservedAfter =
      usage.reservedBytes - reservedConsumptionBytes;
    const globalReservedAfter =
      global.reservedBytes - reservedConsumptionBytes;

    const nextTotal = usage.totalBytes - existingSize + incomingSizeBytes;
    const nextCount = usage.fileCount + (isNewFile ? 1 : 0);
    const nextGlobalUsed = global.usedBytes - existingSize + incomingSizeBytes;

    if (nextCount > EPHEMERAL_MAX_FILES) {
      throw new Error(
        `Ephemeral storage file quota exceeded (${nextCount}/${EPHEMERAL_MAX_FILES})`
      );
    }

    if (nextTotal + extensionReservedAfter > extensionMax) {
      throw new Error(
        `Ephemeral extension pool exceeded (${nextTotal + extensionReservedAfter}/${extensionMax} bytes)`
      );
    }

    if (nextGlobalUsed + globalReservedAfter > globalMax) {
      throw new Error(
        `Ephemeral global pool exceeded (${nextGlobalUsed + globalReservedAfter}/${globalMax} bytes)`
      );
    }

    return { reservedConsumptionBytes };
  }

  private consumeReservation(reservationId: string, consumeBytes: number): void {
    if (consumeBytes <= 0) return;
    const reservations = this.readEphemeralReservations();
    const updated = reservations
      .map((r) => {
        if (r.id !== reservationId) return r;
        const nextConsumed = Math.min(r.sizeBytes, r.consumedBytes + consumeBytes);
        return { ...r, consumedBytes: nextConsumed };
      })
      .filter((r) => r.consumedBytes < r.sizeBytes);
    this.writeEphemeralReservations(updated);
  }

  private handleEphemeralRead(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const data = readFileSync(fullPath, "utf-8");
      this.postToWorker({ type: "response", requestId, result: data });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleEphemeralWrite(
    requestId: string,
    path: string,
    data: string,
    ttlMs?: number,
    reservationId?: string
  ): Promise<void> {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      const pathKey = this.getEphemeralPathKey(fullPath);
      const sizeBytes = Buffer.byteLength(data, "utf-8");
      const quota = await this.enforceEphemeralQuota(pathKey, sizeBytes, reservationId);
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, data, "utf-8");
      this.upsertEphemeralIndex(pathKey, sizeBytes, ttlMs);
      if (reservationId) {
        this.consumeReservation(reservationId, quota.reservedConsumptionBytes);
      }
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEphemeralReadBinary(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const data = readFileSync(fullPath);
      this.postToWorker({
        type: "response",
        requestId,
        result: new Uint8Array(data),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleEphemeralWriteBinary(
    requestId: string,
    path: string,
    data: Uint8Array,
    ttlMs?: number,
    reservationId?: string
  ): Promise<void> {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      const pathKey = this.getEphemeralPathKey(fullPath);
      const quota = await this.enforceEphemeralQuota(
        pathKey,
        data.byteLength,
        reservationId
      );
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, data);
      this.upsertEphemeralIndex(pathKey, data.byteLength, ttlMs);
      if (reservationId) {
        this.consumeReservation(reservationId, quota.reservedConsumptionBytes);
      }
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEphemeralDelete(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      const pathKey = this.getEphemeralPathKey(fullPath);
      if (existsSync(fullPath)) unlinkSync(fullPath);
      this.removeEphemeralIndex(pathKey);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEphemeralList(requestId: string, prefix?: string): void {
    try {
      const base = this.getEphemeralBasePath();
      const searchDir = prefix ? this.resolveEphemeralPath(prefix) : base;
      if (!existsSync(searchDir)) {
        this.postToWorker({ type: "response", requestId, result: [] });
        return;
      }

      const entries = readdirSync(searchDir, { recursive: true });
      const files = entries
        .map((e) => (typeof e === "string" ? e : e.toString()))
        .filter((e) => e !== ".index.json")
        .filter((e) => e !== ".reservations.json")
        .filter((e) => {
          const full = join(searchDir, e);
          try {
            return Bun.file(full).size >= 0;
          } catch {
            return false;
          }
        });

      this.postToWorker({ type: "response", requestId, result: files });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEphemeralStat(requestId: string, path: string): void {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      if (!existsSync(fullPath)) {
        this.postToWorker({ type: "response", requestId, error: "File not found" });
        return;
      }
      const index = this.readEphemeralIndex();
      const stat = statSync(fullPath);
      const pathKey = this.getEphemeralPathKey(fullPath);
      const indexed = index[pathKey];
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          sizeBytes: indexed?.sizeBytes ?? stat.size,
          createdAt: indexed?.createdAt ?? new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
          expiresAt: indexed?.expiresAt,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEphemeralClearExpired(requestId: string): void {
    try {
      const removedFiles = this.clearExpiredEphemeralEntriesInternal();
      const removedReservations = this.clearExpiredReservations();
      this.postToWorker({
        type: "response",
        requestId,
        result: removedFiles + removedReservations,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleEphemeralPoolStatus(requestId: string): Promise<void> {
    try {
      this.clearExpiredEphemeralEntriesInternal();
      this.clearExpiredReservations();

      const extensionUsage = this.collectEphemeralUsage();
      const globalUsage = await this.getGlobalEphemeralPoolUsage();
      const extensionMax = await this.getExtensionEphemeralMaxBytes(this.manifest.identifier);
      const globalMax = (await getEphemeralPoolConfig()).globalMaxBytes;

      this.postToWorker({
        type: "response",
        requestId,
        result: {
          globalMaxBytes: globalMax,
          globalUsedBytes: globalUsage.usedBytes,
          globalReservedBytes: globalUsage.reservedBytes,
          globalAvailableBytes: Math.max(
            0,
            globalMax - globalUsage.usedBytes - globalUsage.reservedBytes
          ),
          extensionMaxBytes: extensionMax,
          extensionUsedBytes: extensionUsage.totalBytes,
          extensionReservedBytes: extensionUsage.reservedBytes,
          extensionAvailableBytes: Math.max(
            0,
            extensionMax - extensionUsage.totalBytes - extensionUsage.reservedBytes
          ),
          fileCount: extensionUsage.fileCount,
          fileCountMax: EPHEMERAL_MAX_FILES,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleEphemeralRequestBlock(
    requestId: string,
    sizeBytes: number,
    ttlMs?: number,
    reason?: string
  ): Promise<void> {
    try {
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        throw new Error("sizeBytes must be a positive number");
      }

      const now = Date.now();
      const cfg = await getEphemeralPoolConfig();
      const effectiveTtlMs =
        ttlMs && ttlMs > 0 ? ttlMs : cfg.reservationTtlMs;
      const expiresAt = new Date(now + effectiveTtlMs).toISOString();

      this.clearExpiredEphemeralEntriesInternal();
      this.clearExpiredReservations();

      const extensionUsage = this.collectEphemeralUsage();
      const globalUsage = await this.getGlobalEphemeralPoolUsage();
      const extensionMax = await this.getExtensionEphemeralMaxBytes(this.manifest.identifier);
      const globalMax = cfg.globalMaxBytes;

      const extensionAvailable =
        extensionMax - extensionUsage.totalBytes - extensionUsage.reservedBytes;
      const globalAvailable =
        globalMax - globalUsage.usedBytes - globalUsage.reservedBytes;

      if (sizeBytes > extensionAvailable) {
        throw new Error(
          `Requested block exceeds extension available pool (${sizeBytes}/${Math.max(0, extensionAvailable)} bytes)`
        );
      }
      if (sizeBytes > globalAvailable) {
        throw new Error(
          `Requested block exceeds global available pool (${sizeBytes}/${Math.max(0, globalAvailable)} bytes)`
        );
      }

      const reservationId = crypto.randomUUID();
      const reservations = this.readEphemeralReservations();
      reservations.push({
        id: reservationId,
        sizeBytes,
        consumedBytes: 0,
        createdAt: new Date(now).toISOString(),
        expiresAt,
        reason,
      });
      this.writeEphemeralReservations(reservations);

      this.postToWorker({
        type: "response",
        requestId,
        result: {
          reservationId,
          sizeBytes,
          expiresAt,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEphemeralReleaseBlock(
    requestId: string,
    reservationId: string
  ): void {
    try {
      const reservations = this.readEphemeralReservations();
      const next = reservations.filter((r) => r.id !== reservationId);
      this.writeEphemeralReservations(next);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Permissions ───────────────────────────────────────────────────────

  private handlePermissionsGetGranted(requestId: string): void {
    try {
      const granted = managerSvc.getGrantedPermissions(this.manifest.identifier);
      this.postToWorker({ type: "response", requestId, result: granted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Chat mutation ─────────────────────────────────────────────────────

  private getChatOwnerId(chatId: string): string | null {
    const row = getDb()
      .query("SELECT user_id FROM chats WHERE id = ?")
      .get(chatId) as { user_id: string } | null;
    return row?.user_id || null;
  }

  private mapChatRole(isUser: boolean, extra: Record<string, unknown>): "system" | "user" | "assistant" {
    if (isUser) return "user";
    const rawRole = extra?.spindle_role;
    if (rawRole === "system") return "system";
    return "assistant";
  }

  private handleChatGetMessages(requestId: string, chatId: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      const messages = getChatMessages(userId, chatId).map((m) => {
        const rawExtra = (m.extra || {}) as Record<string, unknown>;
        const role = this.mapChatRole(m.is_user, rawExtra);

        // Split spindle_metadata out of extra so it's surfaced as `metadata`
        // and not echoed twice on the wire.
        const { spindle_metadata, ...extra } = rawExtra;
        const metadata =
          typeof spindle_metadata === "object" && spindle_metadata
            ? (spindle_metadata as Record<string, unknown>)
            : undefined;

        const swipes = Array.isArray(m.swipes) ? m.swipes.slice() : [];
        const swipeId =
          typeof m.swipe_id === "number" && Number.isFinite(m.swipe_id) ? m.swipe_id : 0;
        const swipeDates = Array.isArray(m.swipe_dates) ? [...m.swipe_dates] : [];

        return {
          id: m.id,
          role,
          content: m.content,
          extra,
          metadata,
          swipe_id: swipeId,
          swipes,
          swipe_dates: swipeDates,
        };
      });

      this.postToWorker({ type: "response", requestId, result: messages });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatAppendMessage(
    requestId: string,
    chatId: string,
    message: {
      role: "system" | "user" | "assistant";
      content: string;
      metadata?: Record<string, unknown>;
    }
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      const extra: Record<string, unknown> = {
        spindle_role: message.role,
      };
      if (message.metadata) extra.spindle_metadata = message.metadata;

      const created = createChatMessage(
        chatId,
        {
          is_user: message.role === "user",
          name:
            message.role === "system"
              ? "System"
              : message.role === "assistant"
                ? "Assistant"
                : "User",
          content: message.content,
          extra,
        },
        userId
      );

      this.postToWorker({
        type: "response",
        requestId,
        result: { id: created.id },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatUpdateMessage(
    requestId: string,
    chatId: string,
    messageId: string,
    patch: {
      content?: string;
      metadata?: Record<string, unknown>;
      swipes?: string[];
      swipe_id?: number;
      swipe_dates?: number[];
      reasoning?: { text?: string | null; duration?: number | null };
      skipChunkRebuild?: boolean;
    }
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      const current = getChatMessage(userId, messageId);
      if (!current || current.chat_id !== chatId) {
        throw new Error("Message not found");
      }

      const extra = { ...(current.extra || {}) } as Record<string, unknown>;
      let extraDirty = false;

      if (patch.metadata !== undefined) {
        extra.spindle_metadata = patch.metadata;
        extraDirty = true;
      }

      if (patch.reasoning && typeof patch.reasoning === "object") {
        const r = patch.reasoning;
        if (r.text !== undefined) {
          if (r.text === null) delete extra.reasoning;
          else extra.reasoning = r.text;
          extraDirty = true;
        }
        if (r.duration !== undefined) {
          if (r.duration === null) delete extra.reasoning_duration;
          else extra.reasoning_duration = r.duration;
          extraDirty = true;
        }
      }

      updateChatMessage(userId, messageId, {
        content: patch.content,
        extra: extraDirty ? extra : undefined,
        swipes: patch.swipes,
        swipe_id: patch.swipe_id,
        swipe_dates: patch.swipe_dates,
        skipChunkRebuild: patch.skipChunkRebuild === true,
      });

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatDeleteMessage(
    requestId: string,
    chatId: string,
    messageId: string
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      const current = getChatMessage(userId, messageId);
      if (!current || current.chat_id !== chatId) {
        throw new Error("Message not found");
      }

      deleteChatMessage(userId, messageId);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatSetMessageHidden(
    requestId: string,
    chatId: string,
    messageId: string,
    hidden: boolean,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      const current = getChatMessage(userId, messageId);
      if (!current || current.chat_id !== chatId) {
        throw new Error("Message not found");
      }

      chatsSvc.bulkSetHidden(userId, chatId, [messageId], !!hidden);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatSetMessagesHidden(
    requestId: string,
    chatId: string,
    messageIds: string[],
    hidden: boolean,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      if (!Array.isArray(messageIds)) {
        throw new Error("messageIds must be an array of strings");
      }
      // Filter to defensively-typed strings; the underlying service caps the
      // batch at 500 and will throw past that.
      const filtered = messageIds.filter((id): id is string => typeof id === "string" && !!id);

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      chatsSvc.bulkSetHidden(userId, chatId, filtered, !!hidden);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatIsMessageHidden(
    requestId: string,
    chatId: string,
    messageId: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const userId = this.getChatOwnerId(chatId);
      if (!userId) throw new Error("Chat not found");
      this.enforceScopedUser(userId);

      const current = getChatMessage(userId, messageId);
      if (!current || current.chat_id !== chatId) {
        throw new Error("Message not found");
      }

      const extra = (current.extra || {}) as Record<string, unknown>;
      this.postToWorker({ type: "response", requestId, result: extra.hidden === true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Event tracking ────────────────────────────────────────────────────

  private getEventLogPath(): string {
    const dir = resolve(this.getStorageRootPath(this.manifest.identifier), ".spindle_events");
    mkdirSync(dir, { recursive: true });
    return join(dir, "events.jsonl");
  }

  private readTrackedEvents(): Array<{
    id: string;
    ts: string;
    eventName: string;
    level: "debug" | "info" | "warn" | "error";
    chatId?: string;
    payload?: Record<string, unknown>;
    expiresAt?: string;
  }> {
    const file = this.getEventLogPath();
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const events: Array<{
      id: string;
      ts: string;
      eventName: string;
      level: "debug" | "info" | "warn" | "error";
      chatId?: string;
      payload?: Record<string, unknown>;
      expiresAt?: string;
    }> = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
    return events;
  }

  private writeTrackedEvents(
    events: Array<{
      id: string;
      ts: string;
      eventName: string;
      level: "debug" | "info" | "warn" | "error";
      chatId?: string;
      payload?: Record<string, unknown>;
      expiresAt?: string;
    }>
  ): void {
    const file = this.getEventLogPath();
    const content = events.map((e) => JSON.stringify(e)).join("\n");
    writeFileSync(file, content ? `${content}\n` : "", "utf-8");
  }

  private enforceTrackedEventPermission(): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "event_tracking")) {
      throw new Error(`${PERMISSION_DENIED_PREFIX} event_tracking — Event tracking permission not granted`);
    }
  }

  private handleEventsTrack(
    requestId: string,
    eventName: string,
    payload?: Record<string, unknown>,
    options?: {
      level?: "debug" | "info" | "warn" | "error";
      chatId?: string;
      retentionDays?: number;
    }
  ): void {
    try {
      this.enforceTrackedEventPermission();

      if (options?.chatId) {
        this.enforceScopedUser(this.getChatOwnerId(options.chatId));
      }

      const now = Date.now();
      const retentionDays = options?.retentionDays ?? 14;
      const expiresAt =
        retentionDays > 0
          ? new Date(now + retentionDays * 24 * 60 * 60 * 1000).toISOString()
          : undefined;

      const events = this.readTrackedEvents();
      events.push({
        id: crypto.randomUUID(),
        ts: new Date(now).toISOString(),
        eventName,
        level: options?.level || "info",
        chatId: options?.chatId,
        payload,
        expiresAt,
      });

      const filtered = events.filter((e) => {
        if (!e.expiresAt) return true;
        const t = Date.parse(e.expiresAt);
        return Number.isNaN(t) || t > now;
      });

      this.writeTrackedEvents(filtered);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEventsQuery(
    requestId: string,
    filter?: {
      eventName?: string;
      chatId?: string;
      since?: string;
      until?: string;
      level?: "debug" | "info" | "warn" | "error";
      limit?: number;
    }
  ): void {
    try {
      this.enforceTrackedEventPermission();

      if (filter?.chatId) {
        this.enforceScopedUser(this.getChatOwnerId(filter.chatId));
      }

      const sinceMs = filter?.since ? Date.parse(filter.since) : Number.NEGATIVE_INFINITY;
      const untilMs = filter?.until ? Date.parse(filter.until) : Number.POSITIVE_INFINITY;
      const now = Date.now();

      const rows = this.readTrackedEvents()
        .filter((e) => {
          if (e.expiresAt) {
            const expiry = Date.parse(e.expiresAt);
            if (!Number.isNaN(expiry) && expiry <= now) return false;
          }
          const tsMs = Date.parse(e.ts);
          if (filter?.eventName && e.eventName !== filter.eventName) return false;
          if (filter?.chatId && e.chatId !== filter.chatId) return false;
          if (filter?.level && e.level !== filter.level) return false;
          if (!Number.isNaN(sinceMs) && tsMs < sinceMs) return false;
          if (!Number.isNaN(untilMs) && tsMs > untilMs) return false;
          return true;
        })
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));

      const limit = Math.max(1, Math.min(filter?.limit ?? 200, 2000));
      const result = rows.slice(0, limit).map((e) => ({
        id: e.id,
        ts: e.ts,
        eventName: e.eventName,
        level: e.level,
        chatId: e.chatId,
        payload: e.payload,
      }));

      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleEventsGetLatestState(requestId: string, keys: string[]): void {
    try {
      this.enforceTrackedEventPermission();

      const remaining = new Set(keys);
      const state: Record<string, unknown> = {};
      const events = this.readTrackedEvents().sort(
        (a, b) => Date.parse(b.ts) - Date.parse(a.ts)
      );

      for (const entry of events) {
        if (!entry.payload || typeof entry.payload !== "object") continue;
        for (const key of [...remaining]) {
          if (Object.prototype.hasOwnProperty.call(entry.payload, key)) {
            state[key] = (entry.payload as Record<string, unknown>)[key];
            remaining.delete(key);
          }
        }
        if (remaining.size === 0) break;
      }

      this.postToWorker({ type: "response", requestId, result: state });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── CORS proxy ──────────────────────────────────────────────────────

  private async handleCorsRequest(
    requestId: string,
    url: string,
    options: any
  ): Promise<void> {
    options = options || {};
    if (!managerSvc.hasPermission(this.manifest.identifier, "cors_proxy")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} cors_proxy — CORS proxy permission not granted`,
      });
      return;
    }

    const isBinary = options?.responseType === "arraybuffer";
    const binaryMediaType = options?.mediaType === "audio" ? "audio" : "image";

    try {
      // Validate URL against SSRF before making the request
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new SSRFError(`Only http and https URLs are allowed`);
      }
      await validateHost(parsed.hostname);

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CORS_PROXY_TIMEOUT_MS);
        let response: Response;
        try {
          response = await fetch(url, {
            method: options.method || "GET",
            headers: options.headers,
            body: options.body,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        // Reject obvious oversize responses up-front; for unknown lengths we
        // still cap the buffered body below.
        const declared = response.headers.get("content-length");
        if (declared && parseInt(declared, 10) > CORS_PROXY_MAX_BODY_BYTES) {
          throw new Error(
            `CORS proxy response too large (declared ${declared} bytes, max ${CORS_PROXY_MAX_BODY_BYTES})`,
          );
        }

        if (isBinary) {
          // Transparent proxy for sandboxed widgets: only serve approved media data.
          const contentType = (response.headers.get("content-type") || "").toLowerCase();
          const isAllowedContentType = binaryMediaType === "audio"
            ? contentType.startsWith("audio/") || contentType.startsWith("application/ogg")
            : contentType.startsWith("image/");
          if (!isAllowedContentType) {
            throw new Error(
              `CORS proxy transparent proxy only serves ${binaryMediaType} data (received Content-Type: ${contentType || "unknown"})`
            );
          }

          const binary = await readResponseBodyBinaryCapped(response, CORS_PROXY_MAX_BODY_BYTES);
          const hasValidMagic = binaryMediaType === "audio"
            ? validateAudioMagicBytes(binary, contentType)
            : contentType.includes("svg") || validateImageMagicBytes(binary, contentType);
          if (!hasValidMagic) {
            throw new Error(`CORS proxy transparent proxy rejected: downloaded content does not match a known ${binaryMediaType} format`);
          }

          this.postToWorker({
            type: "response",
            requestId,
            result: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: Buffer.from(binary).toString("base64"),
              encoding: "base64",
            },
          });
        } else {
          const text = await readResponseBodyCapped(response, CORS_PROXY_MAX_BODY_BYTES);
          this.postToWorker({
            type: "response",
            requestId,
            result: {
              status: response.status,
              statusText: response.statusText,
              headers: Object.fromEntries(response.headers.entries()),
              body: text,
            },
          });
        }
      } catch (fetchErr: any) {
        if (isBinary) {
          throw fetchErr;
        }
        if (/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname)) {
          throw fetchErr;
        }

        const retried = await requestWithAddressFamily(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
        }, 4);
        this.postToWorker({
          type: "response",
          requestId,
          result: retried,
        });
      }
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Context handler ─────────────────────────────────────────────────

  private handleRegisterContextHandler(priority?: number): void {
    if (
      !managerSvc.hasPermission(this.manifest.identifier, "context_handler")
    ) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Context handler permission not granted`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "context_handler",
        operation: "registerContextHandler",
      });
      return;
    }

    this.contextHandlerUnregister?.();
    this.contextHandlerUnregister = contextHandlerChain.register({
      extensionId: this.extensionId,
      extensionName: this.manifest.name || this.manifest.identifier,
      userId: this.getScopedUserId(),
      priority: priority ?? 100,
      handler: async (context) => {
        const requestId = crypto.randomUUID();

        this.postToWorker({
          type: "context_handler_request",
          requestId,
          context,
        });

        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `Context handler timeout from ${this.manifest.identifier}`
              )
            );
          }, 10_000);

          this.pendingRequests.set(requestId, {
            resolve: (val) => {
              clearTimeout(timeout);
              resolve(val);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      },
    });
  }

  // ─── Message content processor ───────────────────────────────────────

  private handleRegisterMessageContentProcessor(priority?: number): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "chat_mutation")) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] chat_mutation permission not granted for registerMessageContentProcessor`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "chat_mutation",
        operation: "registerMessageContentProcessor",
      });
      return;
    }

    this.messageContentProcessorUnregister?.();
    this.messageContentProcessorUnregister = messageContentProcessorChain.register({
      extensionId: this.extensionId,
      extensionName: this.manifest.name || this.manifest.identifier,
      userId: this.getScopedUserId(),
      priority: priority ?? 100,
      handler: async (ctx: MessageContentProcessorCtx) => {
        const requestId = crypto.randomUUID();

        this.postToWorker({
          type: "message_content_processor_request",
          requestId,
          ctx,
        });

        return new Promise<MessageContentProcessorResult | void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `Message content processor timeout from ${this.manifest.identifier}`
              )
            );
          }, 10_000);

          this.pendingRequests.set(requestId, {
            resolve: (val) => {
              clearTimeout(timeout);
              resolve(val as MessageContentProcessorResult | undefined);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      },
    });
  }

  private handleRegisterMacroInterceptor(priority?: number): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "macro_interceptor")) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] macro_interceptor permission not granted for registerMacroInterceptor`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "macro_interceptor",
        operation: "registerMacroInterceptor",
      });
      return;
    }

    this.macroInterceptorUnregister?.();
    this.macroInterceptorUnregister = macroInterceptorChain.register({
      extensionId: this.extensionId,
      userId: this.getScopedUserId(),
      priority: priority ?? 100,
      handler: async (ctx: MacroInterceptorCtx) => {
        const requestId = crypto.randomUUID();

        this.postToWorker({
          type: "macro_interceptor_request",
          requestId,
          ctx,
        });

        return new Promise<MacroInterceptorResult | void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `Macro interceptor timeout from ${this.manifest.identifier}`
              )
            );
          }, 10_000);

          this.pendingRequests.set(requestId, {
            resolve: (val) => {
              clearTimeout(timeout);
              resolve(val as MacroInterceptorResult | undefined);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      },
    });
  }

  private handleRegisterWorldInfoInterceptor(priority?: number): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "generation")) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] generation permission not granted for registerWorldInfoInterceptor`
      );
      this.postToWorker({
        type: "permission_denied",
        permission: "generation",
        operation: "registerWorldInfoInterceptor",
      });
      return;
    }

    this.worldInfoInterceptorUnregister?.();
    this.worldInfoInterceptorUnregister = worldInfoInterceptorChain.register({
      extensionId: this.extensionId,
      userId: this.getScopedUserId(),
      priority: priority ?? 100,
      handler: async (ctx: WorldInfoInterceptorCtxDTO) => {
        const requestId = crypto.randomUUID();

        this.postToWorker({
          type: "world_info_interceptor_request",
          requestId,
          ctx,
        });

        return new Promise<WorldInfoInterceptorResultDTO | void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.pendingRequests.delete(requestId);
            reject(
              new Error(
                `World-info interceptor timeout from ${this.manifest.identifier}`
              )
            );
          }, 10_000);

          this.pendingRequests.set(requestId, {
            resolve: (val) => {
              clearTimeout(timeout);
              resolve(val as WorldInfoInterceptorResultDTO | undefined);
            },
            reject: (err) => {
              clearTimeout(timeout);
              reject(err);
            },
          });
        });
      },
    });
  }

  // ─── Variables (free tier — no permission gating) ────────────────────

  private getLocalVars(chatId: string): Record<string, string> {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    this.enforceScopedUser(userId);
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    return (chat.metadata?.macro_variables?.local as Record<string, string>) || {};
  }

  private setLocalVars(chatId: string, vars: Record<string, string>): void {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    const metadata = { ...chat.metadata };
    const macroVars = (metadata.macro_variables as Record<string, unknown>) || {};
    macroVars.local = vars;
    metadata.macro_variables = macroVars;
    chatsSvc.updateChat(userId, chatId, { metadata });
  }

  private getGlobalVars(userId: string): Record<string, string> {
    const setting = settingsSvc.getSetting(userId, "macro_variables_global");
    return (setting?.value as Record<string, string>) || {};
  }

  private setGlobalVars(userId: string, vars: Record<string, string>): void {
    settingsSvc.putSetting(userId, "macro_variables_global", vars);
  }

  private handleVarsGetLocal(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsSetLocal(requestId: string, chatId: string, key: string, value: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      vars[key] = value;
      this.setLocalVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsDeleteLocal(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      delete vars[key];
      this.setLocalVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsListLocal(requestId: string, chatId: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsHasLocal(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getLocalVars(chatId);
      this.postToWorker({ type: "response", requestId, result: key in vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsGetGlobal(requestId: string, key: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsSetGlobal(requestId: string, key: string, value: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      vars[key] = value;
      this.setGlobalVars(resolvedUserId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsDeleteGlobal(requestId: string, key: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      delete vars[key];
      this.setGlobalVars(resolvedUserId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsListGlobal(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsHasGlobal(requestId: string, key: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        throw new Error("userId is required for operator-scoped extensions");
      }
      this.enforceScopedUser(resolvedUserId);
      const vars = this.getGlobalVars(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: key in vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Chat-Scoped Persisted Variables (free tier) ────────────────────

  private getChatVars(chatId: string): Record<string, string> {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    this.enforceScopedUser(userId);
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    return (chat.metadata?.chat_variables as Record<string, string>) || {};
  }

  private setChatVars(chatId: string, vars: Record<string, string>): void {
    const userId = this.getChatOwnerId(chatId);
    if (!userId) throw new Error("Chat not found");
    const chat = chatsSvc.getChat(userId, chatId);
    if (!chat) throw new Error("Chat not found");
    const metadata = { ...chat.metadata, chat_variables: vars };
    chatsSvc.updateChat(userId, chatId, { metadata });
  }

  private handleVarsGetChat(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getChatVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars[key] ?? "" });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsSetChat(requestId: string, chatId: string, key: string, value: string): void {
    try {
      const vars = this.getChatVars(chatId);
      vars[key] = value;
      this.setChatVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsDeleteChat(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getChatVars(chatId);
      delete vars[key];
      this.setChatVars(chatId, vars);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsListChat(requestId: string, chatId: string): void {
    try {
      const vars = this.getChatVars(chatId);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleVarsHasChat(requestId: string, chatId: string, key: string): void {
    try {
      const vars = this.getChatVars(chatId);
      this.postToWorker({ type: "response", requestId, result: key in vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Characters (gated: "characters") ──────────────────────────────

  private toCharacterDTO(c: any): CharacterDTO {
    return {
      id: c.id,
      name: c.name,
      description: c.description || "",
      personality: c.personality || "",
      scenario: c.scenario || "",
      first_mes: c.first_mes || "",
      mes_example: c.mes_example || "",
      creator_notes: c.creator_notes || "",
      system_prompt: c.system_prompt || "",
      post_history_instructions: c.post_history_instructions || "",
      tags: Array.isArray(c.tags) ? c.tags : [],
      alternate_greetings: Array.isArray(c.alternate_greetings) ? c.alternate_greetings : [],
      creator: c.creator || "",
      image_id: c.image_id || null,
      world_book_ids: getCharacterWorldBookIds(c.extensions),
      extensions: c.extensions || {},
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  /**
   * Normalize and dedupe a `world_book_ids` input from an extension. Filters
   * out non-string and empty entries, deduplicates while preserving order.
   */
  private sanitizeWorldBookIds(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of input) {
      if (typeof id !== "string" || !id.trim()) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  private handleCharactersList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = charactersSvc.listCharacters(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((c) => this.toCharacterDTO(c)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleCharactersGet(requestId: string, characterId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const c = charactersSvc.getCharacter(resolvedUserId, characterId);
      this.postToWorker({
        type: "response",
        requestId,
        result: c ? this.toCharacterDTO(c) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleCharactersCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Character name is required");
      }

      const createInput: any = {
        name: input.name,
        description: input.description,
        personality: input.personality,
        scenario: input.scenario,
        first_mes: input.first_mes,
        mes_example: input.mes_example,
        creator_notes: input.creator_notes,
        system_prompt: input.system_prompt,
        post_history_instructions: input.post_history_instructions,
        tags: input.tags,
        alternate_greetings: input.alternate_greetings,
        creator: input.creator,
      };
      if (input.world_book_ids !== undefined || input.extensions !== undefined) {
        const ids = this.sanitizeWorldBookIds(input.world_book_ids);
        createInput.extensions = setCharacterWorldBookIds(
          input.extensions && typeof input.extensions === "object" && !Array.isArray(input.extensions)
            ? input.extensions
            : {},
          ids,
        );
      }
      const c = charactersSvc.createCharacter(resolvedUserId, createInput);
      this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleCharactersSetAvatar(
    requestId: string,
    characterId: string,
    avatar: CharacterAvatarUploadDTO,
    userId?: string,
  ): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (!(avatar?.data instanceof Uint8Array) || avatar.data.byteLength === 0) {
          throw new Error("Avatar data must be a non-empty Uint8Array");
        }

        const mimeType = typeof avatar.mime_type === "string" && avatar.mime_type.trim()
          ? avatar.mime_type.trim()
          : "image/png";
        const filename = typeof avatar.filename === "string" && avatar.filename.trim()
          ? avatar.filename.trim()
          : "avatar.png";

        const avatarBytes = Uint8Array.from(avatar.data);
        const file = new File([avatarBytes.buffer], filename, { type: mimeType });
        const updated = await charactersSvc.replaceCharacterAvatar(resolvedUserId, characterId, file);
        if (!updated) throw new Error("Character not found");

        this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(updated) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  private handleCharactersUpdate(requestId: string, characterId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const update: any = {};
      const passthroughFields = [
        "name", "description", "personality", "scenario", "first_mes",
        "mes_example", "creator_notes", "system_prompt", "post_history_instructions",
        "tags", "alternate_greetings", "creator",
      ] as const;
      for (const field of passthroughFields) {
        if (input?.[field] !== undefined) update[field] = input[field];
      }

      const existing = charactersSvc.getCharacter(resolvedUserId, characterId);
      if (!existing) throw new Error("Character not found");

      let mergedExtensions: Record<string, any> | undefined;
      if (input?.extensions !== undefined) {
        if (typeof input.extensions !== "object" || Array.isArray(input.extensions)) {
          throw new Error("extensions must be a plain object");
        }
        mergedExtensions = { ...existing.extensions, ...input.extensions };
      }

      if (input?.world_book_ids !== undefined) {
        const ids = this.sanitizeWorldBookIds(input.world_book_ids);
        update.extensions = setCharacterWorldBookIds(mergedExtensions || existing.extensions || {}, ids);
      } else if (mergedExtensions !== undefined) {
        update.extensions = mergedExtensions;
      }

      const c = charactersSvc.updateCharacter(resolvedUserId, characterId, update);
      if (!c) throw new Error("Character not found");
      this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleCharactersDelete(requestId: string, characterId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = charactersSvc.deleteCharacter(resolvedUserId, characterId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Images CRUD (gated: "images") ─────────────────────────────────

  private toImageDTO(img: any): ImageDTO {
    return {
      id: img.id,
      original_filename: img.original_filename || "",
      mime_type: img.mime_type || "",
      width: img.width ?? null,
      height: img.height ?? null,
      has_thumbnail: !!img.has_thumbnail,
      url: img.url,
      specificity: img.specificity || "full",
      owner_extension_identifier: img.owner_extension_identifier ?? null,
      owner_character_id: img.owner_character_id ?? null,
      owner_chat_id: img.owner_chat_id ?? null,
      created_at: img.created_at,
    };
  }

  private handleImagesList(
    requestId: string,
    limit?: number,
    offset?: number,
    specificity?: imagesSvc.ImageSpecificity,
    onlyOwned?: boolean,
    characterId?: string,
    chatId?: string,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "images")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = imagesSvc.listImages(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
        specificity: specificity || "full",
        owner_extension_identifier: onlyOwned ? this.manifest.identifier : undefined,
        owner_character_id: characterId,
        owner_chat_id: chatId,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((img) => this.toImageDTO(img)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleImagesGet(
    requestId: string,
    imageId: string,
    specificity?: imagesSvc.ImageSpecificity,
    onlyOwned?: boolean,
    characterId?: string,
    chatId?: string,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "images")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const img = imagesSvc.getImage(resolvedUserId, imageId, {
        specificity: specificity || "full",
        owner_extension_identifier: onlyOwned ? this.manifest.identifier : undefined,
        owner_character_id: characterId,
        owner_chat_id: chatId,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: img ? this.toImageDTO(img) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleImagesUpload(requestId: string, input: any, userId?: string): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "images")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (!(input?.data instanceof Uint8Array) || input.data.byteLength === 0) {
          throw new Error("Image data must be a non-empty Uint8Array");
        }

        const mimeType = typeof input?.mime_type === "string" && input.mime_type.trim()
          ? input.mime_type.trim()
          : "image/png";
        const filename = typeof input?.filename === "string" && input.filename.trim()
          ? input.filename.trim()
          : "image.png";

        const imageBytes = Uint8Array.from(input.data);
        const file = new File([imageBytes.buffer], filename, { type: mimeType });
        const img = await imagesSvc.uploadImage(resolvedUserId, file, {
          owner_extension_identifier: this.manifest.identifier,
          owner_character_id: typeof input?.owner_character_id === "string" && input.owner_character_id.trim()
            ? input.owner_character_id.trim()
            : undefined,
          owner_chat_id: typeof input?.owner_chat_id === "string" && input.owner_chat_id.trim()
            ? input.owner_chat_id.trim()
            : undefined,
        });

        this.postToWorker({ type: "response", requestId, result: this.toImageDTO(img) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  private handleImagesUploadFromDataUrl(
    requestId: string,
    dataUrl: string,
    originalFilename?: string,
    ownerCharacterId?: string,
    ownerChatId?: string,
    userId?: string,
  ): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "images")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        if (typeof dataUrl !== "string" || !dataUrl.trim()) {
          throw new Error("dataUrl is required");
        }

        const img = await imagesSvc.saveImageFromDataUrl(resolvedUserId, dataUrl, originalFilename, {
          owner_extension_identifier: this.manifest.identifier,
          owner_character_id: typeof ownerCharacterId === "string" && ownerCharacterId.trim()
            ? ownerCharacterId.trim()
            : undefined,
          owner_chat_id: typeof ownerChatId === "string" && ownerChatId.trim()
            ? ownerChatId.trim()
            : undefined,
        });
        this.postToWorker({ type: "response", requestId, result: this.toImageDTO(img) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  private handleImagesDelete(requestId: string, imageId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "images")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} images — Images permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = imagesSvc.deleteImage(resolvedUserId, imageId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Chats CRUD (gated: "chats") ──────────────────────────────────

  private toChatDTO(c: any): ChatDTO {
    return {
      id: c.id,
      character_id: c.character_id,
      name: c.name || "",
      metadata: (typeof c.metadata === "object" && c.metadata) ? c.metadata : {},
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
  }

  private handleChatsList(
    requestId: string,
    characterId?: string,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = chatsSvc.listChats(
        resolvedUserId,
        { limit: Math.min(limit || 50, 200), offset: offset || 0 },
        characterId,
      );
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((c) => this.toChatDTO(c)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatsGet(requestId: string, chatId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const c = chatsSvc.getChat(resolvedUserId, chatId);
      this.postToWorker({ type: "response", requestId, result: c ? this.toChatDTO(c) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatsGetActive(requestId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const setting = settingsSvc.getSetting(resolvedUserId, "activeChatId");
      if (!setting?.value || typeof setting.value !== "string") {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      const chat = chatsSvc.getChat(resolvedUserId, setting.value);
      this.postToWorker({ type: "response", requestId, result: chat ? this.toChatDTO(chat) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatsUpdate(requestId: string, chatId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const c = chatsSvc.updateChat(resolvedUserId, chatId, input || {});
      if (!c) throw new Error("Chat not found");
      this.postToWorker({ type: "response", requestId, result: this.toChatDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleChatsDelete(requestId: string, chatId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = chatsSvc.deleteChat(resolvedUserId, chatId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── World Books CRUD (gated: "world_books") ─────────────────────────

  private toWorldBookDTO(wb: any): WorldBookDTO {
    return {
      id: wb.id,
      name: wb.name || "",
      description: wb.description || "",
      metadata: (typeof wb.metadata === "object" && wb.metadata) ? wb.metadata : {},
      created_at: wb.created_at,
      updated_at: wb.updated_at,
    };
  }

  private toWorldBookEntryDTO(e: any): WorldBookEntryDTO {
    return {
      id: e.id,
      world_book_id: e.world_book_id,
      uid: e.uid || "",
      key: Array.isArray(e.key) ? e.key : [],
      keysecondary: Array.isArray(e.keysecondary) ? e.keysecondary : [],
      content: e.content || "",
      comment: e.comment || "",
      position: e.position ?? 0,
      depth: e.depth ?? 4,
      role: e.role || null,
      order_value: e.order_value ?? 100,
      selective: !!e.selective,
      constant: !!e.constant,
      disabled: !!e.disabled,
      group_name: e.group_name || "",
      group_override: !!e.group_override,
      group_weight: e.group_weight ?? 100,
      probability: e.probability ?? 100,
      scan_depth: e.scan_depth ?? null,
      case_sensitive: !!e.case_sensitive,
      match_whole_words: !!e.match_whole_words,
      automation_id: e.automation_id || null,
      use_regex: !!e.use_regex,
      prevent_recursion: !!e.prevent_recursion,
      exclude_recursion: !!e.exclude_recursion,
      delay_until_recursion: !!e.delay_until_recursion,
      priority: e.priority ?? 10,
      sticky: e.sticky ?? 0,
      cooldown: e.cooldown ?? 0,
      delay: e.delay ?? 0,
      selective_logic: e.selective_logic ?? 0,
      use_probability: e.use_probability !== undefined ? !!e.use_probability : true,
      vectorized: !!e.vectorized,
      extensions: (typeof e.extensions === "object" && e.extensions) ? e.extensions : {},
      created_at: e.created_at,
      updated_at: e.updated_at,
    };
  }

  private handleWorldBooksList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = worldBooksSvc.listWorldBooks(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((wb) => this.toWorldBookDTO(wb)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBooksGet(requestId: string, worldBookId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const wb = worldBooksSvc.getWorldBook(resolvedUserId, worldBookId);
      this.postToWorker({ type: "response", requestId, result: wb ? this.toWorldBookDTO(wb) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBooksCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("World book name is required");
      }

      const wb = worldBooksSvc.createWorldBook(resolvedUserId, {
        name: input.name,
        description: input.description,
        metadata: input.metadata,
      });
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookDTO(wb) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBooksUpdate(requestId: string, worldBookId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const wb = worldBooksSvc.updateWorldBook(resolvedUserId, worldBookId, input || {});
      if (!wb) throw new Error("World book not found");
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookDTO(wb) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBooksDelete(requestId: string, worldBookId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = worldBooksSvc.deleteWorldBook(resolvedUserId, worldBookId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── World Book Entries CRUD (gated: "world_books") ───────────────────

  private handleWorldBookEntriesList(
    requestId: string,
    worldBookId: string,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = worldBooksSvc.listEntriesPaginated(resolvedUserId, worldBookId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((e) => this.toWorldBookEntryDTO(e)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBookEntriesGet(requestId: string, entryId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const entry = worldBooksSvc.getEntry(resolvedUserId, entryId);
      this.postToWorker({ type: "response", requestId, result: entry ? this.toWorldBookEntryDTO(entry) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBookEntriesCreate(requestId: string, worldBookId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const entry = worldBooksSvc.createEntry(resolvedUserId, worldBookId, input || {});
      if (!entry) throw new Error("World book not found");
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookEntryDTO(entry) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBookEntriesUpdate(requestId: string, entryId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const entry = worldBooksSvc.updateEntry(resolvedUserId, entryId, input || {});
      if (!entry) throw new Error("World book entry not found");
      this.postToWorker({ type: "response", requestId, result: this.toWorldBookEntryDTO(entry) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleWorldBookEntriesDelete(requestId: string, entryId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = worldBooksSvc.deleteEntry(resolvedUserId, entryId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Databanks CRUD (gated: "databanks") ─────────────────────────────

  private toDatabankDTO(bank: any): DatabankDTO {
    return {
      id: bank.id,
      name: bank.name || "",
      description: bank.description || "",
      scope: bank.scope,
      scope_id: bank.scopeId ?? null,
      enabled: !!bank.enabled,
      metadata: (typeof bank.metadata === "object" && bank.metadata) ? bank.metadata : {},
      document_count: typeof bank.documentCount === "number" ? bank.documentCount : undefined,
      created_at: bank.createdAt,
      updated_at: bank.updatedAt,
    };
  }

  private toDatabankDocumentDTO(doc: any): DatabankDocumentDTO {
    return {
      id: doc.id,
      databank_id: doc.databankId,
      name: doc.name || "",
      slug: doc.slug || "",
      mime_type: doc.mimeType || "",
      file_size: doc.fileSize ?? 0,
      content_hash: doc.contentHash || "",
      total_chunks: doc.totalChunks ?? 0,
      status: doc.status,
      error_message: doc.errorMessage ?? null,
      metadata: (typeof doc.metadata === "object" && doc.metadata) ? doc.metadata : {},
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    };
  }

  private handleDatabanksList(
    requestId: string,
    limit?: number,
    offset?: number,
    scope?: string,
    scopeId?: string | null,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const normalizedScope =
        scope === undefined
          ? undefined
          : scope === "global" || scope === "character" || scope === "chat"
            ? scope
            : null;
      if (normalizedScope === null) throw new Error("Databank scope must be 'global', 'character', or 'chat'");

      const result = databanksSvc.listDatabanks(
        resolvedUserId,
        {
          limit: Math.min(limit || 50, 200),
          offset: offset || 0,
        },
        {
          scope: normalizedScope,
          scopeId: typeof scopeId === "string" ? scopeId : undefined,
        },
      );
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((bank) => this.toDatabankDTO(bank)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabanksGet(requestId: string, databankId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const bank = databanksSvc.getDatabank(resolvedUserId, databankId);
      this.postToWorker({ type: "response", requestId, result: bank ? this.toDatabankDTO(bank) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabanksCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Databank name is required");
      }
      if (input.scope !== "global" && input.scope !== "character" && input.scope !== "chat") {
        throw new Error("Databank scope must be 'global', 'character', or 'chat'");
      }
      if (input.scope !== "global" && (!input.scope_id || typeof input.scope_id !== "string")) {
        throw new Error("scope_id is required for character and chat databanks");
      }

      const bank = databanksSvc.createDatabank(resolvedUserId, {
        name: input.name.trim(),
        description: typeof input.description === "string" ? input.description : undefined,
        scope: input.scope,
        scopeId: input.scope_id ?? null,
      });
      this.postToWorker({ type: "response", requestId, result: this.toDatabankDTO(bank) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabanksUpdate(requestId: string, databankId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const bank = databanksSvc.updateDatabank(resolvedUserId, databankId, {
        name: typeof input?.name === "string" ? input.name : undefined,
        description: typeof input?.description === "string" ? input.description : undefined,
        enabled: typeof input?.enabled === "boolean" ? input.enabled : undefined,
      });
      if (!bank) throw new Error("Databank not found");

      this.postToWorker({ type: "response", requestId, result: this.toDatabankDTO(bank) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabanksDelete(requestId: string, databankId: string, userId?: string): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        databanksSvc.abortDatabankProcessing(databankId);
        await databanksSvc.deleteDatabankVectors(resolvedUserId, databankId);
        const deleted = await databanksSvc.deleteDatabank(resolvedUserId, databankId);
        this.postToWorker({ type: "response", requestId, result: deleted });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  // ─── Databank Documents CRUD (gated: "databanks") ────────────────────

  private handleDatabankDocumentsList(
    requestId: string,
    databankId: string,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = databanksSvc.listDocuments(resolvedUserId, databankId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((doc) => this.toDatabankDocumentDTO(doc)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabankDocumentsGet(requestId: string, documentId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const doc = databanksSvc.getDocument(resolvedUserId, documentId);
      this.postToWorker({ type: "response", requestId, result: doc ? this.toDatabankDocumentDTO(doc) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabankDocumentsCreate(
    requestId: string,
    databankId: string,
    input: DatabankDocumentCreateDTO,
    userId?: string,
  ): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        const bank = databanksSvc.getDatabank(resolvedUserId, databankId);
        if (!bank) throw new Error("Databank not found");
        if (!(input?.data instanceof Uint8Array) || input.data.byteLength === 0) {
          throw new Error("Document data must be a non-empty Uint8Array");
        }
        if (!input.filename || typeof input.filename !== "string" || !input.filename.trim()) {
          throw new Error("Document filename is required");
        }
        const filename = input.filename.trim();
        if (!databanksSvc.isSupportedFormat(filename)) {
          throw new Error(`Unsupported file format. Supported: ${databanksSvc.getSupportedExtensions().join(", ")}`);
        }
        if (input.data.byteLength > 10 * 1024 * 1024) {
          throw new Error("File too large. Maximum 10MB.");
        }

        const bytes = Uint8Array.from(input.data);
        const mimeType = typeof input.mime_type === "string" ? input.mime_type.trim() : "";
        const file = new File([bytes], filename, { type: mimeType || "application/octet-stream" });
        const storedFilename = await filesSvc.saveUpload(file, resolvedUserId, "databank");
        const hash = createHash("sha256").update(bytes).digest("hex");
        const displayName = typeof input.name === "string" && input.name.trim()
          ? input.name.trim()
          : filename.replace(/\.[^.]+$/, "");

        const doc = databanksSvc.createDocument(
          resolvedUserId,
          databankId,
          displayName,
          storedFilename,
          mimeType,
          bytes.byteLength,
          hash,
        );

        databanksSvc.processDocument(resolvedUserId, doc.id).catch((err) => {
          console.error(`[databank] Background processing failed for ${doc.id}:`, err);
        });

        this.postToWorker({ type: "response", requestId, result: this.toDatabankDocumentDTO(doc) });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  private handleDatabankDocumentsUpdate(requestId: string, documentId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Document name is required");
      }

      const doc = databanksSvc.renameDocument(resolvedUserId, documentId, input.name.trim());
      if (!doc) throw new Error("Document not found");

      this.postToWorker({ type: "response", requestId, result: this.toDatabankDocumentDTO(doc) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabankDocumentsDelete(requestId: string, documentId: string, userId?: string): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        databanksSvc.abortDocumentProcessing(documentId);
        await databanksSvc.deleteDocumentVectors(resolvedUserId, documentId);
        const deleted = await databanksSvc.deleteDocument(resolvedUserId, documentId);
        this.postToWorker({ type: "response", requestId, result: deleted });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  private handleDatabankDocumentsGetContent(requestId: string, documentId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const content = databanksSvc.getDocumentContent(resolvedUserId, documentId);
      this.postToWorker({
        type: "response",
        requestId,
        result: content === null ? null : { content },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleDatabankDocumentsReprocess(requestId: string, documentId: string, userId?: string): void {
    (async () => {
      try {
        if (!managerSvc.hasPermission(this.manifest.identifier, "databanks")) {
          throw new Error(`${PERMISSION_DENIED_PREFIX} databanks — Databanks permission not granted`);
        }
        const resolvedUserId = this.resolveEffectiveUserId(userId);
        if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
        this.enforceScopedUser(resolvedUserId);

        const doc = databanksSvc.getDocument(resolvedUserId, documentId);
        if (!doc) throw new Error("Document not found");

        await databanksSvc.deleteDocumentVectors(resolvedUserId, documentId);
        databanksSvc.updateDocumentStatus(documentId, "pending");
        databanksSvc.processDocument(resolvedUserId, documentId).catch((err) => {
          console.error(`[databank] Reprocessing failed for ${documentId}:`, err);
        });

        this.postToWorker({ type: "response", requestId, result: { success: true, status: "processing" } });
      } catch (err: any) {
        this.postToWorker({ type: "response", requestId, error: err.message });
      }
    })();
  }

  // ─── Personas CRUD (gated: "personas") ────────────────────────────────

  private toPersonaDTO(p: any): PersonaDTO {
    return {
      id: p.id,
      name: p.name || "",
      title: p.title || "",
      description: p.description || "",
      image_id: p.image_id || null,
      attached_world_book_id: p.attached_world_book_id || null,
      folder: p.folder || "",
      is_default: !!p.is_default,
      metadata: (typeof p.metadata === "object" && p.metadata) ? p.metadata : {},
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }

  private handlePersonasList(requestId: string, limit?: number, offset?: number, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = personasSvc.listPersonas(resolvedUserId, {
        limit: Math.min(limit || 50, 200),
        offset: offset || 0,
      });
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((p) => this.toPersonaDTO(p)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasGet(requestId: string, personaId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const p = personasSvc.getPersona(resolvedUserId, personaId);
      this.postToWorker({ type: "response", requestId, result: p ? this.toPersonaDTO(p) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasGetDefault(requestId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const p = personasSvc.getDefaultPersona(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: p ? this.toPersonaDTO(p) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasGetActive(requestId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const setting = settingsSvc.getSetting(resolvedUserId, "activePersonaId");
      if (!setting?.value || typeof setting.value !== "string") {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      const persona = personasSvc.getPersona(resolvedUserId, setting.value);
      this.postToWorker({ type: "response", requestId, result: persona ? this.toPersonaDTO(persona) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Persona name is required");
      }

      const p = personasSvc.createPersona(resolvedUserId, {
        name: input.name,
        title: input.title,
        description: input.description,
        folder: input.folder,
        is_default: input.is_default,
        attached_world_book_id: input.attached_world_book_id,
        metadata: input.metadata,
      });
      this.postToWorker({ type: "response", requestId, result: this.toPersonaDTO(p) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasUpdate(requestId: string, personaId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const p = personasSvc.updatePersona(resolvedUserId, personaId, input || {});
      if (!p) throw new Error("Persona not found");
      this.postToWorker({ type: "response", requestId, result: this.toPersonaDTO(p) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasDelete(requestId: string, personaId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = personasSvc.deletePersona(resolvedUserId, personaId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasSwitch(requestId: string, personaId: string | null, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      // Validate persona exists if a non-null ID is provided
      if (personaId !== null) {
        const persona = personasSvc.getPersona(resolvedUserId, personaId);
        if (!persona) throw new Error("Persona not found");
      }

      // Set the activePersonaId setting (putSetting emits SETTINGS_UPDATED)
      settingsSvc.putSetting(resolvedUserId, "activePersonaId", personaId);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handlePersonasGetWorldBook(requestId: string, personaId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "personas")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} personas — Personas permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const persona = personasSvc.getPersona(resolvedUserId, personaId);
      if (!persona) throw new Error("Persona not found");

      if (!persona.attached_world_book_id) {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }

      const wb = worldBooksSvc.getWorldBook(resolvedUserId, persona.attached_world_book_id);
      this.postToWorker({ type: "response", requestId, result: wb ? this.toWorldBookDTO(wb) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Activated World Info (gated: "world_books") ─────────────────────

  private async handleWorldBooksGetActivated(
    requestId: string,
    chatId: string,
    userId?: string,
  ): Promise<void> {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "world_books")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} world_books — World Books permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const activated = await promptAssemblySvc.getActivatedWorldInfoForChat(resolvedUserId, chatId);

      const result: ActivatedWorldInfoEntryDTO[] = activated.map((e) => ({
        id: e.id,
        comment: e.comment,
        keys: e.keys,
        source: e.source,
        score: e.score,
      }));

      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Regex Scripts (gated: "regex_scripts") ──────────────────────────

  private toRegexScriptDTO(s: any): RegexScriptDTO {
    return {
      id: s.id,
      name: s.name,
      script_id: s.script_id || "",
      find_regex: s.find_regex,
      replace_string: s.replace_string,
      flags: s.flags,
      placement: s.placement,
      scope: s.scope,
      scope_id: s.scope_id,
      target: s.target,
      min_depth: s.min_depth,
      max_depth: s.max_depth,
      trim_strings: s.trim_strings,
      run_on_edit: !!s.run_on_edit,
      substitute_macros: s.substitute_macros,
      disabled: !!s.disabled,
      sort_order: s.sort_order,
      description: s.description || "",
      folder: s.folder || "",
      metadata: s.metadata || {},
      created_at: s.created_at,
      updated_at: s.updated_at,
    };
  }

  private handleRegexScriptsList(
    requestId: string,
    scope?: RegexScopeDTO,
    scopeId?: string,
    target?: RegexTargetDTO,
    limit?: number,
    offset?: number,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (scope !== undefined && scope !== "global" && scope !== "character" && scope !== "chat") {
        throw new Error("scope must be 'global', 'character', or 'chat'");
      }
      if (target !== undefined && target !== "prompt" && target !== "response" && target !== "display") {
        throw new Error("target must be 'prompt', 'response', or 'display'");
      }

      const filters: { scope?: RegexScopeDTO; scope_id?: string; target?: RegexTargetDTO } = {};
      if (target) filters.target = target;
      if (scope) filters.scope = scope;
      if (scopeId) filters.scope_id = scopeId;

      const result = regexScriptsSvc.listRegexScripts(
        resolvedUserId,
        { limit: Math.min(limit || 50, 200), offset: offset || 0 },
        filters,
      );
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          data: result.data.map((s) => this.toRegexScriptDTO(s)),
          total: result.total,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleRegexScriptsGet(requestId: string, scriptId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const s = regexScriptsSvc.getRegexScript(resolvedUserId, scriptId);
      this.postToWorker({ type: "response", requestId, result: s ? this.toRegexScriptDTO(s) : null });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleRegexScriptsGetActive(
    requestId: string,
    target: RegexTargetDTO,
    characterId?: string,
    chatId?: string,
    userId?: string,
  ): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (target !== "prompt" && target !== "response" && target !== "display") {
        throw new Error("target must be 'prompt', 'response', or 'display'");
      }

      const scripts = regexScriptsSvc.getActiveScripts(resolvedUserId, { characterId, chatId, target });
      this.postToWorker({
        type: "response",
        requestId,
        result: scripts.map((s) => this.toRegexScriptDTO(s)),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleRegexScriptsCreate(requestId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.name || typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Regex script name is required");
      }
      if (typeof input.find_regex !== "string") {
        throw new Error("find_regex is required");
      }

      const result = regexScriptsSvc.createRegexScript(resolvedUserId, input);
      if (typeof result === "string") throw new Error(result);
      this.postToWorker({ type: "response", requestId, result: this.toRegexScriptDTO(result) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleRegexScriptsUpdate(requestId: string, scriptId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const result = regexScriptsSvc.updateRegexScript(resolvedUserId, scriptId, input || {});
      if (result === null) throw new Error("Regex script not found");
      if (typeof result === "string") throw new Error(result);
      this.postToWorker({ type: "response", requestId, result: this.toRegexScriptDTO(result) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleRegexScriptsDelete(requestId: string, scriptId: string, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "regex_scripts")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} regex_scripts — Regex Scripts permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const deleted = regexScriptsSvc.deleteRegexScript(resolvedUserId, scriptId);
      this.postToWorker({ type: "response", requestId, result: deleted });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Dry Run (gated: "generation") ──────────────────────────────────

  private async handleGenerateDryRun(
    requestId: string,
    input: any,
    userId?: string,
  ): Promise<void> {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "generation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      if (!input?.chatId) throw new Error("chatId is required");

      const dryRunResult = await generateSvc.dryRunGeneration({
        userId: resolvedUserId,
        chat_id: input.chatId,
        connection_id: input.connectionId,
        persona_id: input.personaId,
        preset_id: input.presetId,
        generation_type: input.generationType,
        parameters: input.parameters,
      });

      // Map LlmMessage[] to LlmMessageDTO[] (flatten multipart content to string)
      const messagesDTO: LlmMessageDTO[] = dryRunResult.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === "string"
          ? m.content
          : m.content.map((p: any) => p.text || "").join(""),
        name: m.name,
      }));

      const result: DryRunResultDTO = {
        messages: messagesDTO,
        breakdown: (dryRunResult.breakdown || []).map((b) => ({
          type: b.type,
          name: b.name,
          role: b.role,
          content: b.content,
          blockId: b.blockId,
          marker: b.marker,
          messageCount: b.messageCount,
          firstMessageIndex: b.firstMessageIndex,
          preCountedTokens: b.preCountedTokens,
          excludeFromTotal: b.excludeFromTotal,
          extensionId: b.extensionId,
          extensionName: b.extensionName,
        })),
        parameters: dryRunResult.parameters,
        model: dryRunResult.model,
        provider: dryRunResult.provider,
        tokenCount: dryRunResult.tokenCount,
        worldInfoStats: dryRunResult.worldInfoStats,
        memoryStats: dryRunResult.memoryStats,
      };

      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Chat Memories (gated: "chats") ─────────────────────────────────

  private async handleChatsGetMemories(
    requestId: string,
    chatId: string,
    topK?: number,
    userId?: string,
  ): Promise<void> {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "chats")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chats — Chats permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const chat = chatsSvc.getChat(resolvedUserId, chatId);
      if (!chat) throw new Error("Chat not found");

      const messages = chatsSvc.getMessages(resolvedUserId, chatId);

      // Load chat memory settings the same way prompt-assembly does
      const chatMemSettingsRaw = settingsSvc.getSetting(resolvedUserId, "chatMemorySettings")?.value;
      const chatMemSettings = chatMemSettingsRaw
        ? embeddingsSvc.normalizeChatMemorySettings(chatMemSettingsRaw)
        : null;

      // Per-chat overrides from chat metadata
      let perChatOverrides = (chat.metadata?.memory_settings as any) ?? null;

      // Apply topK override from request
      if (topK != null && topK > 0) {
        perChatOverrides = { ...(perChatOverrides || {}), retrievalTopK: topK };
      }

      const memoryResult = await promptAssemblySvc.collectChatVectorMemory(
        resolvedUserId, chatId, messages, chatMemSettings, perChatOverrides,
      );

      const result: ChatMemoryResultDTO = {
        chunks: memoryResult.chunks.map((c) => ({
          content: c.content,
          score: c.score,
          metadata: (typeof c.metadata === "object" && c.metadata) ? c.metadata : {},
        })),
        formatted: memoryResult.formatted,
        count: memoryResult.count,
        enabled: memoryResult.enabled,
        queryPreview: memoryResult.queryPreview,
        settingsSource: memoryResult.settingsSource,
        chunksAvailable: memoryResult.chunksAvailable,
        chunksPending: memoryResult.chunksPending,
      };

      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Toast (free tier) ───────────────────────────────────────────────

  private handleToastShow(
    toastType: string,
    message: string,
    title?: string,
    duration?: number,
    userId?: string,
  ): void {
    const validTypes = ["success", "warning", "error", "info"];
    if (!validTypes.includes(toastType)) {
      console.warn(`[Spindle:${this.manifest.identifier}] Invalid toast type: ${toastType}`);
      return;
    }

    if (typeof message !== "string" || !message.trim()) {
      console.warn(`[Spindle:${this.manifest.identifier}] Toast message must be a non-empty string`);
      return;
    }

    // Sliding-window rate limit
    const now = Date.now();
    this.toastTimestamps = this.toastTimestamps.filter(
      (t) => now - t < WorkerHost.TOAST_RATE_WINDOW_MS,
    );
    if (this.toastTimestamps.length >= WorkerHost.TOAST_RATE_LIMIT) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Toast rate limit exceeded (${WorkerHost.TOAST_RATE_LIMIT}/${WorkerHost.TOAST_RATE_WINDOW_MS}ms)`,
      );
      return;
    }
    this.toastTimestamps.push(now);

    // Sanitize inputs
    const sanitizedMessage = message.slice(0, 500);
    const sanitizedTitle = title ? title.slice(0, 100) : undefined;
    let sanitizedDuration = duration;
    if (sanitizedDuration !== undefined) {
      sanitizedDuration = Math.max(1000, Math.min(30_000, sanitizedDuration));
    }

    let targetUserId: string | undefined;
    if (this.installScope === "user") {
      targetUserId = this.installedByUserId ?? undefined;
    } else if (typeof userId === "string" && userId.trim()) {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId) {
        this.enforceScopedUser(resolvedUserId);
        targetUserId = resolvedUserId;
      }
    }

    // Broadcast only when an operator-scoped extension omits userId.
    eventBus.emit(
      EventType.SPINDLE_TOAST,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        type: toastType,
        message: sanitizedMessage,
        title: sanitizedTitle,
        duration: sanitizedDuration,
      },
      targetUserId,
    );
  }

  // ─── Commands (free tier) ─────────────────────────────────────────────

  private handleCommandsRegister(commands: SpindleCommandDTO[]): void {
    if (!Array.isArray(commands)) {
      console.warn(`[Spindle:${this.manifest.identifier}] commands_register: expected array`);
      return;
    }

    if (commands.length > WorkerHost.MAX_COMMANDS_PER_EXTENSION) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Command limit exceeded (${commands.length}/${WorkerHost.MAX_COMMANDS_PER_EXTENSION}), truncating`,
      );
      commands = commands.slice(0, WorkerHost.MAX_COMMANDS_PER_EXTENSION);
    }

    // Validate and sanitize each command
    const validated: SpindleCommandDTO[] = [];
    const seenIds = new Set<string>();
    const validScopes = ["global", "chat", "chat-idle", "landing", "character"];

    for (const cmd of commands) {
      if (!cmd || typeof cmd.id !== "string" || !cmd.id.trim()) continue;
      if (!cmd.label || typeof cmd.label !== "string") continue;
      if (seenIds.has(cmd.id)) continue;
      seenIds.add(cmd.id);

      validated.push({
        id: cmd.id.slice(0, 100),
        label: (cmd.label || "").slice(0, 80),
        description: (cmd.description || "").slice(0, 200),
        keywords: Array.isArray(cmd.keywords)
          ? cmd.keywords.filter((k): k is string => typeof k === "string").slice(0, 10).map((k) => k.slice(0, 30))
          : undefined,
        scope: validScopes.includes(cmd.scope as string) ? cmd.scope : undefined,
      });
    }

    this.registeredCommands = validated;
    this.broadcastCommandsChanged();
  }

  private handleCommandsUnregister(commandIds: string[]): void {
    if (!Array.isArray(commandIds) || commandIds.length === 0) {
      // Remove all commands
      this.registeredCommands = [];
    } else {
      const idsToRemove = new Set(commandIds.filter((id) => typeof id === "string"));
      this.registeredCommands = this.registeredCommands.filter((c) => !idsToRemove.has(c.id));
    }
    this.broadcastCommandsChanged();
  }

  private broadcastCommandsChanged(): void {
    eventBus.emit(
      EventType.SPINDLE_COMMANDS_CHANGED,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        commands: this.registeredCommands,
      },
      this.installScope === "user" ? this.installedByUserId ?? undefined : undefined,
    );
  }

  /** Called by the WS handler when the frontend invokes a command. */
  invokeCommand(commandId: string, context: SpindleCommandContextDTO, userId: string): void {
    if (!this.runtime) return;
    if (!this.registeredCommands.some((c) => c.id === commandId)) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Command "${commandId}" not registered`,
      );
      return;
    }
    this.postToWorker({
      type: "command_invoked",
      commandId,
      context,
      userId,
    });
  }

  /** Expose registered commands for lookup from the WS handler. */
  getRegisteredCommands(): SpindleCommandDTO[] {
    return this.registeredCommands;
  }

  // ─── Logging ─────────────────────────────────────────────────────────

  private handleLog(level: "info" | "warn" | "error", message: string): void {
    // Detect the ready signal from the worker
    if (message === "__worker_ready__") {
      this.onWorkerReady?.();
      this.onWorkerReady = null;
      return;
    }

    // Detect the shutdown acknowledgement so stop() can resolve promptly
    // instead of always waiting for the 5s fallback timeout.
    if (message === "__worker_shutdown_ack__") {
      this.onWorkerShutdownAck?.();
      this.onWorkerShutdownAck = null;
      return;
    }

    const prefix = `[Spindle:${this.manifest.identifier}]`;
    switch (level) {
      case "info":
        console.log(prefix, message);
        break;
      case "warn":
        console.warn(prefix, message);
        break;
      case "error":
        console.error(prefix, message);
        break;
    }
  }

  // ─── Push Notifications (gated: "push_notification") ─────────────────

  private async handlePushSend(
    requestId: string,
    title: string,
    body: string,
    tag?: string,
    url?: string,
    userId?: string,
    icon?: string,
    rawTitle?: boolean,
    image?: string,
  ): Promise<void> {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "push_notification")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} push_notification — Push notification permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      // Build the payload and enforce the 4 KB Web Push payload limit
      const sanitizedTitle = rawTitle
        ? (title || "").slice(0, 200)
        : `${this.manifest.name}: ${(title || "").slice(0, 200)}`;

      // Validate icon URL — must be a relative path (no external URLs)
      let sanitizedIcon: string | undefined;
      if (icon && typeof icon === "string" && icon.startsWith("/")) {
        sanitizedIcon = icon;
      }

      // Validate image URL — must be a relative path (no external URLs)
      let sanitizedImage: string | undefined;
      if (image && typeof image === "string" && image.startsWith("/")) {
        sanitizedImage = image;
      }

      const payload = {
        title: sanitizedTitle,
        body: body || "",
        tag: tag ? `ext-${this.manifest.identifier}-${tag}`.slice(0, 100) : undefined,
        data: {
          url: normalizeSpindleAppNavigationPath(url),
          characterName: this.manifest.name,
        },
        icon: sanitizedIcon,
        image: sanitizedImage,
      };

      // Truncate body if the total payload exceeds PushForge's limit
      // (4078 bytes minus 2 bytes padding prefix = 4076 bytes usable)
      const MAX_PAYLOAD_BYTES = 4076;
      const encoder = new TextEncoder();
      const measure = () => encoder.encode(JSON.stringify(payload)).byteLength;

      if (measure() > MAX_PAYLOAD_BYTES) {
        // Calculate how many bytes are available for the body
        const withoutBody = { ...payload, body: "" };
        const overhead = encoder.encode(JSON.stringify(withoutBody)).byteLength;
        const available = MAX_PAYLOAD_BYTES - overhead - 10; // 10 bytes margin for ellipsis + quotes

        // Binary search for the right body length
        let lo = 0, hi = payload.body.length;
        while (lo < hi) {
          const mid = (lo + hi + 1) >>> 1;
          const candidate = { ...payload, body: payload.body.slice(0, mid) };
          if (encoder.encode(JSON.stringify(candidate)).byteLength <= MAX_PAYLOAD_BYTES) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }

        if (lo < payload.body.length) {
          // Try to break at a sentence boundary
          let trimmed = payload.body.slice(0, lo);
          const lastSentence = Math.max(
            trimmed.lastIndexOf('. '),
            trimmed.lastIndexOf('! '),
            trimmed.lastIndexOf('? '),
          );
          if (lastSentence > lo * 0.5) {
            trimmed = trimmed.slice(0, lastSentence + 1);
          }
          payload.body = trimmed;
        }
      }

      const pushSvc = await import("../services/push.service");
      const sent = await pushSvc.sendPushToUser(resolvedUserId, payload);
      this.postToWorker({ type: "response", requestId, result: { sent } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handlePushGetStatus(requestId: string, userId?: string): Promise<void> {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "push_notification")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} push_notification — Push notification permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const pushSvc = await import("../services/push.service");
      const subs = pushSvc.listSubscriptions(resolvedUserId);
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          available: subs.length > 0,
          subscriptionCount: subs.length,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── User Visibility (free tier) ────────────────────────────────────

  private handleUserIsVisible(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.postToWorker({
        type: "response",
        requestId,
        result: eventBus.isUserVisible(resolvedUserId),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Token Counting (free tier) ─────────────────────────────────────

  private normalizeTokenCountMessages(
    messages: Array<Pick<LlmMessageDTO, "role" | "content">>
  ): tokenizerSvc.TokenCountMessageLike[] {
    if (!Array.isArray(messages)) {
      throw new Error("messages must be an array");
    }

    return messages.map((message, index) => {
      const role = message?.role;
      const content = message?.content;
      if (role !== "system" && role !== "user" && role !== "assistant") {
        throw new Error(`messages[${index}].role must be system, user, or assistant`);
      }
      if (typeof content !== "string") {
        throw new Error(`messages[${index}].content must be a string`);
      }
      return { role, content };
    });
  }

  private async resolveTokenCountModel(
    userId: string,
    explicitModel?: string,
    modelSource: TokenModelSource = "main"
  ): Promise<{ model: string; modelSource: TokenModelSource }> {
    if (explicitModel !== undefined) {
      const model = String(explicitModel).trim();
      if (!model) {
        throw new Error("model must be a non-empty string");
      }
      return { model, modelSource: "explicit" };
    }

    if (modelSource === "sidecar") {
      const sidecar = getSidecarSettings(userId);
      if (!sidecar.connectionProfileId) {
        throw new Error("No sidecar connection configured");
      }

      const connection = connectionsSvc.getConnection(userId, sidecar.connectionProfileId);
      if (!connection) {
        throw new Error("Selected sidecar connection not found");
      }

      const model = String(sidecar.model || connection.model || "").trim();
      if (!model) {
        throw new Error("Selected sidecar connection does not have a model configured");
      }

      return { model, modelSource: "sidecar" };
    }

    const connection = connectionsSvc.getDefaultConnection(userId);
    if (!connection) {
      throw new Error("No default connection configured");
    }

    const model = String(connection.model || "").trim();
    if (!model) {
      throw new Error("Default connection does not have a model configured");
    }

    return { model, modelSource: "main" };
  }

  private async buildTokenCountResult(
    userId: string,
    input: string | tokenizerSvc.TokenCountMessageLike[],
    explicitModel?: string,
    modelSource: TokenModelSource = "main"
  ): Promise<TokenCountResult> {
    const { model, modelSource: resolvedSource } = await this.resolveTokenCountModel(userId, explicitModel, modelSource);
    const tokenizerId = tokenizerSvc.getTokenizerIdForModel(model);
    const { count, name } = await tokenizerSvc.resolveCounter(model);
    const text = Array.isArray(input)
      ? tokenizerSvc.flattenMessagesForTokenCount(input)
      : input;

    return {
      total_tokens: count(text),
      model,
      modelSource: resolvedSource,
      tokenizer_id: tokenizerId,
      tokenizer_name: name,
      approximate: name === tokenizerSvc.APPROXIMATE_TOKENIZER_NAME,
    };
  }

  private async handleTokensCountText(
    requestId: string,
    text: string,
    model?: string,
    modelSource?: TokenModelSource,
    userId?: string
  ): Promise<void> {
    try {
      if (typeof text !== "string") {
        throw new Error("text must be a string");
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const result = await this.buildTokenCountResult(resolvedUserId, text, model, modelSource);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleTokensCountMessages(
    requestId: string,
    messages: Array<Pick<LlmMessageDTO, "role" | "content">>,
    model?: string,
    modelSource?: TokenModelSource,
    userId?: string
  ): Promise<void> {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const normalized = this.normalizeTokenCountMessages(messages);
      const result = await this.buildTokenCountResult(resolvedUserId, normalized, model, modelSource);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleTokensCountChat(
    requestId: string,
    chatId: string,
    model?: string,
    modelSource?: TokenModelSource,
    userId?: string
  ): Promise<void> {
    try {
      const chatOwnerId = this.getChatOwnerId(chatId);
      if (!chatOwnerId) throw new Error("Chat not found");
      this.enforceScopedUser(chatOwnerId);

      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId && resolvedUserId !== chatOwnerId) {
        throw new Error("chatId does not belong to the requested userId");
      }

      const messages = getChatMessages(chatOwnerId, chatId).map((message) => ({
        role: this.mapChatRole(message.is_user, (message.extra || {}) as Record<string, unknown>),
        content: message.content,
      }));

      const result = await this.buildTokenCountResult(chatOwnerId, messages, model, modelSource);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Frontend Process Lifecycle (free tier) ─────────────────────────

  private handleFrontendProcessSpawn(
    requestId: string,
    options: {
      kind: string;
      key?: string;
      payload?: unknown;
      metadata?: Record<string, unknown>;
      userId?: string;
      startupTimeoutMs?: number;
      heartbeatTimeoutMs?: number;
      replaceExisting?: boolean;
    }
  ): void {
    try {
      const kind = typeof options?.kind === "string" ? options.kind.trim() : "";
      if (!kind) throw new Error("kind is required");

      const userId = this.resolveFrontendProcessUserId(options?.userId);
      const processId = crypto.randomUUID();
      const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : undefined;
      const startupTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(options?.startupTimeoutMs ?? 15_000)));
      const heartbeatTimeoutMs = Math.max(0, Math.min(120_000, Math.round(options?.heartbeatTimeoutMs ?? 15_000)));

      if (key) {
        const dedupeKey = this.buildFrontendProcessKey(userId, kind, key);
        const existingId = this.frontendProcessKeyIndex.get(dedupeKey);
        if (existingId) {
          const existing = this.frontendProcesses.get(existingId);
          if (existing) {
            if (!options?.replaceExisting) {
              throw new Error(`Frontend process already exists for kind \"${kind}\" and key \"${key}\"`);
            }
            this.requestFrontendProcessStop(existing, "replaced");
            if (existing.state === "starting") {
              this.rejectRequest(existing.requestId, new Error("Frontend process was replaced before it became ready"));
            }
            this.finalizeFrontendProcess(existing, "stopped", "replaced");
          }
        }
      }

      const record: FrontendProcessRecord = {
        requestId,
        processId,
        kind,
        ...(key ? { key } : {}),
        state: "starting",
        userId,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        startedAt: new Date().toISOString(),
        startupTimer: null,
        heartbeatTimer: null,
        startupTimeoutMs,
        heartbeatTimeoutMs,
      };

      this.frontendProcesses.set(processId, record);
      if (key) {
        this.frontendProcessKeyIndex.set(
          this.buildFrontendProcessKey(userId, kind, key),
          processId
        );
      }

      this.emitFrontendProcessLifecycle(record);

      record.startupTimer = setTimeout(() => {
        const latest = this.frontendProcesses.get(processId);
        if (!latest || latest.state !== "starting") return;
        this.requestFrontendProcessStop(latest, "timed_out");
        this.finalizeFrontendProcess(latest, "timed_out", "timed_out", "Frontend process startup timed out");
        this.rejectRequest(requestId, new Error("Frontend process startup timed out"));
      }, startupTimeoutMs);

      this.sendFrontendProcessEvent(userId, {
        action: "spawn",
        processId,
        kind,
        ...(key ? { key } : {}),
        payload: options?.payload,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleFrontendProcessList(
    requestId: string,
    filter?: { userId?: string; kind?: string; key?: string; state?: FrontendProcessState }
  ): void {
    try {
      const userId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof filter?.userId === "string" && filter.userId.trim()
            ? filter.userId.trim()
            : undefined;
      const items = Array.from(this.frontendProcesses.values())
        .filter((record) => {
          if (userId && record.userId !== userId) return false;
          if (filter?.kind && record.kind !== filter.kind) return false;
          if (filter?.key && record.key !== filter.key) return false;
          if (filter?.state && record.state !== filter.state) return false;
          return true;
        })
        .map((record) => this.snapshotFrontendProcess(record));
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleFrontendProcessGet(requestId: string, processId: string): void {
    try {
      const record = this.getFrontendProcessRecord(processId);
      this.postToWorker({
        type: "response",
        requestId,
        result: record ? this.snapshotFrontendProcess(record) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleFrontendProcessStop(
    requestId: string,
    processId: string,
    options?: { userId?: string; reason?: string }
  ): void {
    try {
      const record = this.getFrontendProcessRecord(processId);
      if (!record) {
        this.postToWorker({ type: "response", requestId, result: undefined });
        return;
      }
      const resolvedUserId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof options?.userId === "string" && options.userId.trim()
            ? options.userId.trim()
            : undefined;
      if (resolvedUserId && record.userId !== resolvedUserId) {
        throw new Error("processId does not belong to the requested userId");
      }
      if (record.state === "starting" || record.state === "running") {
        record.stopReason = options?.reason;
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        this.transitionFrontendProcess(record, "stopping");
      }
      this.requestFrontendProcessStop(record, options?.reason ?? "stopped");
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleFrontendProcessSend(processId: string, payload: unknown, userId?: string): void {
    const record = this.getFrontendProcessRecord(processId);
    if (!record) return;
    if (this.installScope === "operator" && userId && record.userId !== userId) return;
    this.sendFrontendProcessEvent(record.userId ?? this.resolveFrontendProcessUserId(userId), {
      action: "message",
      processId,
      payload,
    });
  }

  private async handleBackendProcessSpawn(
    requestId: string,
    options: {
      entry: string;
      kind?: string;
      key?: string;
      payload?: unknown;
      metadata?: Record<string, unknown>;
      userId?: string;
      startupTimeoutMs?: number;
      heartbeatTimeoutMs?: number;
      replaceExisting?: boolean;
    }
  ): Promise<void> {
    try {
      const entryPath = await this.resolveBackendProcessEntryPath(options?.entry ?? "");
      const entry = typeof options?.entry === "string" ? options.entry.trim().replace(/\\/g, "/") : "";
      const kind = typeof options?.kind === "string" && options.kind.trim() ? options.kind.trim() : entry;
      const userId = this.resolveFrontendProcessUserId(options?.userId);
      const processId = crypto.randomUUID();
      const key = typeof options?.key === "string" && options.key.trim() ? options.key.trim() : undefined;
      const startupTimeoutMs = Math.max(1_000, Math.min(120_000, Math.round(options?.startupTimeoutMs ?? 15_000)));
      const heartbeatTimeoutMs = Math.max(0, Math.min(120_000, Math.round(options?.heartbeatTimeoutMs ?? 15_000)));

      if (key) {
        const dedupeKey = this.buildBackendProcessKey(userId, kind, key);
        const existingId = this.backendProcessKeyIndex.get(dedupeKey);
        if (existingId) {
          const existing = this.backendProcesses.get(existingId);
          if (existing) {
            if (!options?.replaceExisting) {
              throw new Error(`Backend process already exists for kind \"${kind}\" and key \"${key}\"`);
            }
            if (existing.state === "starting") {
              this.rejectRequest(existing.requestId, new Error("Backend process was replaced before it became ready"));
            }
            this.clearBackendProcessTimers(existing);
            try {
              existing.runtime.terminate(true);
            } catch {
              // ignore
            }
            this.finalizeBackendProcess(existing, "stopped", "replaced");
          }
        }
      }

      if (this.backendProcesses.size >= WorkerHost.MAX_BACKEND_PROCESSES) {
        throw new Error(`Backend process limit reached (${WorkerHost.MAX_BACKEND_PROCESSES})`);
      }

      const runtimePath = join(import.meta.dir, "backend-process-runtime.ts");
      const storagePath = this.getStorageRootPath(this.manifest.identifier);
      const repoPath = managerSvc.getRepoPath(this.manifest.identifier);
      const runtime = createRuntimeTransport({
        runtimePath,
        extensionIdentifier: this.manifest.identifier,
        repoPath,
        storagePath,
        mode: this.getBackendProcessRuntimeMode(),
        onMessage: (message) => {
          this.handleBackendProcessRuntimeMessage(processId, message as BackendProcessRuntimeToHost);
        },
        onError: (message) => {
          const record = this.backendProcesses.get(processId);
          if (!record) return;
          this.finalizeBackendProcess(record, "failed", "failed", message);
        },
        onExit: (exitCode, signalCode, error) => {
          this.handleBackendProcessRuntimeExit(processId, exitCode, signalCode, error);
        },
      });

      const record: BackendProcessRecord = {
        requestId,
        runtime,
        processId,
        entry,
        kind,
        ...(key ? { key } : {}),
        state: "starting",
        userId,
        ...(options?.metadata ? { metadata: options.metadata } : {}),
        startedAt: new Date().toISOString(),
        startupTimer: null,
        heartbeatTimer: null,
        stopTimer: null,
        startupTimeoutMs,
        heartbeatTimeoutMs,
      };

      this.backendProcesses.set(processId, record);
      if (key) {
        this.backendProcessKeyIndex.set(
          this.buildBackendProcessKey(userId, kind, key),
          processId
        );
      }

      this.emitBackendProcessLifecycle(record);

      record.startupTimer = setTimeout(() => {
        const latest = this.backendProcesses.get(processId);
        if (!latest || latest.state !== "starting") return;
        try {
          latest.runtime.terminate(true);
        } catch {
          // ignore
        }
        this.finalizeBackendProcess(latest, "timed_out", "timed_out", "Backend process startup timed out");
        this.rejectRequest(requestId, new Error("Backend process startup timed out"));
      }, startupTimeoutMs);

      runtime.postMessage({
        type: "init",
        process: {
          processId,
          entry,
          entryPath,
          kind,
          ...(key ? { key } : {}),
          payload: options?.payload,
          ...(options?.metadata ? { metadata: options.metadata } : {}),
          ...(userId ? { userId } : {}),
        },
      } satisfies HostToBackendProcessRuntime);
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleBackendProcessList(
    requestId: string,
    filter?: { userId?: string; kind?: string; key?: string; state?: BackendProcessState }
  ): void {
    try {
      const userId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof filter?.userId === "string" && filter.userId.trim()
            ? filter.userId.trim()
            : undefined;
      const items = Array.from(this.backendProcesses.values())
        .filter((record) => {
          if (userId && record.userId !== userId) return false;
          if (filter?.kind && record.kind !== filter.kind) return false;
          if (filter?.key && record.key !== filter.key) return false;
          if (filter?.state && record.state !== filter.state) return false;
          return true;
        })
        .map((record) => this.snapshotBackendProcess(record));
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleBackendProcessGet(requestId: string, processId: string): void {
    try {
      const record = this.getBackendProcessRecord(processId);
      this.postToWorker({
        type: "response",
        requestId,
        result: record ? this.snapshotBackendProcess(record) : null,
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleBackendProcessStop(
    requestId: string,
    processId: string,
    options?: { userId?: string; reason?: string }
  ): void {
    try {
      const record = this.getBackendProcessRecord(processId);
      if (!record) {
        this.postToWorker({ type: "response", requestId, result: undefined });
        return;
      }
      const resolvedUserId =
        this.installScope === "user"
          ? this.installedByUserId ?? undefined
          : typeof options?.userId === "string" && options.userId.trim()
            ? options.userId.trim()
            : undefined;
      if (resolvedUserId && record.userId !== resolvedUserId) {
        throw new Error("processId does not belong to the requested userId");
      }
      if (record.state === "starting" || record.state === "running") {
        record.stopReason = options?.reason;
        if (record.startupTimer) {
          clearTimeout(record.startupTimer);
          record.startupTimer = null;
        }
        this.transitionBackendProcess(record, "stopping");
        this.armBackendStopTimer(record);
      }
      record.runtime.postMessage({
        type: "stop",
        ...(options?.reason ? { reason: options.reason } : {}),
      } satisfies HostToBackendProcessRuntime);
      this.postToWorker({ type: "response", requestId, result: undefined });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleBackendProcessSend(processId: string, payload: unknown, userId?: string): void {
    const record = this.getBackendProcessRecord(processId);
    if (!record) return;
    if (this.installScope === "operator" && userId && record.userId !== userId) return;
    record.runtime.postMessage({ type: "message", payload } satisfies HostToBackendProcessRuntime);
  }

  // ─── Version (free tier) ────────────────────────────────────────────

  private async handleVersionGetBackend(requestId: string): Promise<void> {
    try {
      const version = await getBackendVersion();
      this.postToWorker({ type: "response", requestId, result: version });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleVersionGetFrontend(requestId: string): Promise<void> {
    try {
      const version = await getFrontendVersion();
      this.postToWorker({ type: "response", requestId, result: version });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Text Editor (free tier) ────────────────────────────────────────

  private handleTextEditorOpen(
    requestId: string,
    title?: string,
    value?: string,
    placeholder?: string,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      const editorRequestId = `spindle-editor:${this.extensionId}:${requestId}`;

      // Listen for the result from the frontend
      const unsub = eventBus.on(EventType.SPINDLE_TEXT_EDITOR_RESULT, (msg) => {
        if (msg.payload?.requestId !== editorRequestId) return;
        unsub();
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            text: msg.payload.text ?? value ?? "",
            cancelled: !!msg.payload.cancelled,
          },
        });
      });

      // Send the open request to the user's frontend
      eventBus.emit(
        EventType.SPINDLE_TEXT_EDITOR_OPEN,
        {
          requestId: editorRequestId,
          extensionId: this.extensionId,
          title: title ?? "Edit Text",
          value: value ?? "",
          placeholder: placeholder ?? "",
        },
        resolvedUserId,
      );
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Modal (free tier) ──────────────────────────────────────────────

  private handleModalOpen(
    requestId: string,
    title: string,
    items: any[],
    width?: number,
    maxHeight?: number,
    persistent?: boolean,
    userId?: string,
    callerModalRequestId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      const modalRequestId = callerModalRequestId
        ? `spindle-modal:${this.extensionId}:${callerModalRequestId}`
        : `spindle-modal:${this.extensionId}:${requestId}`;

      const unsub = eventBus.on(EventType.SPINDLE_MODAL_RESULT, (msg) => {
        if (msg.payload?.requestId !== modalRequestId) return;
        unsub();
        this.postToWorker({
          type: "response",
          requestId,
          result: { dismissedBy: msg.payload.dismissedBy ?? "user" },
        });
      });

      eventBus.emit(
        EventType.SPINDLE_MODAL_OPEN,
        {
          requestId: modalRequestId,
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          title,
          items,
          width,
          maxHeight,
          persistent: persistent ?? false,
        },
        resolvedUserId,
      );
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleModalClose(
    requestId: string,
    openRequestId: string,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      const modalRequestId = `spindle-modal:${this.extensionId}:${openRequestId}`;

      eventBus.emit(
        EventType.SPINDLE_MODAL_RESULT,
        { requestId: modalRequestId, dismissedBy: "extension" },
        resolvedUserId,
      );

      this.postToWorker({ type: "response", requestId, result: undefined });
      } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleConfirmOpen(
    requestId: string,
    title: string,
    message: string,
    variant?: string,
    confirmLabel?: string,
    cancelLabel?: string,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      const confirmRequestId = `spindle-confirm:${this.extensionId}:${requestId}`;

      const unsub = eventBus.on(EventType.SPINDLE_CONFIRM_RESULT, (msg) => {
        if (msg.payload?.requestId !== confirmRequestId) return;
        unsub();
        this.postToWorker({
          type: "response",
          requestId,
          result: { confirmed: !!msg.payload.confirmed },
        });
      });

      eventBus.emit(
        EventType.SPINDLE_CONFIRM_OPEN,
        {
          requestId: confirmRequestId,
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          title,
          message,
          variant: variant ?? "info",
          confirmLabel: confirmLabel ?? "Confirm",
          cancelLabel: cancelLabel ?? "Cancel",
        },
        resolvedUserId,
      );
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleInputPromptOpen(
    requestId: string,
    title: string,
    message?: string,
    placeholder?: string,
    defaultValue?: string,
    submitLabel?: string,
    cancelLabel?: string,
    multiline?: boolean,
    userId?: string,
  ): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      const promptRequestId = `spindle-input-prompt:${this.extensionId}:${requestId}`;

      const unsub = eventBus.on(EventType.SPINDLE_INPUT_PROMPT_RESULT, (msg) => {
        if (msg.payload?.requestId !== promptRequestId) return;
        unsub();
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            value: msg.payload.cancelled ? null : (msg.payload.value ?? null),
            cancelled: !!msg.payload.cancelled,
          },
        });
      });

      eventBus.emit(
        EventType.SPINDLE_INPUT_PROMPT_OPEN,
        {
          requestId: promptRequestId,
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          title,
          message,
          placeholder,
          defaultValue,
          submitLabel: submitLabel ?? "Submit",
          cancelLabel: cancelLabel ?? "Cancel",
          multiline: !!multiline,
        },
        resolvedUserId,
      );
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Macro Resolution (free tier) ───────────────────────────────────

  private async handleMacrosResolve(
    requestId: string,
    template: string,
    chatId?: string,
    characterId?: string,
    userId?: string,
    commit = true,
  ): Promise<void> {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      if (!template) {
        this.postToWorker({ type: "response", requestId, result: { text: "", diagnostics: [] } });
        return;
      }

      const { evaluate, buildEnv, initMacros, registry } = await import("../macros");
      initMacros();

      const chatsSvc = await import("../services/chats.service");
      const charactersSvc = await import("../services/characters.service");
      const personasSvc = await import("../services/personas.service");
      const connectionsSvc = await import("../services/connections.service");

      let env;

      if (chatId) {
        const chat = chatsSvc.getChat(resolvedUserId, chatId);
        if (chat) {
          const charId = characterId || chat.character_id;
          const character = charactersSvc.getCharacter(resolvedUserId, charId);
          if (character) {
            const persona = personasSvc.resolvePersonaOrDefault(resolvedUserId);
            const messages = chatsSvc.getMessages(resolvedUserId, chatId);
            const connection = connectionsSvc.getDefaultConnection(resolvedUserId);

            env = buildEnv({
              character,
              persona,
              chat,
              messages,
              generationType: "normal",
              commit,
              connection,
            });
          }
        }
      }

      if (!env && characterId) {
        const character = charactersSvc.getCharacter(resolvedUserId, characterId);
        if (character) {
          const persona = personasSvc.resolvePersonaOrDefault(resolvedUserId);
          const connection = connectionsSvc.getDefaultConnection(resolvedUserId);

          env = buildEnv({
            character,
            persona,
            chat: { id: "", character_id: character.id, name: "", metadata: {}, created_at: 0, updated_at: 0 } as any,
            messages: [],
            generationType: "normal",
            commit,
            connection,
          });
        }
      }

      if (!env) {
        // Minimal fallback
        const persona = personasSvc.getDefaultPersona(resolvedUserId);
        const connection = connectionsSvc.getDefaultConnection(resolvedUserId);
        env = {
          commit,
          names: {
            user: persona?.name || "User", char: "", group: "", groupNotMuted: "", notChar: persona?.name || "User",
            charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", groupLastSpeaker: "",
          },
          character: {
            name: "", description: "", personality: "", scenario: "", persona: persona?.description || "",
            personaSubjectivePronoun: persona?.subjective_pronoun || "",
            personaObjectivePronoun: persona?.objective_pronoun || "",
            personaPossessivePronoun: persona?.possessive_pronoun || "",
            mesExamples: "", mesExamplesRaw: "", systemPrompt: "", postHistoryInstructions: "",
            depthPrompt: "", creatorNotes: "", version: "", creator: "", firstMessage: "",
          },
          chat: {
            id: "", messageCount: 0, lastMessage: "", lastMessageName: "", lastUserMessage: "",
            lastCharMessage: "", lastMessageId: -1, firstIncludedMessageId: -1, lastSwipeId: 0, currentSwipeId: 0,
          },
          system: {
            model: connection?.model || "", maxPrompt: 0, maxContext: 0, maxResponse: 0,
            lastGenerationType: "normal", isMobile: false,
          },
          variables: { local: new Map(), global: new Map(), chat: new Map() },
          dynamicMacros: {},
          extra: {},
        };
      }

      const result = await evaluate(template, env, registry);
      this.postToWorker({ type: "response", requestId, result: { text: result.text, diagnostics: result.diagnostics } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Theme (gated: "app_manipulation") ──────────────────────────────

  /** Active CSS variable overrides for this extension, keyed by effective userId. */
  private themeOverrides = new Map<string, ThemeOverrideDTO>();

  private handleThemeApply(requestId: string, overrides: ThemeOverrideDTO, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme manipulation requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      // Validate: variables must be a Record<string, string> if provided
      if (overrides.variables) {
        if (typeof overrides.variables !== "object" || Array.isArray(overrides.variables)) {
          this.postToWorker({ type: "response", requestId, error: "overrides.variables must be an object" });
          return;
        }
        // Only allow CSS custom property keys (--*) and validate each value
        for (const [key, value] of Object.entries(overrides.variables)) {
          if (!key.startsWith("--")) {
            this.postToWorker({ type: "response", requestId, error: `Invalid CSS variable key: "${key}" (must start with --)` });
            return;
          }
          const issue = validateCssValue(value);
          if (issue) {
            this.postToWorker({ type: "response", requestId, error: `Invalid CSS value for "${key}": ${issue}` });
            return;
          }
        }
        // Limit to 200 variables per extension
        if (Object.keys(overrides.variables).length > 200) {
          this.postToWorker({ type: "response", requestId, error: "Too many variables (max 200)" });
          return;
        }
      }

      // Validate variablesByMode if provided
      if (overrides.variablesByMode) {
        for (const modeKey of ["dark", "light"] as const) {
          const modeVars = overrides.variablesByMode[modeKey];
          if (modeVars) {
            if (typeof modeVars !== "object" || Array.isArray(modeVars)) {
              this.postToWorker({ type: "response", requestId, error: `variablesByMode.${modeKey} must be an object` });
              return;
            }
            for (const [key, value] of Object.entries(modeVars)) {
              if (!key.startsWith("--")) {
                this.postToWorker({ type: "response", requestId, error: `Invalid CSS variable key in variablesByMode.${modeKey}: "${key}"` });
                return;
              }
              const issue = validateCssValue(value);
              if (issue) {
                this.postToWorker({ type: "response", requestId, error: `Invalid CSS value in variablesByMode.${modeKey}["${key}"]: ${issue}` });
                return;
              }
            }
          }
        }
      }

      this.commitThemeOverrides(resolvedUserId, overrides);

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private shouldReplaceThemeScope(vars?: Record<string, string>): boolean {
    if (!vars) return false;

    const keys = Object.keys(vars);
    if (keys.length >= WorkerHost.FULL_THEME_MIN_KEYS) {
      return true;
    }

    return WorkerHost.FULL_THEME_SENTINEL_KEYS.every((key) => key in vars);
  }

  private commitThemeOverrides(userId: string, overrides: ThemeOverrideDTO): void {
    const current = this.themeOverrides.get(userId);
    const existingByMode = current?.variablesByMode ?? {};
    const nextVariables = this.shouldReplaceThemeScope(overrides.variables)
      ? { ...(overrides.variables ?? {}) }
      : {
          ...(current?.variables ?? {}),
          ...(overrides.variables ?? {}),
        };
    const nextDarkVars = overrides.variablesByMode?.dark
      ? this.shouldReplaceThemeScope(overrides.variablesByMode.dark)
        ? { ...overrides.variablesByMode.dark }
        : { ...existingByMode.dark, ...overrides.variablesByMode.dark }
      : existingByMode.dark;
    const nextLightVars = overrides.variablesByMode?.light
      ? this.shouldReplaceThemeScope(overrides.variablesByMode.light)
        ? { ...overrides.variablesByMode.light }
        : { ...existingByMode.light, ...overrides.variablesByMode.light }
      : existingByMode.light;

    const nextOverrides: ThemeOverrideDTO = {
      variables: nextVariables,
      variablesByMode: (nextDarkVars || nextLightVars)
        ? {
            dark: nextDarkVars,
            light: nextLightVars,
          }
        : undefined,
    };

    this.themeOverrides.set(userId, nextOverrides);

    eventBus.emit(
      EventType.SPINDLE_THEME_OVERRIDES,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        overrides: nextOverrides,
      },
      userId,
    );
  }

  private handleThemeApplyPalette(
    requestId: string,
    palette: { accent?: { h?: number; s?: number; l?: number } } | null | undefined,
    userId?: string,
  ): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme palette application requires the app_manipulation permission`,
      });
      return;
    }

    try {
      if (palette == null) {
        this.handleThemeClear(requestId, userId);
        return;
      }

      if (!palette.accent || typeof palette.accent.h !== "number" || typeof palette.accent.s !== "number" || typeof palette.accent.l !== "number") {
        this.postToWorker({ type: "response", requestId, error: "palette.accent must be { h: number, s: number, l: number }" });
        return;
      }
      const accent: { h: number; s: number; l: number } = {
        h: palette.accent.h,
        s: palette.accent.s,
        l: palette.accent.l,
      };

      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      this.emitPaletteColorOverrides(accent, resolvedUserId);

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Theme palette application failed" });
    }
  }

  private handleThemeClear(requestId: string, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme manipulation requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      this.themeOverrides.delete(resolvedUserId);

      // Broadcast clear to frontend
      eventBus.emit(
        EventType.SPINDLE_THEME_OVERRIDES,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          overrides: null,
        },
        resolvedUserId,
      );

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  /**
   * Generate color-only theme variables from an accent and emit per-user.
   *
   * Each user's `enableGlass` is read so color variables that encode
   * glass-dependent alpha (--lumiverse-bg, --lcs-glass-bg, etc.) get the
   * correct opacity. User preference keys (blur, radii, fonts, scale,
   * transitions) are stripped — applyPalette only changes colors.
   */
  private emitPaletteColorOverrides(accent: { h: number; s: number; l: number }, userId: string): void {
    const strip = (vars: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (!WorkerHost.USER_PREFERENCE_KEYS.has(k)) out[k] = v;
      }
      return out;
    };

    const connectedUserIds = [userId];

    for (const uid of connectedUserIds) {
      const themeSetting = settingsSvc.getSetting(uid, "theme");
      const enableGlass = typeof themeSetting?.value?.enableGlass === "boolean"
        ? themeSetting.value.enableGlass : true;

      const base = { accent, enableGlass };
      const overrides = {
        paletteAccent: accent,
        variablesByMode: {
          dark: strip(generateThemeVariablesFn({ ...base, mode: "dark" })),
          light: strip(generateThemeVariablesFn({ ...base, mode: "light" })),
        },
      } as ThemeOverrideDTO & { paletteAccent: { h: number; s: number; l: number } };

      this.themeOverrides.set(uid, overrides);

      eventBus.emit(
        EventType.SPINDLE_THEME_OVERRIDES,
        { extensionId: this.extensionId, extensionName: this.manifest.name, overrides },
        uid,
      );
    }
  }

  private handleThemeGetCurrent(requestId: string, userId?: string): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme access requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) {
        this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
        return;
      }
      this.enforceScopedUser(resolvedUserId);

      const themeSetting = settingsSvc.getSetting(resolvedUserId, "theme");
      const themeConfig = themeSetting?.value;

      // Return a safe DTO snapshot
      const mode = themeConfig?.mode === "system" ? "dark" : (themeConfig?.mode ?? "dark");
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          id: themeConfig?.id ?? "lumiverse-purple",
          name: themeConfig?.name ?? "Lumiverse Purple",
          mode,
          accent: themeConfig?.accent ?? { h: 263, s: 55, l: 65 },
          enableGlass: themeConfig?.enableGlass ?? true,
          radiusScale: themeConfig?.radiusScale ?? 1,
          fontScale: themeConfig?.fontScale ?? 1,
          uiScale: themeConfig?.uiScale ?? 1,
          characterAware: !!themeConfig?.characterAware,
        },
      });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleColorExtract(requestId: string, imageId: string, userId?: string): Promise<void> {
    if (!managerSvc.hasPermission(this.manifest.identifier, "app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Color extraction requires the app_manipulation permission`,
      });
      return;
    }

    try {
      const result = await colorExtractionSvc.extractColorsFromImage(imageId);
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Color extraction failed" });
    }
  }

  private handleThemeGenerateVariables(requestId: string, config: any): void {
    if (!managerSvc.hasPermission(this.manifest.identifier, "app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Theme variable generation requires the app_manipulation permission`,
      });
      return;
    }

    try {
      if (!config || typeof config !== "object") {
        this.postToWorker({ type: "response", requestId, error: "config is required" });
        return;
      }
      if (!config.accent || typeof config.accent.h !== "number" || typeof config.accent.s !== "number" || typeof config.accent.l !== "number") {
        this.postToWorker({ type: "response", requestId, error: "config.accent must be { h: number, s: number, l: number }" });
        return;
      }
      if (config.mode !== "dark" && config.mode !== "light") {
        this.postToWorker({ type: "response", requestId, error: 'config.mode must be "dark" or "light"' });
        return;
      }

      const vars = generateThemeVariablesFn(config);
      this.postToWorker({ type: "response", requestId, result: vars });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Variable generation failed" });
    }
  }

  /** Called on worker shutdown to clean up theme overrides. */
  clearThemeOverrides(): void {
    if (this.themeOverrides.size > 0) {
      for (const userId of this.themeOverrides.keys()) {
        eventBus.emit(
          EventType.SPINDLE_THEME_OVERRIDES,
          {
            extensionId: this.extensionId,
            extensionName: this.manifest.name,
            overrides: null,
          },
          userId,
        );
      }
      this.themeOverrides.clear();
    }
  }

  // ─── Council (free tier, read-only) ────────────────────────────────

  private handleCouncilGetSettings(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const settings = councilSettingsSvc.getCouncilSettings(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: settings });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  private handleCouncilGetMembers(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const settings = councilSettingsSvc.getCouncilSettings(resolvedUserId);
      
      // We need to fetch the LumiaItems to build the full context
      const allLumiaItems = packsSvc.getAllLumiaItems(resolvedUserId);
      const itemsById = new Map(allLumiaItems.map((item) => [item.id, item]));

      const membersCtx = settings.members.map((member) => {
        const item = itemsById.get(member.itemId) || null;
        return buildCouncilMemberContext(member, item);
      });

      this.postToWorker({ type: "response", requestId, result: membersCtx });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  private handleCouncilGetAvailableLumiaItems(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const items = packsSvc.getAllLumiaItems(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  // ─── Request/response plumbing ───────────────────────────────────────

  private resolveRequest(requestId: string, result: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      pending.resolve(result);
    }
  }

  private rejectRequest(requestId: string, err: unknown): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      this.pendingRequests.delete(requestId);
      pending.reject(err);
    }
  }
}
