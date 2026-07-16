# Backend Capabilities

`requested_capabilities` is a manifest-fixed declaration in `spindle.json`. It opts an extension out of specific install/update scanner heuristics and, for `dynamic_code_execution`, enables guarded dynamic-code constructors in the extension's backend runtime. It is distinct from `permissions`:

| | Permissions | Capabilities |
|---|---|---|
| **What it does** | Gates runtime API surfaces (`spindle.generate`, `spindle.chats`, …) | Suppresses declared scanner blocks; `dynamic_code_execution` also enables guarded `eval` and Function-family constructors in the backend runtime and extension-owned backend-process runtimes |
| **Enforced at** | Every API call, in real time | Install/update scanning, backend runtime startup, and backend-process spawn |
| **Surfaced to user** | At install + can be revoked any time from the Extensions panel | Manifest/source declaration only; not shown as a grant or live toggle |
| **Changes at runtime?** | Yes (`onChanged` notifications) | No; the loaded manifest fixes the behavior of the current runtime |
| **Default** | None granted | None declared |

Most extensions don't need any capabilities. Declare one only when the install/update scanner blocks a pattern you have confirmed is legitimate, or when the extension intentionally needs the guarded backend behavior described below.

## The install/update scanner

When Lumiverse installs or updates/rebuilds an extension, it text-scans the bundled backend (`entry_backend`) for patterns that frequently indicate malicious or footgun-prone code:

- direct filesystem access (`fs`, `node:fs`)
- subprocess spawning (`child_process`)
- raw network sockets (`net`, `tls`, `dgram`, `http`, `https`)
- worker/cluster modules (`worker_threads`, `cluster`)
- direct SQLite access (`bun:sqlite`, `node:sqlite`)
- dangerous `Bun.*` system methods (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.serve`, …)
- dangerous `process.*` properties (`process.env`, `process.exit`, …)
- dynamic code execution (`eval(`, `Function(` / `new Function(`)
- base64 decoding (`Buffer.from(…, "base64")`)

The scanner is conservative: it tracks strings, comments, regex literals, and a number of evasion patterns (`String.fromCharCode`, computed property access, aliased references) so it doesn't fire on examples in documentation strings or comment-out lines. But two patterns — dynamic code execution and base64 decoding — show up legitimately often enough that they can be declared away.

If your backend bundle hits a non-declarable category, the scanner is telling you the code is genuinely unsafe in a Spindle extension. Refactor or move the work behind a separately supervised process boundary; a capability declaration cannot override a hard block.

## Available capabilities

### `dynamic_code_execution`

Suppresses the `dynamic code execution` scanner block (`eval(`, `Function(`, `new Function(`) and enables guarded `eval` and Function-family constructors in the extension's backend runtime and extension-owned backend-process runtimes. It does not enable dynamic code in frontend JavaScript; frontend sandbox-frame evaluation is separately controlled by the privileged `unsafe_eval` permission.

Declare this when your bundled backend contains any of:

- **Vendored libraries that feature-detect `new Function("")`**. Zod, for example, runs `try { new Function(""); return true } catch { return false }` to check for Cloudflare-Workers-style environments that disable the Function constructor. The empty-body form has no execution capability, but the bundle still contains the literal text `new Function(`. The scanner now carves out empty-body probes automatically, but partial matches in minified code can still surface.
- **`RegExp` literals whose source mentions `Function\s*\(` or `eval\s*\(`**. Common in extensions that ship their own security check banning the Function constructor in user-supplied code. The scanner skips regex literals, but only when the leading `/` is unambiguously in regex context (after `(`, `,`, `=`, `return`, etc.). Edge-case minified output may still trip.
- **Intentional sandboxed code execution**. Extensions like LumiScript run user-supplied JavaScript inside an `AsyncFunction` sandbox. The `Function` reference is mandatory for the sandbox to work; the safety story is provided by the sandbox itself, not by Spindle's static scanner.

Declaring this capability does **not** unlock module loading, filesystem, subprocess, network, process, environment, Bun system APIs, or any other category. It is not a frontend switch. The cooperative runtime guard rejects explicit property-level loader aliases such as `globalThis.import`, `globalThis.require`, and `globalThis.module.require`; the scanner handles their statically recognized forms in the backend bundle or backend-process entry and fails closed for unresolved or dynamic **bare** `import(specifier)` / `require(specifier)` expressions in scanned source. Native ESM `import()` is not rewritten by the cooperative runtime guard, so generated code must not use it for module loading; choose a process/OS isolation boundary when untrusted generated code is required. The declaration is read while installing/updating and when a backend runtime starts; changing it requires an extension reload/restart.

### `base64_decode`

Suppresses the `base64 decoding` block (`Buffer.from(value, "base64")`).

Declare this when your bundle contains base64-to-binary helpers, typically for:

- decoding image bytes received over IPC or a message channel
- ingesting binary assets bundled as base64 in your source
- round-tripping binary payloads through string-only transports

Base64 decode is sometimes used to smuggle code payloads past static scanners (decode → eval), which is why the heuristic exists. Pair this capability with `dynamic_code_execution` **only** if you actually need both, not as a habit.

## Hard-blocked backend patterns (no opt-in)

These representative categories have no `requested_capabilities` value. If your bundle matches one, you must refactor:

| Block | Representative triggers |
|---|---|
| `filesystem module access` | Importing `fs`, `fs/promises`, `node:fs`, or `node:fs/promises` |
| `subprocess module access` | Importing `child_process` or `node:child_process` |
| `direct socket module access` | Importing `net`, `tls`, `dgram`, `http`, `https`, `dns`, `http2`, or their `node:` forms |
| `debugger / worker module access` | Importing `inspector`, `worker_threads`, `cluster`, or their `node:` forms |
| `module loader access` | Importing `module`, `vm`, `process`, or `bun` (including `node:`/`bun:` forms) |
| `native FFI loader access` | Importing `bun:ffi` or `node:ffi`, or using native FFI APIs |
| `direct SQLite module access` | Importing `bun:sqlite`, `node:sqlite`, `sqlite3`, or `better-sqlite3` |
| `dynamic or unresolved module access` | A dynamic `import(specifier)` / bare `require(specifier)` whose specifier cannot be proven safe; unresolved loaders fail closed |
| `dangerous Bun or global API usage` | Reading `Bun.file`, `Bun.spawn`, `Bun.serve`, `Bun.connect`, `fetch`, `WebSocket`, or `Worker` (including aliased / destructured / computed-property forms) |
| `dangerous process API usage` | Reading `process.env`, `process.exit`, `process.kill`, `process.chdir`, `process.dlopen`, or process loader APIs (including aliased / destructured / computed-property forms) |

Spindle provides scoped equivalents for the legitimate use cases:

- **File I/O** — `spindle.storage.*` (per-extension storage) and `spindle.ephemeralStorage.*`
- **HTTP** — `spindle.corsProxy.*` (requires `"cors_proxy"` permission)
- **Secrets** — `spindle.secureEnclave.*` (AES-256-GCM at-rest encryption)
- **Subprocess isolation** — [`spindle.backendProcesses.*`](../backend-api/backend-processes.md)
- **Settings & metadata** — host-managed surfaces; `process.env` is never the right answer

If your refactor still hits a hard block, the design is asking too much for the extension boundary. Open an issue.

## Declaring capabilities

```json
{
  "version": "1.0.0",
  "name": "Image Helper",
  "identifier": "image_helper",
  "permissions": ["images"],
  "requested_capabilities": ["base64_decode"]
}
```

Invalid entries are dropped silently. The scanner still enforces the underlying check — an unrecognised capability value just means no opt-in, and it never bypasses a hard-blocked category.

## When to use capabilities, not workarounds

A few patterns worth avoiding:

- **Don't wrap forbidden tokens in `eval(atob("…"))` to smuggle them past the scanner.** The scanner is layered (string-content evasion, alias detection, computed-property tracking) and will catch most of it; what it doesn't catch still leaves you with code that can't be reviewed.
- **Don't move dangerous logic to a runtime-loaded module.** The scanner re-runs on every backend-process spawn (`spindle.backendProcesses.spawn`), so dynamically loaded entries are scanned with the same rules.
- **Don't strip comments / strings hoping to slip under the radar.** Both are explicitly tracked as ignored spans; their content never reaches the heuristic.

If your code is legitimate and the scanner is wrong, the fix is one of:

1. Declare the appropriate capability (this page).
2. File an issue with a reproducer if the false positive sits outside an existing capability.
