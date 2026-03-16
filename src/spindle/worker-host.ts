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
} from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { validateHost, SSRFError } from "../utils/safe-fetch";
import { createOAuthState } from "./oauth-state";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { registry as macroRegistry } from "../macros";
import { interceptorPipeline } from "./interceptor-pipeline";
import { contextHandlerChain } from "./context-handler";
import { toolRegistry } from "./tool-registry";
import * as managerSvc from "./manager.service";
import * as generateSvc from "../services/generate.service";
import * as connectionsSvc from "../services/connections.service";
import * as charactersSvc from "../services/characters.service";
import * as chatsSvc from "../services/chats.service";
import * as settingsSvc from "../services/settings.service";
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

    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

export class WorkerHost {
  private worker: Worker | null = null;
  private eventUnsubscribers: (() => void)[] = [];
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private interceptorUnregister: (() => void) | null = null;
  private contextHandlerUnregister: (() => void) | null = null;
  private registeredMacroNames = new Set<string>();
  private macroValueCache = new Map<string, string>();
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
    const entryPath = managerSvc.getBackendEntryPath(this.manifest.identifier);
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
    for (const unsub of this.eventUnsubscribers) {
      unsub();
    }
    this.eventUnsubscribers = [];

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
        // We don't track individual unsubs — cleaned up on stop
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
      case "intercept_result":
        this.resolveRequest(msg.requestId, msg.messages);
        break;
      case "register_tool":
        this.handleRegisterTool(msg.tool);
        break;
      case "unregister_tool":
        toolRegistry.unregister(msg.name, this.extensionId);
        break;
      case "request_generation":
        this.handleGeneration(msg.requestId, msg.input);
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
      case "log":
        this.handleLog(msg.level, msg.message);
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
    this.eventUnsubscribers.push(unsub);
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

        return new Promise<LlmMessageDTO[]>((resolve, reject) => {
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
              resolve(val as LlmMessageDTO[]);
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
          });
          break;
        case "quiet":
          result = await generateSvc.quietGenerate(resolvedUserId, {
            messages: input.messages || [],
            connection_id: input.connection_id,
            parameters: input.parameters,
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

  private getExtensionEphemeralMaxBytes(identifier: string): number {
    const cfg = getEphemeralPoolConfig();
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

  private getGlobalEphemeralPoolUsage(): {
    usedBytes: number;
    reservedBytes: number;
  } {
    const extensions = managerSvc.list();
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

  private enforceEphemeralQuota(
    pathKey: string,
    incomingSizeBytes: number,
    reservationId?: string
  ): { reservedConsumptionBytes: number } {
    this.clearExpiredEphemeralEntriesInternal();
    this.clearExpiredReservations();

    const usage = this.collectEphemeralUsage();
    const global = this.getGlobalEphemeralPoolUsage();
    const extensionMax = this.getExtensionEphemeralMaxBytes(this.manifest.identifier);
    const globalMax = getEphemeralPoolConfig().globalMaxBytes;

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

  private handleEphemeralWrite(
    requestId: string,
    path: string,
    data: string,
    ttlMs?: number,
    reservationId?: string
  ): void {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      const pathKey = this.getEphemeralPathKey(fullPath);
      const sizeBytes = Buffer.byteLength(data, "utf-8");
      const quota = this.enforceEphemeralQuota(pathKey, sizeBytes, reservationId);
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

  private handleEphemeralWriteBinary(
    requestId: string,
    path: string,
    data: Uint8Array,
    ttlMs?: number,
    reservationId?: string
  ): void {
    try {
      const fullPath = this.resolveEphemeralPath(path);
      const pathKey = this.getEphemeralPathKey(fullPath);
      const quota = this.enforceEphemeralQuota(
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

  private handleEphemeralPoolStatus(requestId: string): void {
    try {
      this.clearExpiredEphemeralEntriesInternal();
      this.clearExpiredReservations();

      const extensionUsage = this.collectEphemeralUsage();
      const globalUsage = this.getGlobalEphemeralPoolUsage();
      const extensionMax = this.getExtensionEphemeralMaxBytes(this.manifest.identifier);
      const globalMax = getEphemeralPoolConfig().globalMaxBytes;

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

  private handleEphemeralRequestBlock(
    requestId: string,
    sizeBytes: number,
    ttlMs?: number,
    reason?: string
  ): void {
    try {
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
        throw new Error("sizeBytes must be a positive number");
      }

      const now = Date.now();
      const cfg = getEphemeralPoolConfig();
      const effectiveTtlMs =
        ttlMs && ttlMs > 0 ? ttlMs : cfg.reservationTtlMs;
      const expiresAt = new Date(now + effectiveTtlMs).toISOString();

      this.clearExpiredEphemeralEntriesInternal();
      this.clearExpiredReservations();

      const extensionUsage = this.collectEphemeralUsage();
      const globalUsage = this.getGlobalEphemeralPoolUsage();
      const extensionMax = this.getExtensionEphemeralMaxBytes(this.manifest.identifier);
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
