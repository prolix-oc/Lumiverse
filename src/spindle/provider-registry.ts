import { safeFetch, type SafeFetchOptions } from "../utils/safe-fetch";

export const PROVIDER_DESC_MAX_BYTES = 64 * 1024;
export const PROVIDER_REQUEST_MAX_BYTES = 256 * 1024;
export const PROVIDER_RESULT_MAX_BYTES = 1024 * 1024;
export const PROVIDER_ENVELOPE_MAX_BYTES = 1024 * 1024;
export const PROVIDER_INVOKE_TIMEOUT_MS = 30_000;

export const PROVIDER_BROKER_KINDS = ["embedding", "tts", "stt", "sidecar"] as const;
export type ProviderBrokerKind = (typeof PROVIDER_BROKER_KINDS)[number];

export type ProviderScope = "system" | `operator:${string}` | `user:${string}`;

export type ProviderKey = {
  effectiveScope: ProviderScope;
  installationId: string;
  kind: string;
  id: string;
};

export type ProviderProvenance = {
  owner?: string;
  generation?: number;
  revision?: number;
};

export type ProviderBrokerSpec = {
  url: string;
  method?: string;
  secretKey?: string;
  headers?: Record<string, string>;
  kind?: ProviderBrokerKind;
};

export type ProviderDescriptor = {
  kind: string;
  id: string;
  description?: unknown;
  broker?: ProviderBrokerSpec;
  generation?: number;
  revision?: number;
  owner?: string;
};

export type RegisteredProvider = {
  key: ProviderKey;
  descriptor: ProviderDescriptor;
  provenance: ProviderProvenance;
  registeredAt: number;
};

export type BrokerRequest = {
  kind: ProviderBrokerKind;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  secretKey?: string;
  userId?: string;
  owner?: string;
  binary?: boolean;
  correlationId: string;
  round?: number;
};

export type BrokerResponse = {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: string;
  correlationId: string;
  round: number;
};

export type PreparedBroker = {
  kind: ProviderBrokerKind;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  binary: boolean;
  secretKey: string | null;
  authenticatedSubject: string;
  correlationId: string;
  round: number;
  workerView: Record<string, unknown>;
};

export type ProviderRegisterMessage = {
  type: "provider_register";
  phase: "register";
  kind: string;
  id: string;
  description?: unknown;
  broker?: ProviderBrokerSpec;
  generation?: number;
  revision?: number;
  owner?: string;
  userId?: string;
};

export type ProviderUnregisterMessage = {
  type: "provider_unregister";
  phase: "unregister";
  kind: string;
  id: string;
  owner?: string;
  userId?: string;
};

export type ProviderResultMessage = {
  type: "provider_result";
  phase: "result";
  correlationId: string;
  round?: number;
  result?: unknown;
  error?: string;
};

export type ProviderInvokeMessage = {
  type: "provider_invoke";
  phase: "invoke";
  correlationId: string;
  round: number;
  key: ProviderKey;
  request: unknown;
};

export type ProviderAbortMessage = {
  type: "provider_abort";
  phase: "abort";
  correlationId: string;
  round: number;
  reason?: string;
};

export type ProviderChangedMessage = {
  type: "provider_changed";
  phase: "changed";
  action: "registered" | "unregistered" | "updated";
  key: ProviderKey;
};

export type ProviderWorkerToHost =
  | ProviderRegisterMessage
  | ProviderUnregisterMessage
  | ProviderResultMessage;

export type ProviderHostToWorker =
  | ProviderInvokeMessage
  | ProviderAbortMessage
  | ProviderChangedMessage;

export type HostScopeContext = {
  installScope: "system" | "operator" | "user";
  installedByUserId?: string | null;
  authenticatedSubject?: string | null;
};

export type ProviderRegistryDeps = {
  getSecret?: (userId: string, key: string) => Promise<string | null>;
  fetch?: (url: string, options?: SafeFetchOptions) => Promise<Response>;
  now?: () => number;
  timeoutMs?: number;
};

