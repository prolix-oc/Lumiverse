/**
 * Bounded canonical encoding for data crossing the strict preprocessing
 * boundary. This module has no service, database, provider, or callback
 * dependencies and is safe to import from an isolate entrypoint.
 */
import { compareUtf8 } from "./utf8-order";

const UTF8_ENCODER = new TextEncoder();

/** Immutable structural caps shared by snapshot production and verification. */
/**
 * `maxDepth` is a value-frame depth: the canonical root is depth `0`, and
 * every child value (including scalar leaves) is one level deeper than its
 * parent. Property names are counted as nodes, but do not add depth. The
 * encoder and bounds helper enforce this same convention iteratively.
 */
export const CANONICAL_SNAPSHOT_DATA_LIMITS_V1 = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
} as const);

export const SNAPSHOT_DATA_MAX_DEPTH_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxDepth;
export const SNAPSHOT_DATA_MAX_NODES_V1 = CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxNodes;

export type CanonicalDataFailureCode = "invalid_input" | "limit_exceeded";
export type CanonicalDataLimitDimension = "depth" | "nodes" | "bytes";

export class CanonicalDataError extends Error {
  readonly code: CanonicalDataFailureCode;
  readonly dimension: CanonicalDataLimitDimension | null;
  readonly limit: number | null;
  readonly observed: number | null;

  constructor(
    code: CanonicalDataFailureCode,
    message: string,
    dimension: CanonicalDataLimitDimension | null = null,
    limit: number | null = null,
    observed: number | null = null,
  ) {
    super(message);
    this.name = "CanonicalDataError";
    this.code = code;
    this.dimension = dimension;
    this.limit = limit;
    this.observed = observed;
  }
}

export interface CanonicalDataOptions {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
}

export interface CanonicalDataBounds {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
}

interface ValueFrame {
  readonly kind: "value";
  readonly value: unknown;
  readonly depth: number;
}
interface LiteralFrame {
  readonly kind: "literal";
  readonly text: string;
}
interface ExitFrame {
  readonly kind: "exit";
  readonly value: object;
}
type Frame = ValueFrame | LiteralFrame | ExitFrame;

function failure(
  code: CanonicalDataFailureCode,
  message: string,
  dimension: CanonicalDataLimitDimension | null = null,
  limit: number | null = null,
  observed: number | null = null,
): never {
  throw new CanonicalDataError(code, message, dimension, limit, observed);
}

function bytes(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}
function compareCanonicalKey(left: string, right: string): number {
  const utf8Order = compareUtf8(left, right);
  if (utf8Order !== 0 || left === right) return utf8Order;

  // TextEncoder replaces lone UTF-16 surrogates with U+FFFD. Compare the
  // escaped JSON code units to keep those keys distinct and insertion-order
  // independent without changing normal UTF-8 ordering.
  const leftEscaped = JSON.stringify(left);
  const rightEscaped = JSON.stringify(right);
  return leftEscaped < rightEscaped ? -1 : 1;
}

function primitive(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) failure("invalid_input", "Canonical data contains a non-finite number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      failure("invalid_input", "Canonical data contains an unsafe integer");
    }
    return JSON.stringify(value);
  }
  failure("invalid_input", "Canonical data contains a non-JSON primitive");
}

function isArrayIndex(key: string, length: number): boolean {
  if (key === "0") return length > 0;
  if (!/^[1-9][0-9]*$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

interface PlainObjectShape {
  readonly array: boolean;
  readonly keys: readonly string[];
  readonly values: readonly unknown[];
}

function ownDataDescriptor(value: object, key: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    failure("invalid_input", "Canonical data object cannot be inspected");
  }
}

function assignDataProperty(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    failure("invalid_input", "Canonical data clone cannot be populated");
  }
}

