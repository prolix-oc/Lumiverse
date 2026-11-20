#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INTEL_LANCEDB, readIntelLanceDbArtifact } from "./lancedb-macos-native";

if (process.platform !== "darwin" || process.arch !== "x64") throw new Error("Execute this native check with Intel macOS Bun.");
const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--artifact-dir") throw new Error("Usage: check-lancedb-macos.ts --artifact-dir PATH");
const artifact = resolve(args[1]!);
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).dependencies["@lancedb/lancedb"];
readIntelLanceDbArtifact(artifact, version);
process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(artifact, INTEL_LANCEDB.binaryName);
const temporary = mkdtempSync(join(tmpdir(), "lumiverse-intel-lancedb-"));
try {
  const { checkLanceDb } = await import("../src/runtime/lancedb-check");
  await checkLanceDb(temporary);
  console.log("[lancedb-macos] Native writes, vector search, IVF/FTS indexes, and database reopening: OK");
} finally { rmSync(temporary, { recursive: true, force: true }); }
