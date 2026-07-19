---
title: Exporting Your Data
---

# Exporting Your Data

Bundle your entire account into a single `.lvbak` archive you can download, archive, or move to another Lumiverse instance.

---

## Quick Export (No API Keys)

1. Open **Settings → Data Portability**
2. In the **Export your data** card, decide whether to **Include vector embeddings**
3. Click **Download archive**

Your browser saves a file named `lumiverse-{your-username}-{YYYY-MM-DD}-{HHMMSS}.lvbak` — the timestamp makes successive backups sort chronologically.

The archive streams directly to your downloads folder while the server is still producing it; you never wait for the whole file to be assembled first. Progress is shown in the panel: `Exporting messages…`, `Bundling files…`, etc.

---

## Choosing What to Include

### Vector Embeddings

| Choice | Effect |
|--------|--------|
| **On** (default) | Archive bundles a per-user slice of the LanceDB vector store. On import, if the target instance has the **same embedding provider + model + dimension**, vectors restore instantly. Mismatches fall back to re-vectorization. |
| **Off** | Smaller archive. On import, every chunk is marked for re-vectorization and gets re-embedded in the background once an embedding provider is configured. |

Most archives are 100–500 MB without vectors. Adding vectors typically doubles that.

### API Keys & Secrets

This is a separate workflow with its own decryption-ticket file. See [API Keys & Tickets](api-keys-and-tickets.md) for the full details.

If you don't check this box, **no encrypted secrets travel** — you'll re-enter API keys after importing.

---

## What the Archive Contains

Inside the `.lvbak` (it's a ZIP file — you can open it with any zip utility to inspect it):

```
manifest.json              Producer + version + embedding config + archive id
database/                  One NDJSON per user-owned table
files/
  images/                  Original uploaded images
  thumbnails/              Pre-generated 300px and 700px WebP thumbnails
  avatars/                 Character + persona avatar files
  databank/                Databank documents (PDFs, txt, md, etc.)
  theme-assets/            Theme bundle files (fonts, images, CSS)
  notification-sounds/     Your custom completion sound
lancedb/                   Vector embeddings (only when "Include vectors" was on)
secrets/                   Encrypted API keys (only with the ticket flow)
manifest-stats.json        Trailing row counts and skipped-file report
```

Thumbnails are included **as-is**, so character galleries appear instantly on the target instance instead of waiting for Sharp to regenerate them.

---

## Streaming and Performance

The export streams from disk straight into your download. The server never holds the full archive in memory, so even multi-gigabyte exports (10k+ messages, large galleries, vectors) finish without bogging down your other Lumiverse activity.

If you're going through nginx / NPMPlus / a reverse proxy and downloads feel slow (~30–40 Mbps when your line is much faster), the proxy is most likely buffering the response. See the [troubleshooting note](#slow-downloads-through-a-reverse-proxy) below.

### Slow Downloads Through a Reverse Proxy

Lumiverse sets the `X-Accel-Buffering: no` header on export responses, which nginx-family proxies honor automatically. If your proxy ignores it (custom config, very old version), add this to the proxy host's Advanced tab:

```nginx
proxy_buffering off;
proxy_request_buffering off;
proxy_max_temp_file_size 0;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Accept-Encoding "";
gzip off;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
client_max_body_size 0;
```

---

## Tips & Caveats

!!! tip "Re-exports are cheap"
    Each export generates a fresh archive with its own UUID. There's no penalty for running an export weekly — old archives stay valid forever and can be restored alongside newer ones (the importer's merge policy handles overlap gracefully).

!!! tip "Use the timestamp to find recent backups"
    Filenames include `YYYY-MM-DD-HHMMSS` so `ls -lt` (or a Finder sort by name) lines them up chronologically.

!!! warning "Same-account re-imports replace nothing"
    The import side merges by ID and skips conflicts. Restoring a backup into the **same** account doesn't roll the account back to that snapshot — it adds back anything you've deleted since, but doesn't undo edits to surviving rows. For a true rollback, restore into a fresh account.

!!! warning "Some secrets may be skipped"
    If a row in your `secrets` table can't be decrypted (legacy data, identity-key drift, manual inserts), the export panel shows a yellow "secrets could not be decrypted" notice with the affected key names. The export completes; the affected secrets are simply omitted.
