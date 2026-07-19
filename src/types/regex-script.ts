export type RegexPlacement = "user_input" | "ai_output" | "world_info" | "reasoning" | "memory";
export type RegexScope = "global" | "character" | "chat";
export type RegexTarget = "prompt" | "response" | "display";
export type RegexMacroMode = "none" | "raw" | "escaped" | "after";
export type RegexActionType = "send" | "append" | "effects";

export interface RegexActionSetStateEffect {
  type: "set_state";
  /** Fixed creator-defined chat-variable key. Capture references are not allowed. */
  key: string;
  /** Capture-aware value template resolved from the assistant message match. */
  value: string;
}

export interface RegexActionDraftEffect {
  type: "draft";
  /** Capture-aware text placed into the composer after the action is claimed. */
  content: string;
  mode: "replace" | "append";
}

export interface RegexActionForkEffect {
  type: "fork";
}

export type RegexActionEffect = RegexActionSetStateEffect | RegexActionDraftEffect | RegexActionForkEffect;

export interface RegexAction {
  /** Matches data-regex-action="..." (preferred) or id="..." in replacement HTML. */
  id: string;
  type: RegexActionType;
  /** When true, this option is claimed independently and staged until the next send signal. */
  multi_select: boolean;
  /** Capture-aware numeric cost template used by multi-select actions. */
  cost: string;
  /** Capture-aware positive total-cost bound for the rendered action block. */
  limit: string;
  title: string;
  subtitle: string;
  /** Visible message text for send, or hidden prompt appendix for append. */
  content: string;
  /** Optional additive effects. Omitted legacy actions retain their exact behavior. */
  effects?: RegexActionEffect[];
}

export interface RegexScript {
  id: string;
  user_id: string;
  name: string;
  script_id: string;
  find_regex: string;
  replace_string: string;
  actions: RegexAction[];
  flags: string;
  placement: RegexPlacement[];
  scope: RegexScope;
  scope_id: string | null;
  target: RegexTarget[];
  min_depth: number | null;
  max_depth: number | null;
  trim_strings: string[];
  run_on_edit: boolean;
  substitute_macros: RegexMacroMode;
  disabled: boolean;
  sort_order: number;
  description: string;
  folder: string;
  pack_id: string | null;
  preset_id: string | null;
  character_id: string | null;
  metadata: Record<string, any>;
  created_at: number;
  updated_at: number;
}

export interface CreateRegexScriptInput {
  name: string;
  find_regex: string;
  script_id?: string;
  replace_string?: string;
  actions?: RegexAction[];
  flags?: string;
  placement?: RegexPlacement[];
  scope?: RegexScope;
  scope_id?: string | null;
  target?: RegexTarget[];
  min_depth?: number | null;
  max_depth?: number | null;
  trim_strings?: string[];
  run_on_edit?: boolean;
  substitute_macros?: RegexMacroMode;
  disabled?: boolean;
  sort_order?: number;
  description?: string;
  folder?: string;
  pack_id?: string | null;
  preset_id?: string | null;
  character_id?: string | null;
  metadata?: Record<string, any>;
}

export type UpdateRegexScriptInput = Partial<CreateRegexScriptInput>;

export interface RegexScriptExport {
  version: 1;
  type: "lumiverse_regex_scripts";
  scripts: Array<Omit<RegexScript, "id" | "user_id" | "pack_id" | "preset_id" | "character_id" | "created_at" | "updated_at">>;
  exported_at: number;
}
