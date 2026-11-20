/** Offline acceptance check, executed from the extracted application with its own temporary DATA_DIR. */
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { checkLanceDb } from "./lancedb-check";
import { closeDatabase, initDatabase } from "../db/connection";
import { runMigrations } from "../db/migrate";
import { startDatabaseExecution, stopDatabaseExecution } from "../db/execution";
import { readDatabaseRow, runDatabaseStatement } from "../db/queries";
import { regexTestSandboxed, shutdownRegexSandbox } from "../utils/regex-sandbox";
import { createRuntimeTransport, type RuntimeTransport } from "../spindle/runtime-transport";
import { resolveFfmpegBinary } from "../services/ffmpeg-binary.service";

const root = resolve(import.meta.dir, "../..");
const dataDir = process.env.DATA_DIR!;
try {
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: "#8866cc" } }).png().toBuffer();
  assert.equal((await sharp(image).metadata()).width, 2);
  console.log("[bundle-check] Sharp and libvips: OK");
  await checkLanceDb(join(dataDir, "lance-check"));
  console.log("[bundle-check] LanceDB writes, vector search, IVF/FTS indexes, and reopening: OK");
  const db = initDatabase();
  await runMigrations(db);
  await startDatabaseExecution();
  await runDatabaseStatement("CREATE TABLE bundle_check (value TEXT NOT NULL)");
  await runDatabaseStatement("INSERT INTO bundle_check VALUES (?)", ["subprocess"]);
  assert.equal((await readDatabaseRow<{ value: string }>("SELECT value FROM bundle_check"))?.value, "subprocess");
  console.log("[bundle-check] Schema and database subprocess: OK");
  assert.equal((await regexTestSandboxed("hello", "i", "Hello Lumiverse", "Hi")).matches, 1);
  console.log("[bundle-check] Regex worker: OK");
  assert.match(await Bun.file(join(root, "frontend/dist/index.html")).text(), /<html/i);
  assert.ok((await Array.fromAsync(new Bun.Glob("**/*.md").scan(join(root, "user-docs/docs")))).length > 0);
  console.log("[bundle-check] Frontend and documentation: OK");
  const bun = Bun.spawn(["bun", "--version"], { stdout: "pipe", stderr: "pipe" });
  assert.equal((await new Response(bun.stdout).text()).trim(), Bun.version);
  assert.equal(await bun.exited, 0);
  console.log("[bundle-check] Embedded Bun CLI: OK");
  assert.equal(process.env.BUN_BE_BUN, undefined);
  const source = join(dataDir, "extension.ts");
  const built = join(dataDir, "extension.js");
  await Bun.write(source, "export default (ctx: any) => { ctx.ready(); ctx.send({ answer: 42 }); ctx.complete(); };\n");
  const build = Bun.spawn(["bun", "build", source, "--target=bun", "--outfile", built], { stdout: "inherit", stderr: "inherit" });
  assert.equal(await build.exited, 0);
  let transport: RuntimeTransport | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolveCheck, reject) => {
      let answer: unknown;
      const observed: string[] = [];
      timer = setTimeout(() => reject(new Error(`Extension subprocess did not complete; received: ${observed.join(", ") || "no messages"}`)), 10_000);
      transport = createRuntimeTransport({
        runtimePath: join(root, "src/spindle/backend-process-runtime.ts"), mode: "process",
        extensionIdentifier: "bundle-check", repoPath: dataDir, storagePath: dataDir,
        onMessage(message) {
          const event = message as { type: string; payload?: { answer: number }; error?: string };
          observed.push(event.type);
          if (event.type === "message") answer = event.payload?.answer;
          if (event.type === "fail") reject(new Error(event.error));
          if (event.type === "complete") { try { assert.equal(answer, 42); resolveCheck(); } catch (error) { reject(error); } }
        },
        onError: (message) => reject(new Error(message)),
        onExit: (exitCode) => { if (!observed.includes("complete")) reject(new Error(`Extension exited ${exitCode}; received: ${observed.join(", ") || "no messages"}`)); },
      });
      transport.postMessage({ type: "init", process: { processId: "check", entry: "check", entryPath: built, kind: "check" } });
    });
  } finally { if (timer) clearTimeout(timer); transport?.terminate(true); }
  console.log("[bundle-check] Extension build and subprocess: OK");
  const ffmpeg = await resolveFfmpegBinary();
  if (process.env.LUMIVERSE_BUNDLE_FFMPEG === "1") assert.ok(ffmpeg, "Bundled FFmpeg must be executable");
  console.log(`[bundle-check] FFmpeg: ${ffmpeg ? "OK" : "optional binary unavailable on this target"}`);
  console.log("[bundle-check] All checks passed.");
} finally {
  shutdownRegexSandbox();
  await stopDatabaseExecution();
  closeDatabase();
}
