import { readDatabaseRows } from "../db/queries";
import { executeDatabaseOperation, type DatabaseExecutionError } from "../db/execution";
import { getDb } from "../db/connection";
import type { SQLQueryBindings } from "bun:sqlite";
import { zipSync, strToU8 } from "fflate";
import type {
  WorldBook, WorldBookEntry,
  CreateWorldBookInput, UpdateWorldBookInput,
  CreateWorldBookEntryInput, UpdateWorldBookEntryInput,
  WorldBookVectorIndexStatus, WorldBookVectorSummary,
  DuplicateWorldBookEntryInput,
  WorldBookEntryBulkActionInput,
  WorldBookEntryBulkActionResult,
  WorldBookEntryConflictPayload,
  WorldBookEntryFolderActionInput,
  WorldBookEntryOrganizationSummary,
} from "../types/world-book";
import type { PaginationParams, PaginatedResult } from "../types/pagination";
import { paginatedQuery } from "./pagination";
import * as embeddingsSvc from "./embeddings.service";
import * as vectorizationQueue from "./vectorization-queue.service";
import {
  desiredWorldBookVectorIndexStatus,
  isWorldBookEntryVectorEligible,
} from "./world-book-vector-state";
import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";
import { yieldToEventLoop } from "../llm/stream-utils";

/** Canonical stale-entry error. Routes/RPCs can serialize `payload` directly. */
export class WorldBookEntryConflictError extends Error {
  readonly payload: WorldBookEntryConflictPayload;
  readonly code = "WORLD_BOOK_ENTRY_CONFLICT";
  readonly error = "world_book_entry_conflict";
  readonly entryId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(entryId: string, expectedRevision: number, current: WorldBookEntry | null) {
    const actualRevision = current ? entryRevisionOf(current) : 0;
    super(
      `World book entry ${entryId} changed since revision ${expectedRevision}; current revision is ${actualRevision}`,
    );
    this.name = "WorldBookEntryConflictError";
    this.payload = {
      error: "world_book_entry_conflict",
      code: "WORLD_BOOK_ENTRY_CONFLICT",
      conflicts: [{ id: entryId, current }],
    };
    this.entryId = entryId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/** Backward-compatible name retained for existing service consumers. */
export class WorldBookEntryRevisionConflictError extends WorldBookEntryConflictError {
  constructor(entryId: string, expectedRevision: number, current: WorldBookEntry | null) {
    super(entryId, expectedRevision, current);
    this.name = "WorldBookEntryRevisionConflictError";
  }
}

/** Thrown when an opt-in revision field is present but malformed. Map to HTTP 428. */
export class WorldBookEntryRevisionInvalidError extends Error {
  readonly code = "WORLD_BOOK_ENTRY_REVISION_INVALID";
  readonly field: "expected_revision" | "expected_revisions";

  constructor(field: "expected_revision" | "expected_revisions") {
    super(`${field} must contain safe integer revisions greater than or equal to 1`);
    this.name = "WorldBookEntryRevisionInvalidError";
    this.field = field;
  }
}

function isValidEntryRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function entryRevisionOf(entry: { revision?: unknown }): number {
  const value = entry.revision;
  return isValidEntryRevision(value) ? value : 1;
}

function parseExpectedRevision(value: unknown, present: boolean): number | undefined {
  if (!present) return undefined;
  if (!isValidEntryRevision(value)) {
    throw new WorldBookEntryRevisionInvalidError("expected_revision");
  }
  return value;
}

function parseExpectedRevisions(value: unknown, present: boolean): Record<string, number> | undefined {
  if (!present) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorldBookEntryRevisionInvalidError("expected_revisions");
  }
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [id, rev] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidEntryRevision(rev)) {
      throw new WorldBookEntryRevisionInvalidError("expected_revisions");
    }
    out[id] = rev;
  }
  return out;
}

function readExpectedRevision(input: object): number | undefined {
  const present = Object.prototype.hasOwnProperty.call(input, "expected_revision");
  return parseExpectedRevision(Reflect.get(input, "expected_revision"), present);
}

function readExpectedRevisions(input: object): Record<string, number> | undefined {
  const present = Object.prototype.hasOwnProperty.call(input, "expected_revisions");
  return parseExpectedRevisions(Reflect.get(input, "expected_revisions"), present);
}

function expectedRevisionFor(
  expectedRevisions: Record<string, number> | undefined,
  entryId: string,
): number | undefined {
  if (!expectedRevisions || !Object.prototype.hasOwnProperty.call(expectedRevisions, entryId)) {
    return undefined;
  }
  const value = expectedRevisions[entryId];
  return value;
}

function throwEntryRevisionConflict(entryId: string, expectedRevision: number, current: WorldBookEntry | null): never {
  throw new WorldBookEntryRevisionConflictError(entryId, expectedRevision, current);
}

function assertEntryExpectedRevision(entry: WorldBookEntry, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined) return;
  const actual = entryRevisionOf(entry);
  if (actual !== expectedRevision) {
    throwEntryRevisionConflict(entry.id, expectedRevision, entry);
  }
}

function readEntryById(userId: string, entryId: string): WorldBookEntry | null {
  return getEntry(userId, entryId);
}

export function emitWorldBookChanged(userId: string, id: string): void {
  const worldBook = getWorldBook(userId, id);
  if (!worldBook) return;
  eventBus.emit(EventType.WORLD_BOOK_CHANGED, { id, worldBook }, userId);
}

/** Coarse invalidation for bulk workflows that intentionally suppress the
 * full payload emitted for every individual world book. */
export function emitWorldBookLibraryChanged(
  userId: string,
  payload: { reason: string; imported: number },
): void {
  eventBus.emit(EventType.WORLD_BOOK_LIBRARY_CHANGED, payload, userId);
}

function emitWorldBookDeleted(userId: string, id: string): void {
  eventBus.emit(EventType.WORLD_BOOK_DELETED, { id }, userId);
}

function emitWorldBookEntryChanged(userId: string, id: string): void {
  const entry = getEntry(userId, id);
  if (!entry) return;
  eventBus.emit(EventType.WORLD_BOOK_ENTRY_CHANGED, { id, worldBookId: entry.world_book_id, entry }, userId);
}

const ENTRY_OUTLET_NAME_KEYS = ["outlet_name", "outletName"] as const;
const ENTRY_WI_MARKER_KEYS = ["wi_marker", "wiMarker"] as const;
const ENTRY_WI_MARKER_SIDE_KEYS = ["wi_marker_side", "wiMarkerSide"] as const;

// Valid WI marker ids — must match ADDABLE_MARKERS in
// frontend/src/lib/loom/constants.ts. Pinned-marker entries splice adjacent
// to the loom block whose `marker` equals this id.
const VALID_WI_MARKERS: Record<string, true> = {
  chat_history: true,
  world_info_before: true,
  world_info_after: true,
  char_description: true,
  char_personality: true,
  persona_description: true,
  scenario: true,
  dialogue_examples: true,
  main_prompt: true,
  enhance_definitions: true,
  jailbreak: true,
  nsfw_prompt: true,
};

function normalizeEntryOutletName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// Marker id must be one of the 12 valid ids; anything else coerces to null.
function normalizeEntryWiMarker(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return VALID_WI_MARKERS[normalized] === true ? normalized : null;
}

// Side is "before" | "after" (case-insensitive); anything else coerces to null.
function normalizeEntryWiMarkerSide(value: unknown): "before" | "after" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "before") return "before";
  if (normalized === "after") return "after";
  return null;
}

function cloneUnknownRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object") return {};
  return JSON.parse(JSON.stringify(value));
}

function splitManagedEntryExtensions(raw: unknown): {
  extensions: Record<string, any>;
  outletName: string | null;
  wiMarker: string | null;
  wiMarkerSide: "before" | "after" | null;
} {
  const extensions = typeof raw === "string"
    ? JSON.parse(raw)
    : cloneUnknownRecord(raw);
  const next = cloneUnknownRecord(extensions);
  const outletName = normalizeEntryOutletName(next.outlet_name ?? next.outletName);
  const wiMarker = normalizeEntryWiMarker(next.wi_marker ?? next.wiMarker);
  const wiMarkerSide = normalizeEntryWiMarkerSide(next.wi_marker_side ?? next.wiMarkerSide);
  for (const key of ENTRY_OUTLET_NAME_KEYS) delete next[key];
  for (const key of ENTRY_WI_MARKER_KEYS) delete next[key];
  for (const key of ENTRY_WI_MARKER_SIDE_KEYS) delete next[key];
  return { extensions: next, outletName, wiMarker, wiMarkerSide };
}

function buildStoredEntryExtensions(
  raw: unknown,
  outletValue: unknown,
  wiMarkerValue?: unknown,
  wiMarkerSideValue?: unknown,
): string {
  const {
    extensions,
    outletName: embeddedOutletName,
    wiMarker: embeddedWiMarker,
    wiMarkerSide: embeddedWiMarkerSide,
  } = splitManagedEntryExtensions(raw);
  const outletName = outletValue !== undefined
    ? normalizeEntryOutletName(outletValue)
    : embeddedOutletName;
  const wiMarker = wiMarkerValue !== undefined
    ? normalizeEntryWiMarker(wiMarkerValue)
    : embeddedWiMarker;
  const wiMarkerSide = wiMarkerSideValue !== undefined
    ? normalizeEntryWiMarkerSide(wiMarkerSideValue)
    : embeddedWiMarkerSide;
  if (outletName) {
    extensions.outlet_name = outletName;
  }
  if (wiMarker) {
    extensions.wi_marker = wiMarker;
  }
  if (wiMarkerSide) {
    extensions.wi_marker_side = wiMarkerSide;
  }
  return JSON.stringify(extensions);
}

function rowToBook(row: any): WorldBook {
  // Explicit field mapping rather than `...row` so internal columns (user_id)
  // aren't shipped to the client.
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folder: row.folder ?? "",
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeVectorIndexStatus(row: any): WorldBookVectorIndexStatus {
  if (
    row.vector_index_status === "not_enabled" ||
    row.vector_index_status === "pending" ||
    row.vector_index_status === "indexed" ||
    row.vector_index_status === "error"
  ) {
    return row.vector_index_status;
  }
  return desiredWorldBookVectorIndexStatus({
    vectorized: !!row.vectorized,
    disabled: !!row.disabled,
    content: typeof row.content === "string" ? row.content : "",
  });
}

/** Invalid organization mutations are rejected before any writes. Imports stay tolerant. */
export class WorldBookEntryOrganizationError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = "WorldBookEntryOrganizationError";
  }
}

function validateOrganizationInput(input: Partial<CreateWorldBookEntryInput>): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorldBookEntryOrganizationError("Entry input must be an object");
  }
  if (input.folder !== undefined && typeof input.folder !== "string") {
    throw new WorldBookEntryOrganizationError("folder must be a string");
  }
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.some(tag => typeof tag !== "string"))) {
    throw new WorldBookEntryOrganizationError("tags must be an array of strings");
  }
}

function normalizeEntryFolder(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeEntryTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim()).filter(Boolean))];
}

function parseEntryTags(value: unknown): string[] {
  try { return normalizeEntryTags(typeof value === "string" ? JSON.parse(value) : value); }
  catch { return []; }
}

function appendOrganizationMutation(
  input: Partial<CreateWorldBookEntryInput>, fields: string[], values: SQLQueryBindings[],
): void {
  if (input.folder !== undefined) { fields.push("folder = ?"); values.push(normalizeEntryFolder(input.folder)); }
  if (input.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(normalizeEntryTags(input.tags))); }
}

function rowToEntry(row: any): WorldBookEntry {
  const vectorIndexStatus = normalizeVectorIndexStatus(row);
  const { extensions, outletName, wiMarker, wiMarkerSide } = splitManagedEntryExtensions(row.extensions);
  return {
    ...row,
    folder: normalizeEntryFolder(row.folder),
    tags: parseEntryTags(row.tags),
    outlet_name: outletName,
    wi_marker: wiMarker,
    wi_marker_side: wiMarkerSide,
    key: JSON.parse(row.key),
    keysecondary: JSON.parse(row.keysecondary),
    role: row.role || null,
    selective: !!row.selective,
    constant: !!row.constant,
    disabled: !!row.disabled,
    group_override: !!row.group_override,
    case_sensitive: !!row.case_sensitive,
    match_whole_words: !!row.match_whole_words,
    use_regex: !!row.use_regex,
    prevent_recursion: !!row.prevent_recursion,
    exclude_recursion: !!row.exclude_recursion,
    delay_until_recursion: !!row.delay_until_recursion,
    use_probability: !!row.use_probability,
    vectorized: !!row.vectorized,
    vector_index_status: vectorIndexStatus,
    vector_indexed_at: row.vector_indexed_at ?? null,
    vector_index_error: row.vector_index_error || null,
    scan_depth: row.scan_depth ?? null,
    automation_id: row.automation_id || null,
    extensions,
  };
}

function getPendingVectorIndexState(entry: { vectorized: boolean; disabled?: boolean; content?: string | null }): {
  vector_index_status: WorldBookVectorIndexStatus;
  vector_indexed_at: null;
  vector_index_error: null;
} {
  return {
    vector_index_status: desiredWorldBookVectorIndexStatus({
      vectorized: !!entry.vectorized,
      disabled: !!entry.disabled,
      content: entry.content ?? "",
    }),
    vector_indexed_at: null,
    vector_index_error: null,
  };
}

function isOrganizationOnlyMutation(input: Partial<CreateWorldBookEntryInput>): boolean {
  return Object.keys(input).every(key => key === "folder" || key === "tags" || key === "expected_revision");
}

function shouldResetVectorIndex(input: UpdateWorldBookEntryInput): boolean {
  return (
    input.vectorized !== undefined ||
    input.content !== undefined ||
    input.comment !== undefined ||
    input.key !== undefined ||
    input.keysecondary !== undefined ||
    input.disabled !== undefined
  );
}

