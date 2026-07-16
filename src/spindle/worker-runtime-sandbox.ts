/**
 * Runtime sandbox for Spindle extension workers / subprocesses.
 *
 * Called immediately before the extension entry is dynamically imported.
 * It patches global APIs that are common bypass vectors: eval, the Function
 * constructor, indirect Bun/process API access, and sensitive env vars.
 *
 * IMPORTANT: This is a *cooperative* sandbox. It raises the cost of escape
 * but does not replace OS-level isolation (sandbox-exec, containers, etc.).
 *
 * KNOWN LIMITATION — native ESM `import()` in an extension's original bundle
 * is resolved by the runtime and cannot be intercepted by `globalThis.import`.
 * The install-time scanner and OS-level sandbox remain responsible for that
 * path. Generated source passed to guarded eval/Function-family constructors
 * is conservatively checked for module-loader tokens synchronously before
 * native execution, including nested generated-code calls.
 */

import {
  BLOCKED_BUN_API_NAMES,
  BLOCKED_GLOBAL_API_NAMES,
  BLOCKED_PROCESS_API_NAMES,
  isSensitiveEnvironmentKey,
} from "./dangerous-runtime-policy";

const SAFE_ARRAY = Array;
const SAFE_STRING = String;
const SAFE_STRING_FROM_CODE_POINT = String.fromCodePoint;
const SAFE_REFLECT_APPLY = Reflect.apply;
const SAFE_REFLECT_GET = Reflect.get;
const SAFE_REFLECT_CONSTRUCT = Reflect.construct;
const SAFE_OBJECT_CREATE = Object.create;
const SAFE_OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const SAFE_OBJECT_DEFINE_PROPERTIES = Object.defineProperties;
const SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const SAFE_OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const SAFE_OBJECT_PREVENT_EXTENSIONS = Object.preventExtensions;
const SAFE_FUNCTION_HAS_INSTANCE = Function.prototype[Symbol.hasInstance];
const SAFE_OBJECT_FREEZE = Object.freeze;
const SAFE_OBJECT_IS_EXTENSIBLE = Object.isExtensible;
const SAFE_OBJECT_IS = Object.is;
const SAFE_REFLECT_OWN_KEYS = Reflect.ownKeys;
const SAFE_REFLECT_SET = Reflect.set;
const SAFE_OBJECT_KEYS = Object.keys;
const SAFE_FUNCTION_CONSTRUCTOR = Function;
const SAFE_EVAL = eval;
const SAFE_FUNCTION_PROTOTYPE = SAFE_FUNCTION_CONSTRUCTOR.prototype;
const SAFE_ASYNC_FUNCTION_PROTOTYPE = SAFE_OBJECT_GET_PROTOTYPE_OF(async function () {});
const SAFE_GENERATOR_FUNCTION_PROTOTYPE = SAFE_OBJECT_GET_PROTOTYPE_OF(function* () {});
const SAFE_ASYNC_GENERATOR_FUNCTION_PROTOTYPE = SAFE_OBJECT_GET_PROTOTYPE_OF(
  async function* () {},
);
const SAFE_ASYNC_FUNCTION_CONSTRUCTOR = SAFE_ASYNC_FUNCTION_PROTOTYPE.constructor as Function;
const SAFE_GENERATOR_FUNCTION_CONSTRUCTOR = SAFE_GENERATOR_FUNCTION_PROTOTYPE.constructor as Function;
const SAFE_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR =
  SAFE_ASYNC_GENERATOR_FUNCTION_PROTOTYPE.constructor as Function;

type RuntimeObject = object;

function isRuntimeObject(value: unknown): value is RuntimeObject {
  return value !== null && (typeof value === "object" || typeof value === "function");
}





const MODULE_SURFACE_ERROR =
  "Module loader surface could not be sealed in extension context";
const SANDBOX_SURFACE_ERROR = "Sandbox guard installation failed";
/**
 * Guard installation is deliberately one-shot. A successful call permanently
 * seals this worker's host surfaces; there is no disposer because the worker
 * exits instead of restoring host globals.
 */
let sandboxInitialized = false;


function sandboxSurfaceError(surface: string, cause?: unknown): Error {
  const detail = cause instanceof Error && cause.message ? `: ${cause.message}` : "";
  return new Error(`${SANDBOX_SURFACE_ERROR} (${surface})${detail}`);
}

function findPropertyDescriptor(
  target: RuntimeObject,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  let current: RuntimeObject | null = target;
  while (current) {
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, key);
    if (descriptor) return descriptor;
    current = SAFE_OBJECT_GET_PROTOTYPE_OF(current);
  }
  return undefined;
}

function assertGuardInstallable(
  target: RuntimeObject,
  key: PropertyKey,
  surface: string,
): void {
  const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key);
  if (
    (!descriptor && SAFE_OBJECT_IS_EXTENSIBLE(target)) ||
    descriptor?.configurable === true ||
    (descriptor && "value" in descriptor && descriptor.writable)
  ) {
    return;
  }
  throw sandboxSurfaceError(surface);
}

function installDataGuard(
  target: RuntimeObject,
  key: PropertyKey,
  value: unknown,
  surface: string,
  enumerable?: boolean,
): void {
  const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key);
  if (
    descriptor &&
    !descriptor.configurable &&
    "value" in descriptor &&
    !descriptor.writable &&
    SAFE_OBJECT_IS(descriptor.value, value)
  ) {
    verifyDataGuard(target, key, value, surface);
    return;
  }
  try {
    SAFE_OBJECT_DEFINE_PROPERTY(target, key, {
      value,
      writable: false,
      configurable: false,
      ...(enumerable === undefined
        ? {}
        : { enumerable }),
    });
  } catch (error) {
    throw sandboxSurfaceError(surface, error);
  }
  verifyDataGuard(target, key, value, surface);
}

function verifyDataGuard(
  target: RuntimeObject,
  key: PropertyKey,
  value: unknown,
  surface: string,
): void {
  const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, key);
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !SAFE_OBJECT_IS(descriptor.value, value) ||
    descriptor.writable !== false ||
    descriptor.configurable !== false ||
    !SAFE_OBJECT_IS(SAFE_REFLECT_GET(target, key), value)
  ) {
    throw sandboxSurfaceError(surface);
  }
}

