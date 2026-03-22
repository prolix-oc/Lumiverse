import { TokenType, type Token, type AstNode, type TextNode, type MacroNode, type ScopedMacroNode, type MacroFlags } from "./types";
import { lex } from "./MacroLexer";

const DEFAULT_FLAGS: MacroFlags = {
  immediate: false,
  delayed: false,
  reevaluate: false,
  filter: false,
  close: false,
  preserveWhitespace: false,
};

// LRU cache for parsed ASTs — avoids re-lexing/parsing the same template strings
// (e.g. preset blocks that are identical across generations).
const AST_CACHE_MAX = 32;
const astCache = new Map<string, AstNode[]>();

/**
 * Parse a macro template string into an AST.
 * Input is first lexed, then the token stream is walked to produce nodes.
 * After initial parse, opening/closing scoped macros are paired.
 *
 * Results are cached (LRU, up to 32 entries) for repeated calls with the
 * same template string. The returned AST must NOT be mutated by callers.
 */
export function parse(input: string): AstNode[] {
  const cached = astCache.get(input);
  if (cached) return cached;

  const tokens = lex(input);
  const ctx = new ParseContext(tokens);
  const nodes = parseDocument(ctx);
  const result = pairScopedMacros(nodes);

  // Evict oldest entry if at capacity (simple LRU: Map iteration order = insertion order)
  if (astCache.size >= AST_CACHE_MAX) {
    const first = astCache.keys().next().value;
    if (first !== undefined) astCache.delete(first);
  }
  astCache.set(input, result);

  return result;
}

class ParseContext {
  pos = 0;
  constructor(public tokens: Token[]) {}

  peek(): Token {
    return this.tokens[this.pos] ?? { type: TokenType.EOF, value: "", offset: -1 };
  }

  advance(): Token {
    return this.tokens[this.pos++] ?? { type: TokenType.EOF, value: "", offset: -1 };
  }

  expect(type: TokenType): Token {
    const tok = this.advance();
    if (tok.type !== type) {
      // Gracefully handle — return the token anyway
    }
    return tok;
  }

  at(type: TokenType): boolean {
    return this.peek().type === type;
  }

  atEnd(): boolean {
    return this.peek().type === TokenType.EOF;
  }
}

function parseDocument(ctx: ParseContext): AstNode[] {
  const nodes: AstNode[] = [];

  while (!ctx.atEnd()) {
    const tok = ctx.peek();

    if (tok.type === TokenType.TEXT) {
      ctx.advance();
      pushTextNode(nodes, tok.value);
    } else if (tok.type === TokenType.ESCAPED_BRACE) {
      ctx.advance();
      pushTextNode(nodes, tok.value);
    } else if (tok.type === TokenType.MACRO_OPEN) {
      nodes.push(parseMacroExpr(ctx));
    } else {
      // Unexpected token — consume as text
      ctx.advance();
      pushTextNode(nodes, tok.value);
    }
  }

  return nodes;
}

function parseMacroExpr(ctx: ParseContext): MacroNode {
  const openTok = ctx.advance(); // consume {{
  const startOffset = openTok.offset;
  const flags = { ...DEFAULT_FLAGS };

  // Collect flags
  while (!ctx.atEnd()) {
    const tok = ctx.peek();
    if (tok.type === TokenType.FLAG_IMMEDIATE) { flags.immediate = true; ctx.advance(); }
    else if (tok.type === TokenType.FLAG_DELAYED) { flags.delayed = true; ctx.advance(); }
    else if (tok.type === TokenType.FLAG_REEVALUATE) { flags.reevaluate = true; ctx.advance(); }
    else if (tok.type === TokenType.FLAG_FILTER) { flags.filter = true; ctx.advance(); }
    else if (tok.type === TokenType.FLAG_CLOSE) { flags.close = true; ctx.advance(); }
    else if (tok.type === TokenType.FLAG_PRESERVE) { flags.preserveWhitespace = true; ctx.advance(); }
    else break;
  }

  // Variable shorthand: {{.varName}} or {{$varName}}
  if (ctx.at(TokenType.DOT) || ctx.at(TokenType.DOLLAR)) {
    return parseVariableShorthand(ctx, flags, startOffset);
  }

  // Identifier
  let name = "";
  if (ctx.at(TokenType.IDENTIFIER)) {
    name = ctx.advance().value;
  }

  // Collect arguments from separators
  const args: AstNode[][] = [];
  while (ctx.at(TokenType.SEPARATOR)) {
    ctx.advance(); // consume :: or :
    // Argument content — merge adjacent text inline
    const argNodes: AstNode[] = [];
    while (!ctx.atEnd() && !ctx.at(TokenType.SEPARATOR) && !ctx.at(TokenType.MACRO_CLOSE)) {
      const tok = ctx.peek();
      if (tok.type === TokenType.TEXT) {
        ctx.advance();
        pushTextNode(argNodes, tok.value);
      } else if (tok.type === TokenType.MACRO_OPEN) {
        argNodes.push(parseMacroExpr(ctx));
      } else if (tok.type === TokenType.ESCAPED_BRACE) {
        ctx.advance();
        pushTextNode(argNodes, tok.value);
      } else {
        // Consume unknown token as text
        ctx.advance();
        pushTextNode(argNodes, tok.value);
      }
    }
    args.push(argNodes);
  }

  // Consume closing }}
  let closeTok = ctx.peek();
  if (ctx.at(TokenType.MACRO_CLOSE)) {
    closeTok = ctx.advance();
  }

  const endOffset = closeTok.offset + closeTok.value.length;
  const raw = `{{${name}${args.length > 0 ? "::" : ""}}}`;

  return {
    type: "macro",
    name,
    args,
    flags,
    raw,
    offset: startOffset,
  };
}

