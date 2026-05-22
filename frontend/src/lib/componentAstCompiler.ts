import { parse } from '@babel/parser'
import type { ComponentAstBinding, ComponentAstDiagnostic, ComponentAstProgram } from './componentAstTypes'
import {
  ALLOWED_ACTION_PATHS,
  ALLOWED_GLOBAL_IDENTIFIERS,
  ALLOWED_JSX_TAGS,
  FORBIDDEN_IDENTIFIERS,
  FORBIDDEN_PROPERTY_NAMES,
  MAX_AST_NODES,
  MAX_OVERRIDE_SOURCE_LENGTH,
  isAllowedJsxProp,
} from './componentOverrideCapabilities'

type Node = any

export type ComponentAstCompileResult =
  | { program: ComponentAstProgram; error: null }
  | { program: null; error: ComponentAstDiagnostic }

class ValidationError extends Error {
  line?: number
  column?: number

  constructor(message: string, node?: Node) {
    super(message)
    this.line = node?.loc?.start?.line
    this.column = node?.loc?.start?.column != null ? node.loc.start.column + 1 : undefined
  }
}

export function formatAstDiagnostic(error: ComponentAstDiagnostic): string {
  if (error.line && error.column) return `${error.message} (${error.line}:${error.column})`
  if (error.line) return `${error.message} (${error.line})`
  return error.message
}

export function compileComponentAst(source: string): ComponentAstCompileResult {
  if (!source.trim()) return { program: null, error: { message: 'Override source is empty.' } }
  if (source.length > MAX_OVERRIDE_SOURCE_LENGTH) {
    return {
      program: null,
      error: { message: `Override source is too large (max ${MAX_OVERRIDE_SOURCE_LENGTH.toLocaleString()} characters).` },
    }
  }

  let ast: Node
  try {
    ast = parse(source, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      errorRecovery: false,
    })
  } catch (error) {
    const e = error as any
    return {
      program: null,
      error: {
        message: `Syntax error: ${e.message}`,
        line: e.loc?.line,
        column: e.loc?.column != null ? e.loc.column + 1 : undefined,
      },
    }
  }

  try {
    enforceAstBudget(ast)
    return { program: validateProgram(source, ast), error: null }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { program: null, error: { message: error.message, line: error.line, column: error.column } }
    }
    return { program: null, error: { message: (error as Error).message } }
  }
}

function enforceAstBudget(root: Node) {
  let count = 0
  walkAny(root, () => {
    count += 1
    if (count > MAX_AST_NODES) throw new ValidationError(`Override is too complex (max ${MAX_AST_NODES.toLocaleString()} AST nodes).`)
  })
}

function validateProgram(source: string, file: Node): ComponentAstProgram {
  const body = file.program?.body || []
  if (body.length !== 1 || body[0].type !== 'ExportDefaultDeclaration') {
    throw new ValidationError('Override must contain exactly one `export default function Component(...) { ... }` declaration.', body[0])
  }

  const declaration = body[0].declaration
  if (declaration.type !== 'FunctionDeclaration') {
    throw new ValidationError('Default export must be a named function declaration.', declaration)
  }
  if (!declaration.id?.name) throw new ValidationError('Default function must have a name.', declaration)
  if (declaration.async || declaration.generator) throw new ValidationError('Async and generator components are not supported.', declaration)
  if (declaration.params.length !== 1) throw new ValidationError('Component function must accept exactly one props parameter.', declaration)

  const params = validateParams(declaration.params[0])
  const scope = new Set<string>()
  if (params.kind === 'identifier') scope.add(params.name)
  else for (const binding of params.bindings) scope.add(binding.local)

  const statements = declaration.body.body || []
  const declarations = []
  let returnNode: Node | null = null

  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration') {
      if (returnNode) throw new ValidationError('Local declarations must appear before the return statement.', statement)
      if (statement.kind !== 'const') throw new ValidationError('Only `const` local declarations are supported.', statement)
      for (const item of statement.declarations) {
        if (item.id.type !== 'Identifier') throw new ValidationError('Only simple const identifiers are supported.', item.id)
        if (!item.init) throw new ValidationError('Const declarations must have an initializer.', item)
        validateExpression(item.init, scope, { allowJsx: false })
        scope.add(item.id.name)
        declarations.push({ name: item.id.name, init: item.init })
      }
      continue
    }

    if (statement.type === 'ReturnStatement') {
      if (returnNode) throw new ValidationError('Only one return statement is supported.', statement)
      if (!statement.argument) throw new ValidationError('Component must return JSX.', statement)
      validateRenderable(statement.argument, scope)
      returnNode = statement.argument
      continue
    }

    throw new ValidationError('Only const declarations followed by a JSX return are supported.', statement)
  }

  if (!returnNode) throw new ValidationError('Component must return JSX.', declaration.body)

  return { source, functionName: declaration.id.name, params, declarations, returnNode }
}