function createBlockedModuleConstructor(loader: () => never): RuntimeObject {
  const constructorSurface = SAFE_OBJECT_CREATE(null);
  SAFE_OBJECT_DEFINE_PROPERTY(constructorSurface, "_load", {
    value: loader,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  SAFE_OBJECT_DEFINE_PROPERTY(constructorSurface, "createRequire", {
    value: loader,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  SAFE_OBJECT_DEFINE_PROPERTY(constructorSurface, "require", {
    value: loader,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  return SAFE_OBJECT_FREEZE(constructorSurface);
}

function createBlockedModuleSurface(): RuntimeObject {
  const constructorSurface = createBlockedModuleConstructor(BLOCKED_MODULE_LOADER);
  const moduleSurface = SAFE_OBJECT_CREATE(null);

  SAFE_OBJECT_DEFINE_PROPERTY(moduleSurface, "require", {
    value: BLOCKED_MODULE_LOADER,
    writable: false,
    configurable: false,
    enumerable: true,
  });
  SAFE_OBJECT_DEFINE_PROPERTY(moduleSurface, "constructor", {
    value: constructorSurface,
    writable: false,
    configurable: false,
    enumerable: false,
  });
  return SAFE_OBJECT_FREEZE(moduleSurface);
}



function verifyModuleValue(
  moduleValue: RuntimeObject,
  constructorSurface: RuntimeObject,
): void {
  if (
    SAFE_OBJECT_GET_PROTOTYPE_OF(moduleValue) !== null ||
    SAFE_OBJECT_IS_EXTENSIBLE(moduleValue)
  ) {
    throw new Error(MODULE_SURFACE_ERROR);
  }

  const ownKeys = SAFE_REFLECT_OWN_KEYS(moduleValue);
  if (
    ownKeys.length !== 2 ||
    !ownKeys.includes("require") ||
    !ownKeys.includes("constructor")
  ) {
    throw new Error(MODULE_SURFACE_ERROR);
  }

  for (const [key, expected] of [
    ["require", BLOCKED_MODULE_LOADER],
    ["constructor", constructorSurface],
  ] as const) {
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(moduleValue, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !SAFE_OBJECT_IS(descriptor.value, expected) ||
      descriptor.writable !== false ||
      descriptor.configurable !== false
    ) {
      throw new Error(MODULE_SURFACE_ERROR);
    }
  }

  if (
    SAFE_OBJECT_GET_PROTOTYPE_OF(constructorSurface) !== null ||
    SAFE_OBJECT_IS_EXTENSIBLE(constructorSurface)
  ) {
    throw new Error(MODULE_SURFACE_ERROR);
  }
  for (const key of ["_load", "createRequire", "require"] as const) {
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(constructorSurface, key);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !SAFE_OBJECT_IS(descriptor.value, BLOCKED_MODULE_LOADER) ||
      descriptor.writable !== false ||
      descriptor.configurable !== false
    ) {
      throw new Error(MODULE_SURFACE_ERROR);
    }
  }
}


function installModuleSurface(): void {
  const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(globalThis, "module");
  const replaceable =
    !descriptor ||
    descriptor.configurable ||
    ("value" in descriptor && descriptor.writable);
  if (!replaceable) {
    throw new Error(MODULE_SURFACE_ERROR);
  }

  const moduleSurface = createBlockedModuleSurface();
  const constructorSurface = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    moduleSurface,
    "constructor",
  )?.value;
  if (!isRuntimeObject(constructorSurface)) {
    throw new Error(MODULE_SURFACE_ERROR);
  }

  installDataGuard(
    globalThis,
    "module",
    moduleSurface,
    "global module",
    descriptor?.enumerable === true,
  );
  verifyModuleValue(moduleSurface, constructorSurface);
}

function installGlobalRequireSurface(): void {
  const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(globalThis, "require");
  installDataGuard(
    globalThis,
    "require",
    BLOCKED_MODULE_LOADER,
    "global require",
    descriptor?.enumerable === true,
  );
}

const RUNTIME_MODULE_TOKENS = [
  "import",
  "require",
  "createRequire",
  "module",
];

function containsPrimitive(source: string, needle: string): boolean {
  if (needle.length === 0 || source.length < needle.length) return false;
  const lastStart = source.length - needle.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (source[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

const ASCII_IDENTIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_$";

function isIdentifierCharacter(value: string | undefined): boolean {
  if (value === undefined) return false;
  for (let index = 0; index < ASCII_IDENTIFIER_CHARS.length; index += 1) {
    if (value === ASCII_IDENTIFIER_CHARS[index]) return true;
  }
  return false;
}

function containsIdentifier(source: string, identifier: string): boolean {
  if (!containsPrimitive(source, identifier)) return false;
  const lastStart = source.length - identifier.length;
  for (let start = 0; start <= lastStart; start += 1) {
    let matched = true;
    for (let offset = 0; offset < identifier.length; offset += 1) {
      if (source[start + offset] !== identifier[offset]) {
        matched = false;
        break;
      }
    }
    if (
      matched &&
      !isIdentifierCharacter(source[start - 1]) &&
      !isIdentifierCharacter(source[start + identifier.length])
    ) {
      return true;
    }
  }
  return false;
}
type StaticStringExpression = {
  value: string;
  end: number;
};

function isStaticWhitespace(value: string | undefined): boolean {
  return (
    value === " " ||
    value === "\t" ||
    value === "\n" ||
    value === "\r" ||
    value === "\v" ||
    value === "\f" ||
    value === "\u00a0" ||
    value === "\u1680" ||
    value === "\u2000" ||
    value === "\u2001" ||
    value === "\u2002" ||
    value === "\u2003" ||
    value === "\u2004" ||
    value === "\u2005" ||
    value === "\u2006" ||
    value === "\u2007" ||
    value === "\u2008" ||
    value === "\u2009" ||
    value === "\u200a" ||
    value === "\u2028" ||
    value === "\u2029" ||
    value === "\u202f" ||
    value === "\u205f" ||
    value === "\u3000" ||
    value === "\ufeff"
  );
}

function isStaticLineTerminator(value: string | undefined): boolean {
  return value === "\n" || value === "\r" || value === "\u2028" || value === "\u2029";
}

function skipStaticExpressionTrivia(source: string, start: number): number {
  let index = start;
  while (index < source.length) {
    if (isStaticWhitespace(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && !isStaticLineTerminator(source[index])) {
        index += 1;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      if (index >= source.length) return source.length;
      index += 2;
      continue;
    }
    return index;
  }
  return index;
}

function staticHexValue(value: string | undefined): number {
  if (value === undefined) return -1;
  const digits = "0123456789abcdefABCDEF";
  for (let index = 0; index < digits.length; index += 1) {
    if (value !== digits[index]) continue;
    return index < 16 ? index : index - 6;
  }
  return -1;
}

function readUnicodeEscape(
  source: string,
  start: number,
): StaticStringExpression | null {
  if (source[start] !== "\\" || source[start + 1] !== "u") return null;
  let index = start + 2;
  let value = 0;
  if (source[index] === "{") {
    index += 1;
    let digits = 0;
    while (index < source.length && source[index] !== "}") {
      const digit = staticHexValue(source[index]);
      if (digit < 0 || digits >= 6) return null;
      value = value * 16 + digit;
      digits += 1;
      index += 1;
    }
    if (source[index] !== "}" || digits === 0 || value > 0x10ffff) return null;
    return { value: SAFE_STRING_FROM_CODE_POINT(value), end: index + 1 };
  }
  for (let offset = 0; offset < 4; offset += 1) {
    const digit = staticHexValue(source[index + offset]);
    if (digit < 0) return null;
    value = value * 16 + digit;
  }
  return { value: SAFE_STRING_FROM_CODE_POINT(value), end: index + 4 };
}

function readStaticStringLiteral(
  source: string,
  start: number,
): StaticStringExpression | null {
  const quote = source[start];
  if (quote !== "'" && quote !== '"' && quote !== "`") return null;

  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === quote) {
      return { value, end: index + 1 };
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") {
      return null;
    }
    if (char !== "\\") {
      value += char;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) return null;
    if (escaped === "u") {
      const unicode = readUnicodeEscape(source, index);
      if (!unicode) return null;
      value += unicode.value;
      index = unicode.end;
      continue;
    }
    if (escaped === "x") {
      let decoded = 0;
      for (let offset = 0; offset < 2; offset += 1) {
        const digit = staticHexValue(source[index + 2 + offset]);
        if (digit < 0) return null;
        decoded = decoded * 16 + digit;
      }
      value += SAFE_STRING_FROM_CODE_POINT(decoded);
      index += 4;
      continue;
    }
    if (isStaticLineTerminator(escaped)) {
      index += escaped === "\r" && source[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (escaped >= "0" && escaped <= "7") {
      let decoded = staticHexValue(escaped);
      let consumed = 1;
      while (consumed < 3) {
        const digit = staticHexValue(source[index + 1 + consumed]);
        if (digit < 0 || digit > 7) break;
        decoded = decoded * 8 + digit;
        consumed += 1;
      }
      value += SAFE_STRING_FROM_CODE_POINT(decoded);
      index += consumed + 1;
      continue;
    }
    let replacement: string | undefined;
    if (escaped === "b") replacement = "\b";
    else if (escaped === "f") replacement = "\f";
    else if (escaped === "n") replacement = "\n";
    else if (escaped === "r") replacement = "\r";
    else if (escaped === "t") replacement = "\t";
    else if (escaped === "v") replacement = "\v";
    else if (escaped === "\\") replacement = "\\";
    else if (escaped === "'") replacement = "'";
    else if (escaped === '"') replacement = '"';
    else if (escaped === "`") replacement = "`";
    else replacement = escaped;
    value += replacement;
    index += 2;
  }
  return null;
}

function readStaticStringExpression(
  source: string,
  start: number,
  terminator: string,
): StaticStringExpression | null {
  function readExpression(
    position: number,
    closing: string,
  ): StaticStringExpression | null {
    let index = skipStaticExpressionTrivia(source, position);
    let value = "";
    let foundLiteral = false;
    while (index < source.length) {
      const part =
        source[index] === "("
          ? readExpression(index + 1, ")")
          : readStaticStringLiteral(source, index);
      if (!part) return null;
      foundLiteral = true;
      value += part.value;
      index = skipStaticExpressionTrivia(source, part.end);
      if (source[index] === closing) {
        return foundLiteral ? { value, end: index + 1 } : null;
      }
      if (source[index] !== "+") return null;
      index = skipStaticExpressionTrivia(source, index + 1);
    }
    return null;
  }
  return readExpression(start, terminator);
}

function staticExpressionMayImport(
  source: string,
  start: number,
  terminator: string,
): boolean {
  const expression = readStaticStringExpression(source, start, terminator);
  if (expression?.value === "import") return true;
  let index = skipStaticExpressionTrivia(source, start);
  while (source[index] === "(") {
    index = skipStaticExpressionTrivia(source, index + 1);
  }
  return source[index] === "`";
}

function isLikelyIdentifierPart(value: string | undefined): boolean {
  if (value === undefined || isStaticWhitespace(value)) return false;
  if (isIdentifierCharacter(value)) return true;
  return !(
    value === "." ||
    value === "?" ||
    value === ":" ||
    value === ";" ||
    value === "," ||
    value === "(" ||
    value === ")" ||
    value === "[" ||
    value === "]" ||
    value === "{" ||
    value === "}" ||
    value === "\"" ||
    value === "'" ||
    value === "`" ||
    value === "/" ||
    value === "\\" ||
    value === "+" ||
    value === "-" ||
    value === "*" ||
    value === "%" ||
    value === "=" ||
    value === "!" ||
    value === "&" ||
    value === "|" ||

    value === "<" ||
    value === ">" ||
    value === "^" ||
    value === "~"
  );
}

function readIdentifierAt(
  source: string,
  start: number,
  identifier: string,
): StaticStringExpression | null {
  if (start < 0 || start >= source.length) return null;
  if (isLikelyIdentifierPart(source[start - 1])) return null;
  let index = start;
  for (let offset = 0; offset < identifier.length; offset += 1) {
    const escaped = readUnicodeEscape(source, index);
    if (escaped) {
      if (escaped.value !== identifier[offset]) return null;
      index = escaped.end;
      continue;
    }
    if (source[index] !== identifier[offset]) return null;
    index += 1;
  }
  if (isLikelyIdentifierPart(source[index])) return null;
  const escapedBoundary = readUnicodeEscape(source, index);
  if (escapedBoundary && isLikelyIdentifierPart(escapedBoundary.value)) return null;
  return { value: identifier, end: index };
}

function matchesIdentifierAt(source: string, start: number, identifier: string): boolean {
  return readIdentifierAt(source, start, identifier) !== null;
}

function readStaticRootExpression(
  source: string,
  start: number,
  roots: readonly string[],
): StaticStringExpression | null {
  let index = skipStaticExpressionTrivia(source, start);
  let parentheses = 0;
  while (source[index] === "(") {
    parentheses += 1;
    index = skipStaticExpressionTrivia(source, index + 1);
  }
  if (source[index - 1] === "." || (source[index - 2] === "?" && source[index - 1] === ".")) {
    return null;
  }
  let root: StaticStringExpression | null = null;
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    root = readIdentifierAt(source, index, roots[rootIndex]);
    if (root) break;
  }
  if (!root) return null;
  index = skipStaticExpressionTrivia(source, root.end);
  while (parentheses > 0) {
    if (source[index] !== ")") return null;
    parentheses -= 1;
    index = skipStaticExpressionTrivia(source, index + 1);
  }
  return { value: root.value, end: index };
}

type TemplateScanResult = {
  end: number;
  found: boolean;
};

function copySourceRange(source: string, start: number, end: number): string {
  let value = "";
  for (let index = start; index < end; index += 1) {
    value += source[index];
  }
  return value;
}

function findTemplateExpressionEnd(source: string, start: number): number {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const ignoredEnd = skipIgnoredSourceRegion(source, index);
    if (ignoredEnd !== index) {
      index = ignoredEnd;
      continue;
    }
    if (source[index] === "`") {
      index = skipSourceQuotedRegion(source, index);
      continue;
    }
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return source.length;
}

function scanTemplateForComputedImport(
  source: string,
  start: number,
): TemplateScanResult {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += source[index + 1] === "\r" && source[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (source[index] === "`") {
      return { end: index + 1, found: false };
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      const expressionEnd = findTemplateExpressionEnd(source, index + 2);
      if (expressionEnd >= source.length) return { end: source.length, found: false };
      const expression = copySourceRange(source, index + 2, expressionEnd);
      if (containsStaticComputedImportProperty(expression)) {
        return { end: expressionEnd + 1, found: true };
      }
      index = expressionEnd + 1;
      continue;
    }
    index += 1;
  }
  return { end: source.length, found: false };
}

function skipSourceQuotedRegion(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += source[index + 1] === "\r" && source[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function sourceRegexStartsAt(source: string, start: number): boolean {
  let previous = start - 1;
  while (previous >= 0 && isStaticWhitespace(source[previous])) previous -= 1;
  if (previous < 0) return true;
  const value = source[previous];
  if (
    (value === "+" && source[previous - 1] === "+") ||
    (value === "-" && source[previous - 1] === "-")
  ) {
    return false;
  }
  if (
    value === "(" ||
    value === "[" ||
    value === "{" ||
    value === "," ||
    value === ";" ||
    value === ":" ||
    value === "=" ||
    value === "!" ||
    value === "&" ||
    value === "|" ||
    value === "?" ||
    value === "+" ||
    value === "-" ||
    value === "*" ||
    value === "%" ||
    value === "~" ||
    value === "^" ||
    value === "<" ||
    value === ">"
  ) {
    return true;
  }
  if (value === ")") {
    let depth = 1;
    let cursor = previous - 1;
    while (cursor >= 0 && depth > 0) {
      if (source[cursor] === ")") depth += 1;
      else if (source[cursor] === "(") depth -= 1;
      cursor -= 1;
    }
    if (depth === 0) {
      while (cursor > 0 && isStaticWhitespace(source[cursor - 1])) cursor -= 1;
      let wordStart = cursor;
      while (wordStart > 0 && isIdentifierCharacter(source[wordStart - 1])) wordStart -= 1;
      const controls = ["if", "while", "for", "switch", "catch", "with"];
      for (let controlIndex = 0; controlIndex < controls.length; controlIndex += 1) {
        if (matchesIdentifierAt(source, wordStart, controls[controlIndex])) return true;
      }
    }
    return false;
  }
  if (!isIdentifierCharacter(value)) return false;
  let wordStart = previous;
  while (wordStart >= 0 && isIdentifierCharacter(source[wordStart - 1])) wordStart -= 1;
  const keywords = ["return", "typeof", "delete", "void", "throw", "new", "yield", "await", "case"];
  if (source[wordStart - 1] === ".") return false;
  for (let keywordIndex = 0; keywordIndex < keywords.length; keywordIndex += 1) {
    if (matchesIdentifierAt(source, wordStart, keywords[keywordIndex])) return true;
  }
  return false;
}

function skipSourceRegex(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "[" && !inClass) {
      inClass = true;
      index += 1;
      continue;
    }
    if (source[index] === "]" && inClass) {
      inClass = false;
      index += 1;
      continue;
    }
    if (source[index] === "/" && !inClass) {
      index += 1;
      while (
        source[index] === "d" ||
        source[index] === "g" ||
        source[index] === "i" ||
        source[index] === "m" ||
        source[index] === "s" ||
        source[index] === "u" ||
        source[index] === "v" ||
        source[index] === "y"
      ) {
        index += 1;
      }
      return index;
    }
    if (source[index] === "\n" || source[index] === "\r") return start + 1;
    index += 1;
  }
  return source.length;
}

function skipIgnoredSourceRegion(source: string, start: number): number {
  const quote = source[start];
  if (quote === "'" || quote === '"') {
    return skipSourceQuotedRegion(source, start);
  }
  if (source[start] !== "/") return start;
  if (source[start + 1] === "/") {
    let index = start + 2;
    while (index < source.length && !isStaticLineTerminator(source[index])) {
      index += 1;
    }
    return index;
  }
  if (source[start + 1] === "*") {
    let index = start + 2;
    while (
      index < source.length &&
      !(source[index] === "*" && source[index + 1] === "/")
    ) {
      index += 1;
    }
    return index < source.length ? index + 2 : source.length;
  }
  return sourceRegexStartsAt(source, start) ? skipSourceRegex(source, start) : start;
}

function containsStaticComputedImportProperty(source: string): boolean {
  const roots = ["globalThis", "global", "self"] as const;
  let index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      const template = scanTemplateForComputedImport(source, index);
      if (template.found) return true;
      index = template.end;
      continue;
    }
    const ignoredEnd = skipIgnoredSourceRegion(source, index);
    if (ignoredEnd !== index) {
      index = ignoredEnd;
      continue;
    }
    if (source[index] === "[") {
      const property = staticExpressionMayImport(source, index + 1, "]");
      if (property) {
        let cursor = skipStaticExpressionTrivia(source, index + 1);
        const expression = readStaticStringExpression(source, cursor, "]");
        if (expression) {
          cursor = skipStaticExpressionTrivia(source, expression.end);
          if (source[cursor] === ":") {
            cursor = skipStaticExpressionTrivia(source, cursor + 1);
            while (cursor < source.length && source[cursor] !== ";") {
              if (source[cursor] === "=") {
                const root = readStaticRootExpression(source, cursor + 1, roots);
                if (root) return true;
                break;
              }
              cursor += 1;
            }
          }
        }
      }
    }
    for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
      const root = readStaticRootExpression(source, index, [roots[rootIndex]]);
      if (!root) continue;
      let bracket = skipStaticExpressionTrivia(source, root.end);
      if (source[bracket] === "?" && source[bracket + 1] === ".") {
        bracket = skipStaticExpressionTrivia(source, bracket + 2);
      }
      if (source[bracket] !== "[") continue;
      if (staticExpressionMayImport(source, bracket + 1, "]")) return true;
    }
    index += 1;
  }

  const readers = [
    ["Reflect", "get", "key"],
    ["Reflect", "getOwnPropertyDescriptor", "key"],
    ["Object", "getOwnPropertyDescriptor", "key"],
    ["Object", "getOwnPropertyDescriptors", "descriptor"],
  ] as const;
  index = 0;
  while (index < source.length) {
    if (source[index] === "`") {
      const template = scanTemplateForComputedImport(source, index);
      if (template.found) return true;
      index = template.end;
      continue;
    }
    const ignoredEnd = skipIgnoredSourceRegion(source, index);
    if (ignoredEnd !== index) {
      index = ignoredEnd;
      continue;
    }
    for (let readerIndex = 0; readerIndex < readers.length; readerIndex += 1) {
      const reader = readers[readerIndex];
      const objectName = reader[0];
      const methodName = reader[1];
      const object = readStaticRootExpression(source, index, [objectName]);
      if (!object) continue;
      let cursor = skipStaticExpressionTrivia(source, object.end);
      let optionalMember = false;
      if (source[cursor] === "?" && source[cursor + 1] === ".") {
        optionalMember = true;
        cursor = skipStaticExpressionTrivia(source, cursor + 2);
      }
      let method: StaticStringExpression | null = null;
      if (source[cursor] === ".") {
        cursor = skipStaticExpressionTrivia(source, cursor + 1);
        const methodIdentifier = readIdentifierAt(source, cursor, methodName);
        if (!methodIdentifier) continue;
        method = methodIdentifier;
      } else if (source[cursor] === "[") {
        method = readStaticStringExpression(source, cursor + 1, "]");
        if (!method || method.value !== methodName) continue;
      } else if (optionalMember) {
        const methodIdentifier = readIdentifierAt(source, cursor, methodName);
        if (!methodIdentifier) continue;
        method = methodIdentifier;
      } else {
        continue;
      }
      cursor = skipStaticExpressionTrivia(source, method.end);
      while (source[cursor] === ")") {
        cursor = skipStaticExpressionTrivia(source, cursor + 1);
      }
      if (source[cursor] === "?" && source[cursor + 1] === ".") {
        cursor = skipStaticExpressionTrivia(source, cursor + 2);
      }
      if (source[cursor] !== "(") continue;
      const argumentRoot = readStaticRootExpression(source, cursor + 1, roots);
      if (!argumentRoot) continue;
      cursor = skipStaticExpressionTrivia(source, argumentRoot.end);
      if (reader[2] === "descriptor") {
        if (source[cursor] !== ")") continue;
        cursor = skipStaticExpressionTrivia(source, cursor + 1);
        while (source[cursor] === ")") {
          cursor = skipStaticExpressionTrivia(source, cursor + 1);
        }
        if (source[cursor] === "?" && source[cursor + 1] === ".") {
          cursor = skipStaticExpressionTrivia(source, cursor + 2);
        }
        if (source[cursor] !== "[") continue;
        if (staticExpressionMayImport(source, cursor + 1, "]")) return true;
        continue;
      }
      if (source[cursor] !== ",") continue;
      if (
        staticExpressionMayImport(source, cursor + 1, ")") ||
        staticExpressionMayImport(source, cursor + 1, ",")
      ) {
        return true;
      }
    }
    index += 1;
  }
  return false;
}


function createBlockedModuleLoader(): () => never {
  const loader = function (): never {
    throw new Error("Module loading is disabled in extension context");
  };
  return Object.freeze(loader);
}
const BLOCKED_MODULE_LOADER = createBlockedModuleLoader();

const BLOCKED_BUN_APIS = BLOCKED_BUN_API_NAMES;
const BLOCKED_PROCESS_APIS = BLOCKED_PROCESS_API_NAMES;
type ImmutableBunSurface = {
  value: unknown;
  descriptor: PropertyDescriptor;
};

const IMMUTABLE_BUN_SURFACES = new Map<string, ImmutableBunSurface>();
if (typeof Bun !== "undefined") {
  for (const api of BLOCKED_BUN_APIS) {
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Bun, api);
    if (
      descriptor &&
      !descriptor.configurable &&
      (
        !("value" in descriptor) ||
        descriptor.writable === false
      )
    ) {
      IMMUTABLE_BUN_SURFACES.set(api, {
        value: "value" in descriptor ? descriptor.value : undefined,
        descriptor,
      });
    }
  }
}

/** Mask sensitive env vars so extensions cannot exfiltrate credentials. */
function scrubSensitiveEnv(rawEnv: NodeJS.ProcessEnv): void {
  for (const key of SAFE_REFLECT_OWN_KEYS(rawEnv)) {
    if (typeof key !== "string" || !isSensitiveEnvironmentKey(key)) continue;
    try {
      delete rawEnv[key];
    } catch (error) {
      throw sandboxSurfaceError(`environment variable ${key}`, error);
    }
    if (SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(rawEnv, key) !== undefined) {
      throw sandboxSurfaceError(`environment variable ${key}`);
    }
    let current = SAFE_OBJECT_GET_PROTOTYPE_OF(rawEnv);
    while (current) {
      if (SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(current, key)) {
        throw sandboxSurfaceError(`environment variable ${key}`);
      }
      current = SAFE_OBJECT_GET_PROTOTYPE_OF(current);
    }
  }
}

function verifyRawEnv(rawEnv: NodeJS.ProcessEnv, surface: string): void {
  if (SAFE_OBJECT_IS_EXTENSIBLE(rawEnv)) {
    throw sandboxSurfaceError(surface);
  }
  for (const key of SAFE_REFLECT_OWN_KEYS(rawEnv)) {
    if (typeof key === "string" && isSensitiveEnvironmentKey(key)) {
      throw sandboxSurfaceError(surface);
    }
  }
  for (const key of SAFE_OBJECT_KEYS(rawEnv)) {
    if (isSensitiveEnvironmentKey(key)) {
      throw sandboxSurfaceError(surface);
    }
  }
}

function createMaskedEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return new Proxy(rawEnv, {
    get(target, prop) {
      if (typeof prop === "string" && isSensitiveEnvironmentKey(prop)) {
        return undefined;
      }
      return SAFE_REFLECT_GET(target, prop);
    },
    set(target, prop, value) {
      if (typeof prop === "string" && isSensitiveEnvironmentKey(prop)) {
        throw new Error(
          `Setting sensitive env var '${prop}' is blocked in extension context`,
        );
      }
      return SAFE_REFLECT_SET(target, prop, value);
    },
    ownKeys(target) {
      return SAFE_REFLECT_OWN_KEYS(target).filter((key) => {
        return typeof key !== "string" || !isSensitiveEnvironmentKey(key);
      });
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string" && isSensitiveEnvironmentKey(prop)) {
        return undefined;
      }
      return SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(target, prop);
    },
  });
}

function verifyMaskedEnv(
  maskedEnv: NodeJS.ProcessEnv,
  rawEnv: NodeJS.ProcessEnv,
  surface: string,
): void {
  verifyRawEnv(rawEnv, surface);
  for (const key of SAFE_REFLECT_OWN_KEYS(maskedEnv)) {
    if (typeof key === "string" && isSensitiveEnvironmentKey(key)) {
      throw sandboxSurfaceError(surface);
    }
  }
  for (const key of SAFE_OBJECT_KEYS(maskedEnv)) {
    if (isSensitiveEnvironmentKey(key)) {
      throw sandboxSurfaceError(surface);
    }
  }
}
function rejectUnsafeDynamicSource(source: string): void {
  if (containsStaticComputedImportProperty(source)) {
    throw new Error(
      "Dynamic code is blocked in extension context: module loading",
    );
  }
  for (let index = 0; index < RUNTIME_MODULE_TOKENS.length; index += 1) {
    if (containsIdentifier(source, RUNTIME_MODULE_TOKENS[index])) {
      throw new Error(
        "Dynamic code is blocked in extension context: module loading",
      );
    }
  }
  if (
    containsPrimitive(source, "req") &&
    (
      containsIdentifier(source, "globalThis") ||
      containsIdentifier(source, "global") ||
      containsIdentifier(source, "self")
    )
  ) {
    throw new Error(
      "Dynamic code is blocked in extension context: module loading",
    );
  }
}

function coerceDynamicConstructorArguments(
  args: ArrayLike<unknown>,
): unknown[] {
  const coerced = new SAFE_ARRAY<unknown>(args.length);
  for (let index = 0; index < args.length; index += 1) {
    const value = SAFE_STRING(args[index]);
    coerced[index] = value;
    rejectUnsafeDynamicSource(value);
  }
  return coerced;
}

function createGuardedDynamicConstructor(original: Function): Function {
  const target = function (this: unknown): unknown {
    const coerced = coerceDynamicConstructorArguments(arguments);
    return SAFE_REFLECT_APPLY(original, this, coerced);
  };
  let proxy: Function;
  proxy = new Proxy(target, {
    apply(_target, thisArg, args) {
      const coerced = coerceDynamicConstructorArguments(args);
      return SAFE_REFLECT_APPLY(original, thisArg, coerced);
    },
    construct(_target, args, newTarget) {
      const coerced = coerceDynamicConstructorArguments(args);
      const effectiveNewTarget = newTarget === proxy ? original : newTarget;
      return SAFE_REFLECT_CONSTRUCT(original, coerced, effectiveNewTarget);
    },
  });

  const originalPrototype = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    original,
    "prototype",
  )?.value;
  if (!isRuntimeObject(originalPrototype)) {
    throw sandboxSurfaceError("dynamic constructor prototype");
  }
  const targetPrototype = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
    target,
    "prototype",
  )?.value;
  if (!isRuntimeObject(targetPrototype)) {
    throw sandboxSurfaceError("dynamic wrapper prototype");
  }
  const guardedPrototype = SAFE_OBJECT_CREATE(
    SAFE_OBJECT_GET_PROTOTYPE_OF(originalPrototype),
  );
  SAFE_OBJECT_DEFINE_PROPERTIES(
    guardedPrototype,
    SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(originalPrototype),
  );
  SAFE_OBJECT_DEFINE_PROPERTY(target, "prototype", {
    value: guardedPrototype,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  SAFE_OBJECT_DEFINE_PROPERTY(guardedPrototype, "constructor", {
    value: proxy,
    writable: true,
    configurable: true,
  });
  SAFE_OBJECT_DEFINE_PROPERTY(proxy, Symbol.hasInstance, {
    value(value: unknown): boolean {
      return Boolean(
        SAFE_REFLECT_APPLY(SAFE_FUNCTION_HAS_INSTANCE, original, [value]),
      );
    },
    configurable: true,
  });
  if (
    SAFE_REFLECT_GET(proxy, "prototype") !== guardedPrototype ||
    SAFE_REFLECT_GET(guardedPrototype, "constructor") !== proxy
  ) {
    throw sandboxSurfaceError("dynamic constructor wrapper");
  }
  return proxy;
}

function createGuardedEval(original: Function): Function {
  const target = function (this: unknown): unknown {
    const source = arguments[0];
    if (typeof source === "string") rejectUnsafeDynamicSource(source);
    return SAFE_REFLECT_APPLY(original, this, arguments);
  };
  let proxy: Function;
  proxy = new Proxy(target, {
    apply(_target, thisArg, args) {
      if (typeof args[0] === "string") rejectUnsafeDynamicSource(args[0]);
      return SAFE_REFLECT_APPLY(original, thisArg, args);
    },
    construct(_target, args, newTarget) {
      if (typeof args[0] === "string") rejectUnsafeDynamicSource(args[0]);
      const effectiveNewTarget = newTarget === proxy ? original : newTarget;
      return SAFE_REFLECT_CONSTRUCT(original, args, effectiveNewTarget);
    },
  });
  return proxy;
}

type GuardedConstructorEntry = readonly [RuntimeObject, Function];

function installDynamicCodeGuards(): void {
  const originalEval = SAFE_EVAL;
  if (typeof originalEval !== "function") {
    throw sandboxSurfaceError("dynamic code globals");
  }

  const guardedEval = createGuardedEval(originalEval);
  const guardedFunction = createGuardedDynamicConstructor(SAFE_FUNCTION_CONSTRUCTOR);
  const guardedAsyncFunction = createGuardedDynamicConstructor(
    SAFE_ASYNC_FUNCTION_CONSTRUCTOR,
  );
  const guardedGeneratorFunction = createGuardedDynamicConstructor(
    SAFE_GENERATOR_FUNCTION_CONSTRUCTOR,
  );
  const guardedAsyncGeneratorFunction = createGuardedDynamicConstructor(
    SAFE_ASYNC_GENERATOR_FUNCTION_CONSTRUCTOR,
  );
  const guardedConstructors: GuardedConstructorEntry[] = [
    [SAFE_FUNCTION_PROTOTYPE, guardedFunction],
    [SAFE_ASYNC_FUNCTION_PROTOTYPE, guardedAsyncFunction],
    [SAFE_GENERATOR_FUNCTION_PROTOTYPE, guardedGeneratorFunction],
    [SAFE_ASYNC_GENERATOR_FUNCTION_PROTOTYPE, guardedAsyncGeneratorFunction],
  ];

  assertGuardInstallable(globalThis, "eval", "eval");
  assertGuardInstallable(globalThis, "Function", "Function");
  for (const [prototype] of guardedConstructors) {
    assertGuardInstallable(prototype, "constructor", "constructor prototype");
  }
  for (const [prototype, constructor] of guardedConstructors) {
    installDataGuard(prototype, "constructor", constructor, "constructor prototype");
  }
  installDataGuard(globalThis, "eval", guardedEval, "eval");
  installDataGuard(globalThis, "Function", guardedFunction, "Function");
  for (const [prototype, constructor] of guardedConstructors) {
    verifyDataGuard(prototype, "constructor", constructor, "constructor prototype");
  }
}

function installBlockedDynamicCodeGuards(): void {
  const blockedFunction = function (): never {
    throw new Error("Function constructor is disabled in extension context");
  };
  const blockedFunctionPrototype = SAFE_OBJECT_CREATE(
    SAFE_OBJECT_GET_PROTOTYPE_OF(SAFE_FUNCTION_PROTOTYPE),
  );
  SAFE_OBJECT_DEFINE_PROPERTIES(
    blockedFunctionPrototype,
    SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(SAFE_FUNCTION_PROTOTYPE),
  );
  SAFE_OBJECT_DEFINE_PROPERTY(blockedFunctionPrototype, "constructor", {
    value: blockedFunction,
    writable: true,
    configurable: true,
  });
  SAFE_OBJECT_DEFINE_PROPERTY(blockedFunction, "prototype", {
    value: blockedFunctionPrototype,
    writable: true,
    configurable: false,
    enumerable: false,
  });
  const blockedEval = function (): never {
    throw new Error("eval is disabled in extension context");
  };
  const guardedConstructors: GuardedConstructorEntry[] = [
    [SAFE_FUNCTION_PROTOTYPE, blockedFunction],
    [SAFE_ASYNC_FUNCTION_PROTOTYPE, blockedFunction],
    [SAFE_GENERATOR_FUNCTION_PROTOTYPE, blockedFunction],
    [SAFE_ASYNC_GENERATOR_FUNCTION_PROTOTYPE, blockedFunction],
  ];
  assertGuardInstallable(globalThis, "eval", "eval");
  assertGuardInstallable(globalThis, "Function", "Function");
  for (const [prototype] of guardedConstructors) {
    assertGuardInstallable(prototype, "constructor", "constructor prototype");
  }
  for (const [prototype, constructor] of guardedConstructors) {
    installDataGuard(prototype, "constructor", constructor, "constructor prototype");
  }
  installDataGuard(globalThis, "eval", blockedEval, "eval");
  installDataGuard(globalThis, "Function", blockedFunction, "Function");
  for (const [prototype, constructor] of guardedConstructors) {
    verifyDataGuard(prototype, "constructor", constructor, "constructor prototype");
  }
}

function createDisabledSurfaceGuard(
  surface: string,
): Function {
  const guard = function (): never {
    throw new Error(`${surface} is disabled in extension context`);
  };
  return SAFE_OBJECT_FREEZE(guard);
}

function preflightModuleSurface(): void {
  const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(globalThis, "module");
  if (
    descriptor &&
    !descriptor.configurable &&
    (!("value" in descriptor) || !descriptor.writable)
  ) {
    throw new Error(MODULE_SURFACE_ERROR);
  }
}

function preflightGlobalLoaderSurfaces(): void {
  assertGuardInstallable(globalThis, "require", "global require");
  assertGuardInstallable(globalThis, "import", "global import");
}

function preflightGlobalApiSurfaces(): void {
  const globalObject = globalThis as Record<string, unknown>;
  for (const api of BLOCKED_GLOBAL_API_NAMES) {
    const descriptor = findPropertyDescriptor(globalObject, api);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      throw sandboxSurfaceError(`global ${api}`);
    }
    assertGuardInstallable(globalObject, api, `global ${api}`);
  }
}