function touchWorldBook(worldBookId: string, timestamp: number = Math.floor(Date.now() / 1000)): void {
  getDb().query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(timestamp, worldBookId);
}

function cloneEntryExtensions(extensions: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(extensions || {}));
}

// --- H12: Entity extension namespaces ---

export type EntityExtensionEntity = "world_book_entry" | "character" | "preset";

export interface EntityExtensionNamespaceResult {
  entity: EntityExtensionEntity;
  id: string;
  namespace: string;
  value: unknown;
  extensions: Record<string, unknown>;
}

export const ENTITY_EXTENSION_NAMESPACE_CODES = [
  "INVALID_NAMESPACE",
  "HOST_MANAGED_NAMESPACE",
  "NAMESPACE_TOO_LARGE",
] as const;

export type EntityExtensionNamespaceErrorCode = (typeof ENTITY_EXTENSION_NAMESPACE_CODES)[number];

export class EntityExtensionNamespaceError extends Error {
  readonly code: EntityExtensionNamespaceErrorCode;

  constructor(code: EntityExtensionNamespaceErrorCode, message: string) {
    super(message);
    this.name = "EntityExtensionNamespaceError";
    this.code = code;
  }
}

const ENTITY_EXTENSION_NAMESPACE_PATTERN = /^_?[a-z][a-z0-9_]*$/;
const ENTITY_EXTENSION_NAMESPACE_MAX_BYTES = 2 * 1024 * 1024;
const HOST_MANAGED_ENTRY_NAMESPACE_KEYS = new Set<string>([
  ...ENTRY_OUTLET_NAME_KEYS,
  ...ENTRY_WI_MARKER_KEYS,
  ...ENTRY_WI_MARKER_SIDE_KEYS,
]);

interface EntityNamespaceTarget {
  table: "world_book_entries" | "characters" | "presets";
  column: "extensions" | "metadata";
  selectSql: string;
  ownerPredicate: string;
}

function entityNamespaceTarget(entity: EntityExtensionEntity): EntityNamespaceTarget {
  switch (entity) {
    case "world_book_entry":
      return {
        table: "world_book_entries",
        column: "extensions",
        selectSql:
          "SELECT e.extensions AS bag FROM world_book_entries e JOIN world_books w ON e.world_book_id = w.id WHERE e.id = ? AND w.user_id = ?",
        ownerPredicate:
          "EXISTS (SELECT 1 FROM world_books w WHERE w.id = world_book_entries.world_book_id AND w.user_id = ?)",
      };
    case "character":
      return {
        table: "characters",
        column: "extensions",
        selectSql: "SELECT extensions AS bag FROM characters WHERE id = ? AND user_id = ?",
        ownerPredicate: "user_id = ?",
      };
    case "preset":
      return {
        table: "presets",
        column: "metadata",
        selectSql: "SELECT metadata AS bag FROM presets WHERE id = ? AND user_id = ?",
        ownerPredicate: "user_id = ?",
      };
    default:
      throw new EntityExtensionNamespaceError(
        "INVALID_NAMESPACE",
        `Unsupported extension entity ${String(entity)}`,
      );
  }
}

function parseStoredExtensionBag(raw: unknown): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new EntityExtensionNamespaceError(
      "INVALID_NAMESPACE",
      "Stored extension metadata is not valid JSON",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EntityExtensionNamespaceError(
      "INVALID_NAMESPACE",
      "Stored extension metadata must be a JSON object",
    );
  }
  return parsed as Record<string, unknown>;
}

function serializeExtensionNamespaceValue(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    throw new EntityExtensionNamespaceError(
      "INVALID_NAMESPACE",
      "Extension namespace value must be JSON-serializable",
    );
  }
  if (new TextEncoder().encode(serialized).byteLength > ENTITY_EXTENSION_NAMESPACE_MAX_BYTES) {
    throw new EntityExtensionNamespaceError(
      "NAMESPACE_TOO_LARGE",
      "Extension namespace value exceeds the 2 MiB serialized UTF-8 limit",
    );
  }
  return serialized;
}

function validateExtensionNamespace(namespace: string): void {
  if (HOST_MANAGED_ENTRY_NAMESPACE_KEYS.has(namespace)) {
    throw new EntityExtensionNamespaceError(
      "HOST_MANAGED_NAMESPACE",
      `Extension namespace ${JSON.stringify(namespace)} is managed by the host`,
    );
  }
  if (!ENTITY_EXTENSION_NAMESPACE_PATTERN.test(namespace)) {
    throw new EntityExtensionNamespaceError(
      "INVALID_NAMESPACE",
      `Extension namespace ${JSON.stringify(namespace)} must match ${ENTITY_EXTENSION_NAMESPACE_PATTERN}`,
    );
  }
}

/**
 * Merge or delete one extension namespace without treating derived metadata as
 * a user edit. The JSON mutation stays inside the transaction so sibling
 * namespaces survive concurrent writers; ownership is repeated on the UPDATE.
 */
export function setEntityExtensionNamespace(
  userId: string,
  entity: EntityExtensionEntity,
  entityId: string,
  namespace: string,
  value: unknown,
): EntityExtensionNamespaceResult | null {
  const target = entityNamespaceTarget(entity);
  const db = getDb();

  return db.transaction((): EntityExtensionNamespaceResult | null => {
    const row = db.query(target.selectSql).get(entityId, userId) as { bag?: unknown } | null;
    if (!row) return null;

    validateExtensionNamespace(namespace);
    const serialized = value === null ? null : serializeExtensionNamespaceValue(value);
    // Validate malformed existing bags before issuing any write. SQLite's JSON
    // functions also fail closed for malformed JSON, but this gives callers a
    // stable service error and prevents a silent blob replacement.
    parseStoredExtensionBag(row.bag);
    const path = `$.${namespace}`;
    const query = serialized === null
      ? `UPDATE ${target.table}
         SET ${target.column} = json_remove(${target.column}, ?)
         WHERE id = ? AND ${target.ownerPredicate}`
      : `UPDATE ${target.table}
         SET ${target.column} = json_set(${target.column}, ?, json(?))
         WHERE id = ? AND ${target.ownerPredicate}`;
    const result = serialized === null
      ? db.query(query).run(path, entityId, userId)
      : db.query(query).run(path, serialized, entityId, userId);
    if (result.changes === 0) return null;

    const updatedRow = db.query(target.selectSql).get(entityId, userId) as { bag?: unknown } | null;
    if (!updatedRow) return null;
    const extensions = parseStoredExtensionBag(updatedRow.bag);
    if (serialized === null) delete extensions[namespace];
    return {
      entity,
      id: entityId,
      namespace,
      value: serialized === null ? null : extensions[namespace],
      extensions,
    };
  })();
}

function normalizeKeywordList(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function buildSparseEntryMutation(
  entry: WorldBookEntry,
  input: Partial<CreateWorldBookEntryInput>,
): { fields: string[]; values: SQLQueryBindings[]; resetsVectorIndex: boolean } {
  const fields: string[] = [];
  const values: SQLQueryBindings[] = [];
  validateOrganizationInput(input);
  appendOrganizationMutation(input, fields, values);
  const jsonArrayFields = ["key", "keysecondary"] as const;
  for (const field of jsonArrayFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(JSON.stringify(input[field]));
    }
  }
  const stringFields = ["content", "comment", "role", "group_name", "automation_id"] as const;
  for (const field of stringFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(input[field] ?? null);
    }
  }
  const intFields = ["position", "depth", "order_value", "group_weight", "probability", "scan_depth", "priority", "sticky", "cooldown", "delay", "selective_logic"] as const;
  for (const field of intFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(input[field] ?? null);
    }
  }
  const boolFields = ["selective", "constant", "disabled", "group_override", "case_sensitive", "match_whole_words", "use_regex", "prevent_recursion", "exclude_recursion", "delay_until_recursion", "use_probability", "vectorized"] as const;
  for (const field of boolFields) {
    if (input[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(input[field] ? 1 : 0);
    }
  }
  if (input.extensions !== undefined || input.outlet_name !== undefined || input.wi_marker !== undefined || input.wi_marker_side !== undefined) {
    fields.push("extensions = ?");
    values.push(buildStoredEntryExtensions(
      input.extensions ?? entry.extensions,
      input.outlet_name !== undefined ? input.outlet_name : entry.outlet_name,
      input.wi_marker !== undefined ? input.wi_marker : entry.wi_marker,
      input.wi_marker_side !== undefined ? input.wi_marker_side : entry.wi_marker_side,
    ));
  }
  return {
    fields,
    values,
    resetsVectorIndex: shouldResetVectorIndex(input as UpdateWorldBookEntryInput),
  };
}

function importExtensionRecord(raw: any): Record<string, any> {
  return raw?.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
    ? raw.extensions
    : {};
}

function importValue(raw: any, extensions: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    if (raw[key] !== undefined) return raw[key];
  }
  for (const key of keys) {
    if (extensions[key] !== undefined) return extensions[key];
  }
  return undefined;
}

export function normalizeImportedEntries(raw: unknown): any[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") return Object.values(raw as Record<string, any>);
  return [];
}

export function countImportedWorldBookEntries(raw: unknown): number {
  return normalizeImportedEntries(raw).length;
}

function normalizeImportedPosition(position: unknown): number {
  if (typeof position === "number" && Number.isFinite(position)) {
    return position;
  }

  if (typeof position === "string") {
    const trimmed = position.trim().toLowerCase();
    if (!trimmed) return 0;

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return numeric;

    switch (trimmed) {
      case "before":
      case "before_char":
      case "before_character":
        return 0;
      case "after":
      case "after_char":
      case "after_character":
        return 1;
      case "before_an":
      case "before_authors_note":
      case "before_author_note":
        return 2;
      case "after_an":
      case "after_authors_note":
      case "after_author_note":
        return 3;
      case "at_depth":
      case "depth":
        return 4;
      case "before_em":
      case "before_example":
      case "before_examples":
      case "before_example_messages":
        return 5;
      case "after_em":
      case "after_example":
      case "after_examples":
      case "after_example_messages":
        return 6;
    }
  }

  return 0;
}

export function normalizeImportedEntryInput(raw: any, index: number, options: { format: "standard" | "lumiverse" } = { format: "standard" }): CreateWorldBookEntryInput {
  const ext = importExtensionRecord(raw);
  const keys: string[] = Array.isArray(raw.keys) ? raw.keys
    : Array.isArray(raw.key) ? raw.key
    : typeof raw.key === "string" ? raw.key.split(",").map((k: string) => k.trim()).filter(Boolean)
    : typeof raw.keys === "string" ? raw.keys.split(",").map((k: string) => k.trim()).filter(Boolean)
    : [];
  const secondaryKeys: string[] = Array.isArray(raw.secondary_keys) ? raw.secondary_keys
    : Array.isArray(raw.keysecondary) ? raw.keysecondary
    : typeof raw.secondary_keys === "string" ? raw.secondary_keys.split(",").map((k: string) => k.trim()).filter(Boolean)
    : [];

  const comment = raw.comment || raw.name || "";
  const enabled = raw.enabled !== undefined ? raw.enabled
    : raw.disabled !== undefined ? !raw.disabled
    : raw.disable !== undefined ? !raw.disable
    : true;

  const knownFields = new Set([
    "keys", "key", "secondary_keys", "keysecondary", "content", "comment", "name",
    "enabled", "disabled", "disable",
    "insertion_order", "order_value", "order", "displayIndex", "position", "depth", "role", "selective",
    "constant", "case_sensitive", "caseSensitive", "match_whole_words", "matchWholeWords",
    "group", "group_name", "group_override", "groupOverride",
    "group_weight", "groupWeight", "probability", "scan_depth", "scanDepth",
    "automation_id", "automationId", "selectiveLogic", "selective_logic",
    "useProbability", "use_probability", "use_regex", "useRegex",
    "prevent_recursion", "preventRecursion", "exclude_recursion", "excludeRecursion",
    "delay_until_recursion", "delayUntilRecursion",
    "priority", "sticky", "cooldown", "delay",
    "id", "entry", "uid", "vectorized", "extensions",
    "outlet_name", "outletName", "wi_marker", "wiMarker", "wi_marker_side", "wiMarkerSide",
  ]);
  if (options.format === "lumiverse") { knownFields.add("folder"); knownFields.add("tags"); }
  const extras: Record<string, any> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!knownFields.has(k)) extras[k] = v;
  }

  const importedExtensions = { ...raw.extensions, ...extras };
  if (options.format === "lumiverse") {
    // Recover older native exports that preserved future fields as unknown extensions.
    // Foreign standard payloads retain those names and meanings without reinterpretation.
    delete importedExtensions.folder;
    delete importedExtensions.tags;
  }

  return {
    folder: options.format === "lumiverse" ? normalizeEntryFolder(raw.folder !== undefined ? raw.folder : ext.folder) : "",
    tags: options.format === "lumiverse" ? normalizeEntryTags(raw.tags !== undefined ? raw.tags : ext.tags) : [],
    outlet_name: importValue(raw, ext, "outlet_name", "outletName"),
    wi_marker: importValue(raw, ext, "wi_marker", "wiMarker"),
    wi_marker_side: importValue(raw, ext, "wi_marker_side", "wiMarkerSide"),
    key: keys,
    keysecondary: secondaryKeys,
    content: raw.content || "",
    comment,
    disabled: !enabled,
    order_value: resolveImportOrder(raw, index),
    position: normalizeImportedPosition(raw.position),
    depth: importValue(raw, ext, "depth") ?? 4,
    role: normalizeImportRole(raw.role) || undefined,
    selective: importValue(raw, ext, "selective") ?? false,
    constant: importValue(raw, ext, "constant") ?? false,
    case_sensitive: importValue(raw, ext, "case_sensitive", "caseSensitive") ?? false,
    match_whole_words: importValue(raw, ext, "match_whole_words", "matchWholeWords") ?? false,
    group_name: importValue(raw, ext, "group", "group_name") || "",
    group_override: importValue(raw, ext, "group_override", "groupOverride") ?? false,
    group_weight: importValue(raw, ext, "group_weight", "groupWeight") ?? 100,
    probability: importValue(raw, ext, "probability") ?? 100,
    scan_depth: importValue(raw, ext, "scan_depth", "scanDepth") ?? undefined,
    automation_id: importValue(raw, ext, "automation_id", "automationId") || undefined,
    selective_logic: importValue(raw, ext, "selectiveLogic", "selective_logic") ?? 0,
    use_probability: importValue(raw, ext, "useProbability", "use_probability") ?? true,
    use_regex: importValue(raw, ext, "use_regex", "useRegex") ?? false,
    prevent_recursion: importValue(raw, ext, "prevent_recursion", "preventRecursion") ?? false,
    exclude_recursion: importValue(raw, ext, "exclude_recursion", "excludeRecursion") ?? false,
    delay_until_recursion: importValue(raw, ext, "delay_until_recursion", "delayUntilRecursion") ?? false,
    priority: importValue(raw, ext, "priority") ?? 10,
    sticky: importValue(raw, ext, "sticky") ?? 0,
    cooldown: importValue(raw, ext, "cooldown") ?? 0,
    delay: importValue(raw, ext, "delay") ?? 0,
    vectorized: importValue(raw, ext, "vectorized") ?? false,
    extensions: importedExtensions,
  };
}

