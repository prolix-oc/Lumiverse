#!/usr/bin/env bun
/** Submit a CharacterLibrary full bundle to a running Lumiverse instance. */
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { printBanner, printSummary } from "./ui";
import type { ClMigrationJob, ClMigrationPreview } from "../src/migration/cl-types";

const HELP = `CharacterLibrary → Lumiverse migration

  bun run migrate:cl
  bun run migrate:cl --bundle ./cl-bundle.zip --url http://localhost:7860
  LUMIVERSE_MIGRATION_COOKIE='your session cookie' bun run migrate:cl --bundle ./cl-bundle.zip --yes
  bun run migrate:cl --resume JOB_ID

Options:
  --bundle PATH       CharacterLibrary Full bundle (.zip), including linked lorebooks
  --url URL           Lumiverse URL (default http://localhost:7860)
  --username NAME     Account name/email; password is prompted privately
  --source-id ID      Stable source namespace (default: this exact archive's SHA-256)
  --resume JOB_ID     Resume/poll an already uploaded migration
  --dry-run           Upload, validate, and show inventory; import no characters, then discard staging
  --yes               Start without the interactive review prompt
  --enable-regex      Enable newly imported supported regex unless its source disabled it
  --report PATH       Write the complete JSON result
  --help              Show this help

Authentication can also use LUMIVERSE_MIGRATION_COOKIE (Cookie header value).
Bundle v1 has no expression or external-script inventory. Its raw ZIP is retained
by the server after execution; the report lists compatibility and missing-data issues.
`;

type Options = { bundle?: string; url: string; username?: string; sourceId?: string; resume?: string; report?: string; dryRun: boolean; yes: boolean; enableRegex: boolean; help: boolean };
export function parseOptions(args: string[]): Options {
  const options: Options = { url: "http://localhost:7860", dryRun: false, yes: false, enableRegex: false, help: false };
  const values: Record<string, keyof Options> = { "--bundle": "bundle", "--url": "url", "--username": "username", "--source-id": "sourceId", "--resume": "resume", "--report": "report" };
  const flags: Record<string, keyof Options> = { "--dry-run": "dryRun", "--yes": "yes", "--enable-regex": "enableRegex", "--help": "help", "-h": "help" };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (flags[arg]) (options as any)[flags[arg]!] = true;
    else if (values[arg]) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      (options as any)[values[arg]!] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.bundle && options.resume) throw new Error("Choose --bundle or --resume");
  if (options.resume && (options.dryRun || options.sourceId)) throw new Error("--dry-run and --source-id apply to a new bundle upload");
  const url = new URL(options.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Lumiverse URL must be an HTTP(S) URL without credentials, query, or fragment");
  options.url = url.href.replace(/\/+$/, "");
  return options;
}