function preflightDynamicCodeSurfaces(): void {
  for (const key of ["eval", "Function"] as const) {
    const descriptor = findPropertyDescriptor(globalThis, key);
    if (descriptor && !("value" in descriptor)) {
      throw sandboxSurfaceError(key);
    }
    assertGuardInstallable(globalThis, key, key);
  }
  for (const prototype of [
    SAFE_FUNCTION_PROTOTYPE,
    SAFE_ASYNC_FUNCTION_PROTOTYPE,
    SAFE_GENERATOR_FUNCTION_PROTOTYPE,
    SAFE_ASYNC_GENERATOR_FUNCTION_PROTOTYPE,
  ]) {
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(prototype, "constructor");
    if (descriptor && !("value" in descriptor)) {
      throw sandboxSurfaceError("constructor prototype");
    }
    assertGuardInstallable(prototype, "constructor", "constructor prototype");
  }
}

function isKnownImmutableBunSurface(
  api: string,
  descriptor: PropertyDescriptor | undefined,
): boolean {
  const baseline = IMMUTABLE_BUN_SURFACES.get(api);
  if (!baseline || !descriptor) return false;
  if (
    descriptor.configurable !== baseline.descriptor.configurable ||
    descriptor.writable !== baseline.descriptor.writable ||
    descriptor.enumerable !== baseline.descriptor.enumerable ||
    descriptor.get !== baseline.descriptor.get ||
    descriptor.set !== baseline.descriptor.set
  ) {
    return false;
  }
  return !("value" in descriptor) || descriptor.value === baseline.value;
}

