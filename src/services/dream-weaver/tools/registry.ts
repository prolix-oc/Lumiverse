import type { AnyDreamWeaverTool } from "./types";
import { BUILTIN_TOOLS } from "./builtin-tools";

const REGISTRY = new Map<string, AnyDreamWeaverTool>();
for (const tool of BUILTIN_TOOLS) REGISTRY.set(tool.name, tool);

export function getTool(name: string): AnyDreamWeaverTool | null {
  return REGISTRY.get(name) ?? null;
}

export function listTools(): AnyDreamWeaverTool[] {
  return [...REGISTRY.values()];
}

export function listUserInvocable(): AnyDreamWeaverTool[] {
  return [...REGISTRY.values()].filter((t) => t.userInvocable);
}

export function listSoulTools(): AnyDreamWeaverTool[] {
  return [...REGISTRY.values()].filter((t) => t.category === "soul");
}
