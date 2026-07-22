import type {
  SpindleManifest,
  WorkerToHost,
  HostToWorker,
  LlmMessageDTO,
  InterceptorBreakdownEntryDTO,
  ToolRegistration,
  ExtensionInfo,
  ConnectionProfileDTO,
  ConnectionReasoningBindingsDTO,
  InterceptorContextDTO,
  InterceptorMatchDTO,
  ReasoningSettingsDTO,
  ReasoningEffortDTO,
  ThinkingDisplayDTO,
  DatabankDocumentCreateDTO,
  DryRunResultDTO,
  SpindleCommandDTO,
  SpindleCommandContextDTO,
  CouncilMemberContext,
  ImageUploadDTO,
  BoundAssembleRequestDTO,
  QuietTrackedRequestDTO,
  ConnectionDispatchDescriptorDTO,
} from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX, SPINDLE_HOST_CAPABILITIES } from "lumiverse-spindle-types";
import { safeFetch, SSRFError } from "../utils/safe-fetch";
import { createOAuthState } from "./oauth-state";
import * as spindleUploads from "./uploads";
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
import {
  setPromptRegexOwnedChats,
  clearPromptRegexOwner,
} from "./prompt-regex-ownership";
import * as managerSvc from "./manager.service";
import * as generateSvc from "../services/generate.service";
import * as connectionsSvc from "../services/connections.service";
import * as chatsSvc from "../services/chats.service";
import type * as presetsSvc from "../services/presets.service";
import { resolveInterceptorTimeout } from "../services/spindle-settings.service";
import { getSidecarSettings } from "../services/sidecar-settings.service";
import * as promptAssemblySvc from "../services/prompt-assembly.service";
import * as tokenizerSvc from "../services/tokenizer.service";
import type * as imagesSvc from "../services/images.service";
import type * as mediaSvc from "../services/media.service";
import { spawnAsync } from "./spawn-async";
import { assembleSpindleBlocks, type SpindleAssembleInput } from "./assembly";
import { WorkerHostStorageApi } from "./worker-host-storage-api";
import { WorkerHostStateApi } from "./worker-host-state-api";
import { WorkerHostContentApi } from "./worker-host-content-api";
import { WorkerHostMemoryApi } from "./worker-host-memory-api";
import { WorkerHostImageGenApi } from "./worker-host-image-gen-api";
import { WorkerHostProcessApi } from "./worker-host-process-api";
import { WorkerHostInteractionApi } from "./worker-host-interaction-api";
import { WorkerHostPresentationApi } from "./worker-host-presentation-api";
import { createRuntimeTransport, type RuntimeTransport } from "./runtime-transport";
import {
  readSharedRpcEndpoint,
  registerSharedRpcRequestEndpoint,
  syncSharedRpcEndpoint,
  unregisterSharedRpcEndpoint,
  unregisterSharedRpcEndpointsByOwner,
  type SharedRpcEndpointPolicy,
} from "./shared-rpc-pool.service";
import { getTextContent, type LlmMessage } from "../llm/types";
import type { CreatePresetInput, PromptBlock, UpdatePresetInput } from "../types/preset";
import { getDb } from "../db/connection";
import {
  getMessages as getChatMessages,
  createMessage as createChatMessage,
  updateMessage as updateChatMessage,
  deleteMessage as deleteChatMessage,
  getMessage as getChatMessage,
} from "../services/chats.service";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "crypto";
import { join, resolve, sep } from "path";

const sharedRpcPermissionScope = new AsyncLocalStorage<string | undefined>();

type ManagedSpindlePermission = Parameters<typeof managerSvc.hasPermission>[1];
type TokenModelSource = "main" | "sidecar" | "explicit";

type ChatAppendGenerationOptions = {
  connection_id?: string;
  persona_id?: string;
  persona_addon_states?: Record<string, boolean>;
  preset_id?: string;
  force_preset_id?: boolean;
  parameters?: Record<string, unknown>;
  target_character_id?: string;
  retain_council?: boolean;
};

type ChatAppendMessageOptions =
  | boolean
  | {
      triggerGeneration?: boolean;
      generation?: ChatAppendGenerationOptions;
    };

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
  | { type: "dlc_get_catalog"; requestId: string; userId?: string }
  | {
      type: "assemble_prompt";
      requestId: string;
      input: SpindleAssembleInput;
      userId?: string;
    }
  | { type: "register_context_handler"; priority?: number; timeoutMs?: number }
  | { type: "rpc_pool_sync"; endpoint: string; value: unknown; policy?: SharedRpcEndpointPolicy }
  | { type: "rpc_pool_register_handler"; endpoint: string; policy?: SharedRpcEndpointPolicy }
  | { type: "rpc_pool_unregister"; endpoint: string }
  | { type: "rpc_pool_read"; requestId: string; endpoint: string }
  | {
      type: "rpc_pool_handler_result";
      requestId: string;
      result?: unknown;
      error?: string;
      rpcPermissionScopeId?: string;
    }
  | { type: "toast_show"; toastType: "success" | "warning" | "error" | "info"; message: string; title?: string; duration?: number; userId?: string }
  | { type: "prompt_regex_set_owned"; chatIds: string[] }
  | { type: "user_storage_read_binary"; requestId: string; path: string; userId?: string }
  | { type: "user_get_role"; requestId: string; userId?: string }
  | {
      type: "user_storage_write_binary";
      requestId: string;
      path: string;
      data: Uint8Array;
      userId?: string;
    }
  | { type: "user_storage_move"; requestId: string; from: string; to: string; userId?: string }
  | { type: "user_storage_stat"; requestId: string; path: string; userId?: string }
  | { type: "presets_list"; requestId: string; limit?: number; offset?: number; userId?: string }
  | { type: "presets_get"; requestId: string; presetId: string; userId?: string }
  | { type: "presets_create"; requestId: string; input: CreatePresetInput; userId?: string }
  | { type: "presets_update"; requestId: string; presetId: string; input: UpdatePresetInput; userId?: string }
  | { type: "presets_delete"; requestId: string; presetId: string; userId?: string }
  | { type: "preset_blocks_list"; requestId: string; presetId: string; userId?: string }
  | { type: "preset_blocks_get"; requestId: string; presetId: string; blockId: string; userId?: string }
  | { type: "preset_blocks_create"; requestId: string; presetId: string; input: presetsSvc.CreatePromptBlockInput; index?: number; userId?: string }
  | { type: "preset_blocks_update"; requestId: string; presetId: string; blockId: string; input: presetsSvc.UpdatePromptBlockInput; userId?: string }
  | { type: "preset_blocks_delete"; requestId: string; presetId: string; blockId: string; userId?: string }
  | { type: "preset_categories_list"; requestId: string; presetId: string; userId?: string }
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
  | { type: "uploads_get"; requestId: string; uploadId: string; userId?: string }
  | { type: "uploads_delete"; requestId: string; uploadId: string; userId?: string }
  | { type: "images_upload"; requestId: string; input: ImageUploadDTO; userId?: string }
  | {
      type: "images_upload_many";
      requestId: string;
      items: ImageUploadDTO[];
      userId?: string;
      concurrency?: number;
    }
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
  | { type: "images_delete_many"; requestId: string; imageIds: string[]; userId?: string }
  | { type: "media_audio_convert"; requestId: string; input: mediaSvc.MediaConvertAudioRequestDTO }
  | { type: "media_video_convert"; requestId: string; input: mediaSvc.MediaConvertVideoRequestDTO }
  | { type: "media_video_transcode"; requestId: string; input: mediaSvc.MediaTranscodeVideoRequestDTO }
  | { type: "media_video_remove_audio"; requestId: string; input: mediaSvc.MediaRemoveAudioFromVideoRequestDTO }
  | { type: "media_video_add_audio"; requestId: string; input: mediaSvc.MediaAddAudioToVideoRequestDTO }
  | { type: "media_video_from_image_audio"; requestId: string; input: mediaSvc.MediaCreateVideoFromImageAndAudioRequestDTO }
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
  | { type: "backend_process_send"; processId: string; payload: unknown; userId?: string }
  | { type: "ui_get_drawer_tabs"; requestId: string; userId?: string }
  | { type: "ui_get_settings_tabs"; requestId: string; userId?: string }
  | {
      type: "ui_navigate";
      requestId: string;
      action:
        | "open_drawer_tab"
        | "close_drawer"
        | "open_settings"
        | "close_settings"
        | "open_command_palette"
        | "close_command_palette";
      tabId?: string;
      viewId?: string;
      userId?: string;
    }
  | { type: "image_gen_generate_stream"; requestId: string; input: Record<string, unknown> }
  | { type: "image_gen_cancel_stream"; requestId: string };

