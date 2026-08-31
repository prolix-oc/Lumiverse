import { Hono } from "hono";
import type { Context } from "hono";
import { rateLimit } from "../middleware/rate-limit";
import {
  AgentRunStopUnavailableError,
  getAgentRun,
  getAgentRunChanges,
  getWorkspaceIndex,
  getWorkspacePreview,
  prepareAgentRunRetry,
  requestAgentRunStop,
} from "../services/agent-run-projection.service";
import {
  getAgentRunInspection,
  isValidAgentRunInspectionCursor,
  listAgentRunInspections,
} from "../services/agent-activity-runs.service";
import { parsePagination } from "../services/pagination";
import type { PaginationParams } from "../types/pagination";
import { AgenticGenerationError, retryAgenticGeneration } from "../services/agentic-generation.service";
import { resolveGenerationRequestAuthority, stopGenerationRequestAuthority } from "../services/generate.service";
import {
  createPersistentWorkspaceTask,
  deletePersistentWorkspace,
  deletePersistentWorkspacePublication,
  editPersistentWorkspace,
  ensurePersistentWorkspaceForChat,
  getPersistentWorkspaceById,
  getPersistentWorkspaceForChat,
  listPersistentWorkspaceArtifacts,
  listPersistentWorkspacePublications,
  listPersistentWorkspaceRecords,
  listPersistentWorkspaceSubmissions,
  listPersistentWorkspaceTasks,
  listPersistentWorkspaceTurnSessions,
  PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET,
  publishPersistentWorkspaceSelection,
  TurnWorkspaceError,
} from "../services/turn-workspace.service";
import type {
  AgentRunErrorResponseV2,
  AgentRunPublicErrorV2,
  AgentRunPublicOutcomeV2,
  AgentRunPublicPhaseV2,
  AgentRunPublicStatusV2,
  AgentWorkTargetIdentityV1,
  AgentWorkspaceSectionIdV2,
} from "../types/agent-run-projection";
import type {
  AgentPublicErrorCategory,
  AgentRecoveryActionV2,
} from "../types/agent-runtime";

const app = new Hono();
const resyncLimiter = rateLimit({
  bucket: "agent-run-resync",
  max: 60,
  windowMs: 60 * 1000,
  key: (c) => {
    const userId = c.get("userId");
    const chatId = c.req.param("chatId") || c.req.query("chatId") || c.req.query("chat_id") || "invalid-chat";
    return `agent-run-resync:${typeof userId === "string" ? userId : "unauthenticated"}:${chatId}`;
  },
});
const WORKSPACE_SECTIONS = new Set<AgentWorkspaceSectionIdV2>([
  "objective", "tasks", "records", "submissions", "artifacts",
]);
type RouteErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 503;

interface RouteErrorOptions {
  readonly target?: AgentWorkTargetIdentityV1 | null;
  readonly workPhase?: AgentRunPublicPhaseV2;
  readonly workStatus?: AgentRunPublicStatusV2;
  readonly workOutcome?: AgentRunPublicOutcomeV2 | null;
  readonly recoveryEligible?: boolean;
  readonly recoveryAction?: AgentRecoveryActionV2;
  readonly omissionCount?: number;
  readonly inspectionAttemptId?: string | null;
}

const ROUTE_ERROR_CODES: Record<string, true> = {
  not_found: true,
  invalid_request: true,
  projection_unavailable: true,
  inspection_unavailable: true,
  workspace_unavailable: true,
  stop_unavailable: true,
  retry_unavailable: true,
  target_mismatch: true,
  stale_target: true,
  resync_required: true,
  recovery_unavailable: true,
  response_mode_required: true,
  capacity_exceeded: true,
  unauthorized: true,
  internal_error: true,
};
function routeErrorCategory(code: string): AgentPublicErrorCategory {
  if (code === "capacity_exceeded") return "capacity";
  if (code === "unauthorized") return "integrity";
  if (code === "target_mismatch" || code === "stale_target" || code === "response_mode_required") return "validation";
  if (code.includes("projection") || code.includes("inspection") || code.includes("workspace")) return "internal";
  if (code.includes("stop") || code.includes("retry") || code.includes("recovery")) return "internal";
  if (code === "invalid_request") return "validation";
  return "internal";
}



