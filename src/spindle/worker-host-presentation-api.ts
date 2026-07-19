import type { CouncilMemberContext, SpindleManifest, ThemeOverrideDTO } from "lumiverse-spindle-types";
import { PERMISSION_DENIED_PREFIX } from "lumiverse-spindle-types";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { BUILT_IN_DRAWER_TABS, getVisibleSettingsTabs as getVisibleUISettingsTabs } from "./ui-registry";
import { getUserExtensionDrawerTabs } from "./ui-frontend-state.service";
import { normalizeSpindleAppNavigationPath } from "./url-safety";
import { getDb } from "../db/connection";
import * as settingsSvc from "../services/settings.service";
import * as colorExtractionSvc from "../services/color-extraction.service";
import * as imagesSvc from "../services/images.service";
import { generateThemeVariables as generateThemeVariablesFn } from "../utils/theme-engine";
import * as councilSettingsSvc from "../services/council/council-settings.service";
import { buildCouncilMemberContext } from "../services/council/tool-runtime";
import * as packsSvc from "../services/packs.service";

const FULL_THEME_SENTINEL_KEYS = ["--lumiverse-primary", "--lumiverse-bg", "--lumiverse-text", "--lumiverse-border", "--lumiverse-fill", "--lcs-glass-bg"] as const;
const FULL_THEME_MIN_KEYS = 40;
const USER_PREFERENCE_KEYS = new Set(["--lcs-glass-blur", "--lcs-glass-soft-blur", "--lcs-glass-strong-blur", "--lcs-radius", "--lcs-radius-sm", "--lcs-radius-xs", "--lcs-transition", "--lcs-transition-fast", "--lumiverse-radius", "--lumiverse-radius-sm", "--lumiverse-radius-md", "--lumiverse-radius-lg", "--lumiverse-radius-xl", "--lumiverse-font-family", "--lumiverse-font-mono", "--lumiverse-font-scale", "--lumiverse-ui-scale", "--lumiverse-transition", "--lumiverse-transition-fast"]);
const MAX_CSS_VALUE_LENGTH = 1024;
type SpindleUserRole = "operator" | "admin" | "user";

