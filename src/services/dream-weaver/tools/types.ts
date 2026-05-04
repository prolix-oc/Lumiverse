import type { DreamWeaverWorkspace } from "../../../types/dream-weaver";
import type { PromptFragmentId } from "../prompts/index";

export type ValidateResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface DreamWeaverTool<TOutput = unknown> {
  name: string;
  displayName: string;
  category: "soul" | "world" | "lifecycle";
  userInvocable: boolean;
  slashCommand?: string;
  description: string;
  prompt: string;
  validate: (input: unknown) => ValidateResult<TOutput>;
  conflictMode: "overwrite" | "append";
  requiresFragments: PromptFragmentId[];
  contextSlice: (workspace: DreamWeaverWorkspace) => Partial<DreamWeaverWorkspace>;
  apply: (workspace: DreamWeaverWorkspace, output: TOutput) => DreamWeaverWorkspace;
}

export type AnyDreamWeaverTool = DreamWeaverTool<any>;
