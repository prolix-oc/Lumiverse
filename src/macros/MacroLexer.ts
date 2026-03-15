import { TokenType, type Token } from "./types";

/**
 * Hand-written scanner for macro template strings.
 * Produces a flat token stream consumed by the parser.
 */
export function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    // Check for escaped braces
    if (input[pos] === "\\" && pos + 1 < len && (input[pos + 1] === "{" || input[pos + 1] === "}")) {
      tokens.push({ type: TokenType.ESCAPED_BRACE, value: input[pos + 1], offset: pos });
      pos += 2;
      continue;
    }

    // Check for macro open {{
    if (input[pos] === "{" && pos + 1 < len && input[pos + 1] === "{") {
      tokens.push({ type: TokenType.MACRO_OPEN, value: "{{", offset: pos });
      pos += 2;
      lexMacroContent(input, pos, len, tokens);
      // Update pos to after the macro content was consumed
      pos = tokens[tokens.length - 1].offset + tokens[tokens.length - 1].value.length;
      continue;
    }

    // Accumulate plain text
    const textStart = pos;
    while (pos < len) {
      if (input[pos] === "\\" && pos + 1 < len && (input[pos + 1] === "{" || input[pos + 1] === "}")) break;
      if (input[pos] === "{" && pos + 1 < len && input[pos + 1] === "{") break;
      pos++;
    }
    if (pos > textStart) {
      tokens.push({ type: TokenType.TEXT, value: input.substring(textStart, pos), offset: textStart });
    }
  }

  tokens.push({ type: TokenType.EOF, value: "", offset: pos });
  return tokens;
}

function lexMacroContent(input: string, start: number, len: number, tokens: Token[]): void {
  let pos = start;

  // Skip whitespace
  while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;

  // Scan flags
  while (pos < len) {
    const ch = input[pos];
    if (ch === "!") {
      tokens.push({ type: TokenType.FLAG_IMMEDIATE, value: "!", offset: pos });
      pos++;
    } else if (ch === "?") {
      tokens.push({ type: TokenType.FLAG_DELAYED, value: "?", offset: pos });
      pos++;
    } else if (ch === "~") {
      tokens.push({ type: TokenType.FLAG_REEVALUATE, value: "~", offset: pos });
      pos++;
    } else if (ch === ">") {
      tokens.push({ type: TokenType.FLAG_FILTER, value: ">", offset: pos });
      pos++;
    } else if (ch === "/") {
      tokens.push({ type: TokenType.FLAG_CLOSE, value: "/", offset: pos });
      pos++;
    } else if (ch === "#") {
      tokens.push({ type: TokenType.FLAG_PRESERVE, value: "#", offset: pos });
      pos++;
    } else {
      break;
    }
  }

  // Skip whitespace
  while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;

  // Check for variable shorthand: .varName or $varName
  if (pos < len && (input[pos] === "." || input[pos] === "$")) {
    const shorthandType = input[pos] === "." ? TokenType.DOT : TokenType.DOLLAR;
    tokens.push({ type: shorthandType, value: input[pos], offset: pos });
    pos++;

    // Scan variable name
    const nameStart = pos;
    while (pos < len && /[\w\-]/.test(input[pos])) pos++;
    if (pos > nameStart) {
      tokens.push({ type: TokenType.IDENTIFIER, value: input.substring(nameStart, pos), offset: nameStart });
    }

    // Skip whitespace
    while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;

    // Check for operator
    pos = lexOperator(input, pos, len, tokens);

    // Skip whitespace and find closing }}
    while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;
    if (pos < len && input[pos] === "}" && pos + 1 < len && input[pos + 1] === "}") {
      tokens.push({ type: TokenType.MACRO_CLOSE, value: "}}", offset: pos });
      pos += 2;
    } else {
      // No closing brace found — emit as text up to wherever we stopped
      tokens.push({ type: TokenType.MACRO_CLOSE, value: "}}", offset: pos });
    }
    return;
  }

  // Check for comment shorthand: {{// ...}}
  if (pos < len && input[pos] === "/" && pos + 1 < len && input[pos + 1] === "/") {
    tokens.push({ type: TokenType.IDENTIFIER, value: "//", offset: pos });
    pos += 2;
    // Everything until }} is the comment content
    const argStart = pos;
    const closeIdx = input.indexOf("}}", pos);
    if (closeIdx >= 0) {
      if (closeIdx > argStart) {
        tokens.push({ type: TokenType.SEPARATOR, value: "::", offset: pos });
        tokens.push({ type: TokenType.TEXT, value: input.substring(argStart, closeIdx).trim(), offset: argStart });
      }
      tokens.push({ type: TokenType.MACRO_CLOSE, value: "}}", offset: closeIdx });
    } else {
      tokens.push({ type: TokenType.MACRO_CLOSE, value: "}}", offset: len });
    }
    return;
  }

  // Scan identifier
  const idStart = pos;
  while (pos < len && /[a-zA-Z0-9_\-]/.test(input[pos])) pos++;

  if (pos > idStart) {
    tokens.push({ type: TokenType.IDENTIFIER, value: input.substring(idStart, pos), offset: idStart });
  }

  // Skip whitespace
  while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;

  if (pos < len && input[pos] !== ":" && input[pos] !== "}") {
    tokens.push({ type: TokenType.SEPARATOR, value: " ", offset: pos });
    pos = lexArgument(input, pos, len, tokens);
  }

  // Scan separator + arguments
  // :: separator means each :: separates a new argument
  // : (single) means consume everything until }} as one argument (legacy)
  while (pos < len) {
    if (input[pos] === "}" && pos + 1 < len && input[pos + 1] === "}") break;

    if (input[pos] === ":" && pos + 1 < len && input[pos + 1] === ":") {
      tokens.push({ type: TokenType.SEPARATOR, value: "::", offset: pos });
      pos += 2;
      // Scan argument value — may contain nested {{...}}
      pos = lexArgument(input, pos, len, tokens);
    } else if (input[pos] === ":") {
      // Legacy single colon — rest until }} is one arg
      tokens.push({ type: TokenType.SEPARATOR, value: ":", offset: pos });
      pos++;
      // Everything until }} is the argument (may contain nested macros)
      pos = lexArgument(input, pos, len, tokens);
    } else {
      // Unexpected character, skip
      pos++;
    }
  }

  // Closing }}
  if (pos < len && input[pos] === "}" && pos + 1 < len && input[pos + 1] === "}") {
    tokens.push({ type: TokenType.MACRO_CLOSE, value: "}}", offset: pos });
    pos += 2;
  } else {
    // Unterminated macro — emit close anyway at current pos
    tokens.push({ type: TokenType.MACRO_CLOSE, value: "}}", offset: pos });
  }
}