const SECRET_HEADER = /^(authorization|proxy-authorization|x-api-key|api-key|x-auth-token|x-access-token)$/i;
const SECRET_FIELD = /^(secret|secretkey|secretref|apikey|api_key|authorization|token|password|bearer|access_token|refresh_token)$/i;

type PendingInvocation = {
  correlationId: string;
  round: number;
  key: string;
  installationId: string;
  aborted: boolean;
  abortSent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

export function providerKeyString(key: ProviderKey): string {
  return JSON.stringify([key.effectiveScope, key.installationId, key.kind, key.id]);
}

export function parseProviderScope(value: string): ProviderScope | null {
  if (value === "system") return "system";
  if (value.startsWith("operator:") && value.length > "operator:".length) {
    return value as ProviderScope;
  }
  if (value.startsWith("user:") && value.length > "user:".length) {
    return value as ProviderScope;
  }
  return null;
}

export function deriveEffectiveScope(ctx: HostScopeContext): ProviderScope {
  const subject = typeof ctx.authenticatedSubject === "string" && ctx.authenticatedSubject.trim()
    ? ctx.authenticatedSubject.trim()
    : typeof ctx.installedByUserId === "string" && ctx.installedByUserId.trim()
      ? ctx.installedByUserId.trim()
      : null;

  if (ctx.installScope === "user") {
    if (!subject) {
      throw new Error("user scope requires an authenticated subject");
    }
    return `user:${subject}`;
  }
  if (ctx.installScope === "operator") {
    if (!subject) return "system";
    return `operator:${subject}`;
  }
  return "system";
}

export function measureJsonBytes(value: unknown): number {
  return new TextEncoder().encode(stableSerialize(value)).length;
}

function stableSerialize(value: unknown): string {
  if (value instanceof Uint8Array) {
    return JSON.stringify({ $bin: value.byteLength });
  }
  if (ArrayBuffer.isView(value)) {
    return JSON.stringify({ $bin: value.byteLength });
  }
  return JSON.stringify(value ?? null);
}

export function isBrokerKind(kind: string): kind is ProviderBrokerKind {
  return (PROVIDER_BROKER_KINDS as readonly string[]).includes(kind);
}

export function redactForWorker(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value == null) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (typeof value !== "object") return value;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  const out: Record<string, unknown> = {};
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(rawKey) || SECRET_HEADER.test(rawKey)) continue;
    if (rawKey.toLowerCase() === "headers" && rawVal && typeof rawVal === "object" && !Array.isArray(rawVal)) {
      out[rawKey] = redactHeaders(rawVal as Record<string, unknown>);
      continue;
    }
    out[rawKey] = redactValue(rawVal, seen);
  }
  return out;
}

export function redactHeaders(headers: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (SECRET_HEADER.test(key) || SECRET_FIELD.test(key)) continue;
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export function envelopeContainsSecrets(value: unknown): boolean {
  return containsSecrets(value, new WeakSet<object>());
}

function containsSecrets(value: unknown, seen: WeakSet<object>): boolean {
  if (value == null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecrets(entry, seen));
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_FIELD.test(key) || SECRET_HEADER.test(key)) return true;
    if (typeof nested === "string" && looksLikeSecretValue(key, nested)) return true;
    if (containsSecrets(nested, seen)) return true;
  }
  return false;
}

function looksLikeSecretValue(key: string, value: string): boolean {
  if (SECRET_FIELD.test(key) || SECRET_HEADER.test(key)) return true;
  return /^bearer\s+\S+/i.test(value);
}

export function assertByteLimit(value: unknown, limit: number, label: string): void {
  const bytes = measureJsonBytes(value);
  if (bytes > limit) {
    throw new Error(`${label} exceeds ${limit} bytes (${bytes})`);
  }
}

function normalizeId(value: unknown, field: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error(`${field} is required`);
  return id;
}