function routeErrorAction(code: string): { readonly eligible: boolean; readonly action: AgentRecoveryActionV2 } {
  if (code === "projection_unavailable" || code === "resync_required" || code === "workspace_unavailable") {
    return { eligible: true, action: "resync" };
  }
  if (code === "response_mode_required") return { eligible: true, action: "use_response" };
  if (code === "target_mismatch" || code === "stale_target") {
    return { eligible: true, action: "reselect" };
  }
  if (code === "invalid_request" || code === "recovery_unavailable") {
    return { eligible: true, action: "repair" };
  }
  return { eligible: false, action: "none" };
}

function routeErrorPayload(
  code: string,
  reason: string,
  options: RouteErrorOptions = {},
): AgentRunPublicErrorV2 {
  const normalizedCode = Object.hasOwn(ROUTE_ERROR_CODES, code) ? code : "internal_error";
  const defaultRecovery = routeErrorAction(normalizedCode);
  const normalizedReason = /^[A-Za-z0-9_.:-]{1,128}$/.test(reason) ? reason : "request_failed";
  const omissionCount = options.omissionCount;
  return {
    code: normalizedCode,
    category: routeErrorCategory(normalizedCode),
    summaryCode: `agentRun.errors.${normalizedCode}`,
    recoveryEligible: options.recoveryEligible ?? defaultRecovery.eligible,
    recoveryAction: options.recoveryAction ?? defaultRecovery.action,
    target: options.target ?? null,
    workPhase: options.workPhase ?? "ADMIT",
    workStatus: options.workStatus ?? "terminal",
    workOutcome: options.workOutcome ?? null,
    reason: normalizedReason,
    omissionCount: omissionCount !== undefined && Number.isSafeInteger(omissionCount) && omissionCount >= 0
      ? omissionCount : 0,
    inspectionAttemptId: options.inspectionAttemptId ?? null,
  };
}

function routeError(
  c: Context,
  status: RouteErrorStatus,
  code: string,
  reason: string,
  options?: RouteErrorOptions,
): Response {
  const error = routeErrorPayload(code, reason, options);
  return c.json({ version: 2, error } satisfies AgentRunErrorResponseV2, status);
}


function notFound(c: Context): Response {
  return routeError(c, 404, "not_found", "not_found");
}

function authenticatedUserId(c: Context): string | null {
  const userId = c.get("userId");
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

function cursorFor(c: Context): string | undefined {
  return c.req.query("cursor") || c.req.header("x-agent-run-cursor") || undefined;
}

type OptionalIdResult = { readonly present: boolean; readonly value?: string; readonly invalid: boolean };

function optionalQueryId(c: Context, keys: readonly string[]): OptionalIdResult {
  const values = keys
    .map((key) => c.req.query(key))
    .filter((value): value is string => value !== undefined);
  if (values.length === 0) return { present: false, invalid: false };
  if (values.some((value) => value.length === 0)) return { present: true, invalid: true };
  const first = values[0]!;
  return {
    present: true,
    ...(values.every((value) => value === first) ? { value: first } : {}),
    invalid: !values.every((value) => value === first),
  };
}

function optionalBodyId(body: Record<string, unknown>, keys: readonly string[]): OptionalIdResult {
  const values: unknown[] = [];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) values.push(body[key]);
  }
  if (values.length === 0) return { present: false, invalid: false };
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    return { present: true, invalid: true };
  }
  const strings = values as string[];
  const first = strings[0]!;
  return {
    present: true,
    ...(strings.every((value) => value === first) ? { value: first } : {}),
    invalid: !strings.every((value) => value === first),
  };
}

function chatChanges(c: Context, chatId: string | undefined): Response {
  const userId = authenticatedUserId(c);
  if (!userId || !chatId) return notFound(c);
  try {
    const changes = getAgentRunChanges(userId, chatId, cursorFor(c));
    return changes ? c.json(changes) : notFound(c);
  } catch {
    return routeError(c, 503, "projection_unavailable", "projection_unavailable");
  }
}