function inspectObject(
  value: object,
  budget?: { readonly nodes: number; readonly maxNodes: number },
): PlainObjectShape {
  let prototype: object | null;
  let ownKeys: readonly (string | symbol)[];
  try {
    prototype = Object.getPrototypeOf(value);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    failure("invalid_input", "Canonical data object cannot be inspected");
  }

  const remaining = budget === undefined
    ? Number.MAX_SAFE_INTEGER
    : budget.maxNodes - budget.nodes;
  if (remaining < 0 || (budget !== undefined && ownKeys.length > remaining)) {
    const observed = (budget?.nodes ?? 0) + ownKeys.length;
    failure(
      "limit_exceeded",
      "Canonical data exceeds the node limit",
      "nodes",
      budget?.maxNodes ?? ownKeys.length,
      observed,
    );
  }

  const array = Array.isArray(value);
  if (array) {
    if (prototype !== Array.prototype) failure("invalid_input", "Canonical data array has an invalid prototype");
    const lengthDescriptor = ownDataDescriptor(value, "length");
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || !Number.isSafeInteger(lengthDescriptor.value)) {
      failure("invalid_input", "Canonical data array has an invalid length");
    }
    const length = lengthDescriptor.value as number;
    if (length > remaining) {
      failure(
        "limit_exceeded",
        "Canonical data exceeds the node limit",
        "nodes",
        budget?.maxNodes ?? length,
        (budget?.nodes ?? 0) + length,
      );
    }
    const keys: string[] = [];
    for (const key of ownKeys) {
      if (typeof key !== "string") failure("invalid_input", "Canonical data array contains a symbol key");
      if (key === "length") continue;
      if (!isArrayIndex(key, length)) failure("invalid_input", "Canonical data array contains a non-index key");
      keys.push(key);
    }
    keys.sort((left, right) => Number(left) - Number(right));
    if (keys.length !== length || keys.some((key, index) => Number(key) !== index)) {
      failure("invalid_input", "Canonical data array must not contain holes");
    }
    const values: unknown[] = [];
    for (const key of keys) {
      const descriptor = ownDataDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
        failure("invalid_input", "Canonical data array contains an accessor or non-enumerable value");
      }
      values.push(descriptor.value);
    }
    return { array: true, keys, values };
  }

  if (prototype !== Object.prototype && prototype !== null) {
    failure("invalid_input", "Canonical data object has an invalid prototype");
  }
  const entries: Array<{ key: string; value: unknown }> = [];
  for (const key of ownKeys) {
    if (typeof key !== "string") failure("invalid_input", "Canonical data object contains a symbol key");
    const descriptor = ownDataDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) {
      failure("invalid_input", "Canonical data object contains an accessor or non-enumerable value");
    }
    // Preserve the historical canonical representation: undefined object
    // fields are omitted, while undefined array elements become null.
    if (descriptor.value !== undefined) entries.push({ key, value: descriptor.value });
  }
  entries.sort((left, right) => compareCanonicalKey(left.key, right.key));
  return { array: false, keys: entries.map((entry) => entry.key), values: entries.map((entry) => entry.value) };
}

function limits(options: CanonicalDataOptions): { maxDepth: number; maxNodes: number; maxBytes: number } {
  const maxDepth = options.maxDepth ?? CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxDepth;
  const maxNodes = options.maxNodes ?? CANONICAL_SNAPSHOT_DATA_LIMITS_V1.maxNodes;
  const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) failure("invalid_input", "Canonical data depth limit is invalid");
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) failure("invalid_input", "Canonical data node limit is invalid");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) failure("invalid_input", "Canonical data byte limit is invalid");
  return { maxDepth, maxNodes, maxBytes };
}

interface WalkBound {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

/**
 * Shared iterative walk. Occurrence counting (not unique-object counting) is
 * intentional: a diamond DAG expands the same way JSON would, and the node/byte
 * caps are what make that expansion fail closed instead of hanging.
 */
function walkCanonicalPlainData(
  value: unknown,
  bound: WalkBound,
  keepEncoded: boolean,
): { readonly bytes: number; readonly depth: number; readonly nodes: number; readonly encoded: string } {
  const frames: Frame[] = [{ kind: "value", value, depth: 0 }];
  const active = new WeakSet<object>();
  const output: string[] = [];
  let outputBytes = 0;
  let nodes = 0;
  let depth = 0;

  const append = (text: string): void => {
    outputBytes += bytes(text);
    if (outputBytes > bound.maxBytes) {
      failure("limit_exceeded", "Canonical data exceeds the byte limit", "bytes", bound.maxBytes, outputBytes);
    }
    if (keepEncoded) output.push(text);
  };
  const countNode = (nodeDepth: number): void => {
    nodes += 1;
    depth = Math.max(depth, nodeDepth);
    if (nodes > bound.maxNodes) {
      failure("limit_exceeded", "Canonical data exceeds the node limit", "nodes", bound.maxNodes, nodes);
    }
    if (nodeDepth > bound.maxDepth) {
      failure("limit_exceeded", "Canonical data exceeds the depth limit", "depth", bound.maxDepth, nodeDepth);
    }
  };

  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.kind === "literal") {
      append(frame.text);
      continue;
    }
    if (frame.kind === "exit") {
      active.delete(frame.value);
      append(Array.isArray(frame.value) ? "]" : "}");
      continue;
    }

    countNode(frame.depth);
    const item = frame.value;
    if (item === null || typeof item !== "object") {
      if (typeof item === "string") {
        const raw = bytes(item);
        if (outputBytes + raw > bound.maxBytes) {
          failure(
            "limit_exceeded",
            "Canonical data exceeds the byte limit",
            "bytes",
            bound.maxBytes,
            outputBytes + raw,
          );
        }
      }
      append(primitive(item));
      continue;
    }
    if (active.has(item)) failure("invalid_input", "Canonical data contains a cycle");
    active.add(item);

