import type { DraftV2 } from "../../../types/dream-weaver";
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
  contextSlice: (draft: DraftV2) => Partial<DraftV2>;
  apply: (draft: DraftV2, output: TOutput) => DraftV2;
}

export type AnyDreamWeaverTool = DreamWeaverTool<any>;