function validateCssValue(value: unknown): string | null {
  if (value === undefined || value === null || typeof value !== "string") return "value must be a string";
  if (value.length > MAX_CSS_VALUE_LENGTH) return `value exceeds ${MAX_CSS_VALUE_LENGTH} characters`;
  if (value.length === 0) return null;
  const trimmed = value.trim(); const lowered = trimmed.toLowerCase().replace(/\\\\/g, "");
  if (/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]/.test(value)) return "control characters not allowed";
  if (/[<>]/.test(value)) return "angle brackets not allowed";
  if (value.includes("{") || value.includes("}") || value.includes(";")) return "must be a single property value (no { } ; )";
  if (lowered.includes("javascript:")) return "javascript: URLs not allowed";
  if (lowered.includes("vbscript:")) return "vbscript: URLs not allowed";
  if (lowered.includes("data:text/html")) return "data:text/html URLs not allowed";
  if (lowered.includes("expression(")) return "CSS expression() not allowed";
  if (lowered.startsWith("@")) return "at-rules not allowed in variable values";
  if (/^url\(\s*['"]?\s*(?!https?:|data:image\/)/i.test(trimmed)) return "url() must point to https: or a data:image/* payload";
  if (/image-set\(/i.test(trimmed) && !/image-set\(\s*['"]?\s*(https?:|data:image\/)/i.test(trimmed)) return "image-set() must point to https: or a data:image/* payload";
  return null;
}

type PresentationPermission = "push_notification" | "web_search" | "app_manipulation";
export type WorkerHostPresentationApiContext = {
  extensionId: string; manifest: SpindleManifest; installScope: "operator" | "user"; installedByUserId: string | null;
  hasPermission: (permission: PresentationPermission) => boolean;
  resolveEffectiveUserId: (userId?: string) => string; enforceScopedUser: (userId: string | null | undefined) => void;
  post: (message: any) => void;
};

/** Owns frontend/presentation-facing Spindle APIs and their per-user style state. */
export class WorkerHostPresentationApi {
  private chatStyleModes = new Map<string, Map<string, "bounded" | "extension-relaxed">>();
  constructor(private readonly context: WorkerHostPresentationApiContext) {}
  private get extensionId(): string { return this.context.extensionId; }
  private get manifest(): SpindleManifest { return this.context.manifest; }
  private get installScope(): "operator" | "user" { return this.context.installScope; }
  private get installedByUserId(): string | null { return this.context.installedByUserId; }
  private hasPermission(permission: PresentationPermission): boolean { return this.context.hasPermission(permission); }
  private resolveEffectiveUserId(userId?: string): string { return this.context.resolveEffectiveUserId(userId); }
  private enforceScopedUser(userId: string | null | undefined): void { this.context.enforceScopedUser(userId); }
  private postToWorker(message: any): void { this.context.post(message); }

  handleUIGetDrawerTabs(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId) this.enforceScopedUser(resolvedUserId);

      const builtIn = BUILT_IN_DRAWER_TABS.map((tab) => ({
        id: tab.id,
        shortName: tab.shortName,
        tabName: tab.tabName,
        tabDescription: tab.tabDescription,
        keywords: [...tab.keywords],
        source: "builtin" as const,
      }));
      const extensions = getUserExtensionDrawerTabs(resolvedUserId).map((tab) => ({
        id: tab.id,
        shortName: tab.shortName ?? tab.tabName,
        tabName: tab.tabName,
        tabDescription: tab.tabDescription ?? `Open ${tab.tabName} extension tab`,
        keywords: tab.keywords ?? [],
        source: "extension" as const,
        extensionId: tab.extensionId,
      }));
      this.postToWorker({ type: "response", requestId, result: [...builtIn, ...extensions] });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleUIGetSettingsTabs(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (resolvedUserId) this.enforceScopedUser(resolvedUserId);

      let role: string | null = null;
      if (resolvedUserId) {
        const row = getDb()
          .query('SELECT role FROM "user" WHERE id = ?')
          .get(resolvedUserId) as { role: string | null } | null;
        role = row?.role ?? null;
      }

      const result = getVisibleUISettingsTabs(role).map((tab) => ({
        id: tab.id,
        shortName: tab.shortName,
        tabName: tab.tabName,
        tabDescription: tab.tabDescription,
        keywords: [...tab.keywords],
        ...(tab.role ? { role: tab.role } : {}),
      }));
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleUINavigate(
    requestId: string,
    action:
      | "open_drawer_tab"
      | "close_drawer"
      | "open_settings"
      | "close_settings"
      | "open_command_palette"
      | "close_command_palette",
    tabId?: string,
    viewId?: string,
    userId?: string,
  ): void {
    try {
      const validActions = new Set([
        "open_drawer_tab",
        "close_drawer",
        "open_settings",
        "close_settings",
        "open_command_palette",
        "close_command_palette",
      ]);
      if (!validActions.has(action)) {
        throw new Error(`Invalid UI navigate action: ${action}`);
      }
      if (action === "open_drawer_tab") {
        if (typeof tabId !== "string" || !tabId.trim()) {
          throw new Error("tabId is required for open_drawer_tab");
        }
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

      const safeTabId = typeof tabId === "string" ? tabId.slice(0, 100) : undefined;
      const safeViewId = typeof viewId === "string" ? viewId.slice(0, 100) : undefined;

      eventBus.emit(
        EventType.SPINDLE_UI_NAVIGATE,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          action,
          ...(safeTabId !== undefined ? { tabId: safeTabId } : {}),
          ...(safeViewId !== undefined ? { viewId: safeViewId } : {}),
        },
        targetUserId,
      );

      this.postToWorker({ type: "response", requestId, result: { ok: true } });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── Logging ─────────────────────────────────────────────────────────

  async handlePushSend(
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
      if (!this.hasPermission("push_notification")) {
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

  async handlePushGetStatus(requestId: string, userId?: string): Promise<void> {
    try {
      if (!this.hasPermission("push_notification")) {
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

  // ─── Web Search (gated: "web_search") ──────────────────────────────────

  async handleWebSearchQuery(
    requestId: string,
    query: string,
    count?: number,
    scrape?: boolean,
    userId?: string,
  ): Promise<void> {
    try {
      if (!this.hasPermission("web_search")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} web_search — Web search permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const webSearchSvc = await import("../services/web-search.service");
      const response = await webSearchSvc.searchWeb(resolvedUserId, query, count, {
        scrape: scrape !== false,
      });

      const payload: {
        query: string;
        results: typeof response.results;
        documents?: typeof response.documents;
        context?: string;
      } = {
        query: response.query,
        results: response.results,
      };
      if (scrape !== false) {
        payload.documents = response.documents;
        payload.context = response.context;
      }

      this.postToWorker({ type: "response", requestId, result: payload });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  async handleWebSearchGetSettings(requestId: string, userId?: string): Promise<void> {
    try {
      if (!this.hasPermission("web_search")) {
        throw new Error(`${PERMISSION_DENIED_PREFIX} web_search — Web search permission not granted`);
      }
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const settingsSvc = await import("../services/web-search-settings.service");
      const settings = await settingsSvc.getWebSearchSettings(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: settings });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  // ─── User Context (free tier) ───────────────────────────────────────

  handleUserIsVisible(requestId: string, userId?: string): void {
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

  handleUserGetRole(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      if (!resolvedUserId) throw new Error("userId is required for operator-scoped extensions");
      this.enforceScopedUser(resolvedUserId);

      const row = getDb()
        .query('SELECT role FROM "user" WHERE id = ?')
        .get(resolvedUserId) as { role: string | null } | null;
      if (!row) throw new Error("User not found");

      const result: SpindleUserRole =
        row.role === "owner" ? "operator" : row.role === "admin" ? "admin" : "user";
      this.postToWorker({ type: "response", requestId, result });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message });
    }
  }

  handleTextEditorOpen(
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

  handleModalOpen(
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

  handleModalClose(
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

  handleConfirmOpen(
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

  handleInputPromptOpen(
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

  handleChatSetStyleMode(
    requestId: string,
    chatId: unknown,
    mode: unknown,
    userId?: string,
  ): void {
    if (!this.hasPermission("app_manipulation")) {
      this.postToWorker({
        type: "response",
        requestId,
        error: `${PERMISSION_DENIED_PREFIX} app_manipulation — Chat style mode requires the app_manipulation permission`,
      });
      return;
    }
    if (typeof chatId !== "string" || chatId.length === 0) {
      this.postToWorker({ type: "response", requestId, error: "chatId must be a non-empty string" });
      return;
    }
    if (mode !== "bounded" && mode !== "extension-relaxed") {
      this.postToWorker({
        type: "response",
        requestId,
        error: `mode must be 'bounded' or 'extension-relaxed', got ${JSON.stringify(mode)}`,
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

      let userMap = this.chatStyleModes.get(resolvedUserId);
      if (mode === "bounded") {
        if (userMap) {
          userMap.delete(chatId);
          if (userMap.size === 0) this.chatStyleModes.delete(resolvedUserId);
        }
      } else {
        if (!userMap) {
          userMap = new Map();
          this.chatStyleModes.set(resolvedUserId, userMap);
        }
        userMap.set(chatId, mode);
      }

      eventBus.emit(
        EventType.SPINDLE_CHAT_STYLE_MODE,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          chatId,
          mode,
        },
        resolvedUserId,
      );

      this.postToWorker({ type: "response", requestId, result: true });
    } catch (err: any) {
      this.postToWorker({ type: "response", requestId, error: err.message || "Chat style mode set failed" });
    }
  }

  /** Called on worker shutdown to clear chat-style-mode claims. Emits one
   *  null-chatId event per affected user so frontend stores drop this
   *  extension's claims without per-chat enumeration. */
  clearChatStyleModes(): void {
    if (this.chatStyleModes.size === 0) return;
    for (const userId of this.chatStyleModes.keys()) {
      eventBus.emit(
        EventType.SPINDLE_CHAT_STYLE_MODE,
        {
          extensionId: this.extensionId,
          extensionName: this.manifest.name,
          chatId: null,
          mode: "bounded",
        },
        userId,
      );
    }
    this.chatStyleModes.clear();
  }

  // ─── Theme (gated: "app_manipulation") ──────────────────────────────

  /** Active CSS variable overrides for this extension, keyed by effective userId. */
  private themeOverrides = new Map<string, ThemeOverrideDTO>();

  handleThemeApply(requestId: string, overrides: ThemeOverrideDTO, userId?: string): void {
    if (!this.hasPermission("app_manipulation")) {
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
    if (keys.length >= FULL_THEME_MIN_KEYS) {
      return true;
    }

    return FULL_THEME_SENTINEL_KEYS.every((key) => key in vars);
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

  handleThemeApplyPalette(
    requestId: string,
    palette: { accent?: { h?: number; s?: number; l?: number } } | null | undefined,
    userId?: string,
  ): void {
    if (!this.hasPermission("app_manipulation")) {
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

  handleThemeClear(requestId: string, userId?: string): void {
    if (!this.hasPermission("app_manipulation")) {
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
        if (!USER_PREFERENCE_KEYS.has(k)) out[k] = v;
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

  handleThemeGetCurrent(requestId: string, userId?: string): void {
    if (!this.hasPermission("app_manipulation")) {
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

  async handleColorExtract(requestId: string, imageId: string, userId?: string): Promise<void> {
    if (!this.hasPermission("app_manipulation")) {
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

  handleThemeGenerateVariables(requestId: string, config: any): void {
    if (!this.hasPermission("app_manipulation")) {
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

  handleCouncilGetSettings(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const settings = councilSettingsSvc.getCouncilSettings(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: settings });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  handleCouncilGetMembers(requestId: string, userId?: string): void {
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

  handleCouncilGetAvailableLumiaItems(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const items = packsSvc.getAllLumiaItems(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: items });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

  handleDlcGetCatalog(requestId: string, userId?: string): void {
    try {
      const resolvedUserId = this.resolveEffectiveUserId(userId);
      const catalog = packsSvc.getLumiaDlcCatalog(resolvedUserId);
      this.postToWorker({ type: "response", requestId, result: catalog });
    } catch (err) {
      this.postToWorker({ type: "response", requestId, error: String(err) });
    }
  }

}