/**
 * Lex an argument value. Properly tokenizes nested {{...}} macros within
 * arguments so the parser can build recursive AST nodes (Matryoshka macros).
 * Stops at :: or }} boundary (at the top level, not inside nested macros).
 */
function lexArgument(input: string, start: number, len: number, tokens: Token[]): number {
  let pos = start;
  let textStart = pos;

  while (pos < len) {
    // Handle escaped braces
    if (input[pos] === "\\" && pos + 1 < len && (input[pos + 1] === "{" || input[pos + 1] === "}")) {
      if (pos > textStart) {
        tokens.push({ type: TokenType.TEXT, value: input.substring(textStart, pos), offset: textStart });
      }
      tokens.push({ type: TokenType.ESCAPED_BRACE, value: input[pos + 1], offset: pos });
      pos += 2;
      textStart = pos;
      continue;
    }

    // Handle nested macro — emit proper MACRO_OPEN and delegate to lexMacroContent
    if (input[pos] === "{" && pos + 1 < len && input[pos + 1] === "{") {
      // Flush accumulated text before the nested macro
      if (pos > textStart) {
        tokens.push({ type: TokenType.TEXT, value: input.substring(textStart, pos), offset: textStart });
      }
      tokens.push({ type: TokenType.MACRO_OPEN, value: "{{", offset: pos });
      pos += 2;
      lexMacroContent(input, pos, len, tokens);
      // Advance pos past whatever lexMacroContent consumed
      pos = tokens[tokens.length - 1].offset + tokens[tokens.length - 1].value.length;
      textStart = pos;
      continue;
    }

    // }} at top level is the outer macro's close — stop without consuming
    if (input[pos] === "}" && pos + 1 < len && input[pos + 1] === "}") {
      break;
    }

    // :: separator at top level — stop without consuming
    if (input[pos] === ":" && pos + 1 < len && input[pos + 1] === ":") {
      break;
    }

    pos++;
  }

  if (pos > textStart) {
    tokens.push({ type: TokenType.TEXT, value: input.substring(textStart, pos), offset: textStart });
  }

  return pos;
}

function lexOperator(input: string, start: number, len: number, tokens: Token[]): number {
  let pos = start;
  if (pos >= len) return pos;

  // Two-char operators
  const two = pos + 1 < len ? input[pos] + input[pos + 1] : "";
  if (two === "++" || two === "--" || two === "+=" || two === "-=" || two === "||" || two === "??" || two === "==" || two === "!=" || two === ">=" || two === "<=") {
    tokens.push({ type: TokenType.OPERATOR, value: two, offset: pos });
    pos += 2;
    // For assignment operators, scan the value
    if (two === "+=" || two === "-=" || two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "||" || two === "??") {
      while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;
      pos = lexOperatorValue(input, pos, len, tokens);
    }
    return pos;
  }

  // Single-char operators
  if (input[pos] === "=" || input[pos] === ">" || input[pos] === "<") {
    tokens.push({ type: TokenType.OPERATOR, value: input[pos], offset: pos });
    pos++;
    while (pos < len && (input[pos] === " " || input[pos] === "\t")) pos++;
    pos = lexOperatorValue(input, pos, len, tokens);
    return pos;
  }

  return pos;
}

function lexOperatorValue(input: string, start: number, len: number, tokens: Token[]): number {
  let pos = start;
  const valStart = pos;
  // Consume until }}
  while (pos < len) {
    if (input[pos] === "}" && pos + 1 < len && input[pos + 1] === "}") break;
    pos++;
  }
  if (pos > valStart) {
    tokens.push({ type: TokenType.TEXT, value: input.substring(valStart, pos).trim(), offset: valStart });
  }
  return pos;
}
