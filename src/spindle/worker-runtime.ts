/**
 * Worker runtime — runs inside each extension's Bun worker thread.
 * Receives "init" from the host, dynamically imports the extension,
 * and exposes the `spindle` global API.
 */

import type {
  SpindleManifest,
  WorkerToHost,
  HostToWorker,
  LlmMessageDTO,
  SpindleAPI,
  ConnectionProfileDTO,
  PermissionDeniedDetail,
  PermissionChangedDetail,
  CharacterDTO,
  CharacterCreateDTO,
  CharacterUpdateDTO,
  ChatDTO,
  ChatUpdateDTO,
  WorldBookDTO,
  WorldBookCreateDTO,
  WorldBookUpdateDTO,
  WorldBookEntryDTO,
  WorldBookEntryCreateDTO,
  WorldBookEntryUpdateDTO,
  PersonaDTO,
  PersonaCreateDTO,
  PersonaUpdateDTO,
} from "lumiverse-spindle-types";

// ─── State ───────────────────────────────────────────────────────────────

let manifest: SpindleManifest;
let storagePath: string;

const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
const pendingResponses = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
>();
let interceptHandler:
  | ((
      messages: LlmMessageDTO[],
      context: unknown
    ) => Promise<LlmMessageDTO[]>)
  | null = null;
let contextHandlerFn: ((context: unknown) => Promise<unknown>) | null = null;
let oauthCallbackHandler:
  | ((params: Record<string, string>) => Promise<{ html?: string } | void>)
  | null = null;
const frontendMessageHandlers = new Set<(payload: unknown, userId: string) => void>();
const permissionDeniedHandlers = new Set<(detail: PermissionDeniedDetail) => void>();
const permissionChangedHandlers = new Set<(detail: PermissionChangedDetail) => void>();
const grantedPermissions = new Set<string>();
const extensionMacroHandlers = new Map<string, (ctx: unknown) => unknown | Promise<unknown>>();

// ─── Messaging ───────────────────────────────────────────────────────────

function post(msg: WorkerToHost): void {
  self.postMessage(msg);
}

function request(msg: WorkerToHost & { requestId: string }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pendingResponses.set(msg.requestId, { resolve, reject });
    post(msg);
  });
}

// ─── Spindle API (exposed to extensions as globalThis.spindle) ───────────