function preflightBunSurfaces(): void {
  if (typeof Bun === "undefined") return;
  for (const api of BLOCKED_BUN_APIS) {
    if (api === "env") continue;
    const descriptor = findPropertyDescriptor(Bun, api);
    if (!descriptor) continue;
    if (isKnownImmutableBunSurface(api, descriptor)) continue;
    if (!("value" in descriptor)) {
      throw sandboxSurfaceError(`Bun.${api}`);
    }
    assertGuardInstallable(Bun, api, `Bun.${api}`);
  }
}

function preflightProcessSurfaces(): void {
  if (typeof process === "undefined") return;
  for (const api of BLOCKED_PROCESS_APIS) {
    const descriptor = findPropertyDescriptor(process, api);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      throw sandboxSurfaceError(`process.${api}`);
    }
    assertGuardInstallable(process, api, `process.${api}`);
  }
  const envDescriptor = findPropertyDescriptor(process, "env");
  if (envDescriptor && !("value" in envDescriptor)) {
    throw sandboxSurfaceError("process.env");
  }
  assertGuardInstallable(process, "env", "process.env");
}

function readDataSurface(
  target: RuntimeObject,
  key: PropertyKey,
  surface: string,
): unknown {
  const descriptor = findPropertyDescriptor(target, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw sandboxSurfaceError(surface);
  return descriptor.value;
}


function preflightEnvironmentValues(
  rawEnv: NodeJS.ProcessEnv,
  surface: string,
): void {
  for (const key of SAFE_REFLECT_OWN_KEYS(rawEnv)) {
    if (typeof key !== "string" || !isSensitiveEnvironmentKey(key)) continue;
    const descriptor = SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(rawEnv, key);
    if (!descriptor || descriptor.configurable !== true) {
      throw sandboxSurfaceError(`${surface}.${key}`);
    }
  }
  let current = SAFE_OBJECT_GET_PROTOTYPE_OF(rawEnv);
  while (current) {
    for (const key of SAFE_REFLECT_OWN_KEYS(current)) {
      if (typeof key === "string" && isSensitiveEnvironmentKey(key)) {
        throw sandboxSurfaceError(`${surface}.${key}`);
      }
    }
    current = SAFE_OBJECT_GET_PROTOTYPE_OF(current);
  }
}

function preflightEnvironmentSurfaces(): void {
  if (typeof process === "undefined") return;
  const rawProcessEnv = readDataSurface(process, "env", "process.env");
  if (isRuntimeObject(rawProcessEnv)) {
    preflightEnvironmentValues(rawProcessEnv as NodeJS.ProcessEnv, "process.env");
  }
  if (typeof Bun !== "undefined") {
    const bunEnv = readDataSurface(Bun, "env", "Bun.env");
    if (isRuntimeObject(bunEnv)) {
      preflightEnvironmentValues(bunEnv as NodeJS.ProcessEnv, "Bun.env");
    }
  }
}

function installGlobalLoaderSurfaces(): void {
  installDataGuard(
    globalThis,
    "import",
    BLOCKED_MODULE_LOADER,
    "global import",
  );
  installGlobalRequireSurface();
}

function installGlobalApiSurfaces(): void {
  const globalObject = globalThis as Record<string, unknown>;
  for (const api of BLOCKED_GLOBAL_API_NAMES) {
    const descriptor = findPropertyDescriptor(globalObject, api);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      throw sandboxSurfaceError(`global ${api}`);
    }
    if (descriptor.value === undefined) continue;
    installDataGuard(
      globalObject,
      api,
      createDisabledSurfaceGuard(api),
      `global ${api}`,
      SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(globalObject, api)?.enumerable === true,
    );
  }
}

