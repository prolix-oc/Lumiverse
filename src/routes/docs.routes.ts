import { Glob } from "bun";
import { Hono } from "hono";
import { Buffer } from "node:buffer";
import { resolve, sep } from "node:path";

const docsRoutes = new Hono();

const DOCS_ROOT = resolve(import.meta.dir, "../../user-docs/docs");

interface GuideCatalogEntry {
  path: string;
  title: string;
}

function extractDocumentTitle(
  markdown: string,
  path: string,
): string {
  const frontMatter = markdown.match(
    /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
  );

  if (frontMatter) {
    const titleMatch = frontMatter[1].match(
      /^title:\s*(.+?)\s*$/m,
    );

    if (titleMatch) {
      return titleMatch[1]
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  const heading = markdown.match(/^#\s+(.+?)\s*$/m);

  if (heading) {
    return heading[1].trim();
  }

  const filename =
    path.split("/").at(-1)?.replace(/\.md$/i, "") ??
    path;

  return filename
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function buildGuideCatalog(): Promise<GuideCatalogEntry[]> {
  const glob = new Glob("**/*.md");
  const entries: GuideCatalogEntry[] = [];

  for await (const relativePath of glob.scan({
    cwd: DOCS_ROOT,
    absolute: false,
  })) {
    const normalizedPath = relativePath.replace(/\\/g, "/");

    const file = Bun.file(
      resolve(DOCS_ROOT, relativePath),
    );

    const markdown = await file.text();

    entries.push({
      path: normalizedPath,
      title: extractDocumentTitle(
        markdown,
        normalizedPath,
      ),
    });
  }

  return entries.sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}

function resolveDocumentPath(requestPath: string): string | null {
  const cleanPath = requestPath.replace(/^[/\\]+/, "");

  if (!cleanPath) {
    return null;
  }

  const filePath = resolve(DOCS_ROOT, cleanPath);

  if (
    filePath !== DOCS_ROOT &&
    !filePath.startsWith(`${DOCS_ROOT}${sep}`)
  ) {
    return null;
  }

  return filePath;
}

async function documentResponse(
  requestPath: string,
): Promise<Response> {
  const filePath = resolveDocumentPath(requestPath);

  if (!filePath) {
    return Response.json(
      { error: "Invalid document path" },
      { status: 400 },
    );
  }

  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return Response.json(
      { error: "Document not found" },
      { status: 404 },
    );
  }

  return new Response(file, {
    headers: {
      "Content-Type":
        file.type || "application/octet-stream",
      "Cache-Control": "no-cache",
    },
  });
}

docsRoutes.get("/catalog", async (c) => {
  const entries = await buildGuideCatalog();

  return c.json(entries, 200, {
    "Cache-Control": "no-cache",
  });
});

/**
 * Opaque document endpoint used by the in-app guide viewer.
 *
 * Encoding the path keeps document names out of the request URL,
 * avoiding false positives from browser content blockers.
 */
docsRoutes.get("/file/:encoded", async (c) => {
  const encoded = c.req.param("encoded");

  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return c.json(
      { error: "Invalid document key" },
      400,
    );
  }

  const requestPath = Buffer.from(
    encoded,
    "base64url",
  ).toString("utf8");

  if (!requestPath) {
    return c.json(
      { error: "Invalid document key" },
      400,
    );
  }

  return documentResponse(requestPath);
});

/**
 * Human-readable/raw endpoint.
 *
 * Kept for direct access and debugging.
 */
docsRoutes.get("/*", async (c) => {
  const prefix = "/api/v1/docs/";

  let requestPath: string;

  try {
    requestPath = decodeURIComponent(
      c.req.path.slice(prefix.length),
    );
  } catch {
    return c.json(
      { error: "Invalid document path" },
      400,
    );
  }

  return documentResponse(requestPath);
});

export { docsRoutes };