function parseVariableShorthand(ctx: ParseContext, flags: MacroFlags, startOffset: number): MacroNode {
  const scopeTok = ctx.advance(); // . or $
  const isGlobal = scopeTok.type === TokenType.DOLLAR;

  let varName = "";
  if (ctx.at(TokenType.IDENTIFIER)) {
    varName = ctx.advance().value;
  }

  let operator = "";
  let operandValue = "";
  if (ctx.at(TokenType.OPERATOR)) {
    operator = ctx.advance().value;
    // If there's a text value following the operator
    if (ctx.at(TokenType.TEXT)) {
      operandValue = ctx.advance().value;
    }
  }

  // Consume closing }}
  if (ctx.at(TokenType.MACRO_CLOSE)) ctx.advance();

  // Translate variable shorthand to macro calls
  const macroName = translateVarShorthand(isGlobal, operator);
  const args: AstNode[][] = [[{ type: "text", value: varName } as TextNode]];
  if (operandValue) {
    args.push([{ type: "text", value: operandValue } as TextNode]);
  }

  return {
    type: "macro",
    name: macroName,
    args,
    flags,
    raw: `{{${scopeTok.value}${varName}${operator}${operandValue}}}`,
    offset: startOffset,
  };
}

function translateVarShorthand(isGlobal: boolean, operator: string): string {
  const prefix = isGlobal ? "getgvar" : "getvar";
  if (!operator) return prefix;

  switch (operator) {
    case "++": return isGlobal ? "incgvar" : "incvar";
    case "--": return isGlobal ? "decgvar" : "decvar";
    case "=": return isGlobal ? "setgvar" : "setvar";
    case "+=": return isGlobal ? "addgvar" : "addvar";
    case "-=": return isGlobal ? "addgvar" : "addvar"; // addvar with negative
    case "||":
    case "??": return prefix; // fallback — evaluated at runtime
    default: return prefix;
  }
}

/**
 * Post-parse pass: pair opening macros with their corresponding closing macros
 * to form ScopedMacroNode entries.
 */
function pairScopedMacros(nodes: AstNode[]): AstNode[] {
  const result: AstNode[] = [];
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i];

    if (node.type === "macro" && !node.flags.close) {
      // Look ahead for a matching close tag
      const closingIdx = findClosingMacro(nodes, i + 1, node.name);
      if (closingIdx >= 0) {
        // Collect body nodes between open and close
        const bodyNodes = nodes.slice(i + 1, closingIdx);
        const scoped: ScopedMacroNode = {
          type: "scoped_macro",
          name: node.name,
          args: node.args,
          flags: node.flags,
          body: pairScopedMacros(bodyNodes), // recurse into body
          raw: node.raw,
          offset: node.offset,
        };
        result.push(scoped);
        i = closingIdx + 1;
        continue;
      }
    }

    // Skip standalone close tags (orphaned)
    if (node.type === "macro" && node.flags.close) {
      i++;
      continue;
    }

    result.push(node);
    i++;
  }

  return result;
}

function findClosingMacro(nodes: AstNode[], startIdx: number, name: string): number {
  let depth = 0;
  const lowerName = name.toLowerCase();

  for (let i = startIdx; i < nodes.length; i++) {
    const node = nodes[i];
    if (node.type === "macro") {
      if (node.name.toLowerCase() === lowerName) {
        if (node.flags.close) {
          if (depth === 0) return i;
          depth--;
        } else {
          depth++;
        }
      }
    }
  }

  return -1;
}

/** Push a text value, merging with the previous node if it's also text. */
function pushTextNode(nodes: AstNode[], value: string): void {
  if (nodes.length > 0) {
    const prev = nodes[nodes.length - 1];
    if (prev.type === "text") {
      (prev as TextNode).value += value;
      return;
    }
  }
  nodes.push({ type: "text", value } as TextNode);
}