export function materializeCharacterBookEntriesForRuntime(
  worldBookId: string,
  characterBook: any,
): WorldBookEntry[] {
  const rawEntries = normalizeImportedEntries(characterBook?.entries);
  return rawEntries.map((raw, index) => {
    const input = normalizeImportedEntryInput(raw, index);
    const outletName = normalizeEntryOutletName(input.outlet_name);
    const wiMarker = normalizeEntryWiMarker(input.wi_marker);
    const wiMarkerSide = normalizeEntryWiMarkerSide(input.wi_marker_side);
    return {
      id: typeof raw.id === "string" && raw.id ? raw.id : crypto.randomUUID(),
      world_book_id: worldBookId,
      folder: "",
      tags: [],
      uid: typeof raw.uid === "string" && raw.uid ? raw.uid : crypto.randomUUID(),
      outlet_name: outletName,
      wi_marker: wiMarker,
      wi_marker_side: wiMarkerSide,
      key: input.key ?? [],
      keysecondary: input.keysecondary ?? [],
      content: input.content ?? "",
      comment: input.comment ?? "",
      position: input.position ?? 0,
      depth: input.depth ?? 4,
      role: input.role ?? null,
      order_value: input.order_value ?? 100,
      selective: !!input.selective,
      constant: !!input.constant,
      disabled: !!input.disabled,
      group_name: input.group_name ?? "",
      group_override: !!input.group_override,
      group_weight: input.group_weight ?? 100,
      probability: input.probability ?? 100,
      scan_depth: input.scan_depth ?? null,
      exclude_greeting: !!input.exclude_greeting,
      case_sensitive: !!input.case_sensitive,
      match_whole_words: !!input.match_whole_words,
      automation_id: input.automation_id ?? null,
      use_regex: !!input.use_regex,
      prevent_recursion: !!input.prevent_recursion,
      exclude_recursion: !!input.exclude_recursion,
      delay_until_recursion: !!input.delay_until_recursion,
      priority: input.priority ?? 10,
      sticky: input.sticky ?? 0,
      cooldown: input.cooldown ?? 0,
      delay: input.delay ?? 0,
      selective_logic: input.selective_logic ?? 0,
      use_probability: input.use_probability !== false,
      vectorized: false,
      vector_index_status: "not_enabled",
      vector_indexed_at: null,
      vector_index_error: null,
      revision: 1,
      extensions: cloneEntryExtensions(input.extensions || {}),
      created_at: 0,
      updated_at: 0,
    };
  });
}

function getEntriesForBook(userId: string, worldBookId: string, entryIds: string[]): WorldBookEntry[] {
  if (entryIds.length === 0) return [];
  const uniqueIds = [...new Set(entryIds)];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = getDb().query(
    `SELECT e.*
     FROM world_book_entries e
     JOIN world_books w ON e.world_book_id = w.id
     WHERE w.user_id = ? AND e.world_book_id = ? AND e.id IN (${placeholders})`
  ).all(userId, worldBookId, ...uniqueIds) as any[];
  return rows.map(rowToEntry);
}

function setEntriesPendingReindex(entries: WorldBookEntry[]): void {
  if (entries.length === 0) return;
  const stmt = getDb().query(
    `UPDATE world_book_entries
     SET vector_index_status = ?, vector_indexed_at = NULL, vector_index_error = NULL
     WHERE id = ?`,
  );
  for (const entry of entries) {
    stmt.run(desiredWorldBookVectorIndexStatus(entry), entry.id);
  }
}

function worldBookEntryMayHaveVectors(entry: WorldBookEntry): boolean {
  return entry.vectorized || entry.vector_index_status !== "not_enabled";
}

export type WorldBookEntryVectorEffects = Map<string, {
  previous: WorldBookEntry;
  resetsVectorIndex: boolean;
}>;

function deleteWorldBookVectorsAndMaybeRequeue(
  userId: string,
  entry: WorldBookEntry,
  requeue: boolean,
  deferredDeletes?: string[],
): void {
  if (requeue && isWorldBookEntryVectorEligible(entry)) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, entry.id, 4, true);
    return;
  }
  if (deferredDeletes) {
    deferredDeletes.push(entry.id);
    return;
  }
  void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
    console.warn("[embeddings] Failed to remove world book entry vectors:", err);
  });
}

// A write per entry overflows the vector store's write lock queue.
function deleteWorldBookEntryVectorsGrouped(userId: string, entryIds: string[]): void {
  if (entryIds.length === 0) return;
  void embeddingsSvc.deleteWorldBookEntryEmbeddingsBeforeSourceDelete(userId, entryIds, () => undefined).catch((err: unknown) => {
    console.warn("[embeddings] Failed to remove world book entry vectors:", err);
  });
}

function applyWorldBookEntryVectorEffects(
  userId: string,
  previous: WorldBookEntry,
  updated: WorldBookEntry,
  resetsVectorIndex: boolean,
  deferredDeletes?: string[],
): void {
  if (!updated.vectorized) {
    if (worldBookEntryMayHaveVectors(previous)) {
      deleteWorldBookVectorsAndMaybeRequeue(userId, updated, false, deferredDeletes);
    }
  } else if (resetsVectorIndex) {
    deleteWorldBookVectorsAndMaybeRequeue(userId, updated, true, deferredDeletes);
  } else if (updated.vector_index_status !== "indexed" && isWorldBookEntryVectorEligible(updated)) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, updated.id);
  }
}

/** Run once after commit, using each entry's original index state and final source state. */
export function flushWorldBookEntryVectorEffects(userId: string, effects: WorldBookEntryVectorEffects): void {
  const deferredDeletes: string[] = [];
  for (const [id, effect] of effects) {
    const updated = getEntry(userId, id);
    if (updated) applyWorldBookEntryVectorEffects(userId, effect.previous, updated, effect.resetsVectorIndex, deferredDeletes);
  }
  deleteWorldBookEntryVectorsGrouped(userId, deferredDeletes);
}

function queueReindexForEntries(userId: string, entries: WorldBookEntry[]): void {
  for (const entry of entries) {
    if (isWorldBookEntryVectorEligible(entry)) {
      vectorizationQueue.queueWorldBookEntryVectorization(userId, entry.id, 4, true);
    }
  }
}

function queueWorldBookEntriesForIndexing(userId: string, worldBookId: string): void {
  const rows = getDb().query(
    `SELECT id
     FROM world_book_entries
     WHERE world_book_id = ?
       AND vectorized = 1
       AND disabled = 0
       AND length(trim(content)) > 0
       AND vector_index_status IN ('pending', 'error', 'not_enabled')`
  ).all(worldBookId) as Array<{ id: string }>;

  for (const row of rows) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, row.id);
  }
}

// --- World Book CRUD ---

/** Lightweight listing of all world books for manifest building. */
export function listWorldBooksForManifest(userId: string): Array<{ name: string; metadata: Record<string, any>; created_at: number }> {
  const rows = getDb().query("SELECT name, metadata, created_at FROM world_books WHERE user_id = ?").all(userId) as any[];
  return rows.map((row) => ({
    name: row.name,
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
  }));
}

export function listWorldBooks(userId: string, pagination: PaginationParams): PaginatedResult<WorldBook> {
  return paginatedQuery(
    "SELECT * FROM world_books WHERE user_id = ? ORDER BY updated_at DESC",
    "SELECT COUNT(*) as count FROM world_books WHERE user_id = ?",
    [userId],
    pagination,
    rowToBook
  );
}

export async function getWorldBookAsync(userId: string, id: string): Promise<WorldBook | null> {
  const row = await executeDatabaseOperation<any>({ kind: "read", statement: { sql: "SELECT * FROM world_books WHERE id = ? AND user_id = ?", bindings: [id, userId], mode: "get" } });
  return row ? rowToBook(row) : null;
}

export function getWorldBook(userId: string, id: string): WorldBook | null {
  const row = getDb().query("SELECT * FROM world_books WHERE id = ? AND user_id = ?").get(id, userId) as any;
  return row ? rowToBook(row) : null;
}

/**
 * Resolve the standalone world book that already represents a character's
 * embedded `character_book`, if one exists. Prefer a currently-attached book
 * ID first, then fall back to the auto-managed import, then the newest manual
 * import for that character so repeated "import lorebook" clicks do not spawn
 * duplicates.
 */
export function findImportedCharacterBookWorldBook(
  userId: string,
  characterId: string,
  preferredIds: string[] = [],
): WorldBook | null {
  const preferred = preferredIds.filter((id) => typeof id === "string" && id);
  const preferredPlaceholders = preferred.map(() => "?").join(", ");
  const preferredOrder = preferred.length > 0
    ? `CASE WHEN id IN (${preferredPlaceholders}) THEN 0 ELSE 1 END,`
    : "";

  const row = getDb().query(
    `SELECT *
       FROM world_books
      WHERE user_id = ?
        AND json_extract(metadata, '$.source') = 'character'
        AND json_extract(metadata, '$.source_character_id') = ?
      ORDER BY
        ${preferredOrder}
        CASE WHEN json_extract(metadata, '$.auto_managed_by_character') = 1 THEN 0 ELSE 1 END,
        updated_at DESC,
        created_at DESC,
        id ASC
      LIMIT 1`
  ).get(userId, characterId, ...preferred) as any;

  return row ? rowToBook(row) : null;
}

/**
 * Cheap signature of a user's world-book list for ETag generation: count +
 * max(updated_at). Creating/deleting a book changes the count; editing a book
 * OR any of its entries bumps updated_at (entry mutations call touchWorldBook),
 * so this uniquely identifies the list without serializing it.
 */
export function getWorldBookListSignature(userId: string): { count: number; maxUpdatedAt: number } {
  const row = getDb()
    .query("SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as maxUpdatedAt FROM world_books WHERE user_id = ?")
    .get(userId) as { count: number; maxUpdatedAt: number };
  return { count: row.count, maxUpdatedAt: row.maxUpdatedAt };
}

/**
 * Cheap signature of a book's entries for ETag generation: count,
 * max(updated_at), and revision sum scoped by world_book_id.
 * Caller must have already verified ownership of the book. Combined with the
 * book's own updated_at this covers entry CRUD, content edits, and reorders,
 * including organization edits within the same timestamp second.
 */
export function getWorldBookEntriesSignature(worldBookId: string): { count: number; maxUpdatedAt: number; revisionSum: number } {
  const row = getDb()
    .query("SELECT COUNT(*) as count, COALESCE(MAX(updated_at), 0) as maxUpdatedAt, COALESCE(SUM(revision), 0) as revisionSum FROM world_book_entries WHERE world_book_id = ?")
    .get(worldBookId) as { count: number; maxUpdatedAt: number; revisionSum: number };
  return { count: row.count, maxUpdatedAt: row.maxUpdatedAt, revisionSum: row.revisionSum };
}

export interface CreateWorldBookOptions {
  /** Bulk workflows publish one library invalidation after committing. */
  emitEvent?: boolean;
}

