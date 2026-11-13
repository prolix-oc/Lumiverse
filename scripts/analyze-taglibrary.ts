import { basename } from "path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function describeType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: JsonValue): value is Record<string, JsonValue> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function truncate(value: string, max = 120): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function sampleObjectKeys(value: JsonValue): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).slice(0, 12);
}

function collectFilenameLikeStrings(
  value: JsonValue,
  path: string,
  hits: Array<{ path: string; value: string }>,
  maxHits: number,
): void {
  if (hits.length >= maxHits) return;
  if (typeof value === "string") {
    if (/[\\/]|\.(png|jpe?g|webp|gif|bmp|json)$/i.test(value)) {
      hits.push({ path, value });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length && hits.length < maxHits; i++) {
      collectFilenameLikeStrings(value[i], `${path}[${i}]`, hits, maxHits);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (hits.length >= maxHits) break;
      collectFilenameLikeStrings(child, path ? `${path}.${key}` : key, hits, maxHits);
    }
  }
}

function summarizeArray(name: string, value: JsonValue[]): void {
  const typeCounts = new Map<string, number>();
  for (const entry of value.slice(0, 50)) {
    const type = describeType(entry);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }

  console.log(`\n[${name}] array length: ${value.length}`);
  console.log(`sample element types: ${[...typeCounts.entries()].map(([type, count]) => `${type}:${count}`).join(", ") || "(empty)"}`);

  const firstObject = value.find(isPlainObject);
  if (firstObject) {
    console.log(`sample object keys: ${sampleObjectKeys(firstObject).join(", ")}`);
  }
}

function summarizeRecord(name: string, value: Record<string, JsonValue>): void {
  const entries = Object.entries(value);
  console.log(`\n[${name}] object entry count: ${entries.length}`);
  console.log(`sample keys: ${entries.slice(0, 10).map(([key]) => key).join(", ")}`);

  const sampleValues = entries.slice(0, 10).map(([, v]) => describeType(v));
  console.log(`sample value types: ${sampleValues.join(", ")}`);

  const firstObjectValue = entries.map(([, v]) => v).find(isPlainObject);
  if (firstObjectValue) {
    console.log(`sample nested keys: ${sampleObjectKeys(firstObjectValue).join(", ")}`);
  }
}

function summarizeTagLibraryBackup(data: JsonValue): void {
  if (!isPlainObject(data)) return;
  if (!Array.isArray(data.tags) || !isPlainObject(data.tag_map)) return;

  const tags = data.tags.filter(isPlainObject);
  const tagMap = data.tag_map;
  const idToName = new Map<string, string>();

  for (const tag of tags) {
    const id = tag.id;
    const name = tag.name;
    if ((typeof id === "string" || typeof id === "number") && typeof name === "string") {
      idToName.set(String(id), name);
    }
  }

  let totalAssignments = 0;
  let mappedCharacters = 0;
  let emptyMappings = 0;
  const unmatchedTagIds = new Set<string>();
  const samples: Array<{ filename: string; tagIds: string[]; tagNames: string[] }> = [];

  for (const [filename, rawIds] of Object.entries(tagMap)) {
    if (!Array.isArray(rawIds)) continue;
    const tagIds = rawIds
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map((value) => String(value));

    if (tagIds.length === 0) {
      emptyMappings++;
      continue;
    }

    mappedCharacters++;
    totalAssignments += tagIds.length;
    const tagNames = tagIds.map((id) => {
      const name = idToName.get(id);
      if (!name) unmatchedTagIds.add(id);
      return name ?? `(missing:${id})`;
    });

    if (samples.length < 8) {
      samples.push({ filename, tagIds, tagNames });
    }
  }

  console.log("\nTagLibrary summary:");
  console.log(`- tag definitions: ${tags.length}`);
  console.log(`- character mappings: ${mappedCharacters}`);
  console.log(`- empty mappings: ${emptyMappings}`);
  console.log(`- total tag assignments: ${totalAssignments}`);
  console.log(`- average tags per mapped character: ${mappedCharacters > 0 ? (totalAssignments / mappedCharacters).toFixed(2) : "0.00"}`);
  console.log(`- unresolved tag ids: ${unmatchedTagIds.size}`);

  if (samples.length > 0) {
    console.log("Resolved samples:");
    for (const sample of samples) {
      console.log(`- ${sample.filename}`);
      console.log(`  ids: ${sample.tagIds.join(", ")}`);
      console.log(`  names: ${sample.tagNames.join(", ")}`);
    }
  }
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: bun run scripts/analyze-taglibrary.ts /path/to/tags.json");
    process.exit(1);
  }

  const file = Bun.file(filePath);
  const sizeBytes = file.size;
  const data = JSON.parse(await file.text()) as JsonValue;

  console.log(`File: ${basename(filePath)}`);
  console.log(`Size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`Top-level type: ${describeType(data)}`);

  if (Array.isArray(data)) {
    summarizeArray("root", data);
  } else if (isPlainObject(data)) {
    const keys = Object.keys(data);
    console.log(`Top-level keys (${keys.length}): ${keys.join(", ")}`);
    for (const key of keys) {
      const value = data[key];
      const type = describeType(value);
      console.log(`- ${key}: ${type}`);
      if (Array.isArray(value)) summarizeArray(key, value);
      else if (isPlainObject(value)) summarizeRecord(key, value);
      else if (typeof value === "string") console.log(`  sample: ${truncate(value)}`);
      else console.log(`  value: ${String(value)}`);
    }
  }

  const filenameHits: Array<{ path: string; value: string }> = [];
  collectFilenameLikeStrings(data, "", filenameHits, 24);
  if (filenameHits.length > 0) {
    console.log("\nFilename-like strings (sample):");
    for (const hit of filenameHits) {
      console.log(`- ${hit.path}: ${truncate(hit.value)}`);
    }
  }

  summarizeTagLibraryBackup(data);
}

await main();
