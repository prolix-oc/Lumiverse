#!/usr/bin/env bun

import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { retryWindowsRename } from "./windows-fs-retry";

export const EXTENSION_IDENTIFIER = "lumiverse_suite";

export const EXPECTED_PERMISSIONS = [
  "generation",
  "chats",
  "characters",
  "app_manipulation",
  "ui_panels",
  "world_books",
] as const;

const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".jj",
]);

type Manifest = {
  identifier?: unknown;
  permissions?: unknown;
  dev_mode?: unknown;
  github?: unknown;
  homepage?: unknown;
};

type RawGeometryRule = {
  identifier: string;
  pattern: RegExp;
};

export const RAW_GEOMETRY_JUSTIFICATION_MARKER = "lumiverse-geometry-justification:";

export const BANNED_RAW_GEOMETRY_IDENTIFIERS = Object.freeze([
  "globalThis.window",
  "globalThis.innerWidth",
  "globalThis.innerHeight",
  "window.innerWidth",
  "window.innerHeight",
  "window.outerWidth",
  "window.outerHeight",
  "innerWidth",
  "innerHeight",
  "outerWidth",
  "outerHeight",
  "clientWidth/clientHeight",
  "offsetWidth/offsetHeight",
  "scrollWidth/scrollHeight",
  "getBoundingClientRect",
  "visualViewport",
  "devicePixelRatio",
  "screen.width/screen.height",
] as const);