type RuntimeHostToWorker =
  | HostToWorker
  | {
      type: "rpc_pool_request";
      requestId: string;
      endpoint: string;
      requesterExtensionId: string;
      rpcPermissionScopeId: string;
      effectivePermissions: string[];
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
  | {
      type: "permission_changed";
      extensionId?: string;
      permission: string;
      granted: boolean;
      allGranted: string[];
    }
  | { type: "frontend_process_lifecycle"; event: FrontendProcessLifecycleEvent }
  | { type: "frontend_process_message"; processId: string; payload: unknown; userId: string }
  | { type: "backend_process_lifecycle"; event: BackendProcessLifecycleEvent }
  | { type: "backend_process_message"; processId: string; payload: unknown; userId: string }
  | {
      type: "image_gen_stream_chunk";
      requestId: string;
      event:
        | { type: "status"; step?: number; totalSteps?: number; nodeId?: string }
        | { type: "preview"; imageDataUrl: string; step?: number; totalSteps?: number; nodeId?: string }
        | { type: "done"; result: Record<string, unknown> };
    }
  | { type: "image_gen_stream_error"; requestId: string; error: string };

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

/** Validate common web font container formats before proxying to widgets. */
function validateFontMagicBytes(data: Uint8Array, _contentType: string): boolean {
  if (data.length < 4) return false;

  // WOFF: "wOFF"
  if (data[0] === 0x77 && data[1] === 0x4F && data[2] === 0x46 && data[3] === 0x46) return true;

  // WOFF2: "wOF2"
  if (data[0] === 0x77 && data[1] === 0x4F && data[2] === 0x46 && data[3] === 0x32) return true;

  // TTF: 00 01 00 00 (TrueType outline version 1.0 fixed-point).
  if (data[0] === 0x00 && data[1] === 0x01 && data[2] === 0x00 && data[3] === 0x00) return true;

  // OTF: "OTTO"
  if (data[0] === 0x4F && data[1] === 0x54 && data[2] === 0x54 && data[3] === 0x4F) return true;

  // TTC (TrueType Collection): "ttcf"
  if (data[0] === 0x74 && data[1] === 0x74 && data[2] === 0x63 && data[3] === 0x66) return true;

  return false;
}

const REASONING_EFFORT_VALUES = new Set<ReasoningEffortDTO>([
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "max",
  "xhigh",
]);

const THINKING_DISPLAY_VALUES = new Set<ThinkingDisplayDTO>([
  "auto",
  "summarized",
  "omitted",
]);

function coerceReasoningSettings(raw: unknown): ReasoningSettingsDTO | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const effort = REASONING_EFFORT_VALUES.has(r.reasoningEffort as ReasoningEffortDTO)
    ? (r.reasoningEffort as ReasoningEffortDTO)
    : "auto";
  const display = THINKING_DISPLAY_VALUES.has(r.thinkingDisplay as ThinkingDisplayDTO)
    ? (r.thinkingDisplay as ThinkingDisplayDTO)
    : "auto";
  return {
    apiReasoning: r.apiReasoning === true,
    reasoningEffort: effort,
    thinkingDisplay: display,
    prefix: typeof r.prefix === "string" ? r.prefix : "",
    suffix: typeof r.suffix === "string" ? r.suffix : "",
    autoParse: r.autoParse !== false,
    keepInHistory: typeof r.keepInHistory === "number" ? r.keepInHistory : 0,
  };
}

/**
 * Parse the `metadata.reasoningBindings` blob on a connection into a typed
 * `ConnectionReasoningBindingsDTO`. Returns `null` when the connection has
 * no binding attached — callers should treat that as "fall back to the
 * user's global reasoning setting" during generation.
 */