// Cursor delta/full-resync endpoints. The aliases keep the public surface
// stable while the frontend migrates from active polling to chat cursors.
app.get("/changes/:chatId", resyncLimiter, (c) => chatChanges(c, c.req.param("chatId")));
app.get("/:chatId/changes", resyncLimiter, (c) => chatChanges(c, c.req.param("chatId")));
app.get("/active/:chatId", resyncLimiter, (c) => chatChanges(c, c.req.param("chatId")));
app.get("/:chatId/active", resyncLimiter, (c) => chatChanges(c, c.req.param("chatId")));
app.get("/active", resyncLimiter, (c) => {
  const chatId = optionalQueryId(c, ["chatId", "chat_id"]);
  if (chatId.invalid || !chatId.value) return routeError(c, 400, "invalid_request", "invalid_chat_id");
  return chatChanges(c, chatId.value);
});

type PersistentRouteBody = Record<string, unknown>;

async function persistentBody(c: Context): Promise<PersistentRouteBody | Response> {
  try {
    const raw = await c.req.text();
    if (raw.trim().length === 0) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return routeError(c, 400, "invalid_request", "invalid_workspace_request");
    }
    return parsed as PersistentRouteBody;
  } catch {
    return routeError(c, 400, "invalid_request", "invalid_workspace_request");
  }
}

function persistentError(c: Context, error: unknown): Response {
  if (!(error instanceof TurnWorkspaceError)) throw error;
  if (error.code === "not_found") return routeError(c, 404, "not_found", "not_found");
  if (error.code === "forbidden" || error.code === "capability_denied") {
    return routeError(c, 403, "unauthorized", "workspace_forbidden");
  }
  if (error.code === "stale_revision" || error.code === "task_assignment_conflict") {
    return routeError(c, 409, "stale_target", "stale_workspace_revision", { recoveryAction: "resync", recoveryEligible: true });
  }
  if (error.code === "quota_exceeded") return routeError(c, 413, "capacity_exceeded", "workspace_quota_exceeded");
  if (error.code === "workspace_frozen") {
    return routeError(c, 409, "workspace_unavailable", "workspace_frozen", { recoveryAction: "resync", recoveryEligible: true });
  }
  return routeError(c, 400, "invalid_request", "workspace_request_failed");
}
function persistentSessionPagination(c: Context): PaginationParams | null {
  const rawOffset = c.req.query("offset");
  if (rawOffset === undefined) return parsePagination(c.req.query("limit"), undefined);
  const offset = Number(rawOffset);
  if (
    rawOffset === ""
    || !Number.isSafeInteger(offset)
    || offset < 0
    || offset > PERSISTENT_WORKSPACE_MAX_SESSION_OFFSET
  ) {
    return null;
  }
  return { ...parsePagination(c.req.query("limit"), undefined), offset };
}


function routeRevision(c: Context, body?: PersistentRouteBody): number | null {
  const query = c.req.query("revision") ?? c.req.query("expectedRevision");
  const value = body?.expectedRevision ?? query;
  if (value === undefined || value === "") return null;
  const revision = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : -1;
}

function routeChatId(c: Context): string | null {
  const result = optionalQueryId(c, ["chatId", "chat_id"]);
  return result.invalid ? "" : result.value ?? null;
}

function withoutOwnerAuthority(body: PersistentRouteBody): PersistentRouteBody {
  const {
    userId: _userId,
    user_id: _user_id,
    chatId: _chatId,
    chat_id: _chat_id,
    actor: _actor,
    publisher: _publisher,
    publishedBy: _publishedBy,
    published_by: _published_by,
    creator: _creator,
    hostAdmitted: _hostAdmitted,
    host_admitted: _host_admitted,
    authority: _authority,
    ...safe
  } = body;
  return safe;
}

function withoutWorkspaceContext(body: PersistentRouteBody): PersistentRouteBody {
  const {
    workspaceId: _workspaceId,
    workspace_id: _workspace_id,
    expectedRevision: _expectedRevision,
    expected_revision: _expected_revision,
    ...safe
  } = withoutOwnerAuthority(body);
  return safe;
}

function ownerWorkspaceContext(
  c: Context,
  workspace: ReturnType<typeof getPersistentWorkspaceById>,
  body?: PersistentRouteBody,
): { readonly userId: string; readonly chatId: string | null; readonly workspaceId: string; readonly expectedRevision: number } | Response {
  const revision = routeRevision(c, body);
  if (revision === null || revision < 0) return routeError(c, 400, "invalid_request", "invalid_workspace_revision");
  return {
    userId: workspace.userId,
    chatId: workspace.chatId,
    workspaceId: workspace.id,
    expectedRevision: revision,
  };
}