const spindleApi: SpindleAPI = {
  on(event: string, handler: (payload: unknown) => void): () => void {
    if (!eventHandlers.has(event)) {
      eventHandlers.set(event, new Set());
      post({ type: "subscribe_event", event });
    }
    eventHandlers.get(event)!.add(handler);

    return () => {
      eventHandlers.get(event)?.delete(handler);
      if (eventHandlers.get(event)?.size === 0) {
        eventHandlers.delete(event);
        post({ type: "unsubscribe_event", event });
      }
    };
  },

  registerMacro(def): void {
    if (typeof def.handler === "function") {
      // Function handler — store directly, strip before posting (not serializable)
      extensionMacroHandlers.set(def.name.toLowerCase(), def.handler as (ctx: unknown) => unknown | Promise<unknown>);
    } else if (typeof def.handler === "string" && def.handler.trim()) {
      try {
        const compiled = new Function("ctx", `"use strict";\n${def.handler}`) as (
          ctx: unknown
        ) => unknown | Promise<unknown>;
        extensionMacroHandlers.set(def.name.toLowerCase(), compiled);
      } catch (err: any) {
        post({
          type: "log",
          level: "error",
          message: `Failed to compile macro ${def.name}: ${err?.message || err}`,
        });
      }
    }
    // Strip handler before posting — host creates its own RPC handler;
    // functions can't survive structured cloning anyway
    const { handler: _, ...serializableDef } = def;
    post({
      type: "register_macro",
      definition: {
        ...serializableDef,
        handler: typeof def.handler === "string" ? def.handler : "",
      },
    });
  },

  unregisterMacro(name: string): void {
    extensionMacroHandlers.delete(name.toLowerCase());
    post({ type: "unregister_macro", name });
  },

  updateMacroValue(name: string, value: string): void {
    post({ type: "update_macro_value", name, value: String(value ?? "") });
  },

  registerInterceptor(handler, priority?): void {
    interceptHandler = handler;
    post({ type: "register_interceptor", priority });
  },

  registerTool(tool): void {
    post({ type: "register_tool", tool });
  },

  unregisterTool(name: string): void {
    post({ type: "unregister_tool", name });
  },

  generate: {
    async raw(input) {
      const requestId = crypto.randomUUID();
      return request({
        type: "request_generation",
        requestId,
        input: { ...input, type: "raw" },
      });
    },
    async quiet(input) {
      const requestId = crypto.randomUUID();
      return request({
        type: "request_generation",
        requestId,
        input: { ...input, type: "quiet" },
      });
    },
    async batch(input) {
      const requestId = crypto.randomUUID();
      return request({
        type: "request_generation",
        requestId,
        input: { ...input, type: "batch" },
      });
    },
    async dryRun(input, userId?: string) {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "generate_dry_run",
        requestId,
        input,
        userId,
      });
      return result as import("lumiverse-spindle-types").DryRunResultDTO;
    },
  },

  storage: {
    async read(path: string): Promise<string> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "storage_read",
        requestId,
        path,
      });
      return result as string;
    },
    async write(path: string, data: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "storage_write", requestId, path, data });
    },
    async readBinary(path: string): Promise<Uint8Array> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "storage_read_binary",
        requestId,
        path,
      });
      return result as Uint8Array;
    },
    async writeBinary(path: string, data: Uint8Array): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "storage_write_binary", requestId, path, data });
    },
    async delete(path: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "storage_delete", requestId, path });
    },
    async list(prefix?: string): Promise<string[]> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "storage_list",
        requestId,
        prefix,
      });
      return result as string[];
    },
    async exists(path: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "storage_exists", requestId, path });
      return result as boolean;
    },
    async mkdir(path: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "storage_mkdir", requestId, path });
    },
    async move(from: string, to: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "storage_move", requestId, from, to });
    },
    async stat(path: string): Promise<{
      exists: boolean;
      isFile: boolean;
      isDirectory: boolean;
      sizeBytes: number;
      modifiedAt: string;
    }> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "storage_stat", requestId, path });
      return result as {
        exists: boolean;
        isFile: boolean;
        isDirectory: boolean;
        sizeBytes: number;
        modifiedAt: string;
      };
    },
    async getJson<T>(
      path: string,
      options?: { fallback?: T }
    ): Promise<T> {
      try {
        const raw = await spindleApi.storage.read(path);
        return JSON.parse(raw) as T;
      } catch {
        if (options && "fallback" in options) {
          return options.fallback as T;
        }
        throw new Error(`Failed to parse JSON from ${path}`);
      }
    },
    async setJson(
      path: string,
      value: unknown,
      options?: { indent?: number }
    ): Promise<void> {
      const indent = options?.indent ?? 2;
      await spindleApi.storage.write(path, JSON.stringify(value, null, indent));
    },
  },

  userStorage: {
    async read(path: string, userId?: string): Promise<string> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "user_storage_read",
        requestId,
        path,
        userId,
      });
      return result as string;
    },
    async write(path: string, data: string, userId?: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "user_storage_write", requestId, path, data, userId });
    },
    async delete(path: string, userId?: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "user_storage_delete", requestId, path, userId });
    },
    async list(prefix?: string, userId?: string): Promise<string[]> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "user_storage_list",
        requestId,
        prefix,
        userId,
      });
      return result as string[];
    },
    async exists(path: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "user_storage_exists", requestId, path, userId });
      return result as boolean;
    },
    async mkdir(path: string, userId?: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "user_storage_mkdir", requestId, path, userId });
    },
    async getJson<T>(
      path: string,
      options?: { fallback?: T; userId?: string }
    ): Promise<T> {
      try {
        const raw = await spindleApi.userStorage.read(path, options?.userId);
        return JSON.parse(raw) as T;
      } catch {
        if (options && "fallback" in options) {
          return options.fallback as T;
        }
        throw new Error(`Failed to parse JSON from ${path}`);
      }
    },
    async setJson(
      path: string,
      value: unknown,
      options?: { indent?: number; userId?: string }
    ): Promise<void> {
      const indent = options?.indent ?? 2;
      await spindleApi.userStorage.write(
        path,
        JSON.stringify(value, null, indent),
        options?.userId
      );
    },
  },

  enclave: {
    async put(key: string, value: string, userId?: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "enclave_put", requestId, key, value, userId });
    },
    async get(key: string, userId?: string): Promise<string | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "enclave_get", requestId, key, userId });
      return result as string | null;
    },
    async delete(key: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "enclave_delete", requestId, key, userId });
      return result as boolean;
    },
    async has(key: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "enclave_has", requestId, key, userId });
      return result as boolean;
    },
    async list(userId?: string): Promise<string[]> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "enclave_list", requestId, userId });
      return result as string[];
    },
  },

  ephemeral: {
    async read(path: string): Promise<string> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "ephemeral_read", requestId, path });
      return result as string;
    },
    async write(
      path: string,
      data: string,
      options?: { ttlMs?: number; reservationId?: string }
    ): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({
        type: "ephemeral_write",
        requestId,
        path,
        data,
        ttlMs: options?.ttlMs,
        reservationId: options?.reservationId,
      });
    },
    async readBinary(path: string): Promise<Uint8Array> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "ephemeral_read_binary",
        requestId,
        path,
      });
      return result as Uint8Array;
    },
    async writeBinary(
      path: string,
      data: Uint8Array,
      options?: { ttlMs?: number; reservationId?: string }
    ): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({
        type: "ephemeral_write_binary",
        requestId,
        path,
        data,
        ttlMs: options?.ttlMs,
        reservationId: options?.reservationId,
      });
    },
    async delete(path: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "ephemeral_delete", requestId, path });
    },
    async list(prefix?: string): Promise<string[]> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "ephemeral_list",
        requestId,
        prefix,
      });
      return result as string[];
    },
    async stat(path: string): Promise<{
      sizeBytes: number;
      createdAt: string;
      expiresAt?: string;
    }> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "ephemeral_stat", requestId, path });
      return result as { sizeBytes: number; createdAt: string; expiresAt?: string };
    },
    async clearExpired(): Promise<number> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "ephemeral_clear_expired", requestId });
      return result as number;
    },
    async getPoolStatus(): Promise<{
      globalMaxBytes: number;
      globalUsedBytes: number;
      globalReservedBytes: number;
      globalAvailableBytes: number;
      extensionMaxBytes: number;
      extensionUsedBytes: number;
      extensionReservedBytes: number;
      extensionAvailableBytes: number;
      fileCount: number;
      fileCountMax: number;
    }> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "ephemeral_pool_status", requestId });
      return result as {
        globalMaxBytes: number;
        globalUsedBytes: number;
        globalReservedBytes: number;
        globalAvailableBytes: number;
        extensionMaxBytes: number;
        extensionUsedBytes: number;
        extensionReservedBytes: number;
        extensionAvailableBytes: number;
        fileCount: number;
        fileCountMax: number;
      };
    },
    async requestBlock(
      sizeBytes: number,
      options?: { ttlMs?: number; reason?: string }
    ): Promise<{
      reservationId: string;
      sizeBytes: number;
      expiresAt: string;
    }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "ephemeral_request_block",
        requestId,
        sizeBytes,
        ttlMs: options?.ttlMs,
        reason: options?.reason,
      });
      return result as {
        reservationId: string;
        sizeBytes: number;
        expiresAt: string;
      };
    },
    async releaseBlock(reservationId: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({
        type: "ephemeral_release_block",
        requestId,
        reservationId,
      });
    },
  },

  chat: {
    async getMessages(chatId: string) {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "chat_get_messages", requestId, chatId });
      return result as Array<{
        id: string;
        role: "system" | "user" | "assistant";
        content: string;
        metadata?: Record<string, unknown>;
      }>;
    },
    async appendMessage(chatId: string, message) {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "chat_append_message",
        requestId,
        chatId,
        message,
      });
      return result as { id: string };
    },
    async updateMessage(chatId: string, messageId: string, patch): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({
        type: "chat_update_message",
        requestId,
        chatId,
        messageId,
        patch,
      });
    },
    async deleteMessage(chatId: string, messageId: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({
        type: "chat_delete_message",
        requestId,
        chatId,
        messageId,
      });
    },
  },

  events: {
    async track(eventName, payload, options): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({
        type: "events_track",
        requestId,
        eventName,
        payload,
        options,
      });
    },
    async query(filter) {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "events_query", requestId, filter });
      return result as Array<{
        id: string;
        ts: string;
        eventName: string;
        level: "debug" | "info" | "warn" | "error";
        chatId?: string;
        payload?: Record<string, unknown>;
      }>;
    },
    async replay(filter) {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "events_replay", requestId, filter });
      return result as Array<{
        id: string;
        ts: string;
        eventName: string;
        level: "debug" | "info" | "warn" | "error";
        chatId?: string;
        payload?: Record<string, unknown>;
      }>;
    },
    async getLatestState(keys: string[]): Promise<Record<string, unknown>> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "events_get_latest_state",
        requestId,
        keys,
      });
      return result as Record<string, unknown>;
    },
  },

  connections: {
    async list(userId?: string): Promise<ConnectionProfileDTO[]> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "connections_list", requestId, userId });
      return result as ConnectionProfileDTO[];
    },
    async get(connectionId: string, userId?: string): Promise<ConnectionProfileDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "connections_get", requestId, connectionId, userId });
      return result as ConnectionProfileDTO | null;
    },
  },

  imageGen: {
    async generate(input: any): Promise<any> {
      const requestId = crypto.randomUUID();
      return request({ type: "image_gen_generate", requestId, input });
    },
    async getProviders(userId?: string): Promise<any[]> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "image_gen_providers", requestId, userId });
      return result as any[];
    },
    async listConnections(userId?: string): Promise<any[]> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "image_gen_connections_list", requestId, userId });
      return result as any[];
    },
    async getConnection(connectionId: string, userId?: string): Promise<any> {
      const requestId = crypto.randomUUID();
      return request({ type: "image_gen_connections_get", requestId, connectionId, userId });
    },
    async getModels(connectionId: string, userId?: string): Promise<Array<{ id: string; label: string }>> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "image_gen_models", requestId, connectionId, userId });
      return result as Array<{ id: string; label: string }>;
    },
  },

  theme: {
    async apply(overrides: { variables?: Record<string, string>; variablesByMode?: { dark?: Record<string, string>; light?: Record<string, string> } }): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "theme_apply", requestId, overrides });
    },
    async clear(): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "theme_clear", requestId });
    },
    async getCurrent(userId?: string): Promise<{
      id: string; name: string; mode: "light" | "dark";
      accent: { h: number; s: number; l: number };
      enableGlass: boolean; radiusScale: number; fontScale: number; characterAware: boolean;
    }> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "theme_get_current", requestId, userId });
      return result as any;
    },
    async extractColors(imageId: string, userId?: string): Promise<any> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "color_extract", requestId, imageId, userId });
      return result;
    },
  },

  variables: {
    local: {
      async get(chatId: string, key: string): Promise<string> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "vars_get_local", requestId, chatId, key });
        return result as string;
      },
      async set(chatId: string, key: string, value: string): Promise<void> {
        const requestId = crypto.randomUUID();
        await request({ type: "vars_set_local", requestId, chatId, key, value });
      },
      async delete(chatId: string, key: string): Promise<void> {
        const requestId = crypto.randomUUID();
        await request({ type: "vars_delete_local", requestId, chatId, key });
      },
      async list(chatId: string): Promise<Record<string, string>> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "vars_list_local", requestId, chatId });
        return result as Record<string, string>;
      },
      async has(chatId: string, key: string): Promise<boolean> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "vars_has_local", requestId, chatId, key });
        return result as boolean;
      },
    },
    global: {
      async get(key: string, userId?: string): Promise<string> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "vars_get_global", requestId, key, userId });
        return result as string;
      },
      async set(key: string, value: string, userId?: string): Promise<void> {
        const requestId = crypto.randomUUID();
        await request({ type: "vars_set_global", requestId, key, value, userId });
      },
      async delete(key: string, userId?: string): Promise<void> {
        const requestId = crypto.randomUUID();
        await request({ type: "vars_delete_global", requestId, key, userId });
      },
      async list(userId?: string): Promise<Record<string, string>> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "vars_list_global", requestId, userId });
        return result as Record<string, string>;
      },
      async has(key: string, userId?: string): Promise<boolean> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "vars_has_global", requestId, key, userId });
        return result as boolean;
      },
    },
  },

  characters: {
    async list(options?: { limit?: number; offset?: number; userId?: string }): Promise<{ data: CharacterDTO[]; total: number }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "characters_list",
        requestId,
        limit: options?.limit,
        offset: options?.offset,
        userId: options?.userId,
      });
      return result as { data: CharacterDTO[]; total: number };
    },
    async get(characterId: string, userId?: string): Promise<CharacterDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "characters_get", requestId, characterId, userId });
      return result as CharacterDTO | null;
    },
    async create(input: CharacterCreateDTO, userId?: string): Promise<CharacterDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "characters_create", requestId, input, userId });
      return result as CharacterDTO;
    },
    async update(characterId: string, input: CharacterUpdateDTO, userId?: string): Promise<CharacterDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "characters_update", requestId, characterId, input, userId });
      return result as CharacterDTO;
    },
    async delete(characterId: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "characters_delete", requestId, characterId, userId });
      return result as boolean;
    },
  },

  chats: {
    async list(options?: { characterId?: string; limit?: number; offset?: number; userId?: string }): Promise<{ data: ChatDTO[]; total: number }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "chats_list",
        requestId,
        characterId: options?.characterId,
        limit: options?.limit,
        offset: options?.offset,
        userId: options?.userId,
      });
      return result as { data: ChatDTO[]; total: number };
    },
    async get(chatId: string, userId?: string): Promise<ChatDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "chats_get", requestId, chatId, userId });
      return result as ChatDTO | null;
    },
    async getActive(userId?: string): Promise<ChatDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "chats_get_active", requestId, userId });
      return result as ChatDTO | null;
    },
    async update(chatId: string, input: ChatUpdateDTO, userId?: string): Promise<ChatDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "chats_update", requestId, chatId, input, userId });
      return result as ChatDTO;
    },
    async delete(chatId: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "chats_delete", requestId, chatId, userId });
      return result as boolean;
    },
    async getMemories(chatId: string, options?: { topK?: number; userId?: string }) {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "chats_get_memories",
        requestId,
        chatId,
        topK: options?.topK,
        userId: options?.userId,
      });
      return result as import("lumiverse-spindle-types").ChatMemoryResultDTO;
    },
  },

  world_books: {
    async list(options?: { limit?: number; offset?: number; userId?: string }): Promise<{ data: WorldBookDTO[]; total: number }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "world_books_list",
        requestId,
        limit: options?.limit,
        offset: options?.offset,
        userId: options?.userId,
      });
      return result as { data: WorldBookDTO[]; total: number };
    },
    async get(worldBookId: string, userId?: string): Promise<WorldBookDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "world_books_get", requestId, worldBookId, userId });
      return result as WorldBookDTO | null;
    },
    async create(input: WorldBookCreateDTO, userId?: string): Promise<WorldBookDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "world_books_create", requestId, input, userId });
      return result as WorldBookDTO;
    },
    async update(worldBookId: string, input: WorldBookUpdateDTO, userId?: string): Promise<WorldBookDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "world_books_update", requestId, worldBookId, input, userId });
      return result as WorldBookDTO;
    },
    async delete(worldBookId: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "world_books_delete", requestId, worldBookId, userId });
      return result as boolean;
    },
    entries: {
      async list(worldBookId: string, options?: { limit?: number; offset?: number; userId?: string }): Promise<{ data: WorldBookEntryDTO[]; total: number }> {
        const requestId = crypto.randomUUID();
        const result = await request({
          type: "world_book_entries_list",
          requestId,
          worldBookId,
          limit: options?.limit,
          offset: options?.offset,
          userId: options?.userId,
        });
        return result as { data: WorldBookEntryDTO[]; total: number };
      },
      async get(entryId: string, userId?: string): Promise<WorldBookEntryDTO | null> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "world_book_entries_get", requestId, entryId, userId });
        return result as WorldBookEntryDTO | null;
      },
      async create(worldBookId: string, input: WorldBookEntryCreateDTO, userId?: string): Promise<WorldBookEntryDTO> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "world_book_entries_create", requestId, worldBookId, input, userId });
        return result as WorldBookEntryDTO;
      },
      async update(entryId: string, input: WorldBookEntryUpdateDTO, userId?: string): Promise<WorldBookEntryDTO> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "world_book_entries_update", requestId, entryId, input, userId });
        return result as WorldBookEntryDTO;
      },
      async delete(entryId: string, userId?: string): Promise<boolean> {
        const requestId = crypto.randomUUID();
        const result = await request({ type: "world_book_entries_delete", requestId, entryId, userId });
        return result as boolean;
      },
    },
    async getActivated(chatId: string, userId?: string) {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "world_books_get_activated",
        requestId,
        chatId,
        userId,
      });
      return result as import("lumiverse-spindle-types").ActivatedWorldInfoEntryDTO[];
    },
  },

  personas: {
    async list(options?: { limit?: number; offset?: number; userId?: string }): Promise<{ data: PersonaDTO[]; total: number }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "personas_list",
        requestId,
        limit: options?.limit,
        offset: options?.offset,
        userId: options?.userId,
      });
      return result as { data: PersonaDTO[]; total: number };
    },
    async get(personaId: string, userId?: string): Promise<PersonaDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_get", requestId, personaId, userId });
      return result as PersonaDTO | null;
    },
    async getDefault(userId?: string): Promise<PersonaDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_get_default", requestId, userId });
      return result as PersonaDTO | null;
    },
    async getActive(userId?: string): Promise<PersonaDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_get_active", requestId, userId });
      return result as PersonaDTO | null;
    },
    async create(input: PersonaCreateDTO, userId?: string): Promise<PersonaDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_create", requestId, input, userId });
      return result as PersonaDTO;
    },
    async update(personaId: string, input: PersonaUpdateDTO, userId?: string): Promise<PersonaDTO> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_update", requestId, personaId, input, userId });
      return result as PersonaDTO;
    },
    async delete(personaId: string, userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_delete", requestId, personaId, userId });
      return result as boolean;
    },
    async switchActive(personaId: string | null, userId?: string): Promise<void> {
      const requestId = crypto.randomUUID();
      await request({ type: "personas_switch", requestId, personaId, userId });
    },
    async getWorldBook(personaId: string, userId?: string): Promise<WorldBookDTO | null> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "personas_get_world_book", requestId, personaId, userId });
      return result as WorldBookDTO | null;
    },
  },

  permissions: {
    async getGranted(): Promise<string[]> {
      const requestId = crypto.randomUUID();
      const result = await request({ type: "permissions_get_granted", requestId });
      // Sync local cache with authoritative host response
      const perms = result as string[];
      grantedPermissions.clear();
      for (const p of perms) grantedPermissions.add(p);
      return perms;
    },
    has(permission: string): boolean {
      return grantedPermissions.has(permission);
    },
    onDenied(handler: (detail: PermissionDeniedDetail) => void): () => void {
      permissionDeniedHandlers.add(handler);
      return () => {
        permissionDeniedHandlers.delete(handler);
      };
    },
    onChanged(handler: (detail: PermissionChangedDetail) => void): () => void {
      permissionChangedHandlers.add(handler);
      return () => {
        permissionChangedHandlers.delete(handler);
      };
    },
  },

  push: {
    async send(
      input: { title: string; body: string; tag?: string; url?: string; icon?: string; rawTitle?: boolean; image?: string },
      userId?: string,
    ): Promise<{ sent: number }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "push_send",
        requestId,
        title: input.title,
        body: input.body,
        tag: input.tag,
        url: input.url,
        icon: input.icon,
        rawTitle: input.rawTitle,
        image: input.image,
        userId,
      } as any);
      return result as { sent: number };
    },
    async getStatus(userId?: string): Promise<{
      available: boolean;
      subscriptionCount: number;
    }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "push_get_status",
        requestId,
        userId,
      } as any);
      return result as { available: boolean; subscriptionCount: number };
    },
  },

  textEditor: {
    async open(options?: {
      title?: string;
      value?: string;
      placeholder?: string;
      userId?: string;
    }): Promise<{ text: string; cancelled: boolean }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "text_editor_open",
        requestId,
        title: options?.title,
        value: options?.value,
        placeholder: options?.placeholder,
        userId: options?.userId,
      } as any);
      return result as { text: string; cancelled: boolean };
    },
  },

  macros: {
    async resolve(
      template: string,
      options?: { chatId?: string; characterId?: string; userId?: string },
    ): Promise<{ text: string; diagnostics: Array<{ message: string; offset: number; length: number }> }> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "macros_resolve",
        requestId,
        template,
        chatId: options?.chatId,
        characterId: options?.characterId,
        userId: options?.userId,
      } as any);
      return result as { text: string; diagnostics: Array<{ message: string; offset: number; length: number }> };
    },
  },

  users: {
    async isVisible(userId?: string): Promise<boolean> {
      const requestId = crypto.randomUUID();
      const result = await request({
        type: "user_is_visible",
        requestId,
        userId,
      } as any);
      return result as boolean;
    },
  },

  oauth: {
    onCallback(
      handler: (params: Record<string, string>) => Promise<{ html?: string } | void>
    ): () => void {
      oauthCallbackHandler = handler;
      return () => {
        oauthCallbackHandler = null;
      };
    },
    getCallbackUrl(): string {
      return `/api/spindle-oauth/${manifest.identifier}/callback`;
    },
    async createState(): Promise<string> {
      const requestId = crypto.randomUUID();
      return request({
        type: "create_oauth_state",
        requestId,
      }) as Promise<string>;
    },
  },

  async cors(url, options) {
    const requestId = crypto.randomUUID();
    return request({
      type: "cors_request",
      requestId,
      url,
      options: options || {},
    });
  },

  registerContextHandler(handler, priority?): void {
    contextHandlerFn = handler;
    post({ type: "register_context_handler", priority });
  },

  sendToFrontend(payload: unknown): void {
    post({ type: "frontend_message", payload });
  },

  onFrontendMessage(handler: (payload: unknown, userId: string) => void): () => void {
    frontendMessageHandlers.add(handler);
    return () => {
      frontendMessageHandlers.delete(handler);
    };
  },

  log: {
    info(msg: string) {
      post({ type: "log", level: "info", message: msg });
    },
    warn(msg: string) {
      post({ type: "log", level: "warn", message: msg });
    },
    error(msg: string) {
      post({ type: "log", level: "error", message: msg });
    },
  },

  toast: {
    success(message: string, options?: { title?: string; duration?: number }) {
      post({ type: "toast_show", toastType: "success", message, title: options?.title, duration: options?.duration });
    },
    warning(message: string, options?: { title?: string; duration?: number }) {
      post({ type: "toast_show", toastType: "warning", message, title: options?.title, duration: options?.duration });
    },
    error(message: string, options?: { title?: string; duration?: number }) {
      post({ type: "toast_show", toastType: "error", message, title: options?.title, duration: options?.duration });
    },
    info(message: string, options?: { title?: string; duration?: number }) {
      post({ type: "toast_show", toastType: "info", message, title: options?.title, duration: options?.duration });
    },
  },

  get manifest() {
    return manifest;
  },
};