export class ProviderRegistry {
  private readonly providers = new Map<string, RegisteredProvider>();
  private readonly invocations = new Map<string, PendingInvocation>();
  private readonly workers = new Map<string, (message: ProviderHostToWorker) => void>();
  private getSecret: ProviderRegistryDeps["getSecret"];
  private fetchImpl: NonNullable<ProviderRegistryDeps["fetch"]>;
  private now: () => number;
  private timeoutMs: number;

  constructor(deps: ProviderRegistryDeps = {}) {
    this.getSecret = deps.getSecret;
    this.fetchImpl = deps.fetch ?? ((url, options) => safeFetch(url, options));
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? PROVIDER_INVOKE_TIMEOUT_MS;
  }

  configure(deps: ProviderRegistryDeps): void {
    if (deps.getSecret) this.getSecret = deps.getSecret;
    if (deps.fetch) this.fetchImpl = deps.fetch;
    if (deps.now) this.now = deps.now;
    if (typeof deps.timeoutMs === "number") this.timeoutMs = deps.timeoutMs;
  }

  reset(): void {
    for (const pending of this.invocations.values()) {
      this.clearTimer(pending);
      pending.aborted = true;
      pending.reject(new Error("provider registry reset"));
    }
    this.invocations.clear();
    this.providers.clear();
    this.workers.clear();
  }

  attachWorker(installationId: string, post: (message: ProviderHostToWorker) => void): void {
    this.workers.set(installationId, post);
  }

  detachWorker(installationId: string): void {
    this.workers.delete(installationId);
    this.unloadInstallation(installationId);
  }

  register(
    descriptor: ProviderDescriptor,
    host: HostScopeContext & { installationId: string },
  ): RegisteredProvider {
    const kind = normalizeId(descriptor.kind, "kind");
    const id = normalizeId(descriptor.id, "id");
    const installationId = normalizeId(host.installationId, "installationId");
    const effectiveScope = deriveEffectiveScope(host);
    assertByteLimit(descriptor.description ?? null, PROVIDER_DESC_MAX_BYTES, "provider description");
    if (descriptor.broker) {
      this.assertBrokerSpec(descriptor.broker);
    }

    const key: ProviderKey = { effectiveScope, installationId, kind, id };
    const keyStr = providerKeyString(key);
    if (this.providers.has(keyStr)) {
      throw new Error(`provider already registered for ${kind}/${id} in this installation scope`);
    }

    const record: RegisteredProvider = {
      key,
      descriptor: {
        kind,
        id,
        description: descriptor.description,
        broker: descriptor.broker ? this.stripBrokerForStorage(descriptor.broker) : undefined,
        generation: descriptor.generation,
        revision: descriptor.revision,
      },
      provenance: {
        owner: host.authenticatedSubject ?? host.installedByUserId ?? undefined,
        generation: descriptor.generation,
        revision: descriptor.revision,
      },
      registeredAt: this.now(),
    };
    this.providers.set(keyStr, record);
    this.postToInstallation(installationId, {
      type: "provider_changed",
      phase: "changed",
      action: "registered",
      key,
    });
    return record;
  }

  unregister(
    ref: { kind: string; id: string },
    host: HostScopeContext & { installationId: string },
  ): boolean {
    const key: ProviderKey = {
      effectiveScope: deriveEffectiveScope(host),
      installationId: normalizeId(host.installationId, "installationId"),
      kind: normalizeId(ref.kind, "kind"),
      id: normalizeId(ref.id, "id"),
    };
    return this.unregisterKey(key);
  }

  unregisterKey(key: ProviderKey): boolean {
    const keyStr = providerKeyString(key);
    const existing = this.providers.get(keyStr);
    if (!existing) return false;
    this.providers.delete(keyStr);
    this.abortInvocationsForKey(keyStr, "provider unregistered");
    this.postToInstallation(key.installationId, {
      type: "provider_changed",
      phase: "changed",
      action: "unregistered",
      key,
    });
    return true;
  }