const RAW_GEOMETRY_RULES: readonly RawGeometryRule[] = [
  { identifier: "globalThis.window", pattern: /\bglobalThis\s*\.\s*window\b/ },
  { identifier: "globalThis.innerWidth", pattern: /\bglobalThis\s*\.\s*innerWidth\b/ },
  { identifier: "globalThis.innerHeight", pattern: /\bglobalThis\s*\.\s*innerHeight\b/ },
  { identifier: "window.innerWidth", pattern: /\bwindow\s*\.\s*innerWidth\b/ },
  { identifier: "window.innerHeight", pattern: /\bwindow\s*\.\s*innerHeight\b/ },
  { identifier: "window.outerWidth", pattern: /\bwindow\s*\.\s*outerWidth\b/ },
  { identifier: "window.outerHeight", pattern: /\bwindow\s*\.\s*outerHeight\b/ },
  { identifier: "innerWidth", pattern: /\binnerWidth\b/ },
  { identifier: "innerHeight", pattern: /\binnerHeight\b/ },
  { identifier: "outerWidth", pattern: /\bouterWidth\b/ },
  { identifier: "outerHeight", pattern: /\bouterHeight\b/ },
  { identifier: "clientWidth/clientHeight", pattern: /\bclient(?:Width|Height)\b/ },
  { identifier: "offsetWidth/offsetHeight", pattern: /\boffset(?:Width|Height)\b/ },
  { identifier: "scrollWidth/scrollHeight", pattern: /\bscroll(?:Width|Height)\b/ },
  { identifier: "getBoundingClientRect", pattern: /\bgetBoundingClientRect\s*\(/ },
  { identifier: "visualViewport", pattern: /\bvisualViewport\b/ },
  { identifier: "devicePixelRatio", pattern: /\bdevicePixelRatio\b/ },
  { identifier: "screen.width/screen.height", pattern: /\b(?:window\s*\.\s*)?screen\s*\.\s*(?:width|height|availWidth|availHeight)\b/ },
];

const SCRIPT_SOURCE_EXTENSIONS: Record<string, true> = {
  ".cjs": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".ts": true,
  ".tsx": true,
};

type GeometryMaskState = {
  blockComment: boolean;
  quote?: "'" | '"' | "`";
};

function maskGeometryLine(line: string, state: GeometryMaskState): { code: string; comments: string } {
  let code = "";
  let comments = "";
  let index = 0;
  while (index < line.length) {
    if (state.blockComment) {
      const end = line.indexOf("*/", index);
      if (end < 0) {
        comments += line.slice(index);
        break;
      }
      comments += line.slice(index, end);
      state.blockComment = false;
      index = end + 2;
      continue;
    }

    if (state.quote) {
      if (line[index] === "\\") {
        code += "  ";
        index = Math.min(index + 2, line.length);
        continue;
      }
      if (line[index] === state.quote) state.quote = undefined;
      code += " ";
      index += 1;
      continue;
    }

    if (line.startsWith("//", index)) {
      comments += line.slice(index + 2);
      break;
    }
    if (line.startsWith("/*", index)) {
      state.blockComment = true;
      index += 2;
      continue;
    }

    const character = line[index];
    if (character === "'" || character === '"' || character === "`") {
      state.quote = character;
      code += " ";
      index += 1;
      continue;
    }
    code += character;
    index += 1;
  }
  return { code, comments };
}

function explicitGeometryJustification(comments: string): string | undefined {
  const match = comments.match(/(?:^|\s)lumiverse-geometry-justification\s*:\s*([\s\S]+)/i);
  const reason = match?.[1]?.replace(/\*\/\s*$/, "").trim();
  return reason || undefined;
}

function isScriptSourceFile(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  if (!normalized.startsWith("src/")) return false;
  const dot = normalized.lastIndexOf(".");
  return dot >= 0 && SCRIPT_SOURCE_EXTENSIONS[normalized.slice(dot).toLowerCase()] === true;
}

function firstRawGeometryIdentifier(code: string): string | undefined {
  let found: { identifier: string; index: number } | undefined;
  for (const rule of RAW_GEOMETRY_RULES) {
    const match = rule.pattern.exec(code);
    if (!match) continue;
    if (!found || match.index < found.index) found = { identifier: rule.identifier, index: match.index };
  }
  return found?.identifier;
}

export async function scanSuiteSourceGeometry(
  suiteRoot: string,
  files?: readonly string[],
): Promise<void> {
  const sourceFiles = files ?? (await collectSourceFiles(join(suiteRoot, "src"), suiteRoot)).map(file => join("src", file));
  const sourceRoot = resolve(join(suiteRoot, "src"));
  for (const relativePath of sourceFiles) {
    if (!isScriptSourceFile(relativePath)) continue;
    const path = resolve(join(suiteRoot, relativePath));
    if (!isWithin(sourceRoot, path)) {
      throw new Error(`Suite source geometry scan path escapes src: ${describePath(path)}`);
    }
    const source = await Bun.file(path).text();
    const state: GeometryMaskState = { blockComment: false };
    let previousJustification: string | undefined;

    for (const [index, line] of source.split(/\r?\n/).entries()) {
      const masked = maskGeometryLine(line, state);
      const lineJustification = explicitGeometryJustification(masked.comments);
      const identifier = firstRawGeometryIdentifier(masked.code);
      if (identifier && !lineJustification && !previousJustification) {
        throw new Error(
          `Suite source contains banned raw geometry identifier "${identifier}" at ${describePath(path)}:${index + 1}. `
          + `Route geometry through H6 helpers or add an immediate ${RAW_GEOMETRY_JUSTIFICATION_MARKER} <reason> comment.`,
        );
      }

      previousJustification = lineJustification && !identifier ? lineJustification : undefined;
    }
  }
}


export type DeployPaths = {
  projectRoot: string;
  source: string;
  destination: string;
};

export type DeployOptions = Partial<DeployPaths>;

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.includes(`${sep}..${sep}`));
}

