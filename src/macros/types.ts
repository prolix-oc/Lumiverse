// ============================================================================
// TOKEN TYPES
// ============================================================================

export enum TokenType {
  TEXT,
  MACRO_OPEN,
  MACRO_CLOSE,
  IDENTIFIER,
  SEPARATOR,
  FLAG_IMMEDIATE,
  FLAG_DELAYED,
  FLAG_REEVALUATE,
  FLAG_FILTER,
  FLAG_CLOSE,
  FLAG_PRESERVE,
  DOT,
  DOLLAR,
  AT,
  OPERATOR,
  ESCAPED_BRACE,
  EOF,
}

export interface Token {
  type: TokenType;
  value: string;
  offset: number;
}

// ============================================================================
// AST NODES
// ============================================================================

export type AstNode = TextNode | MacroNode | ScopedMacroNode;

export interface TextNode {
  type: "text";
  value: string;
}

export interface MacroNode {
  type: "macro";
  name: string;
  args: AstNode[][];
  flags: MacroFlags;
  raw: string;
  offset: number;
}

export interface ScopedMacroNode {
  type: "scoped_macro";
  name: string;
  args: AstNode[][];
  flags: MacroFlags;
  body: AstNode[];
  raw: string;
  offset: number;
}

export interface MacroFlags {
  immediate: boolean;
  delayed: boolean;
  reevaluate: boolean;
  filter: boolean;
  close: boolean;
  preserveWhitespace: boolean;
}

// ============================================================================
// REGISTRY TYPES
// ============================================================================

export interface MacroDefinition {
  name: string;
  category: string;
  description: string;
  returns?: string;
  returnType?: "string" | "integer" | "number" | "boolean";
  args?: MacroArgDef[];
  isList?: boolean | { min?: number; max?: number };
  strictArgs?: boolean;
  delayArgResolution?: boolean;
  aliases?: string[];
  /** When true, extension macros cannot overwrite this definition */
  builtIn?: boolean;
  handler: MacroHandler;
}

export interface MacroArgDef {
  name: string;
  type?: string;
  optional?: boolean;
  defaultValue?: string;
  description?: string;
}

export type MacroHandler = (ctx: MacroExecContext) => string | Promise<string>;

export interface MacroExecContext {
  name: string;
  args: string[];
  rawArgs: AstNode[][];
  flags: MacroFlags;
  isScoped: boolean;
  body: string;
  bodyRaw: AstNode[];
  offset: number;
  globalOffset: number;
  env: MacroEnv;
  resolve: (text: string) => string | Promise<string>;
  resolveNodes: (nodes: AstNode[]) => string | Promise<string>;
  warn: (message: string) => void;
}

// ============================================================================
// ENVIRONMENT
// ============================================================================

export interface MacroEnv {
  names: {
    user: string;
    char: string;
    group: string;
    groupNotMuted: string;
    notChar: string;
    /** Name of the focused/target character in a group chat. Empty in non-group chats. */
    charGroupFocused: string;
    /** Comma-separated group members excluding the focused character. Empty in non-group chats. */
    groupOthers: string;
    /** Number of group members as a string (e.g. "4"). "0" in non-group chats. */
    groupMemberCount: string;
    /** "yes" or "no" */
    isGroupChat: string;
    /** Name of the last non-user character who spoke. Empty if none or non-group chat. */
    groupLastSpeaker: string;
  };
  character: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    persona: string;
    personaSubjectivePronoun: string;
    personaObjectivePronoun: string;
    personaPossessivePronoun: string;
    mesExamples: string;
    mesExamplesRaw: string;
    systemPrompt: string;
    postHistoryInstructions: string;
    depthPrompt: string;
    creatorNotes: string;
    version: string;
    creator: string;
    firstMessage: string;
  };
  chat: {
    id: string;
    messageCount: number;
    lastMessage: string;
    lastMessageName: string;
    lastUserMessage: string;
    lastCharMessage: string;
    lastMessageId: number;
    firstIncludedMessageId: number;
    lastSwipeId: number;
    currentSwipeId: number;
  };
  system: {
    model: string;
    maxPrompt: number;
    maxContext: number;
    maxResponse: number;
    lastGenerationType: string;
    isMobile: boolean;
  };
  variables: {
    local: Map<string, string>;
    global: Map<string, string>;
    /** Chat-scoped persisted variables — saved to chat.metadata.chat_variables after generation. */
    chat: Map<string, string>;
  };
  /** Set to true when any chat variable macro mutates state. Used to trigger persistence. */
  _chatVarsDirty?: boolean;
  dynamicMacros: Record<string, string | MacroHandler | MacroDefinition>;
  /** Pre-normalized lowercase key → value map for O(1) dynamic macro lookup.
   *  Built automatically by buildEnv(); kept in sync if dynamicMacros changes. */
  _dynamicMacrosLower?: Map<string, string | MacroHandler | MacroDefinition>;
  extra: Record<string, any>;
}

// ============================================================================
// DIAGNOSTICS
// ============================================================================

export interface MacroDiagnostic {
  level: "warn" | "error";
  message: string;
  macroName?: string;
  offset?: number;
}

// ============================================================================
// EVALUATE RESULT
// ============================================================================

export interface EvaluateResult {
  text: string;
  diagnostics: MacroDiagnostic[];
}