// ─── Message handler (host → worker) ─────────────────────────────────────

self.onmessage = async (event: MessageEvent<HostToWorker>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init": {
      manifest = msg.manifest;
      storagePath = msg.storagePath;

      // Expose the API globally
      (globalThis as any).spindle = spindleApi;

      // Seed the permission cache so has() works immediately
      try {
        const perms = await spindleApi.permissions.getGranted();
        grantedPermissions.clear();
        for (const p of perms) grantedPermissions.add(p);
      } catch {
        // Non-fatal — cache starts empty, host still enforces
      }

      // Dynamically import the extension's backend entry
      try {
        const entryPath = manifest.entry_backend || "dist/backend.js";
        await import(entryPath);
      } catch (err: any) {
        post({
          type: "log",
          level: "error",
          message: `Failed to load extension: ${err.message}`,
        });
      }
      // Signal that the extension has finished loading and all
      // synchronous registrations (macros, interceptors, etc.) are queued
      post({ type: "log", level: "info", message: "__worker_ready__" });
      break;
    }

    case "event": {
      if (msg.event === "__macro_invoke__") {
        const payload = (msg.payload ?? {}) as {
          requestId?: string;
          name?: string;
          context?: unknown;
        };
        const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
        const name = typeof payload.name === "string" ? payload.name.toLowerCase() : "";
        const handler = extensionMacroHandlers.get(name);

        if (!requestId) break;
        if (!handler) {
          post({
            type: "macro_result",
            requestId,
            result: "",
          });
          break;
        }

        try {
          const value = await Promise.resolve(handler(payload.context ?? {}));
          post({
            type: "macro_result",
            requestId,
            result: value == null ? "" : String(value),
          });
        } catch (err: any) {
          post({
            type: "macro_result",
            requestId,
            error: err?.message || "Macro execution failed",
          });
        }
        break;
      }

      const handlers = eventHandlers.get(msg.event);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(msg.payload);
          } catch (err: any) {
            post({
              type: "log",
              level: "error",
              message: `Event handler error for ${msg.event}: ${err.message}`,
            });
          }
        }
      }
      break;
    }

    case "intercept_request": {
      if (interceptHandler) {
        try {
          const result = await interceptHandler(msg.messages, msg.context);
          post({
            type: "intercept_result",
            requestId: msg.requestId,
            messages: result,
          });
        } catch (err: any) {
          post({
            type: "log",
            level: "error",
            message: `Interceptor error: ${err.message}`,
          });
          // Return original messages on error
          post({
            type: "intercept_result",
            requestId: msg.requestId,
            messages: msg.messages,
          });
        }
      }
      break;
    }

    case "tool_invocation": {
      const handlers = eventHandlers.get("TOOL_INVOCATION");
      if (!handlers || handlers.size === 0) {
        post({
          type: "tool_invocation_result",
          requestId: msg.requestId,
          error: "No TOOL_INVOCATION handler registered",
        });
        break;
      }

      try {
        let result: string | undefined;
        for (const handler of handlers) {
          const val = await Promise.resolve(
            handler({ toolName: msg.toolName, args: msg.args, requestId: msg.requestId })
          );
          if (val !== undefined && val !== null && result === undefined) {
            result = String(val);
          }
        }
        post({
          type: "tool_invocation_result",
          requestId: msg.requestId,
          result: result ?? "",
        });
      } catch (err: any) {
        post({
          type: "tool_invocation_result",
          requestId: msg.requestId,
          error: err?.message || "Tool invocation failed",
        });
      }
      break;
    }

    case "context_handler_request": {
      if (contextHandlerFn) {
        try {
          const result = await contextHandlerFn(msg.context);
          post({
            type: "context_handler_result",
            requestId: msg.requestId,
            context: result,
          });
        } catch (err: any) {
          post({
            type: "log",
            level: "error",
            message: `Context handler error: ${err.message}`,
          });
          post({
            type: "context_handler_result",
            requestId: msg.requestId,
            context: msg.context,
          });
        }
      }
      break;
    }

    case "response": {
      const pending = pendingResponses.get(msg.requestId);
      if (pending) {
        pendingResponses.delete(msg.requestId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
      break;
    }

    case "permission_denied": {
      for (const handler of permissionDeniedHandlers) {
        try {
          handler({ permission: msg.permission, operation: msg.operation });
        } catch (err: any) {
          post({
            type: "log",
            level: "error",
            message: `Permission denied handler error: ${err.message}`,
          });
        }
      }
      break;
    }

    case "permission_changed": {
      // Update local cache
      if (msg.granted) {
        grantedPermissions.add(msg.permission);
      } else {
        grantedPermissions.delete(msg.permission);
      }
      // Sync full set from host (authoritative)
      grantedPermissions.clear();
      for (const p of msg.allGranted) grantedPermissions.add(p);

      const detail: PermissionChangedDetail = {
        permission: msg.permission,
        granted: msg.granted,
        allGranted: msg.allGranted,
      };
      for (const handler of permissionChangedHandlers) {
        try {
          handler(detail);
        } catch (err: any) {
          post({
            type: "log",
            level: "error",
            message: `Permission changed handler error: ${err.message}`,
          });
        }
      }
      // Also fire as an event for extensions using spindle.on()
      const eventSet = eventHandlers.get("PERMISSION_CHANGED");
      if (eventSet) {
        for (const handler of eventSet) {
          try {
            handler(detail);
          } catch (err: any) {
            post({
              type: "log",
              level: "error",
              message: `PERMISSION_CHANGED event handler error: ${err.message}`,
            });
          }
        }
      }
      break;
    }

    case "frontend_message": {
      for (const handler of frontendMessageHandlers) {
        try {
          handler(msg.payload, msg.userId);
        } catch (err: any) {
          post({
            type: "log",
            level: "error",
            message: `Frontend message handler error: ${err.message}`,
          });
        }
      }
      break;
    }

    case "oauth_callback": {
      if (oauthCallbackHandler) {
        try {
          const result = await oauthCallbackHandler(msg.params);
          post({
            type: "oauth_callback_result",
            requestId: msg.requestId,
            html: result?.html,
          });
        } catch (err: any) {
          post({
            type: "oauth_callback_result",
            requestId: msg.requestId,
            error: err?.message || "OAuth callback handler failed",
          });
        }
      } else {
        post({
          type: "oauth_callback_result",
          requestId: msg.requestId,
          error: "No OAuth callback handler registered",
        });
      }
      break;
    }

    case "shutdown": {
      // Allow extension to clean up
      process.exit(0);
      break;
    }
  }
};