function describePath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function statExisting(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function assertOrdinaryPath(path: string, expectedDevice: number, label: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink, junction, or reparse point: ${describePath(path)}`);
  }
  if (status.dev !== expectedDevice) {
    throw new Error(`${label} must not be a mount point: ${describePath(path)}`);
  }
}

async function assertExistingPathComponents(
  projectRoot: string,
  path: string,
  label: string,
): Promise<void> {
  const rootStatus = await lstat(projectRoot);
  if (rootStatus.isSymbolicLink()) {
    throw new Error(`Project root must not be a symlink, junction, or reparse point: ${describePath(projectRoot)}`);
  }

  const canonicalRoot = await realpath(projectRoot);
  if (!isWithin(canonicalRoot, path)) {
    throw new Error(`${label} escapes project root: ${describePath(path)}`);
  }

  const suffix = relative(canonicalRoot, path).split(sep).filter(Boolean);
  let current = canonicalRoot;
  for (const component of suffix) {
    current = join(current, component);
    const status = await statExisting(current);
    if (!status) break;
    await assertOrdinaryPath(current, rootStatus.dev, `${label} path component`);
    if (!status.isDirectory()) {
      throw new Error(`${label} path component must be a directory: ${describePath(current)}`);
    }
    const canonicalCurrent = await realpath(current);
    if (!isWithin(canonicalRoot, canonicalCurrent)) {
      throw new Error(`${label} path component escapes project root: ${describePath(current)}`);
    }
  }
}

async function collectSourceFiles(source: string, sourceParent: string): Promise<string[]> {
  const parentStatus = await lstat(sourceParent);
  await assertOrdinaryPath(source, parentStatus.dev, "Extension source");

  const canonicalSource = await realpath(source);
  const canonicalParent = await realpath(sourceParent);
  if (!isWithin(canonicalParent, canonicalSource)) {
    throw new Error(`Extension source escapes its parent: ${describePath(source)}`);
  }

  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;

      const path = join(directory, entry.name);
      await assertOrdinaryPath(path, parentStatus.dev, "Extension source entry");
      const canonicalPath = await realpath(path);
      if (!isWithin(canonicalSource, canonicalPath)) {
        throw new Error(`Extension source entry escapes source root: ${describePath(path)}`);
      }

      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(source, path));
      } else {
        throw new Error(`Extension source contains an unsupported entry: ${describePath(path)}`);
      }
    }
  };

  await visit(source);
  return files;
}
function validateRequiredHttpsManifestField(manifest: Manifest, field: "github" | "homepage"): void {
  const value = manifest[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`spindle.json ${field} must be a non-empty HTTPS URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`spindle.json ${field} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new Error(`spindle.json ${field} must be a valid HTTPS URL`);
  }
}

export async function validateManifest(manifestPath: string): Promise<void> {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(await Bun.file(manifestPath).text()) as Manifest;
  } catch (error) {
    throw new Error(`Invalid spindle.json at ${describePath(manifestPath)}: ${(error as Error).message}`);
  }

  if (manifest.identifier !== EXTENSION_IDENTIFIER) {
    throw new Error(`spindle.json identifier must be ${EXTENSION_IDENTIFIER}`);
  }
  validateRequiredHttpsManifestField(manifest, "github");
  validateRequiredHttpsManifestField(manifest, "homepage");
  if (manifest.dev_mode !== true) {
    throw new Error('spindle.json must contain the literal JSON boolean "dev_mode": true');
  }
  if (!Array.isArray(manifest.permissions) || manifest.permissions.length !== EXPECTED_PERMISSIONS.length) {
    throw new Error("spindle.json permissions must declare the Lumiverse Suite permission union");
  }

  const actual = new Set(manifest.permissions);
  if (actual.size !== EXPECTED_PERMISSIONS.length || EXPECTED_PERMISSIONS.some((permission) => !actual.has(permission))) {
    throw new Error("spindle.json permissions must declare the Lumiverse Suite permission union");
  }
}

async function validateTree(root: string, parent: string): Promise<string[]> {
  const files = await collectSourceFiles(root, parent);
  await validateManifest(join(root, "spindle.json"));
  await scanSuiteSourceGeometry(root, files);
  return files;
}


async function copyTree(source: string, destination: string, files: readonly string[]): Promise<void> {
  // COPYFILE_EXCL keeps staging isolated from any unexpected pre-existing file.
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    const from = join(source, file);
    const to = join(destination, file);
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to, fsConstants.COPYFILE_EXCL);
  }
}

function defaultPaths(): DeployPaths {
  const projectRoot = resolve(import.meta.dir, "..");
  return {
    projectRoot,
    source: join(projectRoot, "spindle-extensions", EXTENSION_IDENTIFIER),
    destination: join(projectRoot, "data", "extensions", EXTENSION_IDENTIFIER, "repo"),
  };
}

export async function preflightDeployment(options: DeployOptions = {}): Promise<DeployPaths> {
  const defaults = defaultPaths();
  const projectRoot = await realpath(resolve(options.projectRoot ?? defaults.projectRoot));
  const source = resolve(options.source ?? join(projectRoot, "spindle-extensions", EXTENSION_IDENTIFIER));
  const destination = resolve(options.destination ?? join(projectRoot, "data", "extensions", EXTENSION_IDENTIFIER, "repo"));

  const destinationSegments = destination.split(sep).filter(Boolean);
  const expectedDestinationTail = ["extensions", EXTENSION_IDENTIFIER, "repo"];
  const destinationTail = destinationSegments.slice(-expectedDestinationTail.length);
  if (basename(source) !== EXTENSION_IDENTIFIER || destinationTail.some((segment, index) => segment !== expectedDestinationTail[index])) {
    throw new Error("Local deployment supports only lumiverse_suite; expected <extensions>/lumiverse_suite/repo");
  }
  if (!isWithin(projectRoot, source) || !isWithin(projectRoot, destination)) {
    throw new Error("Local deployment paths must remain inside the project root");
  }

  await assertExistingPathComponents(projectRoot, destination, "Destination");
  await assertExistingPathComponents(projectRoot, source, "Extension source");
  await validateTree(source, dirname(source));
  return { projectRoot, source, destination };
}

export async function deployLocalExtensions(options: DeployOptions = {}): Promise<DeployPaths> {
  const paths = await preflightDeployment(options);
  const files = await validateTree(paths.source, dirname(paths.source));
  const destinationParent = dirname(paths.destination);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const stage = join(destinationParent, `.${EXTENSION_IDENTIFIER}.stage-${nonce}`);
  const backup = join(destinationParent, `.${EXTENSION_IDENTIFIER}.backup-${nonce}`);
  let movedExisting = false;

  try {
    await mkdir(destinationParent, { recursive: true });
    await copyTree(paths.source, stage, files);
    await validateTree(stage, destinationParent);

    if (await statExisting(paths.destination)) {
      await retryWindowsRename(() => rename(paths.destination, backup));
      movedExisting = true;
    }
    await retryWindowsRename(() => rename(stage, paths.destination));

    if (movedExisting) await rm(backup, { recursive: true, force: true });
    return paths;
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
    if (movedExisting) {
      const destinationExists = await statExisting(paths.destination);
      if (!destinationExists) {
        await retryWindowsRename(() => rename(backup, paths.destination)).catch((rollbackError) => {
          throw new AggregateError([error, rollbackError], "Deployment failed and rollback failed");
        });
      }
    }
    throw error;
  }
}
export function parseDeployArguments(arguments_: readonly string[]): void {
  if (arguments_.length === 0) return;
  if (arguments_.length === 2 && arguments_[0] === "--only" && arguments_[1] === EXTENSION_IDENTIFIER) return;
  throw new Error(`Only ${EXTENSION_IDENTIFIER} may be deployed; use --only ${EXTENSION_IDENTIFIER} or no arguments`);
}

async function main(): Promise<void> {
  parseDeployArguments(process.argv.slice(2));
  const paths = await deployLocalExtensions();
  console.log(`Deployed ${EXTENSION_IDENTIFIER}: ${describePath(paths.source)} -> ${describePath(paths.destination)}`);
  console.log("Next: rebuild/update the suite, restart Lumiverse to resync its manifest and permissions, then hard refresh the browser.");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