  unloadInstallation(installationId: string): void {
    for (const [keyStr, record] of [...this.providers]) {
      if (record.key.installationId !== installationId) continue;
      this.providers.delete(keyStr);
    }
    this.abortInvocationsForInstallation(installationId, "provider installation unloaded");
  }

  get(key: ProviderKey): RegisteredProvider | undefined {
    return this.providers.get(providerKeyString(key));
  }

  list(effectiveScope: ProviderScope): RegisteredProvider[] {
    return this.getProviders().filter((record) => record.key.effectiveScope === effectiveScope);
  }

  listVisible(scopes: readonly ProviderScope[]): RegisteredProvider[] {
    const allowed = new Set(scopes);
    return this.getProviders().filter((record) => allowed.has(record.key.effectiveScope));
  }

  getProviders(): RegisteredProvider[] {
    return Array.from(this.providers.values());
  }

  async invoke(
    key: ProviderKey,
    request: unknown,
    opts: { callerScope: ProviderScope; correlationId?: string; round?: number } = {
      callerScope: key.effectiveScope,
    },
  ): Promise<unknown> {
    if (opts.callerScope !== key.effectiveScope) {
      throw new Error("provider invoke is isolated to the caller scope");
    }
    const record = this.get(key);
    if (!record) throw new Error("provider is not registered");
    assertByteLimit(request, PROVIDER_REQUEST_MAX_BYTES, "provider request");

    if (record.descriptor.broker && isBrokerKind(record.descriptor.broker.kind ?? record.key.kind)) {
      const prepared = this.prepareBroker(this.brokerRequestFromInvoke(record, request, opts), {
        authenticatedSubject: this.subjectFromScope(key.effectiveScope),
        installScope: this.installScopeFromScope(key.effectiveScope),
        installedByUserId: this.subjectFromScope(key.effectiveScope),
      });
      return this.completeBroker(prepared);
    }

    const correlationId = opts.correlationId || crypto.randomUUID();
    const round = opts.round ?? 1;
    const redacted = redactForWorker(request);
    assertByteLimit(
      { type: "provider_invoke", correlationId, round, key, request: redacted },
      PROVIDER_ENVELOPE_MAX_BYTES,
      "provider envelope",
    );

    return new Promise((resolve, reject) => {
      const pending: PendingInvocation = {
        correlationId,
        round,
        key: providerKeyString(key),
        installationId: key.installationId,
        aborted: false,
        abortSent: false,
        timer: null,
        resolve,
        reject,
      };
      this.invocations.set(correlationId, pending);
      pending.timer = setTimeout(() => {
        this.abort(correlationId, "provider invoke timed out");
      }, this.timeoutMs);

      this.postToInstallation(key.installationId, {
        type: "provider_invoke",
        phase: "invoke",
        correlationId,
        round,
        key,
        request: redacted,
      });
    });
  }

  abort(correlationId: string, reason = "provider invoke aborted"): boolean {
    const pending = this.invocations.get(correlationId);
    if (!pending) return false;
    if (pending.abortSent) return false;
    pending.abortSent = true;
    pending.aborted = true;
    this.clearTimer(pending);
    const record = this.providers.get(pending.key);
    if (record) {
      this.postToInstallation(record.key.installationId, {
        type: "provider_abort",
        phase: "abort",
        correlationId,
        round: pending.round,
        reason,
      });
    }
    pending.reject(new Error(reason));
    return true;
  }

