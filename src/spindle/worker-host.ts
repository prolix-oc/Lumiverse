import type {
  SpindleManifest,
  WorkerToHost,
  HostToWorker,
  LlmMessageDTO,
  ToolRegistration,
  ExtensionInfo,
  ConnectionProfileDTO,
  CharacterDTO,
  ChatDTO,
  WorldBookDTO,
  WorldBookEntryDTO,
  PersonaDTO,
  ActivatedWorldInfoEntryDTO,
  DryRunResultDTO,
  ChatMemoryResultDTO,
  ThemeOverrideDTO,
  SpindleCommandDTO,
  SpindleCommandContextDTO,
} from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import { createOAuthState } from "./oauth-state";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { registry as macroRegistry } from "../macros";
import { interceptorPipeline, type InterceptorResult } from "./interceptor-pipeline";
import { contextHandlerChain } from "./context-handler";
import { toolRegistry } from "./tool-registry";
import * as managerSvc from "./manager.service";
import * as generateSvc from "../services/generate.service";
import * as connectionsSvc from "../services/connections.service";
import * as charactersSvc from "../services/characters.service";
import * as chatsSvc from "../services/chats.service";
import * as worldBooksSvc from "../services/world-books.service";
import * as personasSvc from "../services/personas.service";
import * as settingsSvc from "../services/settings.service";
import * as colorExtractionSvc from "../services/color-extraction.service";
import { generateThemeVariables as generateThemeVariablesFn } from "../utils/theme-engine";
import * as promptAssemblySvc from "../services/prompt-assembly.service";
import * as embeddingsSvc from "../services/embeddings.service";
import * as imageGenConnSvc from "../services/image-gen-connections.service";
import { getImageProvider, getImageProviderList } from "../image-gen/registry";
import "../image-gen/index";
import { getEphemeralPoolConfig } from "./ephemeral-pool.service";
import { getDb } from "../db/connection";
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
import { join, resolve, relative, sep } from "path";

const EPHEMERAL_MAX_FILES = 250;