    const shape = inspectObject(item, { nodes, maxNodes: bound.maxNodes });
    append(shape.array ? "[" : "{");
    frames.push({ kind: "exit", value: item });
    for (let index = shape.values.length - 1; index >= 0; index -= 1) {
      // Property names/indexes are data nodes as well as the value below
      // them. Count both before pushing the value frame so cap+1 is rejected
      // before that child is inspected.
      countNode(frame.depth);
      if (index < shape.values.length - 1) frames.push({ kind: "literal", text: "," });
      frames.push({ kind: "value", value: shape.values[index], depth: frame.depth + 1 });
      if (!shape.array) frames.push({ kind: "literal", text: `${JSON.stringify(shape.keys[index])}:` });
    }
  }

  return { bytes: outputBytes, depth, nodes, encoded: keepEncoded ? output.join("") : "" };
}

/**
 * Encode closed plain data without recursive calls. Every value and property
 * key is visited iteratively, and depth, node, and UTF-8 output budgets are
 * checked before the next frame is expanded or appended.
 */
export function encodeCanonicalPlainData(value: unknown, options: CanonicalDataOptions = {}): string {
  return walkCanonicalPlainData(value, limits(options), true).encoded;
}

export function canonicalPlainDataBounds(value: unknown, options: CanonicalDataOptions = {}): CanonicalDataBounds {
  const measured = walkCanonicalPlainData(value, limits(options), false);
  return { bytes: measured.bytes, depth: measured.depth, nodes: measured.nodes };
}

export function validateCanonicalPlainData(value: unknown, options: CanonicalDataOptions = {}): void {
  walkCanonicalPlainData(value, limits(options), false);
}

export function isCanonicalPlainData(value: unknown, options: CanonicalDataOptions = {}): boolean {
  try {
    validateCanonicalPlainData(value, options);
    return true;
  } catch (error) {
    if (error instanceof CanonicalDataError && error.code === "limit_exceeded") throw error;
    return false;
  }
}

/** Iterative clone used when a closed value must be detached from its source. */
export function cloneCanonicalPlainData<T>(value: T, options: CanonicalDataOptions = {}): T {
  const bound = limits(options);
  // Measure first so a diamond DAG cannot expand past maxNodes/maxBytes. The
  // clone walk below is unique-object and also abortable: a second inspect
  // that materializes new identities (proxy/getter) cannot run unbounded.
  walkCanonicalPlainData(value, bound, false);
  if (!value || typeof value !== "object") return value;
  const root = Array.isArray(value) ? [] as unknown[] : {} as Record<string, unknown>;
  const targets = new WeakMap<object, object>();
  targets.set(value as object, root);
  const stack: Array<{ source: object; target: object }> = [{ source: value as object, target: root }];
  let nodes = 0;
  let outputBytes = 0;
  while (stack.length > 0) {
    const { source, target } = stack.pop()!;
    nodes += 1;
    if (nodes > bound.maxNodes) {
      failure("limit_exceeded", "Canonical data exceeds the node limit", "nodes", bound.maxNodes, nodes);
    }
    const shape = inspectObject(source, { nodes, maxNodes: bound.maxNodes });
    for (let index = 0; index < shape.values.length; index += 1) {
      nodes += 1;
      if (nodes > bound.maxNodes) {
        failure("limit_exceeded", "Canonical data exceeds the node limit", "nodes", bound.maxNodes, nodes);
      }
      const child = shape.values[index];
      const key = shape.keys[index]!;
      if (!shape.array) {
        outputBytes += bytes(JSON.stringify(key));
        if (outputBytes > bound.maxBytes) {
          failure("limit_exceeded", "Canonical data exceeds the byte limit", "bytes", bound.maxBytes, outputBytes);
        }
      }
      if (child && typeof child === "object") {
        let childTarget = targets.get(child);
        if (!childTarget) {
          childTarget = Array.isArray(child) ? [] as unknown[] : {} as Record<string, unknown>;
          targets.set(child, childTarget);
          stack.push({ source: child, target: childTarget });
        }
        assignDataProperty(target, key, childTarget);
      } else {
        if (typeof child === "string") {
          const raw = bytes(child);
          if (outputBytes + raw > bound.maxBytes) {
            failure(
              "limit_exceeded",
              "Canonical data exceeds the byte limit",
              "bytes",
              bound.maxBytes,
              outputBytes + raw,
            );
          }
          outputBytes += raw;
        }
        assignDataProperty(target, key, child);
      }
    }
  }
  return root as T;
}

/** Validate, then freeze every object iteratively (never recurse on input). */
export function freezeCanonicalPlainData<T>(value: T, options: CanonicalDataOptions = {}): T {
  const bound = limits(options);
  validateCanonicalPlainData(value, options);
  if (!value || typeof value !== "object") return value;
  const stack: object[] = [value as object];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    nodes += 1;
    if (nodes > bound.maxNodes) {
      failure("limit_exceeded", "Canonical data exceeds the node limit", "nodes", bound.maxNodes, nodes);
    }
    const shape = inspectObject(current, { nodes, maxNodes: bound.maxNodes });
    for (const child of shape.values) if (child && typeof child === "object") stack.push(child);
    Object.freeze(current);
  }
  return value;
}