export function createWorldBook(
  userId: string,
  input: CreateWorldBookInput,
  options: CreateWorldBookOptions = {},
): WorldBook {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query("INSERT INTO world_books (id, user_id, name, description, folder, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, userId, input.name, input.description || "", input.folder || "", JSON.stringify(input.metadata || {}), now, now);
  if (options.emitEvent !== false) emitWorldBookChanged(userId, id);
  return getWorldBook(userId, id)!;
}

/** Load SillyTavern migration identities once. This keeps rerun deduplication
 * linear instead of repeatedly scanning JSON metadata for every source file. */
export function listSillyTavernWorldBookSourceFilenameIds(userId: string): Map<string, string> {
  const rows = getDb().query(
    `SELECT id, json_extract(metadata, '$._lumiverse_source_filename') AS source_filename
     FROM world_books
     WHERE user_id = ?
       AND json_extract(metadata, '$.source') = 'sillytavern_migration'
       AND json_type(metadata, '$._lumiverse_source_filename') = 'text'
     ORDER BY updated_at ASC`,
  ).all(userId) as Array<{ id: string; source_filename: string }>;

  const result = new Map<string, string>();
  for (const row of rows) result.set(row.source_filename, row.id);
  return result;
}

export function listSillyTavernWorldBookNameIds(userId: string): Map<string, string> {
  const rows = getDb().query(
    `SELECT id, name
     FROM world_books
     WHERE user_id = ?
       AND json_extract(metadata, '$.source') = 'sillytavern_migration'
     ORDER BY updated_at ASC`,
  ).all(userId) as Array<{ id: string; name: string }>;

  const result = new Map<string, string>();
  for (const row of rows) result.set(row.name, row.id);
  return result;
}

export function updateWorldBook(userId: string, id: string, input: UpdateWorldBookInput): WorldBook | null {
  const existing = getWorldBook(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { fields.push("name = ?"); values.push(input.name); }
  if (input.description !== undefined) { fields.push("description = ?"); values.push(input.description); }
  if (input.folder !== undefined) { fields.push("folder = ?"); values.push(input.folder); }
  if (input.metadata !== undefined) { fields.push("metadata = ?"); values.push(JSON.stringify(input.metadata)); }

  if (fields.length === 0) return existing;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);
  values.push(userId);

  getDb().query(`UPDATE world_books SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  emitWorldBookChanged(userId, id);
  return getWorldBook(userId, id)!;
}

/**
 * Rename a folder by moving every one of the user's world books in that
 * folder. Folders are represented by the `folder` value on each world book,
 * rather than a separate database entity.
 */
export function renameWorldBookFolder(userId: string, oldName: string, newName: string): WorldBook[] {
  const source = oldName.trim();
  const target = newName.trim();
  if (!source || !target) return [];

  const rows = getDb()
    .query("SELECT * FROM world_books WHERE user_id = ? AND folder = ?")
    .all(userId, source) as any[];
  if (rows.length === 0) return [];

  if (source === target) {
    return rows.map(rowToBook);
  }

  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query("UPDATE world_books SET folder = ?, updated_at = ? WHERE user_id = ? AND folder = ?")
    .run(target, now, userId, source);

  const updated = rows.map((row) => rowToBook({ ...row, folder: target, updated_at: now }));
  for (const worldBook of updated) {
    emitWorldBookChanged(userId, worldBook.id);
  }
  return updated;
}

/**
 * Delete an organizational folder without deleting its lorebooks. Its books
 * are moved into the unfiled bucket, represented by an empty folder string.
 */
export function deleteWorldBookFolder(userId: string, name: string): WorldBook[] {
  const folder = name.trim();
  if (!folder) return [];

  const rows = getDb()
    .query("SELECT * FROM world_books WHERE user_id = ? AND folder = ?")
    .all(userId, folder) as any[];
  if (rows.length === 0) return [];

  const now = Math.floor(Date.now() / 1000);
  getDb()
    .query("UPDATE world_books SET folder = '', updated_at = ? WHERE user_id = ? AND folder = ?")
    .run(now, userId, folder);

  const updated = rows.map((row) => rowToBook({ ...row, folder: "", updated_at: now }));
  for (const worldBook of updated) {
    emitWorldBookChanged(userId, worldBook.id);
  }
  return updated;
}

function getWorldBookEntryIdsForDelete(userId: string, worldBookIds: string[]): string[] {
  if (worldBookIds.length === 0) return [];
  const placeholders = worldBookIds.map(() => "?").join(", ");
  return (getDb().query(
    `SELECT e.id
     FROM world_book_entries e
     JOIN world_books wb ON wb.id = e.world_book_id
     WHERE wb.user_id = ? AND e.world_book_id IN (${placeholders})`
  ).all(userId, ...worldBookIds) as Array<{ id: string }>).map((row) => row.id);
}

export async function deleteWorldBook(userId: string, id: string): Promise<boolean> {
  if (!(await getWorldBookAsync(userId, id))) return false;
  const entryIds = await getWorldBookEntryIdsForDeleteAsync(userId, [id]);
  const deleted = await embeddingsSvc.deleteWorldBookEmbeddingsBeforeSourceDelete(
    userId,
    [id],
    entryIds,
    async () => {
      const [result] = await executeDatabaseOperation<[{ changes: number }]>({
        kind: "transaction", statements: [{ sql: "DELETE FROM world_books WHERE id = ? AND user_id = ?", bindings: [id, userId] }],
      });
      return result.changes > 0;
    },
  );
  if (deleted) emitWorldBookDeleted(userId, id);
  return deleted;
}

export async function bulkDeleteWorldBooks(userId: string, ids: string[]): Promise<{ deleted: string[] }> {
  const uniqueIds = dedupeWorldBookIds(ids);
  if (uniqueIds.length === 0) return { deleted: [] };
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const ownedIds = (await readDatabaseRows<{ id: string }>(
    `SELECT id FROM world_books WHERE user_id = ? AND id IN (${placeholders})`
  , [userId, ...uniqueIds])).map((row) => row.id);
  const ownedSet = new Set(ownedIds);
  const orderedOwnedIds = uniqueIds.filter((id) => ownedSet.has(id));
  if (orderedOwnedIds.length === 0) return { deleted: [] };
  const entryIds = await getWorldBookEntryIdsForDeleteAsync(userId, orderedOwnedIds);

  const deleted = await embeddingsSvc.deleteWorldBookEmbeddingsBeforeSourceDelete(
    userId,
    orderedOwnedIds,
    entryIds,
    async () => {
      const results = await executeDatabaseOperation<Array<{ changes: number }>>({
        kind: "transaction", statements: orderedOwnedIds.map((id) => ({ sql: "DELETE FROM world_books WHERE id = ? AND user_id = ?", bindings: [id, userId] })),
      });
      return orderedOwnedIds.filter((_, index) => results[index].changes > 0);
    },
  );

  for (const id of deleted) {
    emitWorldBookDeleted(userId, id);
  }

  return { deleted };
}

export function bulkUpdateWorldBooksFolder(userId: string, ids: string[], folder: string): { updated: number } {
  const uniqueIds = dedupeWorldBookIds(ids);
  const normalizedFolder = folder.trim();
  const now = Math.floor(Date.now() / 1000);
  const updatedIds: string[] = [];
  const db = getDb();

  db.transaction(() => {
    const stmt = db.query("UPDATE world_books SET folder = ?, updated_at = ? WHERE id = ? AND user_id = ?");
    for (const id of uniqueIds) {
      if (stmt.run(normalizedFolder, now, id, userId).changes > 0) updatedIds.push(id);
    }
  })();

  for (const id of updatedIds) {
    emitWorldBookChanged(userId, id);
  }

  return { updated: updatedIds.length };
}

export function bulkExportWorldBooks(
  userId: string,
  ids: string[],
  format: WorldBookExportFormat = "lumiverse"
): { filename: string; bytes: Uint8Array } {
  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();

  for (const id of dedupeWorldBookIds(ids)) {
    const payload = exportWorldBook(userId, id, format);
    if (!payload) continue;

    const bookName = typeof payload.name === "string" ? payload.name : "";
    const baseName = sanitizeWorldBookExportFilenameBase(bookName, id);
    const entryName = makeUniqueWorldBookExportEntryName(baseName, usedNames);
    entries[entryName] = strToU8(JSON.stringify(payload, null, 2));
  }

  return {
    filename: buildWorldBooksExportFilename(),
    bytes: zipSync(entries),
  };
}

function dedupeWorldBookIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

function sanitizeWorldBookExportFilenameBase(name: string, fallback: string): string {
  const sanitized = name.replace(/[\/\\:*?"<>|\x00-\x1F\x7F]/g, "").trim();
  return sanitized || fallback;
}

function makeUniqueWorldBookExportEntryName(baseName: string, usedNames: Set<string>): string {
  let candidate = `${baseName}.json`;
  let index = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName} (${index}).json`;
    index += 1;
  }
  usedNames.add(candidate);
  return candidate;
}

function buildWorldBooksExportFilename(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `world-books-${year}${month}${day}.zip`;
}

export async function deleteAutoManagedCharacterWorldBooks(userId: string, characterId: string): Promise<number> {
  const rows = await readDatabaseRows<{ id: string }>(
    `SELECT id
       FROM world_books
      WHERE user_id = ?
        AND json_extract(metadata, '$.auto_managed_by_character') = 1
        AND json_extract(metadata, '$.source_character_id') = ?`
  , [userId, characterId]);

  return (await bulkDeleteWorldBooks(userId, rows.map((row) => row.id))).deleted.length;
}

export function getWorldBookVectorSummary(userId: string, worldBookId: string): WorldBookVectorSummary | null {
  const row = getDb().query(
    `SELECT
       COUNT(e.id) AS total,
       COALESCE(SUM(CASE WHEN e.vectorized = 1 THEN 1 ELSE 0 END), 0) AS enabled,
       COALESCE(SUM(CASE WHEN length(trim(e.content)) > 0 THEN 1 ELSE 0 END), 0) AS non_empty,
       COALESCE(SUM(CASE WHEN e.vectorized = 1 AND length(trim(e.content)) > 0 THEN 1 ELSE 0 END), 0) AS enabled_non_empty,
       COALESCE(SUM(CASE WHEN e.vector_index_status = 'not_enabled' THEN 1 ELSE 0 END), 0) AS not_enabled,
       COALESCE(SUM(CASE WHEN e.vector_index_status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN e.vector_index_status = 'indexed' THEN 1 ELSE 0 END), 0) AS indexed,
       COALESCE(SUM(CASE WHEN e.vector_index_status = 'error' THEN 1 ELSE 0 END), 0) AS error
     FROM world_books wb
     LEFT JOIN world_book_entries e ON e.world_book_id = wb.id
     WHERE wb.id = ? AND wb.user_id = ?
     GROUP BY wb.id`,
  ).get(worldBookId, userId) as WorldBookVectorSummary | null;

  return row;
}

export function setWorldBookSemanticActivation(
  userId: string,
  worldBookId: string,
  enabled: boolean,
): { summary: WorldBookVectorSummary; updated_entries: number } | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  let updatedEntries = 0;

  if (enabled) {
    updatedEntries = db.query(
      `UPDATE world_book_entries
       SET vectorized = 1,
           vector_index_status = CASE
             WHEN disabled = 0 AND length(trim(content)) > 0 THEN 'pending'
             ELSE 'not_enabled'
           END,
           vector_indexed_at = NULL,
           vector_index_error = NULL,
           updated_at = ?,
           revision = revision + 1
       WHERE world_book_id = ?
         AND length(trim(content)) > 0`
    ).run(now, worldBookId).changes;
  } else {
    updatedEntries = db.query(
      `UPDATE world_book_entries
       SET vectorized = 0,
           vector_index_status = 'not_enabled',
           vector_indexed_at = NULL,
           vector_index_error = NULL,
           updated_at = ?,
           revision = revision + 1
       WHERE world_book_id = ?`
    ).run(now, worldBookId).changes;
  }

  if (updatedEntries > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
    emitWorldBookChanged(userId, worldBookId);
  }

  if (!enabled) {
    for (const entry of listEntries(userId, worldBookId)) {
      void embeddingsSvc.deleteWorldBookEntryEmbeddings(userId, entry.id).catch((err: unknown) => {
        console.warn("[embeddings] Failed to remove world book entry vectors:", err);
      });
    }
  } else if (updatedEntries > 0) {
    queueWorldBookEntriesForIndexing(userId, worldBookId);
  }

  return {
    summary: getWorldBookVectorSummary(userId, worldBookId)!,
    updated_entries: updatedEntries,
  };
}

export function getConvertToVectorizedPreview(
  userId: string,
  worldBookId: string,
): { total: number; eligible: number; keys_to_clear: number; keys_retained: number; constant_skipped: number; already_vectorized: number; empty_skipped: number; disabled_skipped: number } | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;
  const entries = listEntries(userId, worldBookId);

  let eligible = 0;
  let keysRetained = 0;
  let constantSkipped = 0;
  let alreadyVectorized = 0;
  let emptySkipped = 0;
  let disabledSkipped = 0;

  for (const entry of entries) {
    const hasContent = (entry.content || "").trim().length > 0;
    if (entry.constant) { constantSkipped++; continue; }
    if (!hasContent) { emptySkipped++; continue; }
    if (entry.disabled) { disabledSkipped++; continue; }
    const hasKeys = (entry.key?.length ?? 0) > 0 || (entry.keysecondary?.length ?? 0) > 0;
    if (entry.vectorized) { alreadyVectorized++; continue; }
    eligible++;
    if (hasKeys) {
      keysRetained++;
    }
  }

  return { total: entries.length, eligible, keys_to_clear: 0, keys_retained: keysRetained, constant_skipped: constantSkipped, already_vectorized: alreadyVectorized, empty_skipped: emptySkipped, disabled_skipped: disabledSkipped };
}

export function convertToVectorized(
  userId: string,
  worldBookId: string,
): { summary: WorldBookVectorSummary; converted: number } | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const converted = db.query(
    `UPDATE world_book_entries
      SET vectorized = 1,
          vector_index_status = 'pending',
          vector_indexed_at = NULL,
          vector_index_error = NULL,
          updated_at = ?,
          revision = revision + 1
      WHERE world_book_id = ?
        AND constant = 0
        AND disabled = 0
        AND length(trim(content)) > 0
        AND vectorized = 0`
  ).run(now, worldBookId).changes;

  if (converted > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
    queueWorldBookEntriesForIndexing(userId, worldBookId);
  }

  return {
    summary: getWorldBookVectorSummary(userId, worldBookId)!,
    converted,
  };
}

// --- World Book Entry CRUD ---

const ENTRY_SORT_COLUMNS = {
  order: "order_value",
  priority: "priority",
  created: "created_at",
  updated: "updated_at",
  name: "comment",
} as const;

export type EntrySortKey = keyof typeof ENTRY_SORT_COLUMNS;

/**
 * Build an FTS5 MATCH query for the trigram tokenizer. Embedded double quotes
 * are escaped by doubling per FTS5 syntax. Returns "" when the trimmed input is
 * shorter than the trigram minimum (3 chars) — callers fall back to LIKE.
 */
function sanitizeEntryFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length < 3) return "";
  return trimmed
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Escape SQL LIKE metacharacters so a raw user query is matched literally. */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, "\\$&");
}

