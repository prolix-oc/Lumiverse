---
title: Hosting the documentation
---

# Hosting the documentation

Use `scripts/serve-docs.ts` to serve either built Zensical site behind your HTTPS reverse proxy. It requires Bun and no additional packages. The server runs independently of the Lumiverse backend.

## Build and start

From the repository root, build both sites:

```sh
uvx zensical build --clean --config-file user-docs/zensical.toml
uvx zensical build --clean --config-file developer-docs/zensical.toml
```

Run each server in a separate terminal or supervised service:

```sh
# User guides: http://127.0.0.1:3020/guides/
bun run docs:serve:user

# Developer docs: http://127.0.0.1:3021/
bun run docs:serve:developer
```

The user guides use `/guides/` because their Zensical `site_url` includes that prefix. When changing the public URL, update `site_url`, rebuild, and match the server's `--base-path` to the URL path.

To reuse the script with another build directory or port:

```sh
bun --no-env-file scripts/serve-docs.ts --root /srv/docs/site --port 3021
bun --no-env-file scripts/serve-docs.ts --root /srv/guides/site --port 3020 --base-path /guides/
```

Relative roots resolve from the working directory. Startup fails if the root has no regular `index.html`. `--help` lists all options. No Zensical process is needed after building; rebuild and publish the files when the documentation changes.

## Reverse proxy

In your reverse proxy, forward `docs.lumiverse.chat` to the developer server's address and port **3021** (or whatever port specified), using **HTTP** upstream. Terminate HTTPS at the reverse proxy. Keep the original `Host` header; the static server accepts the public hostname and does not construct redirects from forwarded headers.

For `https://lumiverse.chat/guides/`, forward the `/guides/` location to port **3020** (or whatever port specified) and **preserve `/guides/` in the upstream request path**. Leave the main site's other locations pointed at their existing service. Redirect `/guides` to `/guides/` if that exact path does not reach the docs server.

The default bind address is `127.0.0.1`. When the proxy is in another container, loopback refers to that container: use a shared private network and start the docs server with `--host 0.0.0.0`, pointing the proxy at the docs container. Avoid publishing that HTTP port to the internet; let the proxy provide TLS, compression, and any rate limiting.

## Serving behavior

- Only `GET` and `HEAD` are accepted. Directory URLs serve `index.html`; missing trailing slashes redirect locally while preserving query strings.
- Missing pages use the build's `404.html` with HTTP status 404. There is no directory listing or fallback to the homepage.
- Dotfiles, dot directories, traversal, symlinks within the site, and special files are rejected. Files stream from an opened, checked file descriptor.
- MIME types, security headers, ETags, and `Last-Modified` are supplied. Successful files revalidate rather than remaining cached across rebuilds. Errors are not cached. Byte-range requests receive the complete file.
- The Content Security Policy blocks framing, embedded objects, and foreign base URLs while leaving Zensical's scripts, search, fonts, and theme working. It is not a sanitizer for untrusted HTML.

Treat everything in the built directory as public, trusted content. Serve only the build output, keep it writable only by your publishing account, and run the server as an unprivileged account with read-only access. The server does not execute files, accept uploads, or rebuild the documentation. A root symlink is resolved once at startup; restart the server after switching it to a new release directory.