async function secret(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Noninteractive authentication requires LUMIVERSE_MIGRATION_COOKIE");
  process.stdout.write(question);
  process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const restore = () => { process.stdin.setRawMode(false); process.stdin.off("data", onData); process.stdin.pause(); process.stdout.write("\n"); };
    const onData = (bytes: Buffer) => {
      for (const char of bytes.toString()) {
        if (char === "\u0003") { restore(); reject(new Error("Cancelled")); return; }
        if (char === "\r" || char === "\n") { restore(); resolve(value); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

export async function runCli(options: Options): Promise<number> {
  printBanner("CharacterLibrary Migration");
  let rl: ReturnType<typeof createInterface> | undefined;
  const ask = async (label: string, fallback = "") => {
    if (!process.stdin.isTTY) throw new Error(`${label} must be supplied for a noninteractive invocation`);
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    return (await rl.question(`${label}${fallback ? ` (${fallback})` : ""}: `)).trim() || fallback;
  };
  let cookie = process.env.LUMIVERSE_MIGRATION_COOKIE || "";
  let jobId: string | undefined = options.resume;
  let started = !!options.resume;
  try {
    const bundlePath = options.resume ? undefined : resolve((options.bundle || await ask("CharacterLibrary bundle path")).replace(/^~(?=\/|$)/, homedir()));
    if (bundlePath && options.report && resolve(options.report) === bundlePath) throw new Error("Report path must differ from the source bundle path");
    if (bundlePath && !(await Bun.file(bundlePath).exists())) throw new Error("Bundle file not found");
    if (!cookie) {
      const username = options.username || await ask("Lumiverse username/email");
      rl?.close(); rl = undefined;
      const password = await secret("Password: ");
      for (const email of new Set([username.includes("@") ? username : `${username}@lumiverse.local`, username])) {
        const response = await fetch(`${options.url}/api/auth/sign-in/email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }), redirect: "manual" });
        const sessionCookies = response.headers.getSetCookie().filter((c) => c.split(";")[0]!.split("=")[0]!.endsWith("better-auth.session_token"));
        if (response.ok && sessionCookies.length) { cookie = sessionCookies.map((c) => c.split(";")[0]).join("; "); break; }
      }
      if (!cookie) throw new Error("Authentication failed");
    }
    const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
      const response = await fetch(`${options.url}/api/v1/cl-migration${path}`, { ...init, headers: { Cookie: cookie, ...init.headers }, redirect: "error" });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error || `Migration API returned ${response.status}`);
      return result as T;
    };
    let preview: ClMigrationPreview;
    if (options.resume) preview = await api<ClMigrationJob>(`/jobs/${encodeURIComponent(options.resume)}`);
    else {
      const file = Bun.file(bundlePath!);
      const params = new URLSearchParams({ filename: basename(bundlePath!) });
      if (options.sourceId) params.set("sourceId", options.sourceId);
      console.log("Uploading and validating bundle...");
      preview = await api<ClMigrationPreview>(`/bundles?${params}`, { method: "PUT", headers: { "Content-Type": "application/zip", "Content-Length": String(file.size) }, body: file });
      jobId = preview.jobId;
    }
    console.log(`\nJob: ${preview.jobId}\nSource: ${preview.sourceId}`);
    console.log(`Characters: ${preview.counts.characters}; lorebooks: ${preview.counts.worlds}; chats: ${preview.counts.chats}; gallery files: ${preview.counts.galleryFiles}`);
    for (const issue of preview.issues) console.log(`${issue.severity}: ${issue.message}`);
    if (options.dryRun) {
      if (options.report) await Bun.write(resolve(options.report), JSON.stringify(preview, null, 2) + "\n");
      await api(`/jobs/${encodeURIComponent(jobId!)}`, { method: "DELETE" });
      console.log("Preflight finished. No characters imported; staging discarded.");
      return preview.issues.some((i) => i.severity === "error") ? 2 : 0;
    }
    if (!options.yes && !options.resume && (await ask("Start import? y/n", "n")).toLowerCase() !== "y") {
      await api(`/jobs/${encodeURIComponent(jobId!)}`, { method: "DELETE" });
      console.log("Import cancelled; staging discarded."); return 0;
    }
    let job = await api<ClMigrationJob>(`/jobs/${encodeURIComponent(jobId!)}`);
    if (job.status !== "running" && job.status !== "completed") {
      job = await api<ClMigrationJob>(`/jobs/${encodeURIComponent(jobId!)}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enableRegex: options.enableRegex }) });
    }
    started = true;
    let progress = "";
    while (job.status === "running" || job.status === "ready") {
      const text = `${job.progress.phase}: ${job.progress.current}/${job.progress.total}`;
      if (text !== progress) { console.log(text); progress = text; }
      await Bun.sleep(1000);
      job = await api<ClMigrationJob>(`/jobs/${encodeURIComponent(jobId!)}`);
    }
    if (!job.report) throw new Error(`Migration is ${job.status}; resume this job to continue`);
    if (options.report) await Bun.write(resolve(options.report), JSON.stringify(job.report, null, 2) + "\n");
    printSummary(`Migration ${job.status}`, Object.entries(job.report.totals).map(([label, value]) => ({ label, value: String(value) })), job.report.issues.map((i) => i.message));
    for (const item of job.report.items.filter((i) => i.status === "failed")) console.log(`Failed ${item.kind} ${item.source}: ${item.message}`);
    console.log(`Original ZIP: ${options.url}/api/v1/cl-migration/jobs/${encodeURIComponent(jobId!)}/source (requires your session)`);
    console.log("Refresh Lumiverse to see the imported library. Reports and sources remain available under this job ID.");
    return job.status === "completed" ? 0 : 2;
  } catch (error) {
    if (jobId) console.error(`Job ${jobId} is retained. ${started ? "Resume" : "Review or resume"} with: bun run migrate:cl --resume ${jobId}`);
    throw error;
  } finally { rl?.close(); }
}

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) { console.log(HELP); process.exit(0); }
    process.exit(await runCli(options));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exit(1);
  }
}