export function listEntriesPaginated(
  userId: string,
  worldBookId: string,
  pagination: PaginationParams,
  options?: { sortBy?: EntrySortKey; sortDir?: "asc" | "desc"; search?: string; folder?: string; tags?: string[]; type?: "trigger" | "constant" | "vector" }
): PaginatedResult<WorldBookEntry> {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return { data: [], total: 0, limit: pagination.limit, offset: pagination.offset };

  const sortKey: EntrySortKey = options?.sortBy && options.sortBy in ENTRY_SORT_COLUMNS
    ? options.sortBy
    : "order";
  const column = ENTRY_SORT_COLUMNS[sortKey];
  const direction = options?.sortDir === "desc" ? "DESC" : "ASC";
  const collate = sortKey === "name" ? " COLLATE NOCASE" : "";

  if (!options?.search?.trim() && options?.folder === undefined && !options?.tags?.length && !options?.type) {
    return paginatedQuery(
      `SELECT * FROM world_book_entries WHERE world_book_id = ? ORDER BY ${column}${collate} ${direction}, id ASC`,
      "SELECT COUNT(*) as count FROM world_book_entries WHERE world_book_id = ?",
      [worldBookId], pagination, rowToEntry,
    );
  }
  const rawSearch = options?.search?.trim() ?? "";
  const ftsQuery = sanitizeEntryFtsQuery(rawSearch);
  const db = getDb();
  const conditions = ["e.world_book_id = ?"];
  const params: SQLQueryBindings[] = [worldBookId];
  let fromClause = "world_book_entries e";
  if (rawSearch && ftsQuery) {
    fromClause += " JOIN world_book_entries_fts fts ON fts.rowid = e.rowid";
    conditions.push("world_book_entries_fts MATCH ?");
    params.push(ftsQuery);
  } else if (rawSearch) {
    const like = `%${escapeLike(rawSearch)}%`;
    conditions.push("(e.comment LIKE ? ESCAPE '\\' OR e.content LIKE ? ESCAPE '\\' OR e.key LIKE ? ESCAPE '\\' OR e.keysecondary LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like);
  }
  // Omitted folder means all entries; empty folder means Unfiled.
  if (options?.folder !== undefined) {
    conditions.push("e.folder = ?");
    params.push(normalizeEntryFolder(options.folder));
  }
  for (const tag of normalizeEntryTags(options?.tags)) {
    conditions.push("EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(e.tags) THEN CASE WHEN json_type(e.tags) = 'array' THEN e.tags ELSE '[]' END ELSE '[]' END) t WHERE t.value = ?)");
    params.push(tag);
  }
  if (options?.type === "constant") conditions.push("e.constant = 1");
  if (options?.type === "vector") conditions.push("e.constant = 0 AND e.vectorized = 1");
  if (options?.type === "trigger") conditions.push("e.constant = 0 AND e.vectorized = 0");
  const whereStr = conditions.join(" AND ");

  const countRow = db
    .query(`SELECT COUNT(*) as count FROM ${fromClause} WHERE ${whereStr}`)
    .get(...params) as { count: number } | null;
  const total = countRow?.count ?? 0;

  const rows = db
    .query(
      `SELECT e.* FROM ${fromClause} WHERE ${whereStr} ORDER BY e.${column}${collate} ${direction}, e.id ASC LIMIT ? OFFSET ?`
    )
    .all(...params, pagination.limit, pagination.offset) as any[];

  return {
    data: rows.map(rowToEntry),
    total,
    limit: pagination.limit,
    offset: pagination.offset,
  };
}

export function getEntryOrganizationSummary(userId: string, worldBookId: string): WorldBookEntryOrganizationSummary | null {
  if (!getWorldBook(userId, worldBookId)) return null;
  const db = getDb();
  const counts = db.query("SELECT COUNT(*) AS total, COALESCE(SUM(folder = ''), 0) AS unfiled FROM world_book_entries WHERE world_book_id = ?")
    .get(worldBookId) as { total: number; unfiled: number };
  const folders = db.query("SELECT folder AS name, COUNT(*) AS count FROM world_book_entries WHERE world_book_id = ? AND folder != '' GROUP BY folder ORDER BY folder COLLATE NOCASE, folder")
    .all(worldBookId) as Array<{ name: string; count: number }>;
  const tags = db.query(`SELECT t.value AS name, COUNT(DISTINCT e.id) AS count FROM world_book_entries e,
    json_each(CASE WHEN json_valid(e.tags) THEN CASE WHEN json_type(e.tags) = 'array' THEN e.tags ELSE '[]' END ELSE '[]' END) t
    WHERE e.world_book_id = ? AND t.type = 'text' AND t.value != '' GROUP BY t.value ORDER BY t.value COLLATE NOCASE, t.value`)
    .all(worldBookId) as Array<{ name: string; count: number }>;
  return { ...counts, folders, tags };
}

/** Folder names are grouping values. Every matching entry is changed in one transaction. */
export function operateEntryFolder(
  userId: string, worldBookId: string, input: WorldBookEntryFolderActionInput,
): { affected: number; target_book_id: string } | null {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const queued: string[] = [];
  const result = db.transaction(() => {
    if (!getWorldBook(userId, worldBookId)) return null;
    if (!input || !["rename", "remove", "move"].includes(input.action)) {
      throw new WorldBookEntryOrganizationError("Invalid folder action");
    }
    validateOrganizationInput({ folder: input.folder });
    const sourceFolder = normalizeEntryFolder(input.folder);
    if (!sourceFolder) throw new WorldBookEntryOrganizationError("A named source folder is required");
    if (input.action === "rename" && typeof input.target_folder !== "string") {
      throw new WorldBookEntryOrganizationError("target_folder is required");
    }
    validateOrganizationInput({ folder: input.target_folder });
    const targetFolder = input.action === "remove" ? ""
      : normalizeEntryFolder(input.target_folder ?? sourceFolder);
    if (input.action === "rename" && !targetFolder) {
      throw new WorldBookEntryOrganizationError("Use remove to unfile a folder");
    }
    if (input.action === "move" && (typeof input.target_book_id !== "string" || !input.target_book_id)) {
      throw new WorldBookEntryOrganizationError("target_book_id is required");
    }
    const targetBookId = input.action === "move" ? input.target_book_id! : worldBookId;
    if (!getWorldBook(userId, targetBookId)) {
      throw new WorldBookEntryOrganizationError("Target world book not found", 404);
    }
    if (targetBookId === worldBookId && targetFolder === sourceFolder) {
      return { affected: 0, target_book_id: targetBookId };
    }
    const crossBook = targetBookId !== worldBookId;
    // Only cross-book moves need vector bookkeeping. Avoid fetching lore content for same-book operations.
    const entries = crossBook ? db.query(
      "SELECT id, vectorized, disabled, content FROM world_book_entries WHERE world_book_id = ? AND folder = ?",
    ).all(worldBookId, sourceFolder) as Array<{ id: string; vectorized: number; disabled: number; content: string }> : [];
    // Bun's run().changes includes FTS trigger writes; count source entries directly.
    const { affected } = db.query(
      "SELECT COUNT(*) AS affected FROM world_book_entries WHERE world_book_id = ? AND folder = ?",
    ).get(worldBookId, sourceFolder) as { affected: number };
    db.query(
      "UPDATE world_book_entries SET world_book_id = ?, folder = ?, updated_at = ?, revision = revision + 1 WHERE world_book_id = ? AND folder = ?",
    ).run(targetBookId, targetFolder, now, worldBookId, sourceFolder);
    for (const entry of entries) {
      const state = { vectorized: !!entry.vectorized, disabled: !!entry.disabled, content: entry.content };
      db.query("UPDATE world_book_entries SET vector_index_status = ?, vector_indexed_at = NULL, vector_index_error = NULL WHERE id = ? AND world_book_id = ?")
        .run(desiredWorldBookVectorIndexStatus(state), entry.id, targetBookId);
      if (isWorldBookEntryVectorEligible(state)) queued.push(entry.id);
    }
    if (affected) {
      touchWorldBook(worldBookId, now);
      if (crossBook) touchWorldBook(targetBookId, now);
    }
    return { affected, target_book_id: targetBookId };
  })();
  if (result?.affected) {
    for (const id of queued) vectorizationQueue.queueWorldBookEntryVectorization(userId, id, 4, true);
    emitWorldBookChanged(userId, worldBookId);
    if (result.target_book_id !== worldBookId) emitWorldBookChanged(userId, result.target_book_id);
  }
  return result;
}

export function listEntries(userId: string, worldBookId: string): WorldBookEntry[] {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return [];

  return (getDb().query("SELECT * FROM world_book_entries WHERE world_book_id = ? ORDER BY order_value ASC").all(worldBookId) as any[]).map(rowToEntry);
}

/**
 * Batch-load entries for multiple world books in 2 queries (ownership + entries).
 * Returns a Map from bookId → entries[], preserving per-book grouping. When
 * provided, `bookNameMap` is populated from the ownership query at no extra cost.
 */
export function listEntriesForBooks(
  userId: string,
  bookIds: string[],
  bookNameMap?: Map<string, string>,
): Map<string, WorldBookEntry[]> {
  if (bookIds.length === 0) return new Map();
  const ph = bookIds.map(() => "?").join(", ");
  const owned = getDb()
    .query(`SELECT id, name FROM world_books WHERE id IN (${ph}) AND user_id = ?`)
    .all(...bookIds, userId) as { id: string; name: string }[];
  for (const book of owned) bookNameMap?.set(book.id, book.name);
  const ownedSet = new Set(owned.map(b => b.id));
  const validIds = bookIds.filter(id => ownedSet.has(id));
  if (validIds.length === 0) return new Map();
  const eph = validIds.map(() => "?").join(", ");
  const rows = getDb()
    .query(`SELECT * FROM world_book_entries WHERE world_book_id IN (${eph}) ORDER BY world_book_id, order_value ASC`)
    .all(...validIds) as any[];
  const result = new Map<string, WorldBookEntry[]>();
  for (const id of validIds) result.set(id, []);
  for (const row of rows) {
    result.get(row.world_book_id)?.push(rowToEntry(row));
  }
  return result;
}

export function getEntry(userId: string, id: string): WorldBookEntry | null {
  const row = getDb().query(
    "SELECT e.* FROM world_book_entries e JOIN world_books w ON e.world_book_id = w.id WHERE e.id = ? AND w.user_id = ?"
  ).get(id, userId) as any;
  return row ? rowToEntry(row) : null;
}

export function createEntry(
  userId: string,
  worldBookId: string,
  input: CreateWorldBookEntryInput,
  opts?: { emitEvent?: boolean },
): WorldBookEntry | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;

  validateOrganizationInput(input);
  const id = crypto.randomUUID();
  const uid = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const vectorized = !!input.vectorized;
  const vectorIndexState = getPendingVectorIndexState({
    vectorized,
    disabled: !!input.disabled,
    content: input.content || "",
  });
  const storedExtensions = buildStoredEntryExtensions(
    input.extensions,
    input.outlet_name,
    input.wi_marker,
    input.wi_marker_side,
  );

  getDb()
    .query(
      `INSERT INTO world_book_entries (
        id, world_book_id, uid, key, keysecondary, content, comment,
        position, depth, role, order_value, selective, constant, disabled,
        group_name, group_override, group_weight, probability, scan_depth,
        case_sensitive, match_whole_words, automation_id,
        use_regex, prevent_recursion, exclude_recursion, delay_until_recursion,
        priority, sticky, cooldown, delay, selective_logic, use_probability,
        vectorized, vector_index_status, vector_indexed_at, vector_index_error,
        extensions, created_at, updated_at, folder, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id, worldBookId, uid,
      JSON.stringify(input.key || []),
      JSON.stringify(input.keysecondary || []),
      input.content || "",
      input.comment || "",
      input.position ?? 0,
      input.depth ?? 4,
      input.role || null,
      input.order_value ?? 100,
      input.selective ? 1 : 0,
      input.constant ? 1 : 0,
      input.disabled ? 1 : 0,
      input.group_name || "",
      input.group_override ? 1 : 0,
      input.group_weight ?? 100,
      input.probability ?? 100,
      input.scan_depth ?? null,
      input.case_sensitive ? 1 : 0,
      input.match_whole_words ? 1 : 0,
      input.automation_id || null,
      input.use_regex ? 1 : 0,
      input.prevent_recursion ? 1 : 0,
      input.exclude_recursion ? 1 : 0,
      input.delay_until_recursion ? 1 : 0,
      input.priority ?? 10,
      input.sticky ?? 0,
      input.cooldown ?? 0,
      input.delay ?? 0,
      input.selective_logic ?? 0,
      input.use_probability !== false ? 1 : 0,
      vectorized ? 1 : 0,
      vectorIndexState.vector_index_status,
      vectorIndexState.vector_indexed_at,
      vectorIndexState.vector_index_error,
      storedExtensions,
      now, now, normalizeEntryFolder(input.folder), JSON.stringify(normalizeEntryTags(input.tags))
    );

  touchWorldBook(worldBookId, now);
  const created = getEntry(userId, id)!;
  if (isWorldBookEntryVectorEligible(created)) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, created.id);
  }
  if (opts?.emitEvent !== false) emitWorldBookEntryChanged(userId, id);
  return created;
}

export function updateEntry(
  userId: string,
  id: string,
  input: UpdateWorldBookEntryInput,
  options?: { deferredVectorEffects?: WorldBookEntryVectorEffects },
): WorldBookEntry | null {
  const expectedRevision = readExpectedRevision(input);
  const existing = getEntry(userId, id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: SQLQueryBindings[] = [];
  validateOrganizationInput(input);
  appendOrganizationMutation(input, fields, values);

  const jsonArrayFields = ["key", "keysecondary"] as const;
  for (const f of jsonArrayFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(JSON.stringify(input[f])); }
  }

  const stringFields = ["content", "comment", "role", "group_name", "automation_id"] as const;
  for (const f of stringFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(input[f]); }
  }

  const intFields = ["position", "depth", "order_value", "group_weight", "probability", "scan_depth", "priority", "sticky", "cooldown", "delay", "selective_logic"] as const;
  for (const f of intFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(input[f]); }
  }

  const boolFields = ["selective", "constant", "disabled", "group_override", "case_sensitive", "match_whole_words", "use_regex", "prevent_recursion", "exclude_recursion", "delay_until_recursion", "use_probability", "vectorized"] as const;
  for (const f of boolFields) {
    if (input[f] !== undefined) { fields.push(`${f} = ?`); values.push(input[f] ? 1 : 0); }
  }

  if (
    input.extensions !== undefined
    || input.outlet_name !== undefined
    || input.wi_marker !== undefined
    || input.wi_marker_side !== undefined
  ) {
    fields.push("extensions = ?");
    values.push(buildStoredEntryExtensions(
      input.extensions ?? existing.extensions,
      input.outlet_name !== undefined ? input.outlet_name : existing.outlet_name,
      input.wi_marker !== undefined ? input.wi_marker : existing.wi_marker,
      input.wi_marker_side !== undefined ? input.wi_marker_side : existing.wi_marker_side,
    ));
  }

  if (shouldResetVectorIndex(input)) {
    const vectorIndexState = getPendingVectorIndexState({
      vectorized: input.vectorized ?? existing.vectorized,
      disabled: input.disabled ?? existing.disabled,
      content: input.content ?? existing.content,
    });
    fields.push("vector_index_status = ?");
    values.push(vectorIndexState.vector_index_status);
    fields.push("vector_indexed_at = ?");
    values.push(vectorIndexState.vector_indexed_at);
    fields.push("vector_index_error = ?");
    values.push(vectorIndexState.vector_index_error);
  }

  if (fields.length === 0) {
    assertEntryExpectedRevision(existing, expectedRevision);
    return existing;
  }

  const now = Math.floor(Date.now() / 1000);
  fields.push("updated_at = ?", "revision = revision + 1");
  values.push(now);

  const where = ["id = ?"];
  values.push(id);
  if (expectedRevision !== undefined) {
    where.push("revision = ?");
    values.push(expectedRevision);
  }

  const changes = getDb()
    .query(`UPDATE world_book_entries SET ${fields.join(", ")} WHERE ${where.join(" AND ")}`)
    .run(...values)
    .changes;
  if (changes === 0) {
    const current = getEntry(userId, id);
    if (!current) return null;
    if (expectedRevision !== undefined) {
      throwEntryRevisionConflict(id, expectedRevision, current);
    }
    return null;
  }

  touchWorldBook(existing.world_book_id, now);
  const updated = getEntry(userId, id)!;
  if (isOrganizationOnlyMutation(input)) {
    // Organization edits never enqueue, delete or invalidate vectors, in any index state.
  } else if (options?.deferredVectorEffects) {
    const previousEffect = options.deferredVectorEffects.get(id);
    options.deferredVectorEffects.set(id, {
      previous: previousEffect?.previous ?? existing,
      resetsVectorIndex: !!previousEffect?.resetsVectorIndex || shouldResetVectorIndex(input),
    });
  } else {
    applyWorldBookEntryVectorEffects(userId, existing, updated, shouldResetVectorIndex(input));
  }
  emitWorldBookEntryChanged(userId, id);
  return updated;
}

export async function deleteEntry(
  userId: string,
  id: string,
  expectedRevision?: number,
): Promise<boolean> {
  const parsedExpectedRevision = parseExpectedRevision(
    expectedRevision,
    expectedRevision !== undefined,
  );
  // Verify the entry belongs to a world book owned by this user
  const entry = await getEntryAsync(userId, id);
  if (!entry) return false;
  assertEntryExpectedRevision(entry, parsedExpectedRevision);

  const deleted = await embeddingsSvc.deleteWorldBookEntryEmbeddingsBeforeSourceDelete(
    userId,
    [id],
    async () => {
      const [result] = await executeDatabaseOperation<[{ changes: number }, unknown]>({
        kind: "transaction", statements: [
          { sql: "DELETE FROM world_book_entries WHERE id = ? AND (? IS NULL OR revision = ?) AND world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)", bindings: [id, parsedExpectedRevision ?? null, parsedExpectedRevision ?? null, userId] },
          { sql: "UPDATE world_books SET updated_at = ? WHERE id = ? AND user_id = ? AND changes() > 0", bindings: [Math.floor(Date.now() / 1000), entry.world_book_id, userId] },
        ],
      });
      const removed = result.changes > 0;
      if (!removed) {
        if (parsedExpectedRevision !== undefined) {
          const current = await getEntryAsync(userId, id);
          if (current) {
            throwEntryRevisionConflict(id, parsedExpectedRevision, current);
          }
        }
        return false;
      }
      return true;
    },
  );
  if (deleted) {
    eventBus.emit(EventType.WORLD_BOOK_ENTRY_DELETED, { id, worldBookId: entry.world_book_id }, userId);
  }
  return deleted;
}

export function duplicateEntry(userId: string, entryId: string, input?: DuplicateWorldBookEntryInput): WorldBookEntry | null {
  const existing = getEntry(userId, entryId);
  if (!existing) return null;
  const expectedRevision = input ? readExpectedRevision(input) : undefined;
  assertEntryExpectedRevision(existing, expectedRevision);

  const targetBookId = input?.target_book_id || existing.world_book_id;
  const targetBook = getWorldBook(userId, targetBookId);
  if (!targetBook) return null;

  const duplicatedComment = existing.comment
    ? `${existing.comment} (Copy)`
    : "Copy";

  return createEntry(userId, targetBook.id, {
    folder: existing.folder,
    tags: [...existing.tags],
    outlet_name: existing.outlet_name,
    wi_marker: existing.wi_marker,
    wi_marker_side: existing.wi_marker_side,
    key: [...existing.key],
    keysecondary: [...existing.keysecondary],
    content: existing.content,
    comment: duplicatedComment,
    position: existing.position,
    depth: existing.depth,
    role: existing.role || undefined,
    order_value: existing.order_value,
    selective: existing.selective,
    constant: existing.constant,
    disabled: existing.disabled,
    group_name: existing.group_name,
    group_override: existing.group_override,
    group_weight: existing.group_weight,
    probability: existing.probability,
    scan_depth: existing.scan_depth ?? undefined,
    case_sensitive: existing.case_sensitive,
    match_whole_words: existing.match_whole_words,
    automation_id: existing.automation_id || undefined,
    use_regex: existing.use_regex,
    prevent_recursion: existing.prevent_recursion,
    exclude_recursion: existing.exclude_recursion,
    delay_until_recursion: existing.delay_until_recursion,
    priority: existing.priority,
    sticky: existing.sticky,
    cooldown: existing.cooldown,
    delay: existing.delay,
    selective_logic: existing.selective_logic,
    use_probability: existing.use_probability,
    vectorized: existing.vectorized,
    extensions: cloneEntryExtensions(existing.extensions),
  });
}

export function reorderEntries(
  userId: string,
  worldBookId: string,
  orderedIds: string[],
  expectedRevisions?: Record<string, number>,
): boolean {
  const parsedExpectedRevisions = parseExpectedRevisions(
    expectedRevisions,
    expectedRevisions !== undefined,
  );
  const book = getWorldBook(userId, worldBookId);
  if (!book) return false;
  const uniqueIds = [...new Set(orderedIds)];
  if (uniqueIds.length === 0) return false;

  const entries = listEntries(userId, worldBookId);
  if (uniqueIds.length !== entries.length) return false;
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  if (uniqueIds.some((id) => !entryMap.has(id))) return false;

  for (const entryId of uniqueIds) {
    const entry = entryMap.get(entryId)!;
    assertEntryExpectedRevision(entry, expectedRevisionFor(parsedExpectedRevisions, entryId));
  }

  const currentValues = entries.map((entry) => entry.order_value).sort((a, b) => a - b);
  const strictlyIncreasing = currentValues.every((value, index) => index === 0 || value > currentValues[index - 1]);
  const normalizedValues = strictlyIncreasing
    ? currentValues
    : entries.map((_, index) => index);
  const now = Math.floor(Date.now() / 1000);
  const db = getDb();

  db.transaction(() => {
    const unconditional = db.query(
      "UPDATE world_book_entries SET order_value = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND world_book_id = ?",
    );
    const conditional = db.query(
      "UPDATE world_book_entries SET order_value = ?, updated_at = ?, revision = revision + 1 WHERE id = ? AND world_book_id = ? AND revision = ?",
    );
    uniqueIds.forEach((entryId, index) => {
      const expected = expectedRevisionFor(parsedExpectedRevisions, entryId);
      const changes = expected === undefined
        ? unconditional.run(normalizedValues[index], now, entryId, worldBookId).changes
        : conditional.run(normalizedValues[index], now, entryId, worldBookId, expected).changes;
      if (changes === 0 && expected !== undefined) {
        const current = readEntryById(userId, entryId);
        if (current !== null) {
          throwEntryRevisionConflict(entryId, expected, current);
        }
        throw new Error("One or more entries were not found in this world book");
      }
    });
    touchWorldBook(worldBookId, now);
  })();

  emitWorldBookChanged(userId, worldBookId);
  return true;
}

export async function bulkOperateEntries(
  userId: string,
  worldBookId: string,
  input: WorldBookEntryBulkActionInput,
): Promise<WorldBookEntryBulkActionResult | null> {
  const expectedRevisions = readExpectedRevisions(input);
  const book = await getWorldBookAsync(userId, worldBookId);
  if (!book) return null;

  const uniqueIds = [...new Set(input.entry_ids || [])];
  if (uniqueIds.length === 0) {
    throw new Error("entry_ids is required");
  }

  const entries = await getEntriesForBookAsync(userId, worldBookId, uniqueIds);
  if (entries.length !== uniqueIds.length) {
    throw new Error("One or more entries were not found in this world book");
  }

  const orderedEntries = uniqueIds.map((id) => entries.find((entry) => entry.id === id)!);
  for (const entry of orderedEntries) {
    assertEntryExpectedRevision(entry, expectedRevisionFor(expectedRevisions, entry.id));
  }

  const now = Math.floor(Date.now() / 1000);
  if (input.action === "delete") {
    await embeddingsSvc.deleteWorldBookEntryEmbeddingsBeforeSourceDelete(userId, uniqueIds, async () => {
      try {
        await executeDatabaseOperation({ kind: "transaction", statements: [
          ...uniqueIds.map((entryId) => {
            const expected = expectedRevisionFor(expectedRevisions, entryId);
            return {
              sql: "DELETE FROM world_book_entries WHERE id = ? AND world_book_id = ? AND (? IS NULL OR revision = ?) AND world_book_id IN (SELECT id FROM world_books WHERE user_id = ?)",
              bindings: [entryId, worldBookId, expected ?? null, expected ?? null, userId],
              expectedChanges: expected === undefined ? undefined : 1,
            };
          }),
          { sql: "UPDATE world_books SET updated_at = ? WHERE id = ? AND user_id = ?", bindings: [now, worldBookId, userId] },
        ] });
      } catch (error) {
        const failure = error as DatabaseExecutionError;
        if (failure?.code === "DATABASE_COMPARE_FAILED" && failure.statementIndex !== undefined) {
          const entryId = uniqueIds[failure.statementIndex];
          const expected = expectedRevisionFor(expectedRevisions, entryId);
          const current = await getEntryAsync(userId, entryId);
          if (current && expected !== undefined) throwEntryRevisionConflict(entryId, expected, current);
          throw new Error("One or more entries were not found in this world book");
        }
        throw error;
      }
    });
    await emitWorldBookChangedAsync(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  const db = getDb();

  const runConditionalMutation = (
    entryId: string,
    sql: string,
    params: SQLQueryBindings[],
  ): void => {
    const expected = expectedRevisionFor(expectedRevisions, entryId);
    const where = expected === undefined
      ? "id = ? AND world_book_id = ?"
      : "id = ? AND world_book_id = ? AND revision = ?";
    const values = expected === undefined
      ? [...params, entryId, worldBookId]
      : [...params, entryId, worldBookId, expected];
    const changes = db.query(`${sql} WHERE ${where}`).run(...values).changes;
    if (changes === 0 && expected !== undefined) {
      const current = readEntryById(userId, entryId);
      if (current !== null) {
        throwEntryRevisionConflict(entryId, expected, current);
      }
      throw new Error("One or more entries were not found in this world book");
    }
  };

  if (input.action === "add_tags" || input.action === "remove_tags") {
    validateOrganizationInput({ tags: input.tags });
    const tags = normalizeEntryTags(input.tags);
    if (!tags.length) throw new WorldBookEntryOrganizationError("At least one non-empty tag is required");
    const removing = new Set(tags);
    db.transaction(() => {
      for (const entry of orderedEntries) {
        const next = input.action === "add_tags"
          ? normalizeEntryTags([...entry.tags, ...tags])
          : entry.tags.filter(tag => !removing.has(tag));
        runConditionalMutation(entry.id,
          "UPDATE world_book_entries SET tags = ?, updated_at = ?, revision = revision + 1",
          [JSON.stringify(next), now]);
      }
      touchWorldBook(worldBookId, now);
    })();
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: orderedEntries.length };
  }

  if (input.action === "move") {
    validateOrganizationInput({ folder: input.target_folder });
    const targetBook = getWorldBook(userId, input.target_book_id);
    if (!targetBook) {
      throw new WorldBookEntryOrganizationError("Target world book not found", 404);
    }

    if (targetBook.id === worldBookId) {
      if (input.target_folder === undefined) return { action: input.action, affected: 0, target_book_id: targetBook.id };
      db.transaction(() => {
        for (const entry of orderedEntries) {
          runConditionalMutation(entry.id,
            "UPDATE world_book_entries SET folder = ?, updated_at = ?, revision = revision + 1",
            [normalizeEntryFolder(input.target_folder), now]);
        }
        touchWorldBook(worldBookId, now);
      })();
      emitWorldBookChanged(userId, worldBookId);
      return { action: input.action, affected: orderedEntries.length, target_book_id: targetBook.id };
    }

    db.transaction(() => {
      orderedEntries.forEach((entry) => {
        runConditionalMutation(
          entry.id,
          `UPDATE world_book_entries
           SET world_book_id = ?, folder = ?, updated_at = ?, revision = revision + 1,
               vector_index_status = ?, vector_indexed_at = NULL, vector_index_error = NULL`,
          [targetBook.id, input.target_folder === undefined ? entry.folder : normalizeEntryFolder(input.target_folder), now, desiredWorldBookVectorIndexStatus(entry)],
        );
      });
      touchWorldBook(worldBookId, now);
      touchWorldBook(targetBook.id, now);
    })();

    queueReindexForEntries(userId, orderedEntries);
    emitWorldBookChanged(userId, worldBookId);
    emitWorldBookChanged(userId, targetBook.id);
    return { action: input.action, affected: uniqueIds.length, target_book_id: targetBook.id };
  }

  if (input.action === "renumber") {
    const step = Number.isFinite(input.step) && input.step && input.step > 0 ? Math.trunc(input.step) : 1;
    const direction = input.direction === "desc" ? "desc" : "asc";
    const start = input.start != null ? Math.trunc(input.start) : orderedEntries[0]?.order_value ?? 0;
    db.transaction(() => {
      orderedEntries.forEach((entry, index) => {
        const delta = step * index;
        const nextValue = direction === "desc" ? start - delta : start + delta;
        runConditionalMutation(
          entry.id,
          "UPDATE world_book_entries SET order_value = ?, updated_at = ?, revision = revision + 1",
          [nextValue, now],
        );
      });
      touchWorldBook(worldBookId, now);
    })();
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "add_keyword") {
    const keyword = input.keyword.trim();
    if (!keyword) {
      throw new Error("keyword is required");
    }
    const target = input.target === "secondary" ? "secondary" : "primary";
    db.transaction(() => {
      orderedEntries.forEach((entry) => {
        const nextPrimary = target === "primary"
          ? normalizeKeywordList([...entry.key, keyword])
          : normalizeKeywordList(entry.key);
        const nextSecondary = target === "secondary"
          ? normalizeKeywordList([...entry.keysecondary, keyword])
          : normalizeKeywordList(entry.keysecondary);
        runConditionalMutation(
          entry.id,
          `UPDATE world_book_entries
           SET key = ?, keysecondary = ?, updated_at = ?, revision = revision + 1`,
          [JSON.stringify(nextPrimary), JSON.stringify(nextSecondary), now],
        );
      });
      touchWorldBook(worldBookId, now);
    })();

    const affectedVectorized = orderedEntries.filter((entry) => entry.vectorized);
    setEntriesPendingReindex(affectedVectorized);
    for (const entry of affectedVectorized) {
      deleteWorldBookVectorsAndMaybeRequeue(userId, entry, true);
    }
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "set_position") {
    const position = Number.isFinite(input.position) ? Math.trunc(input.position) : 0;
    if (position < 0 || position > 8) {
      throw new Error("position must be between 0 and 8");
    }
    const depth = position === 4 && Number.isFinite(input.depth) ? Math.trunc(input.depth!) : 4;
    db.transaction(() => {
      orderedEntries.forEach((entry) => {
        runConditionalMutation(
          entry.id,
          "UPDATE world_book_entries SET position = ?, depth = ?, updated_at = ?, revision = revision + 1",
          [position, position === 4 ? depth : entry.depth, now],
        );
      });
      touchWorldBook(worldBookId, now);
    })();
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "set_priority" || input.action === "set_depth" || input.action === "set_enabled") {
    const field = input.action === "set_priority" ? "priority" : input.action === "set_depth" ? "depth" : "disabled";
    const value = input.action === "set_priority"
      ? input.priority
      : input.action === "set_depth"
        ? input.depth
        : (input.enabled ? 0 : 1);
    if (!Number.isSafeInteger(value)) throw new Error(`${field} must be a safe integer`);
    db.transaction(() => {
      orderedEntries.forEach((entry) => {
        runConditionalMutation(
          entry.id,
          `UPDATE world_book_entries SET ${field} = ?, updated_at = ?, revision = revision + 1`,
          [value, now],
        );
      });
      touchWorldBook(worldBookId, now);
    })();
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "set_fields") {
    if (!input.fields || typeof input.fields !== "object" || Array.isArray(input.fields)) {
      throw new Error("fields must be an object");
    }
    const mutations = orderedEntries.map((entry) => ({
      entry,
      ...buildSparseEntryMutation(entry, input.fields),
    }));
    if (mutations.some((mutation) => mutation.fields.length === 0)) {
      throw new Error("fields must contain at least one supported field");
    }
    db.transaction(() => {
      for (const mutation of mutations) {
        runConditionalMutation(
          mutation.entry.id,
          `UPDATE world_book_entries SET ${mutation.fields.join(", ")}, updated_at = ?, revision = revision + 1`,
          [...mutation.values, now],
        );
      }
      touchWorldBook(worldBookId, now);
    })();

    const deferredVectorDeletes: string[] = [];
    for (const mutation of mutations) {
      const updated = getEntry(userId, mutation.entry.id);
      if (!updated) continue;
      if (isOrganizationOnlyMutation(input.fields)) continue;
      applyWorldBookEntryVectorEffects(userId, mutation.entry, updated, mutation.resetsVectorIndex, deferredVectorDeletes);
    }
    deleteWorldBookEntryVectorsGrouped(userId, deferredVectorDeletes);
    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  if (input.action === "copy") {
    const targetBook = getWorldBook(userId, input.target_book_id);
    if (!targetBook) throw new Error("Target world book not found");
    const copied: WorldBookEntry[] = [];
    db.transaction(() => {
      for (const entry of orderedEntries) {
        const next = createEntry(userId, targetBook.id, {
          folder: entry.folder,
          tags: [...entry.tags],
          outlet_name: entry.outlet_name,
          wi_marker: entry.wi_marker,
          wi_marker_side: entry.wi_marker_side,
          key: [...entry.key],
          keysecondary: [...entry.keysecondary],
          content: entry.content,
          comment: entry.comment ? `${entry.comment} (Copy)` : "Copy",
          position: entry.position,
          depth: entry.depth,
          role: entry.role || undefined,
          order_value: entry.order_value,
          selective: entry.selective,
          constant: entry.constant,
          disabled: entry.disabled,
          group_name: entry.group_name,
          group_override: entry.group_override,
          group_weight: entry.group_weight,
          probability: entry.probability,
          scan_depth: entry.scan_depth ?? undefined,
          case_sensitive: entry.case_sensitive,
          match_whole_words: entry.match_whole_words,
          automation_id: entry.automation_id || undefined,
          use_regex: entry.use_regex,
          prevent_recursion: entry.prevent_recursion,
          exclude_recursion: entry.exclude_recursion,
          delay_until_recursion: entry.delay_until_recursion,
          priority: entry.priority,
          sticky: entry.sticky,
          cooldown: entry.cooldown,
          delay: entry.delay,
          selective_logic: entry.selective_logic,
          use_probability: entry.use_probability,
          vectorized: entry.vectorized,
          extensions: cloneEntryExtensions(entry.extensions),
        }, { emitEvent: false });
        if (!next) throw new Error("Unable to copy entry");
        copied.push(next);
      }
    })();
    for (const entry of copied) emitWorldBookEntryChanged(userId, entry.id);
    emitWorldBookChanged(userId, targetBook.id);
    return { action: input.action, affected: copied.length, target_book_id: targetBook.id };
  }

  if (input.action === "set_activation" || input.action === "set_trigger") {
    const activation = input.action === "set_trigger" ? "trigger" : input.activation;
    if (activation !== "trigger" && activation !== "constant" && activation !== "vector") {
      throw new Error("activation must be trigger, constant, or vector");
    }

    const nextConstant = activation === "constant";
    const nextVectorized = activation === "vector";
    const entriesChangingVectorization = orderedEntries.filter((entry) => entry.vectorized !== nextVectorized);

    db.transaction(() => {
      orderedEntries.forEach((entry) => {
        const vectorIndexState = entry.vectorized === nextVectorized
          ? {
              vector_index_status: entry.vector_index_status,
              vector_indexed_at: entry.vector_indexed_at,
              vector_index_error: entry.vector_index_error,
            }
          : getPendingVectorIndexState({
              vectorized: nextVectorized,
              disabled: entry.disabled,
              content: entry.content,
            });
        runConditionalMutation(
          entry.id,
          `UPDATE world_book_entries
           SET constant = ?, vectorized = ?, vector_index_status = ?, vector_indexed_at = ?,
               vector_index_error = ?, updated_at = ?, revision = revision + 1`,
          [
            nextConstant ? 1 : 0,
            nextVectorized ? 1 : 0,
            vectorIndexState.vector_index_status,
            vectorIndexState.vector_indexed_at,
            vectorIndexState.vector_index_error,
            now,
          ],
        );
      });
      touchWorldBook(worldBookId, now);
    })();

    for (const entry of entriesChangingVectorization) {
      const updatedEntry = { ...entry, constant: nextConstant, vectorized: nextVectorized };
      if (nextVectorized && isWorldBookEntryVectorEligible(updatedEntry)) {
        vectorizationQueue.queueWorldBookEntryVectorization(userId, entry.id, 4, true);
      } else if (!nextVectorized) {
        deleteWorldBookVectorsAndMaybeRequeue(userId, updatedEntry, false);
      }
    }

    emitWorldBookChanged(userId, worldBookId);
    return { action: input.action, affected: uniqueIds.length };
  }

  throw new Error("Unsupported bulk action");
}

// --- Import helpers ---

/**
 * Convert SillyTavern numeric role (0=system, 1=user, 2=assistant) or string
 * role to the string format Lumiverse expects. Returns null for unknown/unset.
 */
function normalizeImportRole(role: any): string | null {
  if (role === 0 || role === "system") return "system";
  if (role === 1 || role === "user") return "user";
  if (role === 2 || role === "assistant") return "assistant";
  if (typeof role === "string" && role) return role;
  return null;
}

/**
 * Resolve order_value for an imported entry. Prefers displayIndex (ST's visual
 * ordering set by drag-and-drop), then explicit ordering fields, then the
 * iteration index so entries retain their original source ordering.
 */
function resolveImportOrder(raw: any, index: number): number {
  // displayIndex — SillyTavern's visual ordering (most reliable for user intent)
  if (raw.displayIndex !== undefined && raw.displayIndex !== null) return raw.displayIndex;
  // insertion_order / order_value / order — explicit prompt-injection ordering
  const explicit = raw.insertion_order ?? raw.order_value ?? raw.order;
  if (explicit !== undefined && explicit !== null) return explicit;
  // Last resort: preserve source iteration order
  return index;
}

// --- World Book Import (shared helpers) ---

const IMPORT_DEFAULT_CHUNK_SIZE = 500;

export interface ImportWorldBookOptions {
  signal?: AbortSignal;
  /** Suppress the full-book websocket event for a surrounding bulk workflow. */
  emitEvent?: boolean;
  /** Extra provenance retained on the imported book. */
  metadata?: Record<string, unknown>;
}

export interface ImportResult {
  worldBook: WorldBook;
  entryCount: number;
  aborted?: boolean;
}

interface BulkInsertEntriesResult {
  insertedIds: string[];
  vectorizedIds: string[];
  aborted: boolean;
}

interface BulkInsertEntriesOptions {
  forceVectorizedOff?: boolean;
  signal?: AbortSignal;
  chunkSize?: number;
}

// Inserts pre-normalized entries in chunked transactions with a reused
// prepared statement. A 1k-entry import becomes ~2 fsyncs instead of ~1k.
// Between chunks we check the optional AbortSignal so a client disconnect
// stops further work. world_books.updated_at is touched once at the end.
// Vectorization is NOT queued here — the caller enqueues from the returned IDs.
function bulkInsertEntries(
  worldBookId: string,
  inputs: CreateWorldBookEntryInput[],
  options: BulkInsertEntriesOptions = {},
): BulkInsertEntriesResult {
  const chunkSize = Math.max(1, options.chunkSize ?? IMPORT_DEFAULT_CHUNK_SIZE);
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const insertedIds: string[] = [];
  const vectorizedIds: string[] = [];

  if (inputs.length === 0) {
    return { insertedIds, vectorizedIds, aborted: false };
  }

  const insert = db.query(
    `INSERT INTO world_book_entries (
      id, world_book_id, uid, key, keysecondary, content, comment,
      position, depth, role, order_value, selective, constant, disabled,
      group_name, group_override, group_weight, probability, scan_depth,
      case_sensitive, match_whole_words, automation_id,
      use_regex, prevent_recursion, exclude_recursion, delay_until_recursion,
      priority, sticky, cooldown, delay, selective_logic, use_probability,
      vectorized, vector_index_status, vector_indexed_at, vector_index_error,
      extensions, created_at, updated_at, folder, tags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  let aborted = false;

  for (let start = 0; start < inputs.length; start += chunkSize) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const end = Math.min(start + chunkSize, inputs.length);

    const tx = db.transaction(() => {
      for (let i = start; i < end; i++) {
        const input = inputs[i];
        const id = crypto.randomUUID();
        const uid = crypto.randomUUID();
        const vectorized = options.forceVectorizedOff ? false : !!input.vectorized;
        const vectorIndexState = getPendingVectorIndexState({
          vectorized,
          disabled: !!input.disabled,
          content: input.content || "",
        });
        const extensionsJson = buildStoredEntryExtensions(
          input.extensions,
          input.outlet_name,
          input.wi_marker,
          input.wi_marker_side,
        );

        insert.run(
          id, worldBookId, uid,
          JSON.stringify(input.key || []),
          JSON.stringify(input.keysecondary || []),
          input.content || "",
          input.comment || "",
          input.position ?? 0,
          input.depth ?? 4,
          input.role || null,
          input.order_value ?? 100,
          input.selective ? 1 : 0,
          input.constant ? 1 : 0,
          input.disabled ? 1 : 0,
          input.group_name || "",
          input.group_override ? 1 : 0,
          input.group_weight ?? 100,
          input.probability ?? 100,
          input.scan_depth ?? null,
          input.case_sensitive ? 1 : 0,
          input.match_whole_words ? 1 : 0,
          input.automation_id || null,
          input.use_regex ? 1 : 0,
          input.prevent_recursion ? 1 : 0,
          input.exclude_recursion ? 1 : 0,
          input.delay_until_recursion ? 1 : 0,
          input.priority ?? 10,
          input.sticky ?? 0,
          input.cooldown ?? 0,
          input.delay ?? 0,
          input.selective_logic ?? 0,
          input.use_probability !== false ? 1 : 0,
          vectorized ? 1 : 0,
          vectorIndexState.vector_index_status,
          vectorIndexState.vector_indexed_at,
          vectorIndexState.vector_index_error,
          extensionsJson,
          now, now, normalizeEntryFolder(input.folder), JSON.stringify(normalizeEntryTags(input.tags)),
        );

        insertedIds.push(id);
        if (vectorIndexState.vector_index_status === "pending") vectorizedIds.push(id);
      }
    });
    tx();
  }

  if (insertedIds.length > 0) {
    db.query("UPDATE world_books SET updated_at = ? WHERE id = ?").run(now, worldBookId);
  }

  return { insertedIds, vectorizedIds, aborted };
}

function queueVectorizationsBatch(userId: string, ids: string[]): void {
  for (const id of ids) {
    vectorizationQueue.queueWorldBookEntryVectorization(userId, id);
  }
}

// --- World Book Import (standalone JSON) ---

export function importWorldBook(
  userId: string,
  payload: any,
  options: ImportWorldBookOptions = {},
): ImportResult {
  // Accept imported lorebook format or a plain {entries} object.
  // Imported lorebooks may wrap entries in an object keyed by numeric index,
  // or provide them as an array.
  const bookName = payload.name || payload.originalName || "Imported World Book";
  const description = payload.description || "";

  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { source: "import" },
  });

  const rawEntries = normalizeImportedEntries(payload.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i, { format: payload.type === "lumiverse_world_book" ? "lumiverse" : "standard" }));

  const result = bulkInsertEntries(worldBook.id, inputs, { signal: options.signal });
  queueVectorizationsBatch(userId, result.vectorizedIds);

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// Bulk import variant that forces vectorization off for every entry. Used by
// migration endpoints — users opt in to embeddings per-book afterwards.
export async function importWorldBookBulk(
  userId: string,
  payload: any,
  options: ImportWorldBookOptions = {},
): Promise<ImportResult> {
  const bookName = payload.name || payload.originalName || "Imported World Book";
  const description = payload.description || "";

  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { source: "import", ...options.metadata },
  }, { emitEvent: false });

  const rawEntries = normalizeImportedEntries(payload.entries);
  let entryCount = 0;
  let aborted = false;

  // Normalize and commit in bounded slices. Yielding between each slice lets
  // websocket heartbeats and other requests run even for enormous lorebooks.
  for (let start = 0; start < rawEntries.length; start += IMPORT_DEFAULT_CHUNK_SIZE) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const end = Math.min(start + IMPORT_DEFAULT_CHUNK_SIZE, rawEntries.length);
    const inputs = new Array<CreateWorldBookEntryInput>(end - start);
    for (let index = start; index < end; index++) {
      inputs[index - start] = normalizeImportedEntryInput(rawEntries[index], index, { format: payload.type === "lumiverse_world_book" ? "lumiverse" : "standard" });
    }
    const result = bulkInsertEntries(worldBook.id, inputs, {
      forceVectorizedOff: true,
      signal: options.signal,
      chunkSize: IMPORT_DEFAULT_CHUNK_SIZE,
    });
    entryCount += result.insertedIds.length;
    if (result.aborted) {
      aborted = true;
      break;
    }
    await yieldToEventLoop();
  }

  if (options.emitEvent !== false) emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook: getWorldBook(userId, worldBook.id) ?? worldBook,
    entryCount,
    aborted: aborted || undefined,
  };
}