function validateParams(param: Node): ComponentAstProgram['params'] {
  if (param.type === 'Identifier') return { kind: 'identifier', name: param.name }
  if (param.type !== 'ObjectPattern') throw new ValidationError('Props parameter must be an identifier or object destructuring pattern.', param)

  const bindings: ComponentAstBinding[] = []
  for (const property of param.properties) {
    if (property.type === 'RestElement') throw new ValidationError('Rest props are not supported.', property)
    if (property.type !== 'ObjectProperty' || property.computed) {
      throw new ValidationError('Only simple object destructuring is supported.', property)
    }
    const prop = property.key.type === 'Identifier' ? property.key.name : property.key.value
    if (typeof prop !== 'string') throw new ValidationError('Destructured prop names must be strings.', property.key)
    if (property.value.type !== 'Identifier') throw new ValidationError('Nested/default destructuring is not supported.', property.value)
    bindings.push({ prop, local: property.value.name })
  }
  return { kind: 'destructure', bindings }
}

function validateRenderable(node: Node, scope: Set<string>) {
  if (isJsxNode(node)) {
    validateJsx(node, scope)
    return
  }
  validateExpression(node, scope, { allowJsx: true })
}

function validateJsx(node: Node, scope: Set<string>) {
  if (node.type === 'JSXFragment') {
    for (const child of node.children || []) validateJsxChild(child, scope)
    return
  }
  if (node.type !== 'JSXElement') throw new ValidationError('Expected JSX.', node)

  const tag = getJsxTagName(node.openingElement.name)
  if (!tag || !ALLOWED_JSX_TAGS.has(tag)) throw new ValidationError(`JSX tag <${tag || 'unknown'}> is not supported.`, node.openingElement.name)

  for (const attribute of node.openingElement.attributes || []) {
    if (attribute.type === 'JSXSpreadAttribute') throw new ValidationError('JSX spread props are not supported.', attribute)
    const prop = getJsxAttributeName(attribute.name)
    if (!prop || !isAllowedJsxProp(tag, prop)) throw new ValidationError(`Prop \`${prop || 'unknown'}\` is not supported on <${tag}>.`, attribute)
    if (!attribute.value) continue
    if (attribute.value.type === 'StringLiteral') continue
    if (attribute.value.type !== 'JSXExpressionContainer' || attribute.value.expression.type === 'JSXEmptyExpression') {
      throw new ValidationError(`Prop \`${prop}\` must be a string or safe expression.`, attribute.value)
    }
    if (prop.startsWith('on')) validateActionBinding(attribute.value.expression)
    else validateExpression(attribute.value.expression, scope, { allowJsx: false })
  }

  for (const child of node.children || []) validateJsxChild(child, scope)
}

function validateJsxChild(child: Node, scope: Set<string>) {
  if (child.type === 'JSXText') return
  if (child.type === 'JSXElement' || child.type === 'JSXFragment') return validateJsx(child, scope)
  if (child.type === 'JSXExpressionContainer') {
    if (child.expression.type === 'JSXEmptyExpression') return
    validateExpression(child.expression, scope, { allowJsx: true })
    return
  }
  throw new ValidationError('Unsupported JSX child.', child)
}

function validateExpression(node: Node, scope: Set<string>, options: { allowJsx: boolean }) {
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
    case 'NullLiteral':
      return
    case 'Identifier':
      validateIdentifier(node, scope)
      return
    case 'ThisExpression':
    case 'Super':
      throw new ValidationError('`this` and `super` are not supported.', node)
    case 'TemplateLiteral':
      for (const expression of node.expressions || []) validateExpression(expression, scope, { allowJsx: false })
      return
    case 'UnaryExpression':
      if (!['!', '+', '-'].includes(node.operator)) throw new ValidationError(`Unary operator ${node.operator} is not supported.`, node)
      validateExpression(node.argument, scope, { allowJsx: false })
      return
    case 'BinaryExpression':
      if (!['===', '!==', '>', '>=', '<', '<=', '+', '-', '*', '/', '%'].includes(node.operator)) {
        throw new ValidationError(`Binary operator ${node.operator} is not supported.`, node)
      }
      validateExpression(node.left, scope, { allowJsx: false })
      validateExpression(node.right, scope, { allowJsx: false })
      return
    case 'LogicalExpression':
      if (!['&&', '||', '??'].includes(node.operator)) throw new ValidationError(`Logical operator ${node.operator} is not supported.`, node)
      validateExpression(node.left, scope, { allowJsx: false })
      if (options.allowJsx && isJsxNode(node.right)) validateJsx(node.right, scope)
      else validateExpression(node.right, scope, options)
      return
    case 'ConditionalExpression':
      validateExpression(node.test, scope, { allowJsx: false })
      validateExpressionOrJsx(node.consequent, scope, options)
      validateExpressionOrJsx(node.alternate, scope, options)
      return
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      validateMemberExpression(node, scope)
      return
    case 'ObjectExpression':
      for (const property of node.properties || []) {
        if (property.type === 'SpreadElement') throw new ValidationError('Object spread is not supported.', property)
        if (property.computed) throw new ValidationError('Computed object keys are not supported.', property)
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value
        if (FORBIDDEN_PROPERTY_NAMES.has(key)) throw new ValidationError(`Object key \`${key}\` is not allowed.`, property.key)
        validateExpression(property.value, scope, { allowJsx: false })
      }
      return
    case 'ArrayExpression':
      for (const element of node.elements || []) {
        if (!element) throw new ValidationError('Sparse arrays are not supported.', node)
        validateExpression(element, scope, { allowJsx: false })
      }
      return
    case 'CallExpression':
    case 'OptionalCallExpression':
      validateCallExpression(node, scope, options)
      return
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      throw new ValidationError('Function expressions are only supported inside allowlisted `.map()` calls.', node)
    case 'AssignmentExpression':
    case 'UpdateExpression':
    case 'SequenceExpression':
    case 'NewExpression':
    case 'TaggedTemplateExpression':
    case 'AwaitExpression':
    case 'YieldExpression':
      throw new ValidationError(`${node.type} is not supported in component overrides.`, node)
    default:
      if (isJsxNode(node) && options.allowJsx) return validateJsx(node, scope)
      throw new ValidationError(`${node.type} is not supported in component overrides.`, node)
  }
}

