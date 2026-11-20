#!/usr/bin/env node
/**
 * Measure production frontend ENTRY JS gzip size from a dist/index.html
 * module script. Does not read Vite manifests, does not use *.gz artifacts,
 * and does not run a production build.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const SCHEMA_VERSION = 1;
const METHOD = "node:zlib.gzipSync(Buffer, { level: 9 })";
const METHOD_VERSION = "gzipSync-level-9-v1";
const GROWTH_FAIL_PCT = 5;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const DIRTY_DIST = resolve(REPO_ROOT, "frontend", "dist");

function usage() {
  return `Usage:
  node scripts/perf/measure-frontend-entry-gzip.mjs --baseline <path> --dist <path> [--write-baseline]
  node scripts/perf/measure-frontend-entry-gzip.mjs --baseline <path> [--allow-dirty-dist]

Measures the production entry JS gzip size by parsing dist/index.html
(module script src). Does not read Vite manifests or *.gz artifacts.
Does not run a production build.

Default --dist is <repo>/frontend/dist. That path is refused unless
--allow-dirty-dist is passed (dirty main worktree dist is not evidence).

--write-baseline writes a schemaVersion 1 record to --baseline.
Comparison mode fails if the baseline file is missing or if gzip growth
exceeds ${GROWTH_FAIL_PCT.toFixed(2)}%.`;
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    baseline: null,
    dist: null,
    writeBaseline: false,
    allowDirtyDist: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      out.help = true;
      continue;
    }
    if (arg === "--write-baseline") {
      out.writeBaseline = true;
      continue;
    }
    if (arg === "--allow-dirty-dist") {
      out.allowDirtyDist = true;
      continue;
    }
    if (arg === "--baseline" || arg === "--dist") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        fail(`${arg} requires a path argument.\n\n${usage()}`);
      }
      out[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--baseline=")) {
      out.baseline = arg.slice("--baseline=".length);
      continue;
    }
    if (arg.startsWith("--dist=")) {
      out.dist = arg.slice("--dist=".length);
      continue;
    }
    fail(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  return out;
}

function resolveExistingPath(input, label) {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input);
  if (!existsSync(resolved)) {
    fail(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function samePath(a, b) {
  const left = resolve(a);
  const right = resolve(b);
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function toPosixRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

function findGitRoot(startDir) {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function gitText(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    fail(`git ${args.join(" ")} failed to start in ${cwd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    fail(`git ${args.join(" ")} failed in ${cwd}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function extractModuleScriptSrcs(html) {
  const srcs = [];
  const tagRe = /<script\b([^>]*)>/gi;
  let match;
  while ((match = tagRe.exec(html))) {
    const attrs = match[1];
    if (!/\btype\s*=\s*(["']?)module\1/i.test(attrs)) continue;
    const srcMatch = attrs.match(/\bsrc\s*=\s*(["'])([^"']+)\1/i);
    if (srcMatch) srcs.push(srcMatch[2]);
  }
  return srcs;
}

function pickEntrySrc(srcs) {
  const jsSrcs = srcs.filter((src) => {
    const pathOnly = src.split(/[?#]/, 1)[0];
    return pathOnly.toLowerCase().endsWith(".js") && !pathOnly.toLowerCase().endsWith(".gz");
  });
  if (jsSrcs.length === 0) return null;
  const indexNamed = jsSrcs.find((src) => {
    const base = src.split(/[?#]/, 1)[0].split("/").pop() || "";
    return /^index-[^/]+\.js$/i.test(base);
  });
  return indexNamed || jsSrcs[0];
}

function resolveAssetFromSrc(distDir, src) {
  const pathOnly = src.split(/[?#]/, 1)[0];
  if (!pathOnly) fail(`Entry module script src is empty.`);
  if (/^[a-z]+:\/\//i.test(pathOnly)) {
    fail(`Entry module script src is not a local dist path: ${src}`);
  }
  const stripped = pathOnly.replace(/^\/+/, "");
  const assetPath = resolve(distDir, stripped);
  const rel = toPosixRelative(distDir, assetPath);
  if (rel.startsWith("..") || rel === "") {
    fail(`Entry asset resolves outside --dist: ${src} -> ${assetPath}`);
  }
  if (rel.toLowerCase().endsWith(".gz")) {
    fail(`Refusing to measure a .gz artifact: ${rel}`);
  }
  if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
    fail(`Entry asset is missing: ${assetPath} (from index.html src ${src})`);
  }
  return { assetPath, assetRelativePath: rel };
}

function measureEntry(distDir) {
  const indexPath = join(distDir, "index.html");
  if (!existsSync(indexPath) || !statSync(indexPath).isFile()) {
    fail(`dist index.html is missing: ${indexPath}`);
  }
  const html = readFileSync(indexPath, "utf8");
  const srcs = extractModuleScriptSrcs(html);
  const entrySrc = pickEntrySrc(srcs);
  if (!entrySrc) {
    fail(
      `No <script type="module" src="..."> entry JS found in ${indexPath}. ` +
        `Expected a hashed file such as assets/index-<hash>.js.`,
    );
  }
  const { assetPath, assetRelativePath } = resolveAssetFromSrc(distDir, entrySrc);
  const buf = readFileSync(assetPath);
  const gzipBytes = gzipSync(buf, { level: 9 }).byteLength;
  const assetSha256 = createHash("sha256").update(buf).digest("hex");
  return { assetPath, assetRelativePath, gzipBytes, assetSha256 };
}

function sourceIdentity(distDir) {
  const gitRoot = findGitRoot(distDir) || findGitRoot(REPO_ROOT) || REPO_ROOT;
  const sourceCommit = gitText(gitRoot, ["rev-parse", "HEAD"]);
  const sourceTreeHash = gitText(gitRoot, ["rev-parse", "HEAD^{tree}"]);
  return { sourceCommit, sourceTreeHash, gitRoot };
}

function buildRecord(distDir) {
  const measured = measureEntry(distDir);
  const identity = sourceIdentity(distDir);
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceCommit: identity.sourceCommit,
    sourceTreeHash: identity.sourceTreeHash,
    assetRelativePath: measured.assetRelativePath,
    assetSha256: measured.assetSha256,
    gzipBytes: measured.gzipBytes,
    method: METHOD,
    methodVersion: METHOD_VERSION,
    nodeVersion: process.version,
  };
}

function writeJsonStable(filePath, record) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

function readBaseline(filePath) {
  if (!existsSync(filePath)) {
    fail(
      `Baseline file is missing: ${filePath}\n` +
        `No comparison was performed (no invented delta).\n` +
        `Measure a detached worktree dist, then write a baseline with --write-baseline.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`Baseline file is not valid JSON: ${filePath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Baseline file must be a JSON object: ${filePath}`);
  }
  return parsed;
}

function assertComparableBaseline(baseline, filePath) {
  if (baseline.schemaVersion !== SCHEMA_VERSION) {
    fail(
      `Baseline schemaVersion is ${JSON.stringify(baseline.schemaVersion)}, expected ${SCHEMA_VERSION}: ${filePath}`,
    );
  }
  if (baseline.method !== METHOD || baseline.methodVersion !== METHOD_VERSION) {
    fail(
      `Baseline method mismatch in ${filePath}.\n` +
        `  baseline: ${JSON.stringify(baseline.method)} / ${JSON.stringify(baseline.methodVersion)}\n` +
        `  current:  ${JSON.stringify(METHOD)} / ${JSON.stringify(METHOD_VERSION)}\n` +
        `Refusing to invent a comparable delta.`,
    );
  }
  if (!Number.isFinite(baseline.gzipBytes) || baseline.gzipBytes <= 0) {
    fail(
      `Baseline gzipBytes is unset or invalid in ${filePath}: ${JSON.stringify(baseline.gzipBytes)}\n` +
        `Refusing to invent a passing delta. Write a real baseline from a detached dist.`,
    );
  }
}

function formatPct(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function compareRecords(current, baseline, baselinePath) {
  assertComparableBaseline(baseline, baselinePath);
  const deltaBytes = current.gzipBytes - baseline.gzipBytes;
  const growthPct = (deltaBytes / baseline.gzipBytes) * 100;
  const summary = [
    `entry asset: ${current.assetRelativePath}`,
    `baseline:    ${baseline.gzipBytes} gzip bytes (${baseline.assetRelativePath || "unknown asset"})`,
    `current:     ${current.gzipBytes} gzip bytes`,
    `delta:       ${deltaBytes} bytes (${formatPct(growthPct)})`,
    `threshold:   fail if growth > ${GROWTH_FAIL_PCT.toFixed(2)}%`,
    `commit:      ${current.sourceCommit}`,
    `tree:        ${current.sourceTreeHash}`,
    `sha256:      ${current.assetSha256}`,
    `method:      ${current.methodVersion}`,
  ].join("\n");
  process.stdout.write(`${summary}\n`);
  if (growthPct > GROWTH_FAIL_PCT) {
    fail(
      `FAIL: entry gzip grew ${formatPct(growthPct)} (${deltaBytes} bytes), which exceeds ${GROWTH_FAIL_PCT.toFixed(2)}%.`,
    );
  }
  process.stdout.write(`PASS: entry gzip growth ${formatPct(growthPct)} is within ${GROWTH_FAIL_PCT.toFixed(2)}%.\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (!args.baseline) {
    fail(`--baseline is required.\n\n${usage()}`);
  }

  const distDir = resolveExistingPath(args.dist ?? join(REPO_ROOT, "frontend", "dist"), "--dist");
  if (!statSync(distDir).isDirectory()) {
    fail(`--dist is not a directory: ${distDir}`);
  }
  if (samePath(distDir, DIRTY_DIST) && !args.allowDirtyDist) {
    fail(
      `Refusing to treat the dirty main worktree dist as evidence:\n` +
        `  ${DIRTY_DIST}\n` +
        `Point --dist at a detached worktree build, or pass --allow-dirty-dist if you intentionally want this path.`,
    );
  }

  const baselinePath = isAbsolute(args.baseline)
    ? resolve(args.baseline)
    : resolve(process.cwd(), args.baseline);
  const record = buildRecord(distDir);

  if (args.writeBaseline) {
    writeJsonStable(baselinePath, record);
    process.stdout.write(
      [
        `Wrote baseline: ${baselinePath}`,
        `entry asset:    ${record.assetRelativePath}`,
        `gzipBytes:      ${record.gzipBytes}`,
        `sourceCommit:   ${record.sourceCommit}`,
        `sourceTreeHash: ${record.sourceTreeHash}`,
        `assetSha256:    ${record.assetSha256}`,
        `methodVersion:  ${record.methodVersion}`,
      ].join("\n") + "\n",
    );
    return;
  }

  const baseline = readBaseline(baselinePath);
  compareRecords(record, baseline, baselinePath);
}

main();