// --- Character Book Import / Export ---

export function importCharacterBook(
  userId: string,
  characterId: string,
  characterName: string,
  characterBook: any,
  options: { autoManagedByCharacter?: boolean; signal?: AbortSignal } = {},
): ImportResult {
  const bookName = characterBook.name || `${characterName}'s Lorebook`;
  const importedAt = new Date().toLocaleString();
  const description = characterBook.description || `Imported from ${characterName} at ${importedAt}`;
  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: {
      source: "character",
      source_character_id: characterId,
      auto_managed_by_character: options.autoManagedByCharacter === true,
    },
  });

  const rawEntries = normalizeImportedEntries(characterBook?.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i));

  const result = bulkInsertEntries(worldBook.id, inputs, { signal: options.signal });
  queueVectorizationsBatch(userId, result.vectorizedIds);

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// Import a world book from the Lumiverse export format (used in lumiverse_modules.json).
// Entries already use the internal schema, so normalizeImportedEntryInput is a no-op for
// the canonical fields and only kicks in for the legacy aliases it tolerates.
export function importLumiverseWorldBook(
  userId: string,
  characterId: string,
  data: Record<string, any>,
  options: ImportWorldBookOptions = {},
): ImportResult {
  const bookName = data.name || "Imported Lorebook";
  const description = data.description || `Imported from CharX at ${new Date().toLocaleString()}`;
  const worldBook = createWorldBook(userId, {
    name: bookName,
    description,
    metadata: { ...(data.metadata || {}), source: "charx_import", source_character_id: characterId },
  });

  const rawEntries = normalizeImportedEntries(data.entries);
  const inputs = rawEntries.map((raw, i) => normalizeImportedEntryInput(raw, i, { format: "lumiverse" }));

  const result = bulkInsertEntries(worldBook.id, inputs, { signal: options.signal });
  queueVectorizationsBatch(userId, result.vectorizedIds);

  emitWorldBookChanged(userId, worldBook.id);
  return {
    worldBook,
    entryCount: result.insertedIds.length,
    aborted: result.aborted || undefined,
  };
}

