/**
 * Resolve a pasted HuggingFace model URL (or `owner/repo` slug) into a usable
 * tokenizer config. Parses the repo's file tree, picks the files our loaders
 * need, verifies the tokenizer actually loads, and suggests a name + model-match
 * rule — so the user doesn't have to hand-hunt raw `/resolve/main/...` links.
 *
 * Returns a discriminated result: `ok:true` with a ready-to-install suggestion,
 * or `ok:false` with a reason (`invalid` input, repo `unavailable`, or files
 * found but `unsupported` by our loaders).
 */
import { safeFetch } from "../utils/safe-fetch";
import * as tokenizerService from "./tokenizer.service";
import { HF_HOSTS, hfAuthHeaders } from "./huggingface.service";
import type { ResolveTokenizerResult, ResolvedFile, ResolvedTokenizerSuggestion, TokenizerType } from "../types/tokenizer";

const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;
const TREE_LIST_TIMEOUT_MS = 20_000;

interface RepoRef {
  owner: string;
  repo: string;
  revision: string;
  sourceUrl: string;
}

class ResolveError extends Error {
  constructor(public reason: "invalid" | "unavailable", message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

/**
 * Parse user input into a repo reference. Accepts full HuggingFace URLs
 * (`/owner/repo`, `.../tree/<rev>`, `.../resolve/<rev>/file`, `.../blob/<rev>/file`),
 * the `hf.co` alias, and a bare `owner/repo` slug.
 */
function parseRepoRef(input: string): RepoRef {
  const raw = (input || "").trim();
  if (!raw) throw new ResolveError("invalid", "Paste a model URL or owner/model slug.");

  let owner: string;
  let repo: string;
  let revision = "main";

  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ResolveError("invalid", `Not a valid URL: ${raw}`);
    }
    if (!HF_HOSTS.has(parsed.hostname.toLowerCase())) {
      throw new ResolveError(
        "invalid",
        `Only HuggingFace model URLs are supported here (got ${parsed.hostname}). For other hosts, add a direct tokenizer.json URL via Advanced.`
      );
    }
    const segs = parsed.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
    if (segs[0] === "datasets" || segs[0] === "spaces") {
      throw new ResolveError("invalid", "That looks like a dataset/space — paste a model URL instead.");
    }
    if (segs.length < 2) {
      throw new ResolveError("invalid", "URL is missing the owner/model path.");
    }
    owner = segs[0];
    repo = segs[1];
    if ((segs[2] === "tree" || segs[2] === "resolve" || segs[2] === "blob") && segs[3]) {
      revision = segs[3];
    }
  } else if (SLUG_RE.test(raw)) {
    const [o, r] = raw.split("/");
    owner = o;
    repo = r;
  } else {
    throw new ResolveError(
      "invalid",
      "Couldn't read a HuggingFace model from that. Paste a URL like https://huggingface.co/owner/model or an owner/model slug."
    );
  }

  return { owner, repo, revision, sourceUrl: `https://huggingface.co/${owner}/${repo}` };
}

/** List the repo's top-level file paths via the HuggingFace tree API. */
async function listRepoFiles(ref: RepoRef): Promise<string[]> {
  const url = `https://huggingface.co/api/models/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/tree/${encodeURIComponent(ref.revision)}`;
  const headers = await hfAuthHeaders(url);
  const usedToken = "Authorization" in headers;
  let resp: Response;
  try {
    resp = await safeFetch(url, { timeoutMs: TREE_LIST_TIMEOUT_MS, headers });
  } catch (err: any) {
    throw new ResolveError("unavailable", `Couldn't reach HuggingFace to list the repo files: ${err?.message || String(err)}`);
  }
  if (!resp.ok) {
    if (resp.status === 404) throw new ResolveError("unavailable", "Repository not found on HuggingFace.");
    if (resp.status === 401 || resp.status === 403) {
      // HuggingFace returns 401 for gated/private *and* nonexistent repos (to avoid
      // leaking which repos exist), so tailor the hint by whether a token was sent.
      throw new ResolveError(
        "unavailable",
        usedToken
          ? "The configured HuggingFace token doesn't have access to this repo (it may be gated, private, or not exist)."
          : "This repo is gated, private, or doesn't exist. If it's gated/private, add a HuggingFace token below to access it."
      );
    }
    throw new ResolveError("unavailable", `HuggingFace returned ${resp.status} when listing the repo files.`);
  }
  let entries: any;
  try {
    entries = await resp.json();
  } catch {
    throw new ResolveError("unavailable", "HuggingFace returned an unexpected (non-JSON) file listing.");
  }
  if (!Array.isArray(entries)) {
    throw new ResolveError("unavailable", "HuggingFace returned an unexpected file listing.");
  }
  return entries
    .filter((e: any) => e && e.type === "file" && typeof e.path === "string")
    .map((e: any) => e.path as string);
}

type Detection =
  | { kind: "ok"; type: TokenizerType; config: Record<string, any>; files: ResolvedFile[]; warnings: string[] }
  | { kind: "unsupported"; message: string; files: ResolvedFile[] }
  | { kind: "unavailable"; message: string };

