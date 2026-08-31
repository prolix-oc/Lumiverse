/** Compare JSON-compatible values structurally. Object insertion order is not authority. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}

/** Serialize JSON-compatible values with stable object-key ordering. */
export function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map((item) => item === undefined ? "null" : canonicalJsonValue(item)).join(",") + "]";
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJsonValue(record[key]));
    return "{" + entries.join(",") + "}";
  }
  return JSON.stringify(value) ?? "null";
}