  handleProviderResult(message: ProviderResultMessage): boolean {
    const pending = this.invocations.get(message.correlationId);
    if (!pending) return false;
    if (pending.aborted) {
      this.invocations.delete(message.correlationId);
      return false;
    }
    const round = message.round ?? pending.round;
    if (round !== pending.round) return false;
    try {
      if (message.error) {
        assertByteLimit(message.error, PROVIDER_RESULT_MAX_BYTES, "provider error");
      } else {
        assertByteLimit(message.result ?? null, PROVIDER_RESULT_MAX_BYTES, "provider result");
      }
      assertByteLimit(message, PROVIDER_ENVELOPE_MAX_BYTES, "provider envelope");
    } catch (err) {
      this.clearTimer(pending);
      this.invocations.delete(message.correlationId);
      pending.reject(err);
      return true;
    }
    this.clearTimer(pending);
    this.invocations.delete(message.correlationId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
    return true;
  }

  prepareBroker(request: BrokerRequest, host: HostScopeContext): PreparedBroker {
    if (!isBrokerKind(request.kind)) {
      throw new Error(`unsupported broker kind: ${request.kind}`);
    }
    assertByteLimit(request, PROVIDER_REQUEST_MAX_BYTES, "provider request");
    const url = typeof request.url === "string" ? request.url.trim() : "";
    if (!url) throw new Error("broker url is required");
    const authenticatedSubject = this.requireSubject(host);
    const headers = redactHeaders(request.headers);
    const prepared: PreparedBroker = {
      kind: request.kind,
      url,
      method: (request.method || "POST").toUpperCase(),
      headers,
      body: request.body,
      binary: request.binary === true,
      secretKey: typeof request.secretKey === "string" && request.secretKey.trim()
        ? request.secretKey.trim()
        : null,
      authenticatedSubject,
      correlationId: request.correlationId,
      round: request.round ?? 1,
      workerView: redactForWorker({
        kind: request.kind,
        url,
        method: (request.method || "POST").toUpperCase(),
        headers,
        body: request.body,
        binary: request.binary === true,
        correlationId: request.correlationId,
        round: request.round ?? 1,
      }) as Record<string, unknown>,
    };
    if (envelopeContainsSecrets(prepared.workerView)) {
      throw new Error("broker worker view must not contain secrets");
    }
    return prepared;
  }

  async completeBroker(prepared: PreparedBroker): Promise<BrokerResponse> {
    const headers: Record<string, string> = { ...prepared.headers };
    if (prepared.secretKey) {
      if (!this.getSecret) {
        throw new Error("host secret resolver is not configured");
      }
      const secret = await this.getSecret(prepared.authenticatedSubject, prepared.secretKey);
      if (!secret) {
        throw new Error("provider secret is not available");
      }
      headers.Authorization = `Bearer ${secret}`;
    }

    const init: SafeFetchOptions = {
      method: prepared.method,
      headers,
      timeoutMs: this.timeoutMs,
      maxBytes: PROVIDER_RESULT_MAX_BYTES,
    };
    if (prepared.body !== undefined) {
      init.body = this.encodeBody(prepared.body, prepared.binary);
    }

    try {
      const response = await this.fetchImpl(prepared.url, init);
      const body = prepared.binary
        ? new Uint8Array(await response.arrayBuffer())
        : await this.readResponseBody(response);
      const result: BrokerResponse = {
        ok: response.ok,
        status: response.status,
        headers: redactHeaders(Object.fromEntries(response.headers.entries())),
        body,
        correlationId: prepared.correlationId,
        round: prepared.round,
      };
      assertByteLimit(result, PROVIDER_RESULT_MAX_BYTES, "provider result");
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error,
        correlationId: prepared.correlationId,
        round: prepared.round,
      };
    }
  }

  handleWorkerMessage(
    message: ProviderWorkerToHost,
    host: HostScopeContext & { installationId: string },
  ): unknown {
    switch (message.type) {
      case "provider_register":
        return this.register({
          kind: message.kind,
          id: message.id,
          description: message.description,
          broker: message.broker,
          generation: message.generation,
          revision: message.revision,
        }, host);
      case "provider_unregister":
        return this.unregister({ kind: message.kind, id: message.id }, host);
      case "provider_result":
        return this.handleProviderResult(message);
      default:
        return false;
    }
  }

  private assertBrokerSpec(spec: ProviderBrokerSpec): void {
    if (!spec.url || typeof spec.url !== "string") {
      throw new Error("broker url is required");
    }
    if (spec.kind && !isBrokerKind(spec.kind)) {
      throw new Error(`unsupported broker kind: ${spec.kind}`);
    }
  }