/** Decide which tokenizer type a repo's files imply, and build its config. */
function detectTokenizer(files: string[], ref: RepoRef): Detection {
  const resolveUrl = (f: string) =>
    `https://huggingface.co/${ref.owner}/${ref.repo}/resolve/${encodeURIComponent(ref.revision)}/${f}`;
  const has = (name: string) => files.includes(name);

  // Fast HuggingFace tokenizer — the common case (Qwen, GLM, Mistral, Gemma, …).
  if (has("tokenizer.json")) {
    const config: Record<string, any> = { url: resolveUrl("tokenizer.json") };
    if (has("tokenizer_config.json")) config.configUrl = resolveUrl("tokenizer_config.json");
    return {
      kind: "ok",
      type: "huggingface",
      config,
      files: [
        { name: "tokenizer.json", url: resolveUrl("tokenizer.json"), required: true, present: true },
        { name: "tokenizer_config.json", url: resolveUrl("tokenizer_config.json"), required: false, present: has("tokenizer_config.json") },
      ],
      warnings: [],
    };
  }

  // tiktoken `.model` (e.g. Moonshot Kimi). Note: SentencePiece's `tokenizer.model`
  // is a different format — only match files whose name actually says "tiktoken".
  const tiktokenFile = files.find((f) => f.toLowerCase().includes("tiktoken"));
  if (tiktokenFile) {
    const config: Record<string, any> = { url: resolveUrl(tiktokenFile) };
    if (has("tokenizer_config.json")) config.configUrl = resolveUrl("tokenizer_config.json");
    return {
      kind: "ok",
      type: "tiktoken",
      config,
      files: [
        { name: tiktokenFile, url: resolveUrl(tiktokenFile), required: true, present: true },
        { name: "tokenizer_config.json", url: resolveUrl("tokenizer_config.json"), required: false, present: has("tokenizer_config.json") },
      ],
      warnings: [
        "tiktoken models may need a model-specific pre-tokenizer regex for exact counts — a default is used here, so counts are best-effort.",
      ],
    };
  }

  // SentencePiece-only repo: our loader can't read a bare `tokenizer.model`.
  if (has("tokenizer.model")) {
    return {
      kind: "unsupported",
      message:
        "This repo ships only a SentencePiece `tokenizer.model` (no fast `tokenizer.json`). Our loader needs a `tokenizer.json` — check whether the model offers a 'fast' tokenizer variant.",
      files: [{ name: "tokenizer.model", url: resolveUrl("tokenizer.model"), required: false, present: true }],
    };
  }

  return { kind: "unavailable", message: "No tokenizer files (tokenizer.json or a tiktoken model) were found in this repo." };
}

/** Suggest a display name and an editable model-match rule from the repo name. */
function suggestNameAndPattern(ref: RepoRef): { name: string; pattern: string; priority: number } {
  const escaped = ref.repo.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Mirror the built-in pattern style (see tokenizer-seed.ts): anchor to start or
  // a namespace separator so `openai/...`, `bedrock.` and `vertex:` ids still match.
  return { name: ref.repo, pattern: `(?:^|[/:.])${escaped}`, priority: 60 };
}

/** Resolve a pasted URL / slug into an installable tokenizer suggestion (verified to load). */
export async function resolveTokenizer(input: string): Promise<ResolveTokenizerResult> {
  let ref: RepoRef;
  try {
    ref = parseRepoRef(input);
  } catch (err: any) {
    if (err instanceof ResolveError) return { ok: false, reason: err.reason, message: err.message };
    return { ok: false, reason: "invalid", message: err?.message || String(err) };
  }

  let files: string[];
  try {
    files = await listRepoFiles(ref);
  } catch (err: any) {
    if (err instanceof ResolveError) return { ok: false, reason: err.reason, message: err.message };
    return { ok: false, reason: "unavailable", message: err?.message || String(err) };
  }

  const det = detectTokenizer(files, ref);
  if (det.kind === "unavailable") return { ok: false, reason: "unavailable", message: det.message };
  if (det.kind === "unsupported") return { ok: false, reason: "unsupported", message: det.message, files: det.files };

  // Prove it actually loads before offering to install it.
  const verify = await tokenizerService.verifyConfig(det.type, det.config);
  if (!verify.ok) {
    return {
      ok: false,
      reason: "unsupported",
      message: `Found the files but couldn't load the tokenizer: ${verify.error}`,
      files: det.files,
    };
  }

  const sug = suggestNameAndPattern(ref);
  const suggested: ResolvedTokenizerSuggestion = {
    name: sug.name,
    type: det.type,
    config: det.config,
    pattern: sug.pattern,
    priority: sug.priority,
  };

  return {
    ok: true,
    repo: `${ref.owner}/${ref.repo}`,
    revision: ref.revision,
    sourceUrl: ref.sourceUrl,
    type: det.type,
    files: det.files,
    suggested,
    warnings: det.warnings,
  };
}