// --- World Book Export ---

export type WorldBookExportFormat = "lumiverse" | "character_book" | "sillytavern";

export function exportWorldBook(
  userId: string,
  worldBookId: string,
  format: WorldBookExportFormat = "lumiverse"
): Record<string, any> | null {
  const book = getWorldBook(userId, worldBookId);
  if (!book) return null;
  const entries = listEntries(userId, worldBookId);

  switch (format) {
    case "lumiverse":
      return exportLumiverse(book, entries);
    case "character_book":
      return exportCharacterBookFormat(book, entries);
    case "sillytavern":
      return exportSillyTavern(book, entries);
  }
}

function exportLumiverse(book: WorldBook, entries: WorldBookEntry[]): Record<string, any> {
  return {
    version: 1,
    type: "lumiverse_world_book",
    name: book.name,
    description: book.description,
    metadata: book.metadata,
    entries: entries.map((entry) => {
      const { id, world_book_id, vector_index_status, vector_indexed_at, vector_index_error, created_at, updated_at, ...rest } = entry;
      return rest;
    }),
    exported_at: Math.floor(Date.now() / 1000),
  };
}

function entryToCharacterBookSpec(entry: WorldBookEntry, index: number): Record<string, any> {
  const extensions: Record<string, any> = {
    ...entry.extensions,
    priority: entry.priority,
    sticky: entry.sticky,
    cooldown: entry.cooldown,
    delay: entry.delay,
    selective_logic: entry.selective_logic,
    use_probability: entry.use_probability,
    use_regex: entry.use_regex,
    prevent_recursion: entry.prevent_recursion,
    exclude_recursion: entry.exclude_recursion,
    delay_until_recursion: entry.delay_until_recursion,
    group_override: entry.group_override,
    group_weight: entry.group_weight,
    probability: entry.probability,
    scan_depth: entry.scan_depth,
    automation_id: entry.automation_id,
    vectorized: entry.vectorized,
    uid: entry.uid,
  };
  if (entry.outlet_name) extensions.outlet_name = entry.outlet_name;
  if (entry.wi_marker) extensions.wi_marker = entry.wi_marker;
  if (entry.wi_marker_side) extensions.wi_marker_side = entry.wi_marker_side;

  return {
    id: index,
    keys: entry.key,
    secondary_keys: entry.keysecondary,
    content: entry.content,
    comment: entry.comment,
    enabled: !entry.disabled,
    insertion_order: entry.order_value,
    position: entry.position,
    depth: entry.depth,
    selective: entry.selective,
    constant: entry.constant,
    case_sensitive: entry.case_sensitive,
    match_whole_words: entry.match_whole_words,
    ...(entry.role ? { role: entry.role } : {}),
    ...(entry.group_name ? { group: entry.group_name } : {}),
    extensions,
  };
}

