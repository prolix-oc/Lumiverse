---
title: Migrating from CharacterLibrary
---

# Migrating from CharacterLibrary

Import a **SillyTavern CharacterLibrary full bundle** into your own Lumiverse account using the CLI. The server receives the ZIP, shows an inventory, imports in the background, and retains the original archive and a result report. Lumiverse must be running with the CharacterLibrary migration endpoint available.

## Export from SillyTavern

In CharacterLibrary, select the characters, choose **Export → Full bundle (.zip)**, and keep **Include linked lorebooks** enabled. A bundle contains `manifest.json`, `cards/`, `gallery/`, `chats/`, and optional `worlds/`. A SillyTavern user-folder backup or a ZIP containing only PNGs uses a different import flow.

The current v1 bundle does not export expression images, external extension script files, or regex permission settings. Keep your original SillyTavern data for those items. The transfer cannot restore files that were never included in the bundle.

## Run the CLI

From the `Lumiverse-Backend` directory, first review the archive:

```sh
bun run migrate:cl --bundle ~/Downloads/cl-bundle.zip --dry-run
```

The CLI asks for your Lumiverse username/email and prompts privately for the password. Use `--url https://your-lumiverse-host` for a remote instance. Accounts that use SSO can supply their existing session cookie through `LUMIVERSE_MIGRATION_COOKIE`; this is the full Cookie header value, including the session cookie name. Do not put a password or session cookie in a command-line argument.

Preflight uploads and extracts the archive to validate paths, integrity, and inventory. It creates no characters and discards its temporary server staging afterward. It does not test every card, regex, or chat conversion. Use `--report ./preview.json` to save the preview.

Start an import:

```sh
bun run migrate:cl --bundle ~/Downloads/cl-bundle.zip --report ./cl-report.json
```

Review the counts and warnings, then confirm the import. `--yes` skips this review prompt. Noninteractive use requires the session-cookie environment variable and `--yes` (or `--dry-run`).

Regex scripts are imported **disabled** by default because the bundle omits the source account's permission state. To opt in during the initial import, add `--enable-regex`. Scripts disabled in the source stay disabled. Unsupported ST placements stay disabled and are reported. You can also review and enable supported scripts in Lumiverse afterward; retries preserve that decision.

Exit codes are `0` for a completed import or successful preflight, `2` for a partial/failed import or preflight inventory errors, and `1` for CLI/authentication/request failures. A completed import can still have compatibility warnings; inspect the report.

## What is transferred

| Source data | Destination behavior |
| --- | --- |
| Card PNG and avatar | New character in your private library; original PNG retained |
| Same-name characters | Separate identities based on source avatar filenames |
| Primary and additional external lorebooks | Separate source file identities, linked to the correct characters |
| Chat-bound lorebooks | Mapped to native chat world-book IDs |
| Embedded lorebook snapshot | Preserved as a separate character-managed book; not automatically activated alongside an external book |
| Gallery files | User-owned assets with per-character gallery associations; shared folders upload each path once |
| Local `/user/images/<folder>/<file>` paths | Converted in standard card text, regex replacements, chat messages and swipes; images use native gallery references and other media use authenticated image URLs |
| Remote media URLs and lorebook media | Original text and downloaded bytes retained; historical localization associations are not inferred |
| Character regex | Bound to the destination character, normalized through the existing ST importer; disabled unless explicitly opted in |
| Chats | Native messages, swipes, supported extras, and chat-header metadata; original JSONL retained |
| Favorites and creation dates | Native favorites and character creation timestamps |
| Source active chat | Saved as migration provenance; does not select a chat in the UI |
| Unmodeled card/message fields and other ZIP members | Original ZIP remains available; no claim of native runtime compatibility |
| Expressions and external scripts absent from v1 | Reported as unknown inventories; require a future richer export |

Local reference replacement covers exact known paths, including URL-encoded filenames. It does not rewrite remote hosts that happen to contain the same path. Media rendering remains subject to Lumiverse's supported formats and HTML/CSS contexts. Source lorebook settings pass through the existing normalizer; activation behavior is not guaranteed to be identical to SillyTavern.

## Retry and source identity

The CLI prints a job ID as soon as staging finishes. If the client disconnects, the server continues. To poll a running job or retry an interrupted/partial import:

```sh
bun run migrate:cl --resume JOB_ID --report ./cl-report.json
```

Use the same `--url` and account as the upload. Completed items are reused rather than duplicated. Existing character edits, avatar changes, and regex enablement are preserved. Missing native files can be repaired. An unfinished book from an interrupted chunked import is rebuilt.

By default the exact archive's SHA-256 is its source namespace. Re-uploading the same bytes reuses completed items on the same instance and account. A newly generated export normally has a new digest and imports as a separate source.

For repeated exports from one SillyTavern installation, optionally choose a stable identifier such as `--source-id my-st-installation`. Unchanged source filenames and contents are reused; changed contents at a previously imported identity are reported as conflicts. This first version does not overwrite those existing entities or adopt older ST imports. Use a different source ID to intentionally import a separate copy. Keep stable identifiers distinct between unrelated libraries. Filename renames are new identities.

## Originals and cleanup

The CLI prints an authenticated download URL:

```text
/api/v1/cl-migration/jobs/JOB_ID/source
```

Open it while signed in to the same account. The archive preserves every original ZIP member, including fields and files that have no native representation. Keep your own copy and save the JSON report.

Migration sources and receipts remain local to this Lumiverse instance. They are excluded from normal `.lvbak` account backups; imported native characters, books, chats, regex and gallery assets are included in those backups. Download the original ZIP separately before moving servers. Reimporting it on a different instance does not inherit the first instance's retry receipts.

`DELETE /api/v1/cl-migration/jobs/JOB_ID` deletes a stopped job and its retained source/staging. It leaves imported data and local retry receipts intact. There is no import rollback or migration UI in this first CLI release.

## HTTP entrypoint

All routes require an authenticated Lumiverse session and operate on that account. The API accepts no destination account override or arbitrary filesystem path.

| Method and path (under `/api/v1/cl-migration`) | Result |
| --- | --- |
| `PUT /bundles?filename=NAME&sourceId=OPTIONAL` | Stream a raw ZIP body; return `201` with inventory, issues and `jobId` |
| `POST /jobs/JOB_ID/execute` | JSON `{ "enableRegex": false }`; return `202` and start/resume execution |
| `GET /jobs/JOB_ID` | Status, phase progress, preview and final per-item report |
| `GET /jobs` | Most recent 50 jobs for this account |
| `GET /jobs/JOB_ID/source` | Download original ZIP |
| `DELETE /jobs/JOB_ID` | Remove stopped job and retained files |

Limits: 5 GB compressed upload, 20 GB selected decompressed payloads (duplicate gallery copies also count), 16 MB manifest, and 128 MB per processed card/chat/book/asset. ZIP64, STORE and DEFLATE are supported. Traversal paths, conflicting duplicate members, encrypted entries and unsupported bundle versions are rejected. Files absent from the manifest stay in the original ZIP without being extracted or executed.