const CORS_PROXY_TIMEOUT_MS = 30_000;

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
  private worker: Worker | null = null;
  private eventUnsubscribers = new Map<string, () => void>();
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private interceptorUnregister: (() => void) | null = null;
  private contextHandlerUnregister: (() => void) | null = null;
  private registeredMacroNames = new Set<string>();
  private macroValueCache = new Map<string, string>();
  private toastTimestamps: number[] = [];
  private static readonly TOAST_RATE_LIMIT = 5;
  private static readonly TOAST_RATE_WINDOW_MS = 10_000;
  private registeredCommands: SpindleCommandDTO[] = [];
  private static readonly MAX_COMMANDS_PER_EXTENSION = 20;
  private commandInvokedHandlers = new Set<string>(); // tracked for cleanup only
  private onWorkerReady: (() => void) | null = null;
  private readonly installScope: "operator" | "user";
  private readonly installedByUserId: string | null;

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

  private getStorageRootPath(identifier: string = this.manifest.identifier): string {
    if (identifier === this.manifest.identifier && this.installScope === "user") {
      if (!this.installedByUserId) {
        throw new Error("Extension owner is not set");
      }
      return managerSvc.getUserExtensionStoragePath(identifier, this.installedByUserId);
    }
    return managerSvc.getStoragePath(identifier);
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

    this.worker = new Worker(runtimePath, {
      type: "module",
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

    this.worker.onmessage = (event) => {
      this.handleMessage(event.data as WorkerToHost);
    };

    this.worker.onerror = (event) => {
      console.error(
        `[Spindle:${this.manifest.identifier}] Worker error:`,
        event.message
      );
      eventBus.emit(EventType.SPINDLE_EXTENSION_ERROR, {
        extensionId: this.extensionId,
        identifier: this.manifest.identifier,
        error: event.message,
      });

      // Detect fatal worker crash: try a no-op postMessage to see if the
      // worker is still alive. If it throws, the worker is dead — clean up
      // registered macros/interceptors so they don't silently fail forever.
      try {
        this.worker?.postMessage({ type: "ping" } as any);
      } catch {
        console.warn(
          `[Spindle:${this.manifest.identifier}] Worker appears dead after error, cleaning up registrations`
        );
        this.cleanup();
      }
    };

    // Send init message with the extension's backend entry path
    const storagePath = this.getStorageRootPath(this.manifest.identifier);
    this.postToWorker({
      type: "init",
      manifest: { ...this.manifest, entry_backend: entryPath },
      storagePath,
    });

    await readyPromise;
  }

  async stop(): Promise<void> {
    if (!this.worker) return;

    // Send shutdown
    this.postToWorker({ type: "shutdown" });

    // Wait up to 5 seconds then terminate
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.worker?.terminate();
        resolve();
      }, 5000);

      // If the worker terminates naturally, clear the timer
      const origOnMessage = this.worker!.onmessage;
      this.worker!.onmessage = (event) => {
        if (origOnMessage) (origOnMessage as any)(event);
      };

      setTimeout(() => {
        clearTimeout(timer);
        this.worker?.terminate();
        resolve();
      }, 5000);
    });

    this.cleanup();
  }

  private cleanup(): void {
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

    // Reject pending requests
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Extension worker stopped"));
    }
    this.pendingRequests.clear();

    this.worker = null;
  }

  private postToWorker(msg: HostToWorker): void {
    this.worker?.postMessage(msg);
  }

  sendFrontendMessage(payload: unknown, userId: string): void {
    this.postToWorker({ type: "frontend_message", payload, userId });
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
   */
  invokeExtensionTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<string> {
    const requestId = crypto.randomUUID();

    this.postToWorker({
      type: "tool_invocation",
      requestId,
      toolName,
      args,
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

  private handleMessage(msg: WorkerToHost): void {
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
        this.resolveRequest(msg.requestId, { messages: msg.messages, parameters: interceptParams });
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
      case "frontend_message":
        eventBus.emit(
          EventType.SPINDLE_FRONTEND_MSG,
          {
            extensionId: this.extensionId,
            identifier: this.manifest.identifier,
            data: msg.payload,
          },
          this.installScope === "user" ? this.installedByUserId ?? undefined : undefined
        );
        break;
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
      // ─── Toast (free tier) ────────────────────────────────────────────
      case "toast_show":
        this.handleToastShow(msg.toastType, msg.message, msg.title, msg.duration);
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
        this.handleModalOpen(msg.requestId, msg.title, msg.items, msg.width, msg.maxHeight, msg.persistent, msg.userId);
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
      // ─── Macro Resolution (free tier — no permission needed) ────────────
      case "macros_resolve":
        this.handleMacrosResolve(msg.requestId, msg.template, msg.chatId, msg.characterId, msg.userId);
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

  private handleSubscribeEvent(event: string): void {
    const eventType = (EventType as any)[event];
    if (!eventType) {
      console.warn(
        `[Spindle:${this.manifest.identifier}] Unknown event: ${event}`
      );
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
        if (!this.worker) {
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
            if (this.worker) {
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

    this.interceptorUnregister?.();
    this.interceptorUnregister = interceptorPipeline.register({
      extensionId: this.extensionId,
      userId: this.getScopedUserId(),
      priority: priority ?? 100,
      handler: async (messages, context) => {
        const requestId = crypto.randomUUID();

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
                `Interceptor timeout from ${this.manifest.identifier}`
              )
            );
          }, 10_000);

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
          });
          break;
        case "quiet":
          result = await generateSvc.quietGenerate(resolvedUserId, {
            messages: input.messages || [],
            connection_id: input.connection_id,
            parameters: input.parameters,
            tools: input.tools,
          });
          break;
        case "batch":
          result = await generateSvc.batchGenerate(resolvedUserId, {
            requests: input.requests || [],
            concurrent: input.concurrent,
          });
          break;
        default:
          throw new Error(`Unknown generation type: ${input.type}`);
      }
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({
        type: "response",
        requestId,
        error: err.message,
      });
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
            `image-gen-${connection.provider}-${Date.now()}.png`
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
        const role = this.mapChatRole(m.is_user, (m.extra || {}) as Record<string, unknown>);
        const extra = (m.extra || {}) as Record<string, unknown>;
        const metadata =
          typeof extra.spindle_metadata === "object" && extra.spindle_metadata
            ? (extra.spindle_metadata as Record<string, unknown>)
            : undefined;

        return {
          id: m.id,
          role,
          content: m.content,
          metadata,
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
    patch: { content?: string; metadata?: Record<string, unknown> }
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
      if (patch.metadata !== undefined) {
        extra.spindle_metadata = patch.metadata;
      }

      updateChatMessage(userId, messageId, {
        content: patch.content,
        extra: patch.metadata !== undefined ? extra : undefined,
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
    if (!managerSvc.hasPermission(this.manifest.identifier, "cors_proxy")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} cors_proxy — CORS proxy permission not granted`,
      });
      return;
    }

    try {
      // Validate URL against SSRF before making the request
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new SSRFError(`Only http and https URLs are allowed`);
      }
      await validateHost(parsed.hostname);

      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: options.headers,
          body: options.body,
        });
        const text = await response.text();
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
      } catch (fetchErr: any) {
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
      created_at: c.created_at,
      updated_at: c.updated_at,
    };
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

      const c = charactersSvc.createCharacter(resolvedUserId, {
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
      });
      this.postToWorker({ type: "response", requestId, result: this.toCharacterDTO(c) });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  private handleCharactersUpdate(requestId: string, characterId: string, input: any, userId?: string): void {
    try {
      if (!managerSvc.hasPermission(this.manifest.identifier, "characters")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} characters — Characters permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const c = charactersSvc.updateCharacter(resolvedUserId, characterId, input || {});
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

    // Broadcast — scoped to extension owner for user-scoped extensions
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
      this.installScope === "user" ? this.installedByUserId ?? undefined : undefined,
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
    if (!this.worker) return;
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
        data: { url: url || "/", characterName: this.manifest.name },
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
  ): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");

      const modalRequestId = `spindle-modal:${this.extensionId}:${requestId}`;

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
            connection,
          });
        }
      }

      if (!env) {
        // Minimal fallback
        const persona = personasSvc.getDefaultPersona(resolvedUserId);
        const connection = connectionsSvc.getDefaultConnection(resolvedUserId);
        env = {
          names: {
            user: persona?.name || "User", char: "", group: "", groupNotMuted: "", notChar: persona?.name || "User",
            charGroupFocused: "", groupOthers: "", groupMemberCount: "0", isGroupChat: "no", groupLastSpeaker: "",
          },
          character: {
            name: "", description: "", personality: "", scenario: "", persona: persona?.description || "",
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
          variables: { local: new Map(), global: new Map() },
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

  /** Active CSS variable overrides for this extension (null = none). */
  private themeOverrides: ThemeOverrideDTO | null = null;

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
      // Validate: variables must be a Record<string, string> if provided
      if (overrides.variables) {
        if (typeof overrides.variables !== "object" || Array.isArray(overrides.variables)) {
          this.postToWorker({ type: "response", requestId, error: "overrides.variables must be an object" });
          return;
        }
        // Only allow CSS custom property keys (--*)
        for (const key of Object.keys(overrides.variables)) {
          if (!key.startsWith("--")) {
            this.postToWorker({ type: "response", requestId, error: `Invalid CSS variable key: "${key}" (must start with --)` });
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
            for (const key of Object.keys(modeVars)) {
              if (!key.startsWith("--")) {
                this.postToWorker({ type: "response", requestId, error: `Invalid CSS variable key in variablesByMode.${modeKey}: "${key}"` });
                return;
              }
            }
          }
        }
      }

      this.commitThemeOverrides(overrides);

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

  private commitThemeOverrides(overrides: ThemeOverrideDTO): void {
    const existingByMode = this.themeOverrides?.variablesByMode ?? {};
    const nextVariables = this.shouldReplaceThemeScope(overrides.variables)
      ? { ...(overrides.variables ?? {}) }
      : {
          ...(this.themeOverrides?.variables ?? {}),
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

    this.themeOverrides = {
      variables: nextVariables,
      variablesByMode: (nextDarkVars || nextLightVars)
        ? {
            dark: nextDarkVars,
            light: nextLightVars,
          }
        : undefined,
    };

    eventBus.emit(
      EventType.SPINDLE_THEME_OVERRIDES,
      {
        extensionId: this.extensionId,
        extensionName: this.manifest.name,
        overrides: this.themeOverrides,
      },
      this.installScope === "user" ? this.installedByUserId ?? undefined : undefined,
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
      if (!palette?.accent || typeof palette.accent.h !== "number" || typeof palette.accent.s !== "number" || typeof palette.accent.l !== "number") {
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

      this.emitPaletteColorOverrides(accent);

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
      this.themeOverrides = null;

      // Broadcast clear to frontend
      eventBus.emit(
        EventType.SPINDLE_THEME_OVERRIDES,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          overrides: null,
        },
        this.installScope === "user" ? this.installedByUserId ?? undefined : undefined,
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
  private emitPaletteColorOverrides(accent: { h: number; s: number; l: number }): void {
    const strip = (vars: Record<string, string>) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(vars)) {
        if (!WorkerHost.USER_PREFERENCE_KEYS.has(k)) out[k] = v;
      }
      return out;
    };

    const connectedUserIds = this.installScope === "operator"
      ? eventBus.getConnectedUserIds()
      : (this.installedByUserId ? [this.installedByUserId] : []);

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
    if (this.themeOverrides) {
      this.themeOverrides = null;
      eventBus.emit(
        EventType.SPINDLE_THEME_OVERRIDES,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          overrides: null,
        },
        this.installScope === "user" ? this.installedByUserId ?? undefined : undefined,
      );
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