  private stripBrokerForStorage(spec: ProviderBrokerSpec): ProviderBrokerSpec {
    return {
      url: spec.url,
      method: spec.method,
      secretKey: spec.secretKey,
      headers: redactHeaders(spec.headers),
      kind: spec.kind,
    };
  }

  private brokerRequestFromInvoke(
    record: RegisteredProvider,
    request: unknown,
    opts: { correlationId?: string; round?: number },
  ): BrokerRequest {
    const payload = request && typeof request === "object" ? request as Record<string, unknown> : {};
    const broker = record.descriptor.broker!;
    const kind = (broker.kind ?? record.key.kind) as ProviderBrokerKind;
    return {
      kind,
      url: typeof payload.url === "string" ? payload.url : broker.url,
      method: typeof payload.method === "string" ? payload.method : broker.method,
      headers: {
        ...broker.headers,
        ...(payload.headers && typeof payload.headers === "object"
          ? payload.headers as Record<string, string>
          : {}),
      },
      body: "body" in payload ? payload.body : payload,
      secretKey: broker.secretKey,
      binary: payload.binary === true,
      correlationId: opts.correlationId || crypto.randomUUID(),
      round: opts.round ?? 1,
    };
  }

  private encodeBody(body: unknown, binary: boolean): BodyInit {
    if (body instanceof Uint8Array) return body;
    if (ArrayBuffer.isView(body)) {
      return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
    }
    if (typeof body === "string" || body instanceof ArrayBuffer) return body;
    if (binary && body && typeof body === "object" && "data" in (body as object)) {
      const data = (body as { data: unknown }).data;
      if (data instanceof Uint8Array) return data;
    }
    return JSON.stringify(body ?? null);
  }

  private async readResponseBody(response: Response): Promise<unknown> {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return response.text();
  }

  private requireSubject(host: HostScopeContext): string {
    const scope = deriveEffectiveScope(host);
    const subject = this.subjectFromScope(scope);
    if (!subject && scope !== "system") {
      throw new Error("authenticated subject is required");
    }
    if (scope === "system") {
      const fallback = host.authenticatedSubject || host.installedByUserId;
      if (!fallback) throw new Error("authenticated subject is required");
      return fallback;
    }
    return subject;
  }

  private subjectFromScope(scope: ProviderScope): string {
    if (scope === "system") return "";
    return scope.slice(scope.indexOf(":") + 1);
  }

  private installScopeFromScope(scope: ProviderScope): "system" | "operator" | "user" {
    if (scope.startsWith("user:")) return "user";
    if (scope.startsWith("operator:")) return "operator";
    return "system";
  }

  private postToInstallation(installationId: string, message: ProviderHostToWorker): void {
    const envelope = redactForWorker(message) as ProviderHostToWorker;
    if (envelopeContainsSecrets(envelope)) {
      throw new Error("refusing to send secrets to worker");
    }
    assertByteLimit(envelope, PROVIDER_ENVELOPE_MAX_BYTES, "provider envelope");
    this.workers.get(installationId)?.(envelope);
  }

  private abortInvocationsForKey(keyStr: string, reason: string): void {
    for (const [correlationId, pending] of [...this.invocations]) {
      if (pending.key !== keyStr) continue;
      this.abort(correlationId, reason);
      this.invocations.delete(correlationId);
    }
  }

  private abortInvocationsForInstallation(installationId: string, reason: string): void {
    for (const [correlationId, pending] of [...this.invocations]) {
      if (pending.installationId !== installationId) continue;
      this.abort(correlationId, reason);
      this.invocations.delete(correlationId);
    }
  }

  private clearTimer(pending: PendingInvocation): void {
    if (!pending.timer) return;
    clearTimeout(pending.timer);
    pending.timer = null;
  }
}

export const providerRegistry = new ProviderRegistry();
