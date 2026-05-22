import type { ToolCatalogEntry } from "@/api/dream-weaver-tooling";

export type ParseResult =
  | { ok: true; tool: ToolCatalogEntry; rawArgs: string }
  | { ok: false; error: string };

export function parseSlash(input: string, catalog: ToolCatalogEntry[]): ParseResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return { ok: false, error: "Slash commands only — start with /" };
  }
  const body = trimmed.slice(1);
  const spaceIdx = body.indexOf(" ");
  const name = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const rawArgs = spaceIdx === -1 ? "" : body.slice(spaceIdx + 1).trim();

  const tool = catalog.find(
    (t) =>
      t.userInvocable &&
      (t.slashCommand === `/${name}` || t.name === name || t.slashCommand === `/add_${name.replace(/^add_/, "")}`),
  );
  if (!tool) return { ok: false, error: `Unknown command: /${name}` };
  return { ok: true, tool, rawArgs };
}