function installBunSurfaces(): void {
  if (typeof Bun === "undefined") return;
  for (const api of BLOCKED_BUN_APIS) {
    if (api === "env") continue;
    const descriptor = findPropertyDescriptor(Bun, api);
    if (!descriptor) continue;
    if (isKnownImmutableBunSurface(api, descriptor)) continue;
    if (!("value" in descriptor)) {
      throw sandboxSurfaceError(`Bun.${api}`);
    }
    if (descriptor.value === undefined) continue;
    installDataGuard(
      Bun,
      api,
      createDisabledSurfaceGuard(`Bun.${api}`),
      `Bun.${api}`,
      SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(Bun, api)?.enumerable === true,
    );
  }
}

function installProcessSurfaces(): void {
  if (typeof process === "undefined") return;
  for (const api of BLOCKED_PROCESS_APIS) {
    const descriptor = findPropertyDescriptor(process, api);
    if (!descriptor) continue;
    if (!("value" in descriptor)) {
      throw sandboxSurfaceError(`process.${api}`);
    }
    if (descriptor.value === undefined) continue;
    installDataGuard(
      process,
      api,
      createDisabledSurfaceGuard(`process.${api}`),
      `process.${api}`,
      SAFE_OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(process, api)?.enumerable === true,
    );
  }
}