function extractReasoningBindingsDTO(
  metadata: Record<string, any> | null | undefined,
): ConnectionReasoningBindingsDTO | null {
  const blob = metadata?.reasoningBindings;
  if (!blob || typeof blob !== "object" || Array.isArray(blob)) return null;
  const settings = coerceReasoningSettings((blob as any).settings);
  if (!settings) return null;
  const promptBias = (blob as any).promptBias;
  return {
    settings,
    ...(typeof promptBias === "string" ? { promptBias } : {}),
  };
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

export class WorkerHost {
  private runtime: RuntimeTransport | null = null;
  private eventUnsubscribers = new Map<string, () => void>();
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  /**
   * AbortControllers for in-flight generation and assembly calls, keyed by the
   * worker-supplied `requestId`. The worker posts `cancel_generation` with the
   * same id when an extension's `AbortSignal` fires; the host calls
   * `controller.abort()` to tear down the upstream LLM request.
   */
  private generationAbortControllers = new Map<string, AbortController>();
  private interceptorUnregister: (() => void) | null = null;
  private interceptorRegistrationId: string | null = null;
  private activeInterceptorContexts = new Map<string, Omit<InterceptorContextDTO, "signal">>();
  private contextHandlerUnregister: (() => void) | null = null;
  private messageContentProcessorUnregister: (() => void) | null = null;
  private macroInterceptorUnregister: (() => void) | null = null;
  private worldInfoInterceptorUnregister: (() => void) | null = null;
  private registeredMacroNames = new Set<string>();
  private macroValueCache = new Map<string, string>();
  private static readonly MAX_BACKEND_PROCESSES = 16;
  private static readonly SHARED_RPC_REQUEST_TIMEOUT_MS = 10_000;
  private onWorkerReady: (() => void) | null = null;
  private onWorkerShutdownAck: (() => void) | null = null;
  private onRuntimeExit: (() => void) | null = null;
  private runtimeExitPromise: Promise<void> | null = null;
  private runtimeStopping = false;
  private runtimeStatsInterval: ReturnType<typeof setInterval> | null = null;
  private readonly installScope: "operator" | "user";
  private readonly installedByUserId: string | null;
  private readonly storageApi: WorkerHostStorageApi;
  private readonly stateApi: WorkerHostStateApi;
  private readonly contentApi: WorkerHostContentApi;
  private readonly memoryApi: WorkerHostMemoryApi;
  private readonly imageGenApi: WorkerHostImageGenApi;
  private readonly processApi: WorkerHostProcessApi;
  private readonly interactionApi: WorkerHostInteractionApi;
  private readonly presentationApi: WorkerHostPresentationApi;
  private sharedRpcPermissionScopes = new Map<string, Set<string>>();

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
    this.storageApi = new WorkerHostStorageApi({
      identifier: manifest.identifier,
      installScope: this.installScope,
      installedByUserId: this.installedByUserId,
      hasPermission: (permission) => this.hasPermission(permission),
      postResponse: (message) => this.postToWorker(message),
    });
    this.stateApi = new WorkerHostStateApi({
      getChatOwnerId: (chatId) => this.getChatOwnerId(chatId),
      enforceScopedUser: (userId) => this.enforceScopedUser(userId),
      resolveEffectiveUserId: (userId) => this.resolveEffectiveUserId(userId),
      hasPermission: (permission) => this.hasPermission(permission),
      postResponse: (message) => this.postToWorker(message),
    });
    this.contentApi = new WorkerHostContentApi({
      manifest,
      hasPermission: (permission) => this.hasPermission(permission),
      resolveEffectiveUserId: (userId) => this.resolveEffectiveUserId(userId),
      enforceScopedUser: (userId) => this.enforceScopedUser(userId),
      postResponse: (message) => this.postToWorker(message),
    });
    this.memoryApi = new WorkerHostMemoryApi({
      hasPermission: (permission) => this.hasPermission(permission),
      resolveEffectiveUserId: (userId) => this.resolveEffectiveUserId(userId),
      enforceScopedUser: (userId) => this.enforceScopedUser(userId),
      postResponse: (message) => this.postToWorker(message),
    });
    this.imageGenApi = new WorkerHostImageGenApi({
      extensionIdentifier: manifest.identifier,
      hasPermission: (permission) => this.hasPermission(permission),
      resolveEffectiveUserId: (userId) => this.resolveEffectiveUserId(userId),
      enforceScopedUser: (userId) => this.enforceScopedUser(userId),
      post: (message) => this.postToWorker(message as RuntimeHostToWorker),
    });
    this.processApi = new WorkerHostProcessApi({
      extensionId,
      manifest,
      installScope: this.installScope,
      installedByUserId: this.installedByUserId,
      storageRootPath: () => this.getStorageRootPath(),
      post: (message) => this.postToWorker(message),
      resolve: (requestId, result) => this.resolveRequest(requestId, result),
      reject: (requestId, error) => this.rejectRequest(requestId, error),
    });
    this.interactionApi = new WorkerHostInteractionApi({
      extensionId,
      manifest,
      installScope: this.installScope,
      installedByUserId: this.installedByUserId,
      isRuntimeActive: () => this.runtime !== null,
      resolveEffectiveUserId: (userId) => this.resolveEffectiveUserId(userId),
      enforceScopedUser: (userId) => this.enforceScopedUser(userId),
      post: (message) => this.postToWorker(message as RuntimeHostToWorker),
    });
    this.presentationApi = new WorkerHostPresentationApi({
      extensionId,
      manifest,
      installScope: this.installScope,
      installedByUserId: this.installedByUserId,
      hasPermission: (permission) => this.hasPermission(permission),
      resolveEffectiveUserId: (userId) => this.resolveEffectiveUserId(userId),
      enforceScopedUser: (userId) => this.enforceScopedUser(userId),
      post: (message) => this.postToWorker(message),
    });
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

  private getGrantedPermissions(): ManagedSpindlePermission[] {
    const granted = managerSvc.getGrantedPermissions(this.manifest.identifier);
    const scopeId = sharedRpcPermissionScope.getStore();
    if (!scopeId) return granted;

    const scoped = this.sharedRpcPermissionScopes.get(scopeId);
    if (!scoped) return [];
    return granted.filter((permission) => scoped.has(permission));
  }

  private hasPermission(permission: ManagedSpindlePermission): boolean {
    const scopeId = sharedRpcPermissionScope.getStore();
    if (!scopeId) return managerSvc.hasPermission(this.manifest.identifier, permission);

    const scoped = this.sharedRpcPermissionScopes.get(scopeId);
    return Boolean(scoped?.has(permission)) && managerSvc.hasPermission(this.manifest.identifier, permission);
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
      host: {
        descriptorVersion: 1,
        lumiverseVersion: await getBackendVersion(),
        capabilities: SPINDLE_HOST_CAPABILITIES,
        extensionInstallationId: this.extensionId,
      },
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
    this.processApi.stopAllFrontendProcesses("backend_unloaded");
    this.processApi.stopAllBackendProcesses("backend_unloaded");

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
    this.processApi.stopAllFrontendProcesses("backend_unloaded");
    this.processApi.stopAllBackendProcesses("backend_unloaded");
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
    this.interceptorRegistrationId = null;
    this.activeInterceptorContexts.clear();

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

    // Drop any prompt-regex ownership claims so the host resumes its own pass
    clearPromptRegexOwner(this.extensionId);

    // Unregister all macros registered by this extension
    for (const macroName of this.registeredMacroNames) {
      macroRegistry.unregisterMacro(macroName);
    }
    this.registeredMacroNames.clear();
    this.macroValueCache.clear();
    this.interactionApi.clear();

    // Clear theme overrides and chat-style-mode claims.
    this.presentationApi.clearThemeOverrides();
    this.presentationApi.clearChatStyleModes();

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
    // Already torn down by an earlier failure on this stack, bail before recursing.
    if (!this.runtime) return;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[Spindle:${this.manifest.identifier}] Runtime transport failed, cleaning up: ${message}`
    );
    this.runtime = null;
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
    this.processApi.handleFrontendProcessEvent(processId, userId, event, error);
  }

  handleFrontendProcessMessage(processId: string, userId: string, payload: unknown): void {
    this.processApi.handleFrontendProcessMessage(processId, userId, payload);
  }

  /**
   * Notify the worker that a permission was granted or revoked at runtime.
   * The worker updates its internal cache and fires onChanged handlers —
   * no restart needed.
   */
  notifyPermissionChanged(permission: string, granted: boolean, allGranted: string[]): void {
    this.postToWorker({
      type: "permission_changed",
      extensionId: this.manifest.identifier,
      permission,
      granted,
      allGranted,
    });
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
    effectivePermissions: readonly string[],
  ): Promise<unknown> {
    const requestId = crypto.randomUUID();
    const rpcPermissionScopeId = crypto.randomUUID();
    this.sharedRpcPermissionScopes.set(rpcPermissionScopeId, new Set(effectivePermissions));

    this.postToWorker({
      type: "rpc_pool_request",
      requestId,
      endpoint,
      requesterExtensionId,
      rpcPermissionScopeId,
      effectivePermissions: [...effectivePermissions],
    });

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.sharedRpcPermissionScopes.delete(rpcPermissionScopeId);
      };
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        cleanup();
        reject(new Error(`Shared RPC endpoint "${endpoint}" timed out`));
      }, WorkerHost.SHARED_RPC_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timeout);
          cleanup();
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          cleanup();
          reject(reason);
        },
      });
    });
  }

  private handleRpcPoolSync(endpoint: string, value: unknown, policy?: SharedRpcEndpointPolicy): void {
    syncSharedRpcEndpoint(this.manifest.identifier, endpoint, value, policy);
  }

  private handleRpcPoolRegisterHandler(endpoint: string, policy?: SharedRpcEndpointPolicy): void {
    registerSharedRpcRequestEndpoint(
      this.manifest.identifier,
      endpoint,
      async (requesterExtensionId, effectivePermissions) =>
        await this.requestSharedRpcValue(endpoint, requesterExtensionId, effectivePermissions),
      policy,
    );
  }

  private handleRpcPoolUnregister(endpoint: string): void {
    unregisterSharedRpcEndpoint(this.manifest.identifier, endpoint);
  }

  private async handleRpcPoolRead(requestId: string, endpoint: string): Promise<void> {
    try {
      const result = await readSharedRpcEndpoint(
        endpoint,
        this.manifest.identifier,
        managerSvc.getGrantedPermissions,
      );
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err?.message || String(err) });
    }
  }

  private handleCreateOAuthState(requestId: string): void {
    if (!this.hasPermission("oauth")) {
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
    const scopeId = typeof (msg as any).rpcPermissionScopeId === "string"
      ? (msg as any).rpcPermissionScopeId
      : undefined;
    sharedRpcPermissionScope.run(scopeId, () => this.handleMessageInScope(msg));
  }

  private handleMessageInScope(msg: RuntimeWorkerToHost): void {
    if (this.storageApi.dispatch(msg as unknown as { type: string; [key: string]: unknown })) {
      return;
    }
    if (this.stateApi.dispatch(msg as unknown as { type: string; [key: string]: unknown })) {
      return;
    }

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
        this.handleRegisterInterceptor(msg.registrationId, msg.priority, msg.match);
        break;
      case "unregister_interceptor":
        this.handleUnregisterInterceptor(msg.registrationId);
        break;
      case "intercept_result": {
        if (msg.registrationId !== this.interceptorRegistrationId) {
          console.warn(`[Spindle:${this.manifest.identifier}] Ignoring interceptor result for an inactive registration`);
          break;
        }
        // Strip parameters if the extension lacks the generation_parameters permission
        let interceptParams = msg.parameters;
        if (interceptParams && Object.keys(interceptParams).length > 0) {
          if (!this.hasPermission("generation_parameters")) {
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
      case "assemble_prompt":
        this.handleAssemblePrompt(msg.requestId, msg.input, msg.userId);
        break;
      case "generate_assemble":
        void this.handleBoundAssembly(msg.requestId, msg.input);
        break;
      case "generate_quiet_tracked":
        void this.handleBoundQuietGeneration(msg.requestId, msg.input);
        break;
      case "permissions_get_granted":
        this.handlePermissionsGetGranted(msg.requestId);
        break;
      case "rpc_pool_sync":
        this.handleRpcPoolSync(msg.endpoint, msg.value, (msg as any).policy);
        break;
      case "rpc_pool_register_handler":
        this.handleRpcPoolRegisterHandler(msg.endpoint, (msg as any).policy);
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
      case "connections_resolve_dispatch":
        this.handleConnectionsResolveDispatch(msg.requestId, msg.connectionId);
        break;
      case "chat_get_messages":
        this.handleChatGetMessages(msg.requestId, msg.chatId);
        break;
      case "chat_append_message":
        void this.handleChatAppendMessage(
          msg.requestId,
          msg.chatId,
          msg.message,
          (msg as any).options,
        );
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
        this.handleRegisterContextHandler(msg.priority, (msg as { timeoutMs?: number }).timeoutMs);
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
      // ─── Characters (gated: "characters") ─────────────────────────────
      case "characters_list":
        this.contentApi.handleCharactersList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "characters_get":
        this.contentApi.handleCharactersGet(msg.requestId, msg.characterId, msg.userId);
        break;
      case "characters_create":
        this.contentApi.handleCharactersCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "characters_set_avatar":
        this.contentApi.handleCharactersSetAvatar(msg.requestId, msg.characterId, msg.avatar, msg.userId);
        break;
      case "characters_update":
        this.contentApi.handleCharactersUpdate(msg.requestId, msg.characterId, msg.input, msg.userId);
        break;
      case "characters_delete":
        this.contentApi.handleCharactersDelete(msg.requestId, msg.characterId, msg.userId);
        break;
      // ─── Chats (gated: "chats") ───────────────────────────────────────
      case "chats_list":
        this.contentApi.handleChatsList(msg.requestId, msg.characterId, msg.limit, msg.offset, msg.userId);
        break;
      case "chats_get":
        this.contentApi.handleChatsGet(msg.requestId, msg.chatId, msg.userId);
        break;
      case "chats_get_active":
        this.contentApi.handleChatsGetActive(msg.requestId, msg.userId);
        break;
      case "chats_update":
        this.contentApi.handleChatsUpdate(msg.requestId, msg.chatId, msg.input, msg.userId);
        break;
      case "chats_delete":
        this.contentApi.handleChatsDelete(msg.requestId, msg.chatId, msg.userId);
        break;
      // ─── Chat Memories (gated: "chats") ──────────────────────────────
      case "chats_get_memories":
        this.memoryApi.handleChatsGetMemories(msg.requestId, msg.chatId, msg.topK, msg.userId);
        break;
      // ─── Memory Cortex & Long-Term Chat Memory (gated: "memories") ───
      case "memories_config_get":
        this.memoryApi.handleMemoriesConfigGet(msg.requestId, msg.userId);
        break;
      case "memories_config_put":
        this.memoryApi.handleMemoriesConfigPut(msg.requestId, msg.patch, msg.userId);
        break;
      case "memories_query_cortex":
        this.memoryApi.handleMemoriesQueryCortex(msg.requestId, msg.query);
        break;
      case "memories_query_linked":
        this.memoryApi.handleMemoriesQueryLinked(msg.requestId, msg.chatId, msg.queryText, msg.userId);
        break;
      case "memories_get_cached":
        this.memoryApi.handleMemoriesGetCached(msg.requestId, msg.chatId);
        break;
      case "memories_get_cached_linked":
        this.memoryApi.handleMemoriesGetCachedLinked(msg.requestId, msg.chatId);
        break;
      case "memories_invalidate_cache":
        this.memoryApi.handleMemoriesInvalidateCache(msg.requestId, msg.chatId);
        break;
      case "memories_invalidate_linked_cache":
        this.memoryApi.handleMemoriesInvalidateLinkedCache(msg.requestId, msg.chatId);
        break;
      case "memories_entities_list":
        this.memoryApi.handleMemoriesEntitiesList(msg.requestId, msg.chatId, msg.activeOnly, msg.limit, msg.userId);
        break;
      case "memories_entities_get":
        this.memoryApi.handleMemoriesEntitiesGet(msg.requestId, msg.entityId, msg.userId);
        break;
      case "memories_entities_find_by_name":
        this.memoryApi.handleMemoriesEntitiesFindByName(msg.requestId, msg.chatId, msg.name, msg.userId);
        break;
      case "memories_entities_upsert":
        this.memoryApi.handleMemoriesEntitiesUpsert(msg.requestId, msg.chatId, msg.entity, msg.chunkId ?? null, msg.createdAt, msg.userId);
        break;
      case "memories_entities_update_status":
        this.memoryApi.handleMemoriesEntitiesUpdateStatus(msg.requestId, msg.entityId, msg.patch, msg.userId);
        break;
      case "memories_entities_add_facts":
        this.memoryApi.handleMemoriesEntitiesAddFacts(msg.requestId, msg.entityId, msg.facts, msg.userId);
        break;
      case "memories_entities_get_facts":
        this.memoryApi.handleMemoriesEntitiesGetFacts(msg.requestId, msg.entityId, msg.userId);
        break;
      case "memories_entities_update_emotional_valence":
        this.memoryApi.handleMemoriesEntitiesUpdateEmotionalValence(msg.requestId, msg.entityId, msg.valence, msg.userId);
        break;
      case "memories_relations_list":
        this.memoryApi.handleMemoriesRelationsList(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_relations_list_all":
        this.memoryApi.handleMemoriesRelationsListAll(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_relations_for_entity":
        this.memoryApi.handleMemoriesRelationsForEntity(msg.requestId, msg.chatId, msg.entityId, msg.userId);
        break;
      case "memories_relations_for_entities":
        this.memoryApi.handleMemoriesRelationsForEntities(msg.requestId, msg.chatId, msg.entityIds, msg.limit, msg.userId);
        break;
      case "memories_relations_upsert":
        this.memoryApi.handleMemoriesRelationsUpsert(msg.requestId, msg.chatId, msg.relation, msg.chunkId ?? null, msg.userId);
        break;
      case "memories_consolidations_list":
        this.memoryApi.handleMemoriesConsolidationsList(msg.requestId, msg.chatId, msg.tier, msg.userId);
        break;
      case "memories_consolidations_latest_arc":
        this.memoryApi.handleMemoriesConsolidationsLatestArc(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_consolidations_run":
        this.memoryApi.handleMemoriesConsolidationsRun(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_salience_get":
        this.memoryApi.handleMemoriesSalienceGet(msg.requestId, msg.chatId, msg.limit, msg.offset, msg.userId);
        break;
      case "memories_vaults_list":
        this.memoryApi.handleMemoriesVaultsList(msg.requestId, msg.userId);
        break;
      case "memories_vaults_get":
        this.memoryApi.handleMemoriesVaultsGet(msg.requestId, msg.vaultId, msg.userId);
        break;
      case "memories_vaults_get_chunks":
        this.memoryApi.handleMemoriesVaultsGetChunks(msg.requestId, msg.vaultId, msg.userId);
        break;
      case "memories_vaults_create":
        this.memoryApi.handleMemoriesVaultsCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "memories_vaults_rename":
        this.memoryApi.handleMemoriesVaultsRename(msg.requestId, msg.vaultId, msg.name, msg.userId);
        break;
      case "memories_vaults_delete":
        this.memoryApi.handleMemoriesVaultsDelete(msg.requestId, msg.vaultId, msg.userId);
        break;
      case "memories_vaults_reindex":
        this.memoryApi.handleMemoriesVaultsReindex(msg.requestId, msg.vaultId, msg.userId);
        break;
      case "memories_links_list":
        this.memoryApi.handleMemoriesLinksList(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_links_attach":
        this.memoryApi.handleMemoriesLinksAttach(msg.requestId, msg.input, msg.userId);
        break;
      case "memories_links_remove":
        this.memoryApi.handleMemoriesLinksRemove(msg.requestId, msg.chatId, msg.linkId, msg.userId);
        break;
      case "memories_links_toggle":
        this.memoryApi.handleMemoriesLinksToggle(msg.requestId, msg.chatId, msg.linkId, msg.enabled, msg.userId);
        break;
      case "memories_chat_chunks_list":
        this.memoryApi.handleMemoriesChatChunksList(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_chat_memory_get":
        this.memoryApi.handleMemoriesChatMemoryGet(msg.requestId, msg.chatId, msg.topK, msg.userId);
        break;
      case "memories_chat_memory_warm":
        this.memoryApi.handleMemoriesChatMemoryWarm(msg.requestId, msg.chatId, msg.force, msg.userId);
        break;
      case "memories_chat_memory_invalidate":
        this.memoryApi.handleMemoriesChatMemoryInvalidate(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_stats_usage":
        this.memoryApi.handleMemoriesStatsUsage(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_stats_ingestion_status":
        this.memoryApi.handleMemoriesStatsIngestionStatus(msg.requestId, msg.chatId, msg.userId);
        break;
      case "memories_stats_ingestion_telemetry":
        this.memoryApi.handleMemoriesStatsIngestionTelemetry(msg.requestId, msg.chatId, msg.userId);
        break;
      // ─── World Books (gated: "world_books") ──────────────────────────
      case "world_books_list":
        this.contentApi.handleWorldBooksList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "world_books_get":
        this.contentApi.handleWorldBooksGet(msg.requestId, msg.worldBookId, msg.userId);
        break;
      case "world_books_create":
        this.contentApi.handleWorldBooksCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "world_books_update":
        this.contentApi.handleWorldBooksUpdate(msg.requestId, msg.worldBookId, msg.input, msg.userId);
        break;
      case "world_books_delete":
        this.contentApi.handleWorldBooksDelete(msg.requestId, msg.worldBookId, msg.userId);
        break;
      // ─── World Book Entries (gated: "world_books") ────────────────────
      case "world_book_entries_list":
        this.contentApi.handleWorldBookEntriesList(msg.requestId, msg.worldBookId, msg.limit, msg.offset, msg.userId);
        break;
      case "world_book_entries_get":
        this.contentApi.handleWorldBookEntriesGet(msg.requestId, msg.entryId, msg.userId);
        break;
      case "world_book_entries_create":
        this.contentApi.handleWorldBookEntriesCreate(msg.requestId, msg.worldBookId, msg.input, msg.userId);
        break;
      case "world_book_entries_update":
        this.contentApi.handleWorldBookEntriesUpdate(msg.requestId, msg.entryId, msg.input, msg.userId);
        break;
      case "world_book_entries_delete":
        this.contentApi.handleWorldBookEntriesDelete(msg.requestId, msg.entryId, msg.userId);
        break;
      // ─── Activated World Info (gated: "world_books") ─────────────────
      case "world_books_get_activated":
        this.contentApi.handleWorldBooksGetActivated(msg.requestId, msg.chatId, msg.userId);
        break;
      // ─── Global World Books (gated: "world_books") ───────────────────
      case "world_books_get_global":
        this.contentApi.handleWorldBooksGetGlobal(msg.requestId, msg.userId);
        break;
      case "world_books_set_global":
        this.contentApi.handleWorldBooksSetGlobal(msg.requestId, msg.worldBookIds, msg.userId);
        break;
      case "world_books_activate_global":
        this.contentApi.handleWorldBooksActivateGlobal(msg.requestId, msg.worldBookId, msg.userId);
        break;
      case "world_books_deactivate_global":
        this.contentApi.handleWorldBooksDeactivateGlobal(msg.requestId, msg.worldBookId, msg.userId);
        break;
      // ─── Regex Scripts (gated: "regex_scripts") ──────────────────────
      case "regex_scripts_list":
        this.contentApi.handleRegexScriptsList(
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
        this.contentApi.handleRegexScriptsGet(msg.requestId, msg.scriptId, msg.userId);
        break;
      case "regex_scripts_get_active":
        this.contentApi.handleRegexScriptsGetActive(
          msg.requestId,
          msg.target,
          msg.characterId,
          msg.chatId,
          msg.userId,
        );
        break;
      case "regex_scripts_create":
        this.contentApi.handleRegexScriptsCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "regex_scripts_update":
        this.contentApi.handleRegexScriptsUpdate(msg.requestId, msg.scriptId, msg.input, msg.userId);
        break;
      case "regex_scripts_delete":
        this.contentApi.handleRegexScriptsDelete(msg.requestId, msg.scriptId, msg.userId);
        break;
      // ─── Databanks (gated: "databanks") ─────────────────────────────
      case "databanks_list":
        this.contentApi.handleDatabanksList(msg.requestId, msg.limit, msg.offset, msg.scope, msg.scopeId, msg.userId);
        break;
      case "databanks_get":
        this.contentApi.handleDatabanksGet(msg.requestId, msg.databankId, msg.userId);
        break;
      case "databanks_create":
        this.contentApi.handleDatabanksCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "databanks_update":
        this.contentApi.handleDatabanksUpdate(msg.requestId, msg.databankId, msg.input, msg.userId);
        break;
      case "databanks_delete":
        this.contentApi.handleDatabanksDelete(msg.requestId, msg.databankId, msg.userId);
        break;
      // ─── Databank Documents (gated: "databanks") ───────────────────
      case "databank_documents_list":
        this.contentApi.handleDatabankDocumentsList(msg.requestId, msg.databankId, msg.limit, msg.offset, msg.userId);
        break;
      case "databank_documents_get":
        this.contentApi.handleDatabankDocumentsGet(msg.requestId, msg.documentId, msg.userId);
        break;
      case "databank_documents_create":
        this.contentApi.handleDatabankDocumentsCreate(msg.requestId, msg.databankId, msg.input, msg.userId);
        break;
      case "databank_documents_update":
        this.contentApi.handleDatabankDocumentsUpdate(msg.requestId, msg.documentId, msg.input, msg.userId);
        break;
      case "databank_documents_delete":
        this.contentApi.handleDatabankDocumentsDelete(msg.requestId, msg.documentId, msg.userId);
        break;
      case "databank_documents_get_content":
        this.contentApi.handleDatabankDocumentsGetContent(msg.requestId, msg.documentId, msg.userId);
        break;
      case "databank_documents_reprocess":
        this.contentApi.handleDatabankDocumentsReprocess(msg.requestId, msg.documentId, msg.userId);
        break;
      // ─── Images (gated: "images") ──────────────────────────────────────
      case "images_list":
        this.contentApi.handleImagesList(
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
        this.contentApi.handleImagesGet(
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
        this.contentApi.handleImagesUpload(msg.requestId, msg.input, msg.userId);
        break;
      case "images_upload_many":
        this.contentApi.handleImagesUploadMany(msg.requestId, msg.items, msg.userId, msg.concurrency);
        break;
      case "images_upload_from_data_url":
        this.contentApi.handleImagesUploadFromDataUrl(
          msg.requestId,
          msg.dataUrl,
          msg.originalFilename,
          msg.owner_character_id,
          msg.owner_chat_id,
          msg.userId,
        );
        break;
      case "images_delete":
        this.contentApi.handleImagesDelete(msg.requestId, msg.imageId, msg.userId);
        break;
      case "images_delete_many":
        this.contentApi.handleImagesDeleteMany(msg.requestId, msg.imageIds, msg.userId);
        break;
      case "media_audio_convert":
        this.contentApi.handleMediaAudioConvert(msg.requestId, msg.input);
        break;
      case "media_video_convert":
        this.contentApi.handleMediaVideoConvert(msg.requestId, msg.input);
        break;
      case "media_video_transcode":
        this.contentApi.handleMediaVideoTranscode(msg.requestId, msg.input);
        break;
      case "media_video_remove_audio":
        this.contentApi.handleMediaVideoRemoveAudio(msg.requestId, msg.input);
        break;
      case "media_video_add_audio":
        this.contentApi.handleMediaVideoAddAudio(msg.requestId, msg.input);
        break;
      case "media_video_from_image_audio":
        this.contentApi.handleMediaVideoFromImageAudio(msg.requestId, msg.input);
        break;
      // ─── Personas (gated: "personas") ──────────────────────────────────
      case "personas_list":
        this.contentApi.handlePersonasList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "personas_get":
        this.contentApi.handlePersonasGet(msg.requestId, msg.personaId, msg.userId);
        break;
      case "personas_get_default":
        this.contentApi.handlePersonasGetDefault(msg.requestId, msg.userId);
        break;
      case "personas_get_active":
        this.contentApi.handlePersonasGetActive(msg.requestId, msg.userId);
        break;
      case "personas_create":
        this.contentApi.handlePersonasCreate(msg.requestId, msg.input, msg.userId);
        break;
      case "personas_update":
        this.contentApi.handlePersonasUpdate(msg.requestId, msg.personaId, msg.input, msg.userId);
        break;
      case "personas_delete":
        this.contentApi.handlePersonasDelete(msg.requestId, msg.personaId, msg.userId);
        break;
      case "personas_switch":
        this.contentApi.handlePersonasSwitch(msg.requestId, msg.personaId, msg.userId);
        break;
      case "personas_get_world_book":
        this.contentApi.handlePersonasGetWorldBook(msg.requestId, msg.personaId, msg.userId);
        break;
      // ─── Global Add-ons (gated: "personas") ─────────────────────────
      case "global_addons_list":
        this.contentApi.handleGlobalAddonsList(msg.requestId, msg.limit, msg.offset, msg.userId);
        break;
      case "global_addons_get":
        this.contentApi.handleGlobalAddonsGet(msg.requestId, msg.addonId, msg.userId);
        break;
      case "global_addons_update":
        this.contentApi.handleGlobalAddonsUpdate(msg.requestId, msg.addonId, msg.input, msg.userId);
        break;
      // ─── Council (free tier, read-only) ─────────────────────────────
      case "council_get_settings":
        this.presentationApi.handleCouncilGetSettings(msg.requestId, msg.userId);
        break;
      case "council_get_members":
        this.presentationApi.handleCouncilGetMembers(msg.requestId, msg.userId);
        break;
      case "council_get_available_lumia_items":
        this.presentationApi.handleCouncilGetAvailableLumiaItems(msg.requestId, msg.userId);
        break;
      // ─── Lumia DLC (free tier, read-only) ───────────────────────────
      case "dlc_get_catalog":
        this.presentationApi.handleDlcGetCatalog(msg.requestId, msg.userId);
        break;
      // ─── Toast (free tier) ────────────────────────────────────────────
      case "toast_show":
        this.interactionApi.handleToastShow(
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
      case "prompt_regex_set_owned":
        setPromptRegexOwnedChats(this.extensionId, msg.chatIds);
        break;
      // ─── Commands (free tier) ─────────────────────────────────────────
      case "commands_register":
        this.interactionApi.handleCommandsRegister(msg.commands);
        break;
      case "commands_unregister":
        this.interactionApi.handleCommandsUnregister(msg.commandIds);
        break;
      // ─── UI Automation (free tier) ────────────────────────────────────
      case "ui_get_drawer_tabs":
        this.presentationApi.handleUIGetDrawerTabs(msg.requestId, msg.userId);
        break;
      case "ui_get_settings_tabs":
        this.presentationApi.handleUIGetSettingsTabs(msg.requestId, msg.userId);
        break;
      case "ui_navigate":
        this.presentationApi.handleUINavigate(msg.requestId, msg.action, msg.tabId, msg.viewId, msg.userId);
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
      // ─── Resumable uploads (free tier) ────────────────────────────────
      case "uploads_get":
        this.handleUploadsGet(msg.requestId, msg.uploadId, msg.userId);
        break;
      case "uploads_delete":
        this.handleUploadsDelete(msg.requestId, msg.uploadId, msg.userId);
        break;
      // ─── Push Notifications (gated: "push_notification") ──────────────
      case "push_send":
        this.presentationApi.handlePushSend(msg.requestId, msg.title, msg.body, msg.tag, msg.url, msg.userId, msg.icon, msg.rawTitle, msg.image);
        break;
      case "push_get_status":
        this.presentationApi.handlePushGetStatus(msg.requestId, msg.userId);
        break;
      // ─── Web Search (gated: "web_search") ──────────────────────────────
      case "web_search_query":
        void this.presentationApi.handleWebSearchQuery(msg.requestId, msg.query, msg.count, msg.scrape, msg.userId);
        break;
      case "web_search_get_settings":
        void this.presentationApi.handleWebSearchGetSettings(msg.requestId, msg.userId);
        break;
      // ─── User Context (free tier — no permission needed) ────────────────
      case "user_is_visible":
        this.presentationApi.handleUserIsVisible(msg.requestId, msg.userId);
        break;
      case "user_get_role":
        this.presentationApi.handleUserGetRole(msg.requestId, msg.userId);
        break;
      // ─── Text Editor (free tier — no permission needed) ─────────────────
      case "text_editor_open":
        this.presentationApi.handleTextEditorOpen(msg.requestId, msg.title, msg.value, msg.placeholder, msg.userId);
        break;
      // ─── Modal (free tier — no permission needed) ─────────────────────
      case "modal_open":
        this.presentationApi.handleModalOpen(msg.requestId, msg.title, msg.items, msg.width, msg.maxHeight, msg.persistent, msg.userId, (msg as any).modalRequestId);
        break;
      case "modal_close":
        this.presentationApi.handleModalClose(msg.requestId, msg.openRequestId, msg.userId);
        break;
      case "confirm_open":
        this.presentationApi.handleConfirmOpen(msg.requestId, msg.title, msg.message, msg.variant, msg.confirmLabel, msg.cancelLabel, msg.userId);
        break;
      case "input_prompt_open":
        this.presentationApi.handleInputPromptOpen(msg.requestId, msg.title, msg.message, msg.placeholder, msg.defaultValue, msg.submitLabel, msg.cancelLabel, msg.multiline, msg.userId);
        break;
      // ─── Frontend Process Lifecycle (free tier) ───────────────────────
      case "frontend_process_spawn":
        this.processApi.handleFrontendProcessSpawn(msg.requestId, msg.options);
        break;
      case "frontend_process_list":
        this.processApi.handleFrontendProcessList(msg.requestId, msg.filter);
        break;
      case "frontend_process_get":
        this.processApi.handleFrontendProcessGet(msg.requestId, msg.processId);
        break;
      case "frontend_process_stop":
        this.processApi.handleFrontendProcessStop(msg.requestId, msg.processId, msg.options);
        break;
      case "frontend_process_send":
        this.processApi.handleFrontendProcessSend(msg.processId, msg.payload, msg.userId);
        break;
      case "backend_process_spawn":
        void this.processApi.handleBackendProcessSpawn(msg.requestId, msg.options);
        break;
      case "backend_process_list":
        this.processApi.handleBackendProcessList(msg.requestId, msg.filter);
        break;
      case "backend_process_get":
        this.processApi.handleBackendProcessGet(msg.requestId, msg.processId);
        break;
      case "backend_process_stop":
        this.processApi.handleBackendProcessStop(msg.requestId, msg.processId, msg.options);
        break;
      case "backend_process_send":
        this.processApi.handleBackendProcessSend(msg.processId, msg.payload, msg.userId);
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
        void this.imageGenApi.handleGenerate(msg.requestId, msg.input);
        break;
      case "image_gen_providers":
        this.imageGenApi.handleProviders(msg.requestId);
        break;
      case "image_gen_connections_list":
        this.imageGenApi.handleConnectionsList(msg.requestId, msg.userId);
        break;
      case "image_gen_connections_get":
        this.imageGenApi.handleConnectionsGet(msg.requestId, msg.connectionId, msg.userId);
        break;
      case "image_gen_models":
        void this.imageGenApi.handleModels(msg.requestId, msg.connectionId, msg.userId);
        break;
      case "image_gen_generate_stream":
        void this.imageGenApi.handleGenerateStream(msg.requestId, msg.input);
        break;
      case "image_gen_cancel_stream":
        this.imageGenApi.cancelStream(msg.requestId);
        break;
      // ─── Chat style mode (gated: "app_manipulation") ────────────────────
      case "chat_set_style_mode":
        this.presentationApi.handleChatSetStyleMode(msg.requestId, msg.chatId, msg.mode, msg.userId);
        break;
      // ─── Theme (gated: "app_manipulation") ──────────────────────────────
      case "theme_apply":
        this.presentationApi.handleThemeApply(msg.requestId, msg.overrides, msg.userId);
        break;
      case "theme_apply_palette":
        this.presentationApi.handleThemeApplyPalette((msg as any).requestId, (msg as any).palette, (msg as any).userId);
        break;
      case "theme_clear":
        this.presentationApi.handleThemeClear(msg.requestId, msg.userId);
        break;
      case "theme_get_current":
        this.presentationApi.handleThemeGetCurrent(msg.requestId, msg.userId);
        break;
      case "color_extract":
        this.presentationApi.handleColorExtract(msg.requestId, msg.imageId, msg.userId);
        break;
      case "theme_generate_variables":
        this.presentationApi.handleThemeGenerateVariables(msg.requestId, msg.config);
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
      !this.hasPermission("generation")
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
      if (eventType === EventType.SPINDLE_PERMISSION_CHANGED) {
        const payload = (msg.payload ?? {}) as { extensionId?: string; identifier?: string };
        if (payload.extensionId !== this.extensionId && payload.identifier !== this.manifest.identifier) {
          return;
        }
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

  private handleRegisterInterceptor(
    registrationId: string,
    priority?: number,
    match?: InterceptorMatchDTO,
  ): void {
    if (!this.hasPermission("interceptor")) {
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
    this.interceptorRegistrationId = registrationId;
    this.interceptorUnregister = interceptorPipeline.register({
      extensionId: this.extensionId,
      extensionName: this.manifest.name || this.manifest.identifier,
      userId: scopedUserId,
      priority: priority ?? 100,
      match,
      resolveTimeoutMs,
      handler: async (messages, context) => {
        const requestId = crypto.randomUUID();
        const timeoutMs = resolveTimeoutMs();

        // Expose assembly-source membership explicitly on the DTO so extensions
        // can distinguish real chat turns and standalone World Info blocks
        // from other prompt material. Shallow-copy so the synthetic flags never
        // leak onto the outbound LLM payload.
        const messagesWithSourceFlags = messages.map((m) => {
          const llm = m as unknown as LlmMessage;
          const isChatHistory = promptAssemblySvc.isChatHistoryMessage(llm);
          const isWorldInfoEntry = promptAssemblySvc.isWorldInfoEntryMessage(llm);
          if (!isChatHistory && !isWorldInfoEntry) return m;
          const sourceMessageId = promptAssemblySvc.getSourceMessageId(llm);
          const sourceIndexInChat = promptAssemblySvc.getSourceIndexInChat(llm);
          return {
            ...m,
            ...(isChatHistory ? { __isChatHistory: true } : {}),
            ...(isWorldInfoEntry ? { __isWorldInfoEntry: true } : {}),
            ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
            ...(sourceIndexInChat !== undefined ? { sourceIndexInChat } : {}),
          };
        });

        const interceptorContext = context as Omit<InterceptorContextDTO, "signal">;
        this.activeInterceptorContexts.set(registrationId, interceptorContext);
        this.postToWorker({
          type: "intercept_request",
          requestId,
          registrationId,
          messages: messagesWithSourceFlags,
          context: interceptorContext,
        });

        return new Promise<InterceptorResult>((resolve, reject) => {
          const timeout = setTimeout(() => {
            setTimeout(() => {
              if (!this.pendingRequests.has(requestId)) return;
              this.pendingRequests.delete(requestId);
              reject(
                new Error(
                  `Interceptor timeout from ${this.manifest.identifier} (${Math.round(timeoutMs / 1000)}s)`
                )
              );
            }, 0);
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
        }).finally(() => {
          if (this.activeInterceptorContexts.get(registrationId) === interceptorContext) {
            this.activeInterceptorContexts.delete(registrationId);
          }
        });
      },
    });
  }

  private handleUnregisterInterceptor(registrationId: string): void {
    if (registrationId !== this.interceptorRegistrationId) return;
    this.interceptorUnregister?.();
    this.interceptorUnregister = null;
    this.interceptorRegistrationId = null;
    this.activeInterceptorContexts.delete(registrationId);
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
      content: typeof message.content === "string"
        ? message.content
        : message.content.map((part: any) => part.text || "").join(""),
      extensionId: this.manifest.identifier,
      extensionName,
    };
  }

  // ─── Tool registration ───────────────────────────────────────────────

  private handleRegisterTool(toolDTO: any): void {
    if (!this.hasPermission("tools")) {
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
    if (!this.hasPermission("generation")) {
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
            reasoning: input.reasoning,
            signal: abortController.signal,
          });
          break;
        case "quiet":
          result = await generateSvc.quietGenerate(resolvedUserId, {
            messages: input.messages || [],
            connection_id: input.connection_id,
            parameters: input.parameters,
            tools: input.tools,
            reasoning: input.reasoning,
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
    if (!this.hasPermission("generation")) {
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
            reasoning: input.reasoning,
            signal: abortController.signal,
          });
          break;
        case "quiet":
          stream = await generateSvc.quietGenerateStream(resolvedUserId, {
            messages: input.messages || [],
            connection_id: input.connection_id,
            parameters: input.parameters,
            tools: input.tools,
            reasoning: input.reasoning,
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
    if (!this.hasPermission("generation")) {
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
        reasoning_bindings: extractReasoningBindingsDTO(c.metadata),
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
    if (!this.hasPermission("generation")) {
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
        reasoning_bindings: extractReasoningBindingsDTO(c.metadata),
        created_at: c.created_at,
        updated_at: c.updated_at,
      };
      this.postToWorker({ type: "response", requestId, result: profile });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private getConnectionDispatchDescriptor(
    userId: string,
    connectionId: string,
  ): ConnectionDispatchDescriptorDTO | null {
    const connection = connectionsSvc.getConnection(userId, connectionId);
    if (!connection) return null;
    let endpointOrigin = connection.api_url;
    try {
      endpointOrigin = new URL(connection.api_url).origin;
    } catch {
      // Preserve a non-standard endpoint verbatim; the descriptor is
      // informational and must never expose credentials.
    }
    return {
      connectionId: connection.id,
      connectionName: connection.name,
      provider: connection.provider,
      model: connection.model,
      endpointOrigin,
      dispatchKind: "concrete",
      connectionDispatchRevision: `${connection.id}:${connection.updated_at}`,
    };
  }

  private getActiveInterceptorContext(): Omit<InterceptorContextDTO, "signal"> {
    const registrationId = this.interceptorRegistrationId;
    const context = registrationId ? this.activeInterceptorContexts.get(registrationId) : undefined;
    if (!context) throw new Error("This operation is only available during an active interceptor callback");
    return context;
  }

  private resolveBoundDispatch(
    context: Omit<InterceptorContextDTO, "signal">,
    dispatch: BoundAssembleRequestDTO["dispatch"],
  ): ConnectionDispatchDescriptorDTO {
    const descriptor = dispatch.source === "main"
      ? context.mainDispatch.descriptor
      : this.getConnectionDispatchDescriptor(context.userId, dispatch.connectionId);
    if (!descriptor || descriptor.dispatchKind !== "concrete") {
      throw new Error("The requested connection dispatch is not available");
    }
    if (descriptor.connectionDispatchRevision !== dispatch.expectedConnectionDispatchRevision) {
      throw new Error("The requested connection dispatch changed before it could be used");
    }
    return descriptor;
  }

  private handleConnectionsResolveDispatch(requestId: string, connectionId: string): void {
    try {
      if (!this.hasPermission("generation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} generation — Connection dispatch access requires the generation permission`);
      }
      const context = this.getActiveInterceptorContext();
      const descriptor = this.getConnectionDispatchDescriptor(context.userId, connectionId);
      this.postToWorker({ type: "response", requestId, result: descriptor });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err?.message ?? String(err) });
    }
  }

  private async handleBoundAssembly(
    requestId: string,
    input: Omit<BoundAssembleRequestDTO, "signal">,
  ): Promise<void> {
    try {
      if (!this.hasPermission("generation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`);
      }
      if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now()) {
        this.postToWorker({
          type: "response",
          requestId,
          result: { ok: false, error: { kind: "precondition", code: "INTERCEPTOR_DEADLINE_EXPIRED", message: "The interceptor deadline has expired" } },
        });
        return;
      }
      const context = this.getActiveInterceptorContext();
      const dispatch = this.resolveBoundDispatch(context, input.dispatch);
      const controller = new AbortController();
      this.generationAbortControllers.set(requestId, controller);
      try {
        const result = await assembleSpindleBlocks(
          context.userId,
          this.manifest.identifier,
          {
            blocks: input.blocks as PromptBlock[],
            chatId: context.chatId,
            connectionId: dispatch.connectionId,
            generationType: context.generationType,
            promptVariables: input.promptVariableValues,
          },
          controller.signal,
        );
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            ok: true,
            result: {
              ...result,
              resolved: {
                source: input.dispatch.source === "main" ? "main" : "slot",
                connectionId: input.dispatch.source === "main" ? null : dispatch.connectionId,
                connectionDispatchRevision: dispatch.connectionDispatchRevision!,
                dispatchKind: "concrete",
              },
            },
          },
        });
      } finally {
        this.generationAbortControllers.delete(requestId);
      }
    } catch (err: any) {
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          ok: false,
          error: {
            kind: err?.name === "AbortError" ? "abort" : "precondition",
            code: err?.name === "AbortError" ? "ASSEMBLY_ABORTED" : "BOUND_ASSEMBLY_FAILED",
            ...(err?.name === "AbortError" ? { name: "AbortError" } : {}),
            message: err?.message ?? String(err),
          },
        },
      });
    }
  }

  private async handleBoundQuietGeneration(
    requestId: string,
    input: Omit<QuietTrackedRequestDTO, "signal">,
  ): Promise<void> {
    try {
      if (!this.hasPermission("generation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`);
      }
      if (!Number.isFinite(input.deadlineAt) || input.deadlineAt <= Date.now()) {
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            ok: false,
            phase: "preflight",
            providerInvoked: false,
            receipt: null,
            error: { kind: "precondition", code: "INTERCEPTOR_DEADLINE_EXPIRED", name: "Error", message: "The interceptor deadline has expired" },
          },
        });
        return;
      }
      if (input.continuation) {
        throw new Error("Tracked quiet generation with a parent prefill is not available for this host runtime");
      }
      const context = this.getActiveInterceptorContext();
      const dispatch = this.resolveBoundDispatch(context, input.dispatch);
      const controller = new AbortController();
      this.generationAbortControllers.set(requestId, controller);
      try {
        const response = await generateSvc.quietGenerate(context.userId, {
          messages: input.messages as any,
          connection_id: dispatch.connectionId,
          parameters: input.parameters as any,
          reasoning: input.reasoning as any,
          tools: input.tools as any,
          signal: controller.signal,
        });
        this.postToWorker({
          type: "response",
          requestId,
          result: {
            ok: true,
            response,
            receipt: {
              providerInvoked: true,
              terminalResponse: true,
              source: input.dispatch.source === "main" ? "main" : "slot",
              connectionId: input.dispatch.source === "main" ? null : dispatch.connectionId,
              connectionDispatchRevision: dispatch.connectionDispatchRevision!,
              ...(response.usage ? { usage: response.usage } : {}),
            },
          },
        });
      } finally {
        this.generationAbortControllers.delete(requestId);
      }
    } catch (err: any) {
      this.postToWorker({
        type: "response",
        requestId,
        result: {
          ok: false,
          phase: "resolved",
          receipt: null,
          error: {
            kind: err?.name === "AbortError" ? "abort" : "precondition",
            code: err?.name === "AbortError" ? "QUIET_TRACKED_ABORTED" : "QUIET_TRACKED_FAILED",
            name: err?.name ?? "Error",
            message: err?.message ?? String(err),
          },
        },
      });
    }
  }

  // ─── Permissions ───────────────────────────────────────────────────────

  private handlePermissionsGetGranted(requestId: string): void {
    try {
      const granted = this.getGrantedPermissions();
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
      if (!this.hasPermission("chat_mutation")) {
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
          chat_id: m.chat_id,
          index_in_chat: m.index_in_chat,
          is_user: m.is_user,
          name: m.name,
          role,
          content: m.content,
          send_date: m.send_date,
          extra,
          metadata,
          swipe_id: swipeId,
          swipes,
          swipe_dates: swipeDates,
          parent_message_id: m.parent_message_id,
          branch_id: m.branch_id,
          created_at: m.created_at,
        };
      });

      this.postToWorker({ type: "response", requestId, result: messages });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleChatAppendMessage(
    requestId: string,
    chatId: string,
    message: {
      role: "system" | "user" | "assistant";
      content: string;
      metadata?: Record<string, unknown>;
    },
    options?: ChatAppendMessageOptions,
  ): Promise<void> {
    try {
      if (!this.hasPermission("chat_mutation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} chat_mutation — Chat mutation permission not granted`);
      }

      const triggerGeneration =
        options === true ||
        (typeof options === "object" && options !== null && options.triggerGeneration === true);
      if (triggerGeneration && !this.hasPermission("generation")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`);
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

      let generationId: string | undefined;
      if (triggerGeneration) {
        const generationOptions =
          typeof options === "object" &&
          options !== null &&
          typeof options.generation === "object" &&
          options.generation !== null
            ? options.generation
            : undefined;
        const generation = await generateSvc.startGeneration({
          userId,
          chat_id: chatId,
          generation_type: "normal",
          connection_id: generationOptions?.connection_id,
          persona_id: generationOptions?.persona_id,
          persona_addon_states: generationOptions?.persona_addon_states,
          preset_id: generationOptions?.preset_id,
          force_preset_id: generationOptions?.force_preset_id,
          parameters: generationOptions?.parameters,
          target_character_id: generationOptions?.target_character_id,
          retain_council: generationOptions?.retain_council,
        });
        generationId = generation.generationId;
      }

      this.postToWorker({
        type: "response",
        requestId,
        result: generationId ? { id: created.id, generationId } : { id: created.id },
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
      if (!this.hasPermission("chat_mutation")) {
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
          if (r.text === null) extra.reasoning = null;
          else extra.reasoning = r.text;
          extraDirty = true;
        }
        if (r.duration !== undefined) {
          delete extra.reasoning_duration;
          if (r.duration === null) extra.reasoningDuration = null;
          else extra.reasoningDuration = r.duration;
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
      if (!this.hasPermission("chat_mutation")) {
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
      if (!this.hasPermission("chat_mutation")) {
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
      if (!this.hasPermission("chat_mutation")) {
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
      if (!this.hasPermission("chat_mutation")) {
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
    if (!this.hasPermission("event_tracking")) {
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
    if (!this.hasPermission("cors_proxy")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} cors_proxy — CORS proxy permission not granted`,
      });
      return;
    }

    const isBinary = options?.responseType === "arraybuffer";
    const binaryMediaType: "audio" | "font" | "image" =
      options?.mediaType === "audio" ? "audio"
      : options?.mediaType === "font" ? "font"
      : "image";

    try {
      const response = await safeFetch(url, {
        method: options.method || "GET",
        headers: options.headers,
        body: options.body,
        timeoutMs: CORS_PROXY_TIMEOUT_MS,
        maxBytes: CORS_PROXY_MAX_BODY_BYTES,
        allowPrivate: true,
      });

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
        const isAllowedContentType =
          binaryMediaType === "audio"
            ? contentType.startsWith("audio/") || contentType.startsWith("application/ogg")
            : binaryMediaType === "font"
              ? contentType.startsWith("font/") ||
                contentType === "application/font-woff" ||
                contentType === "application/font-woff2" ||
                contentType === "application/x-font-ttf" ||
                contentType === "application/x-font-otf" ||
                contentType === "application/vnd.ms-fontobject"
              : contentType.startsWith("image/");
        if (!isAllowedContentType) {
          throw new Error(
            `CORS proxy transparent proxy only serves ${binaryMediaType} data (received Content-Type: ${contentType || "unknown"})`
          );
        }

        const binary = await readResponseBodyBinaryCapped(response, CORS_PROXY_MAX_BODY_BYTES);
        const hasValidMagic =
          binaryMediaType === "audio"
            ? validateAudioMagicBytes(binary, contentType)
            : binaryMediaType === "font"
              ? validateFontMagicBytes(binary, contentType)
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
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Context handler ─────────────────────────────────────────────────

  private handleRegisterContextHandler(priority?: number, timeoutMs?: number): void {
    if (
      !this.hasPermission("context_handler")
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

    const budgetMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.min(Math.max(timeoutMs, 1_000), 120_000)
      : 10_000;

    this.contextHandlerUnregister?.();
    this.contextHandlerUnregister = contextHandlerChain.register({
      extensionId: this.extensionId,
      extensionName: this.manifest.name || this.manifest.identifier,
      userId: this.getScopedUserId(),
      priority: priority ?? 100,
      timeoutMs: budgetMs,
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
          }, budgetMs);

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
    if (!this.hasPermission("chat_mutation")) {
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
    if (!this.hasPermission("macro_interceptor")) {
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
            console.warn(
              `[Spindle] Macro interceptor from ${this.manifest.identifier} timed out after 10s; skipping`
            );
            resolve(undefined);
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
    if (!this.hasPermission("generation")) {
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
            console.warn(
              `[Spindle] World-info interceptor from ${this.manifest.identifier} timed out after 10s; skipping`
            );
            resolve(undefined);
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

  // ─── Characters (gated: "characters") ──────────────────────────────

  private async handleGenerateDryRun(
    requestId: string,
    input: any,
    userId?: string,
  ): Promise<void> {
    try {
      if (!this.hasPermission("generation")) {
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

      const messagesDTO: LlmMessageDTO[] = dryRunResult.messages.map((m) => ({
        role: m.role,
        content: m.content,
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

  private async handleAssemblePrompt(
    requestId: string,
    input: SpindleAssembleInput,
    userId?: string,
  ): Promise<void> {
    if (!this.hasPermission("generation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} generation — Generation permission not granted`,
      });
      return;
    }

    const resolvedUserId = this.resolveEffectiveUserId(userId);
    if (!resolvedUserId) {
      this.postToWorker({ type: "response", requestId, error: "userId is required for operator-scoped extensions" });
      return;
    }
    this.enforceScopedUser(resolvedUserId);

    const abortController = new AbortController();
    this.generationAbortControllers.set(requestId, abortController);
    try {
      const result = await assembleSpindleBlocks(
        resolvedUserId,
        this.manifest.identifier,
        input,
        abortController.signal,
      );
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      const aborted = abortController.signal.aborted || err?.name === "AbortError";
      this.postToWorker({
        type: "response",
        requestId,
        error: aborted ? "AbortError: Assembly aborted" : err?.message ?? String(err),
      });
    } finally {
      this.generationAbortControllers.delete(requestId);
    }
  }

  // ─── Toast (free tier) ───────────────────────────────────────────────

  invokeCommand(commandId: string, context: SpindleCommandContextDTO, userId: string): void {
    this.interactionApi.invokeCommand(commandId, context, userId);
  }

  getRegisteredCommands(): SpindleCommandDTO[] {
    return this.interactionApi.getRegisteredCommands();
  }

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

      const connection = connectionsSvc.resolveConnection(userId, sidecar.connectionProfileId);
      if (!connection) {
        throw new Error("Selected sidecar connection not found");
      }

      const model = String(sidecar.model || connection.model || "").trim();
      if (!model) {
        throw new Error("Selected sidecar connection does not have a model configured");
      }

      return { model, modelSource: "sidecar" };
    }

    const connection = connectionsSvc.resolveConnection(userId);
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

  private async handleUploadsGet(requestId: string, uploadId: string, userId?: string): Promise<void> {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const rec = spindleUploads.getUpload(uploadId);
      if (!rec || rec.ownerUserId !== resolvedUserId || rec.extensionIdentifier !== this.manifest.identifier) {
        this.postToWorker({ type: "response", requestId, result: null });
        return;
      }
      const data = await spindleUploads.readUploadBytes(uploadId);
      this.postToWorker({ type: "response", requestId, result: { fileName: rec.fileName, size: data.byteLength, data } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private async handleUploadsDelete(requestId: string, uploadId: string, userId?: string): Promise<void> {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);
      const rec = spindleUploads.getUpload(uploadId);
      if (!rec || rec.ownerUserId !== resolvedUserId || rec.extensionIdentifier !== this.manifest.identifier) {
        this.postToWorker({ type: "response", requestId, result: false });
        return;
      }
      spindleUploads.deleteUpload(uploadId);
      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
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
      const personaAddonStatesSvc = await import("../services/persona-addon-states");

      let env;

      if (chatId) {
        const chat = chatsSvc.getChat(resolvedUserId, chatId);
        if (chat) {
          const charId = characterId || chat.character_id;
          const { makeAssistantCharacter } = await import("../types/character");
          const { isTemporaryChatMetadata } = await import("../types/chat");
          const character = charId
            ? charactersSvc.getCharacter(resolvedUserId, charId)
            : makeAssistantCharacter();
          if (character) {
            const persona = isTemporaryChatMetadata(chat.metadata)
              ? null
              : personaAddonStatesSvc.resolvePersonaForChatMacros(resolvedUserId, personasSvc.resolvePersonaOrDefault(resolvedUserId), chat.metadata);
            const messages = chatsSvc.getMessages(resolvedUserId, chatId);
            const connection = connectionsSvc.resolveConnection(resolvedUserId);

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
          const persona = personaAddonStatesSvc.resolvePersonaForChatMacros(resolvedUserId, personasSvc.resolvePersonaOrDefault(resolvedUserId), null);
          const connection = connectionsSvc.resolveConnection(resolvedUserId);

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
        // Minimal fallback. Route through buildEnv so persona add-ons and
        // outlet-backed add-ons behave the same as other macro contexts.
        const { makeAssistantCharacter } = await import("../types/character");
        const persona = personaAddonStatesSvc.resolvePersonaForChatMacros(
          resolvedUserId,
          personasSvc.getDefaultPersona(resolvedUserId),
          null,
        );
        const connection = connectionsSvc.resolveConnection(resolvedUserId);
        env = buildEnv({
          character: makeAssistantCharacter(),
          persona,
          chat: {
            id: "",
            character_id: null,
            name: "",
            metadata: {},
            created_at: 0,
            updated_at: 0,
          },
          messages: [],
          generationType: "normal",
          commit,
          connection,
        });
      }

      const result = await evaluate(template, env, registry);
      this.postToWorker({ type: "response", requestId, result: { text: result.text, diagnostics: result.diagnostics } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
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