function readOwnerWorkspace(
  c: Context,
  userId: string,
  workspaceId: string,
): Response | ReturnType<typeof getPersistentWorkspaceById> {
  const chatId = routeChatId(c);
  if (chatId === "") return routeError(c, 400, "invalid_request", "invalid_chat_id");
  try {
    const workspace = getPersistentWorkspaceById({ userId, workspaceId });
    if (chatId !== null && workspace.chatId !== chatId) return notFound(c);
    return workspace;
  } catch (error) {
    return persistentError(c, error);
  }
}

function workspaceReadContext(
  _c: Context,
  workspace: ReturnType<typeof getPersistentWorkspaceById>,
): { readonly userId: string; readonly chatId: string | null; readonly workspaceId: string; readonly expectedRevision: number } {
  return { userId: workspace.userId, chatId: workspace.chatId, workspaceId: workspace.id, expectedRevision: workspace.revision };
}

app.get("/workspace", (c) => {
  const userId = authenticatedUserId(c);
  const chatId = routeChatId(c);
  if (!userId || !chatId) return routeError(c, 400, "invalid_request", "invalid_chat_id");
  try {
    return c.json(getPersistentWorkspaceForChat({ userId, chatId }));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.post("/workspace", async (c) => {
  const userId = authenticatedUserId(c);
  const chatId = routeChatId(c);
  if (!userId || !chatId) return routeError(c, 400, "invalid_request", "invalid_chat_id");
  const body = await persistentBody(c);
  if (body instanceof Response) return body;
  const workspaceFields = withoutWorkspaceContext(body);
  try {
    return c.json(ensurePersistentWorkspaceForChat({
      ...workspaceFields,
      userId,
      chatId,
    }), 201);
  } catch (error) {
    return persistentError(c, error);
  }
});

function routeWorkspace(c: Context): Response | ReturnType<typeof getPersistentWorkspaceById> {
  const userId = authenticatedUserId(c);
  const workspaceId = c.req.param("workspaceId");
  if (!userId || !workspaceId) return notFound(c);
  return readOwnerWorkspace(c, userId, workspaceId);
}

app.get("/workspace/:workspaceId", (c) => {
  const workspace = routeWorkspace(c);
  return workspace instanceof Response ? workspace : c.json(workspace);
});

app.get("/workspace/:workspaceId/sessions", (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  try {
    const pagination = persistentSessionPagination(c);
    if (pagination === null) return routeError(c, 400, "invalid_request", "invalid_workspace_sessions_page");
    return c.json(listPersistentWorkspaceTurnSessions(workspaceReadContext(c, workspace), pagination));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.get("/workspace/:workspaceId/tasks", (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  try {
    return c.json(listPersistentWorkspaceTasks(workspaceReadContext(c, workspace)));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.get("/workspace/:workspaceId/records", (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  try {
    return c.json(listPersistentWorkspaceRecords(workspaceReadContext(c, workspace)));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.get("/workspace/:workspaceId/submissions", (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  try {
    return c.json(listPersistentWorkspaceSubmissions(workspaceReadContext(c, workspace)));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.get("/workspace/:workspaceId/artifacts", (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  try {
    return c.json(listPersistentWorkspaceArtifacts(workspaceReadContext(c, workspace)));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.get("/workspace/:workspaceId/publications", (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  try {
    return c.json(listPersistentWorkspacePublications(workspaceReadContext(c, workspace)));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.patch("/workspace/:workspaceId", async (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  const body = await persistentBody(c);
  if (body instanceof Response) return body;
  const context = ownerWorkspaceContext(c, workspace, body);
  if (context instanceof Response) return context;
  try {
    return c.json(editPersistentWorkspace({
      ...withoutOwnerAuthority(body),
      ...context,
    }));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.post("/workspace/:workspaceId/tasks", async (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  const body = await persistentBody(c);
  if (body instanceof Response) return body;
  const context = ownerWorkspaceContext(c, workspace, body);
  if (context instanceof Response) return context;
  try {
    return c.json(createPersistentWorkspaceTask(
      context,
      withoutWorkspaceContext(body),
    ), 201);
  } catch (error) {
    return persistentError(c, error);
  }
});

app.post("/workspace/:workspaceId/publications", async (c) => {
  const userId = authenticatedUserId(c);
  const workspace = routeWorkspace(c);
  if (!userId || workspace instanceof Response) return workspace instanceof Response ? workspace : notFound(c);
  const body = await persistentBody(c);
  if (body instanceof Response) return body;
  const context = ownerWorkspaceContext(c, workspace, body);
  if (context instanceof Response) return context;
  try {
    return c.json(publishPersistentWorkspaceSelection(
      { kind: "owner", userId },
      {
        ...withoutOwnerAuthority(body),
        ...context,
      },
    ), 201);
  } catch (error) {
    return persistentError(c, error);
  }
});

app.delete("/workspace/:workspaceId/publications/:publicationId", async (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  const body = await persistentBody(c);
  if (body instanceof Response) return body;
  const context = ownerWorkspaceContext(c, workspace, body);
  if (context instanceof Response) return context;
  try {
    return c.json(deletePersistentWorkspacePublication({
      ...context,
      publicationId: c.req.param("publicationId"),
    }));
  } catch (error) {
    return persistentError(c, error);
  }
});

app.delete("/workspace/:workspaceId", async (c) => {
  const workspace = routeWorkspace(c);
  if (workspace instanceof Response) return workspace;
  const body = await persistentBody(c);
  if (body instanceof Response) return body;
  const context = ownerWorkspaceContext(c, workspace, body);
  if (context instanceof Response) return context;
  try {
    return c.json(deletePersistentWorkspace(context));
  } catch (error) {
    return persistentError(c, error);
  }
});
function exactRun(c: Context, turnId: string): Response {
  const userId = authenticatedUserId(c);
  if (!userId || !turnId) return notFound(c);
  const chatId = optionalQueryId(c, ["chatId", "chat_id"]);
  if (chatId.invalid) return routeError(c, 400, "invalid_request", "invalid_chat_id");
  const run = getAgentRun(userId, turnId, chatId.value);
  return run ? c.json(run) : notFound(c);
}
function inspectionLimit(c: Context): number | undefined | null {
  const raw = c.req.query("limit");
  if (raw === undefined || raw === "") return raw === undefined ? undefined : null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 64 ? value : null;
}

function inspectionCursor(c: Context): string | undefined | null {
  const raw = c.req.query("cursor");
  if (raw === undefined || raw === "") return raw === undefined ? undefined : null;
  return isValidAgentRunInspectionCursor(raw) ? raw : null;
}

function inspectionList(c: Context, chatId: string | undefined): Response {
  const userId = authenticatedUserId(c);
  if (!userId || !chatId) return notFound(c);
  const limit = inspectionLimit(c);
  const cursor = inspectionCursor(c);
  if (limit === null || cursor === null) return routeError(c, 400, "invalid_request", "invalid_inspection_page");
  const result = listAgentRunInspections(userId, chatId, limit, cursor);
  return result ? c.json(result) : notFound(c);
}

app.get("/inspection", (c) => {
  const chatId = optionalQueryId(c, ["chatId", "chat_id"]);
  if (chatId.invalid || !chatId.value) return routeError(c, 400, "invalid_request", "invalid_chat_id");
  return inspectionList(c, chatId.value);
});
app.get("/inspection/:chatId", (c) => inspectionList(c, c.req.param("chatId")));

function exactInspection(c: Context, attemptId: string): Response {
  const userId = authenticatedUserId(c);
  if (!userId || !attemptId) return notFound(c);
  const chatId = optionalQueryId(c, ["chatId", "chat_id"]);
  if (chatId.invalid) return routeError(c, 400, "invalid_request", "invalid_chat_id");
  const result = getAgentRunInspection(userId, attemptId, chatId.value);
  return result ? c.json(result) : notFound(c);
}

app.get("/:turnId/inspection", (c) => exactInspection(c, c.req.param("turnId")));
app.get("/:turnId/inspect", (c) => exactInspection(c, c.req.param("turnId")));

app.post("/:attemptId/retry", async (c) => {
  const userId = authenticatedUserId(c);
  const attemptId = c.req.param("attemptId");
  if (!userId || !attemptId) return notFound(c);
  const refusedInspection = getAgentRunInspection(userId, attemptId);
  const refusalTarget = refusedInspection?.attempt.target ?? null;
  const refusalInspectionAttemptId = refusedInspection?.attempt.attemptId ?? null;
  const retryRefusalOptions = (
    fallbackTarget: AgentWorkTargetIdentityV1 | null = null,
    fallbackAttemptId: string | null = null,
  ): RouteErrorOptions => ({
    target: refusalTarget ?? fallbackTarget,
    inspectionAttemptId: refusalInspectionAttemptId ?? fallbackAttemptId,
  });
  try {
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).length > 0) {
        return c.json({ version: 1, accepted: false, attempt: null, reason: "invalid_input", error: routeErrorPayload("invalid_request", "invalid_retry_body", retryRefusalOptions()) }, 400);
      }
    }
  } catch {
    return c.json({ version: 1, accepted: false, attempt: null, reason: "invalid_input", error: routeErrorPayload("invalid_request", "invalid_retry_body", retryRefusalOptions()) }, 400);
  }
  let preflight;
  try {
    preflight = prepareAgentRunRetry(userId, attemptId);
  } catch {
    return c.json({ version: 1, accepted: false, attempt: null, reason: "unavailable", error: routeErrorPayload("projection_unavailable", "projection_unavailable", retryRefusalOptions()) }, 503);
  }
  if (!preflight.accepted) {
    const refusal = preflight.code === "not_found" || preflight.code === "owner_mismatch"
      ? { code: "not_found", reason: "not_found", inspectionReason: "unavailable" as const }
      : preflight.code === "chat_mismatch" || preflight.code === "invalid_target"
        ? { code: "target_mismatch", reason: "target_mismatch", inspectionReason: "stale_input" as const }
        : preflight.code === "stale_target"
          ? { code: "stale_target", reason: "stale_target", inspectionReason: "stale_input" as const }
          : preflight.code === "completed"
            ? { code: "response_mode_required", reason: "completed", inspectionReason: "needs_attention" as const }
            : preflight.code === "admission_unavailable"
              ? { code: "retry_unavailable", reason: "retry_unavailable", inspectionReason: "unavailable" as const }
              : { code: "recovery_unavailable", reason: preflight.code, inspectionReason: "needs_attention" as const };
    return c.json({
      version: 1,
      accepted: false,
      attempt: null,
      reason: refusal.inspectionReason,
      error: routeErrorPayload(refusal.code, refusal.reason, retryRefusalOptions()),
    }, preflight.status);
  }
  const admittedTarget: AgentWorkTargetIdentityV1 = {
    chatId: preflight.chatId,
    generationType: preflight.generationType,
    messageId: preflight.messageId,
    swipeId: preflight.swipeId,
  };
  try {
    const started = await retryAgenticGeneration({
      userId,
      chatId: preflight.chatId,
      generationType: preflight.generationType,
      ...(preflight.messageId ? { messageId: preflight.messageId } : {}),
      ...(preflight.swipeId !== null ? { swipeId: preflight.swipeId } : {}),
      signal: c.req.raw.signal,
    }, preflight.previousAttemptId);
    return c.json({
      version: 1,
      accepted: true,
      attempt: started.attemptLineage,
      reason: "none",
      target: started.attemptLineage.target,
      recoveryEligible: false,
      recoveryAction: "none",
      inspectionAttemptId: started.attemptLineage.attemptId,
    }, 202);
  } catch (error) {
    if (error instanceof AgenticGenerationError) {
      const code = error.code === "agentic_chat_busy"
        ? "retry_unavailable"
        : error.code === "agentic_unsupported_surface" || error.code === "agentic_preflight_failed"
          ? "target_mismatch"
          : "retry_unavailable";
      const status = error.code === "agentic_runtime_unavailable" ? 503 : 409;
      return c.json({
        version: 1,
        accepted: false,
        attempt: null,
        reason: error.code === "agentic_unsupported_surface" || error.code === "agentic_preflight_failed" ? "stale_input" : "unavailable",
        error: routeErrorPayload(code, code, retryRefusalOptions(admittedTarget, preflight.previousAttemptId)),
      }, status);
    }
    return c.json({ version: 1, accepted: false, attempt: null, reason: "unavailable", error: routeErrorPayload("retry_unavailable", "retry_unavailable", retryRefusalOptions(admittedTarget, preflight.previousAttemptId)) }, 503);
  }
});

app.get("/status/:turnId", (c) => exactRun(c, c.req.param("turnId")));
app.get("/:turnId/status", (c) => exactRun(c, c.req.param("turnId")));
app.get("/:turnId", (c) => exactRun(c, c.req.param("turnId")));

app.get("/:turnId/workspace", (c) => {
  const userId = authenticatedUserId(c);
  const turnId = c.req.param("turnId");
  if (!userId || !turnId) return notFound(c);
  const index = getWorkspaceIndex(userId, turnId);
  return index ? c.json(index) : notFound(c);
});

app.get("/:turnId/workspace/:section", (c) => {
  const userId = authenticatedUserId(c);
  const turnId = c.req.param("turnId");
  const rawSection = c.req.param("section");
  if (!userId || !turnId || !WORKSPACE_SECTIONS.has(rawSection as AgentWorkspaceSectionIdV2)) return notFound(c);
  const pageRaw = c.req.query("page");
  const page = pageRaw === undefined ? 0 : Number(pageRaw);
  const expectedRevisionRaw = c.req.query("revision");
  const expectedRevision = expectedRevisionRaw === undefined ? undefined : Number(expectedRevisionRaw);
  if (!Number.isSafeInteger(page) || page < 0 || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
    return routeError(c, 400, "invalid_request", "invalid_workspace_page");
  }
  const preview = getWorkspacePreview(
    userId,
    turnId,
    rawSection as AgentWorkspaceSectionIdV2,
    page,
    expectedRevision,
  );
  return preview ? c.json(preview) : notFound(c);
});

app.post("/:turnId/stop", async (c) => {
  const userId = authenticatedUserId(c);
  const turnId = c.req.param("turnId");
  if (!userId || !turnId) return notFound(c);
  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return routeError(c, 400, "invalid_request", "invalid_stop_request");
      }
      body = parsed as Record<string, unknown>;
    }
  } catch {
    return routeError(c, 400, "invalid_request", "invalid_stop_request");
  }
  const chatIdResult = optionalBodyId(body, ["chat_id", "chatId"]);
  const generationIdResult = optionalBodyId(body, ["generation_id", "generationId"]);
  const requestAuthorityIdResult = optionalBodyId(body, ["request_authority_id", "requestAuthorityId"]);
  const rootIdResult = optionalBodyId(body, ["root_id", "rootId"]);
  if (chatIdResult.invalid || generationIdResult.invalid || rootIdResult.invalid || requestAuthorityIdResult.invalid) {
    return routeError(c, 400, "invalid_request", "invalid_stop_request");
  }
  const chatId = chatIdResult.value;
  const generationId = generationIdResult.value;
  const rootId = rootIdResult.value;
  const requestAuthorityId = requestAuthorityIdResult.value;
  const run = getAgentRun(userId, turnId, chatId);
  if (!run || (generationId !== undefined && generationId !== run.generationId) || (rootId !== undefined && rootId !== turnId)) {
    return notFound(c);
  }
  const boundRequestAuthorityId = requestAuthorityId ?? resolveGenerationRequestAuthority(
    userId,
    run.chatId,
    run.generationId,
  );
  if (!boundRequestAuthorityId) {
    return routeError(c, 409, "stop_unavailable", "request_authority_unavailable", {
      target: run.attemptLineage.target,
      workPhase: run.workPhase,
      workStatus: run.workStatus,
      workOutcome: run.workOutcome,
    });
  }
  const authorityStop = await stopGenerationRequestAuthority(
    userId,
    run.chatId,
    boundRequestAuthorityId,
    run.generationId,
  );
  if (authorityStop === false) {
    return routeError(c, 409, "target_mismatch", "request_authority_mismatch", {
      target: run.attemptLineage.target,
      workPhase: run.workPhase,
      workStatus: run.workStatus,
      workOutcome: run.workOutcome,
    });
  }
  try {
    const result = requestAgentRunStop(userId, run.chatId, turnId);
    return result ? c.json(result) : notFound(c);
  } catch (error) {
    if (error instanceof AgentRunStopUnavailableError) {
      return routeError(c, 409, "stop_unavailable", "stop_unavailable", {
        target: run.attemptLineage.target,
        workPhase: run.workPhase,
        workStatus: run.workStatus,
        workOutcome: run.workOutcome,
        recoveryEligible: run.recoveryEligible,
        recoveryAction: run.recoveryAction,
        omissionCount: run.omissionCount,
        inspectionAttemptId: run.inspectionAttemptId,
      });
    }
    throw error;
  }
});
export const agentRunsRoutes = app;