function exportCharacterBookFormat(book: WorldBook, entries: WorldBookEntry[]): Record<string, any> {
  return {
    name: book.name,
    description: book.description,
    entries: entries.map((entry, i) => entryToCharacterBookSpec(entry, i)),
  };
}

function exportSillyTavern(book: WorldBook, entries: WorldBookEntry[]): Record<string, any> {
  return {
    name: book.name,
    description: book.description,
    entries: Object.fromEntries(
      entries.map((entry, i) => [
        String(i),
        {
          // ST renders rows via data.entries[entry.uid]; use matching numeric IDs.
          // Legacy aliases must not mask edited canonical values on reimport.
          ...Object.fromEntries(Object.entries(entry.extensions).filter(([key]) => ![
            "keys", "secondary_keys", "enabled", "disabled", "insertion_order", "order_value",
            "case_sensitive", "match_whole_words", "group_override", "group_weight",
            "scan_depth", "automation_id", "prevent_recursion", "exclude_recursion",
            "delay_until_recursion", "outlet_name", "role", "folder", "tags", "revision",
          ].includes(key))),
          uid: i,
          key: entry.key,
          keysecondary: entry.keysecondary,
          content: entry.content,
          comment: entry.comment,
          disable: entry.disabled,
          order: entry.order_value,
          position: entry.position,
          depth: entry.depth,
          selective: entry.selective,
          constant: entry.constant,
          caseSensitive: entry.case_sensitive,
          matchWholeWords: entry.match_whole_words,
          role: entry.role === "user" ? 1 : entry.role === "assistant" ? 2 : 0,
          group: entry.group_name,
          groupOverride: entry.group_override,
          groupWeight: entry.group_weight,
          probability: entry.probability,
          scanDepth: entry.scan_depth,
          automationId: entry.automation_id ?? "",
          selectiveLogic: entry.selective_logic,
          useProbability: entry.use_probability,
          use_regex: entry.use_regex,
          preventRecursion: entry.prevent_recursion,
          excludeRecursion: entry.exclude_recursion,
          delayUntilRecursion: entry.delay_until_recursion ? 1 : 0,
          priority: entry.priority,
          sticky: entry.sticky,
          cooldown: entry.cooldown,
          delay: entry.delay,
          vectorized: entry.vectorized,
          outletName: entry.outlet_name ?? "",
          ...(entry.wi_marker ? { wi_marker: entry.wi_marker } : {}),
          ...(entry.wi_marker_side ? { wi_marker_side: entry.wi_marker_side } : {}),
          displayIndex: i,
        },
      ])
    ),
  };
}

export async function getEntryAsync(userId: string, id: string): Promise<WorldBookEntry | null> {
  const row = await executeDatabaseOperation<any>({ kind: "read", statement: { sql: "SELECT e.* FROM world_book_entries e JOIN world_books w ON e.world_book_id = w.id WHERE e.id = ? AND w.user_id = ?", bindings: [id, userId], mode: "get" } });
  return row ? rowToEntry(row) : null;
}
async function getWorldBookEntryIdsForDeleteAsync(userId: string, worldBookIds: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < worldBookIds.length; i += 400) {
    const chunk = worldBookIds.slice(i, i + 400);
    const rows = await readDatabaseRows<{ id: string }>(`SELECT e.id FROM world_book_entries e JOIN world_books wb ON wb.id = e.world_book_id WHERE wb.user_id = ? AND e.world_book_id IN (${chunk.map(() => "?").join(",")})`, [userId, ...chunk]);
    ids.push(...rows.map((row) => row.id));
  }
  return ids;
}
async function getEntriesForBookAsync(userId: string, worldBookId: string, entryIds: string[]): Promise<WorldBookEntry[]> {
  const entries: WorldBookEntry[] = [];
  for (let i = 0; i < entryIds.length; i += 400) {
    const chunk = entryIds.slice(i, i + 400);
    const rows = await readDatabaseRows<any>(`SELECT e.* FROM world_book_entries e JOIN world_books w ON e.world_book_id = w.id WHERE w.user_id = ? AND e.world_book_id = ? AND e.id IN (${chunk.map(() => "?").join(",")})`, [userId, worldBookId, ...chunk]);
    entries.push(...rows.map(rowToEntry));
  }
  return entries;
}
async function emitWorldBookChangedAsync(userId: string, id: string): Promise<void> {
  const worldBook = await getWorldBookAsync(userId, id);
  if (worldBook) eventBus.emit(EventType.WORLD_BOOK_CHANGED, { id, worldBook }, userId);
}