function validateExpressionOrJsx(node: Node, scope: Set<string>, options: { allowJsx: boolean }) {
  if (options.allowJsx && isJsxNode(node)) validateJsx(node, scope)
  else validateExpression(node, scope, options)
}

function validateIdentifier(node: Node, scope: Set<string>) {
  if (FORBIDDEN_IDENTIFIERS.has(node.name)) throw new ValidationError(`Identifier \`${node.name}\` is not allowed.`, node)
  if (!scope.has(node.name) && !ALLOWED_GLOBAL_IDENTIFIERS.has(node.name)) {
    throw new ValidationError(`Identifier \`${node.name}\` is not available in component overrides.`, node)
  }
}

function validateMemberExpression(node: Node, scope: Set<string>) {
  if (node.computed) throw new ValidationError('Computed property access is not supported. Use direct dot access.', node)
  validateExpression(node.object, scope, { allowJsx: false })
  const property = node.property?.name
  if (!property) throw new ValidationError('Only direct dot property access is supported.', node.property)
  if (FORBIDDEN_PROPERTY_NAMES.has(property)) throw new ValidationError(`Property \`${property}\` is not allowed.`, node.property)
}

function validateCallExpression(node: Node, scope: Set<string>, options: { allowJsx: boolean }) {
  if (node.callee.type === 'Identifier' && node.callee.name === 'clsx') {
    for (const arg of node.arguments || []) validateExpression(arg, scope, { allowJsx: false })
    return
  }

  if (isMapCall(node)) {
    validateExpression(node.callee.object, scope, { allowJsx: false })
    if (node.arguments.length !== 1) throw new ValidationError('`.map()` overrides must use exactly one callback.', node)
    const callback = node.arguments[0]
    if (callback.type !== 'ArrowFunctionExpression') throw new ValidationError('`.map()` callback must be an arrow function.', callback)
    if (callback.params.length !== 1 || callback.params[0].type !== 'Identifier') {
      throw new ValidationError('`.map()` callback must use one simple item parameter.', callback)
    }
    const childScope = new Set(scope)
    childScope.add(callback.params[0].name)
    if (callback.body.type === 'BlockStatement') throw new ValidationError('`.map()` callback must directly return JSX.', callback.body)
    if (options.allowJsx && isJsxNode(callback.body)) validateJsx(callback.body, childScope)
    else validateExpression(callback.body, childScope, options)
    return
  }

  throw new ValidationError('Function calls are not supported except `clsx(...)` and allowlisted `.map(...)` rendering.', node)
}

function validateActionBinding(node: Node) {
  const path = getMemberPath(node)
  if (!path || !ALLOWED_ACTION_PATHS.has(path)) {
    throw new ValidationError(`Only allowlisted action bindings are supported for events. Use ${Array.from(ALLOWED_ACTION_PATHS).join(', ')}.`, node)
  }
}

function isMapCall(node: Node): boolean {
  return (
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'map'
  )
}

export function getMemberPath(node: Node): string | null {
  if (node.type === 'Identifier') return node.name
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed) {
    const left = getMemberPath(node.object)
    const right = node.property?.name
    return left && right ? `${left}.${right}` : null
  }
  return null
}

function getJsxTagName(name: Node): string | null {
  if (name.type === 'JSXIdentifier') return name.name
  return null
}

function getJsxAttributeName(name: Node): string | null {
  if (name.type === 'JSXIdentifier') return name.name
  if (name.type === 'JSXNamespacedName') return `${name.namespace.name}:${name.name.name}`
  return null
}

function isJsxNode(node: Node): boolean {
  return node?.type === 'JSXElement' || node?.type === 'JSXFragment'
}

function walkAny(value: unknown, visit: (node: Node) => void) {
  if (!value || typeof value !== 'object') return
  const node = value as Node
  if (typeof node.type === 'string') visit(node)
  for (const [key, child] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue
    if (Array.isArray(child)) {
      for (const item of child) walkAny(item, visit)
    } else {
      walkAny(child, visit)
    }
  }
}