function installEnvironmentSurfaces(): void {
  if (typeof process === "undefined") return;
  const rawProcessEnvValue = readDataSurface(process, "env", "process.env");
  if (!isRuntimeObject(rawProcessEnvValue)) {
    throw sandboxSurfaceError("process.env");
  }
  const rawProcessEnv = rawProcessEnvValue as NodeJS.ProcessEnv;
  const rawEnvs: NodeJS.ProcessEnv[] = [rawProcessEnv];
  let bunEnvValue: unknown;
  if (typeof Bun !== "undefined") {
    bunEnvValue = readDataSurface(Bun, "env", "Bun.env");
    if (isRuntimeObject(bunEnvValue)) {
      const typedBunEnv = bunEnvValue as NodeJS.ProcessEnv;
      if (!rawEnvs.includes(typedBunEnv)) rawEnvs.push(typedBunEnv);
    }
  }
  for (const rawEnv of rawEnvs) {
    scrubSensitiveEnv(rawEnv);
    try {
      SAFE_OBJECT_PREVENT_EXTENSIONS(rawEnv);
    } catch (error) {
      throw sandboxSurfaceError("environment", error);
    }
    verifyRawEnv(rawEnv, "environment");
  }
  const maskedEnv = createMaskedEnv(rawProcessEnv);
  installDataGuard(process, "env", maskedEnv, "process.env");
  verifyMaskedEnv(maskedEnv, rawProcessEnv, "process.env");
  if (isRuntimeObject(bunEnvValue) && bunEnvValue !== rawProcessEnv) {
    verifyRawEnv(bunEnvValue as NodeJS.ProcessEnv, "Bun.env");
  }
}

export function initializeSandbox(options?: { allowDynamicCode?: boolean }): void {
  if (sandboxInitialized) return;
  const allowDynamicCode = options?.allowDynamicCode === true;

  // Preflight every replacement before mutating a host object. This keeps a
  // hostile descriptor from leaving a partially installed sandbox behind.
  preflightModuleSurface();
  preflightGlobalLoaderSurfaces();
  preflightGlobalApiSurfaces();
  preflightDynamicCodeSurfaces();
  preflightBunSurfaces();
  preflightProcessSurfaces();
  preflightEnvironmentSurfaces();

  // The dynamic-code capability only opts out of blocking eval/constructors.
  // Loader, network, filesystem, process, environment, and Bun guards remain.
  installModuleSurface();
  installGlobalLoaderSurfaces();
  installGlobalApiSurfaces();
  if (allowDynamicCode) installDynamicCodeGuards();
  else installBlockedDynamicCodeGuards();
  installBunSurfaces();
  installProcessSurfaces();
  installEnvironmentSurfaces();
  sandboxInitialized = true;
}
