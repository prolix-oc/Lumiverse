import React from 'react'
import clsx from 'clsx'
import { getMemberPath } from './componentAstCompiler'
import type {
  ComponentAstProgram,
  RuntimeOverrideContext,
  SafeActionBinding,
  SafePropPrimitive,
  SafePropValue,
  SafeRenderNode,
  TrustedOverrideComponent,
} from './componentAstTypes'
import {
  ALLOWED_EVENT_PROPS,
  ALLOWED_JSX_TAGS,
  FORBIDDEN_PROPERTY_NAMES,
  MAX_MAP_ITEMS,
  MAX_RENDER_DEPTH,
  MAX_RENDER_NODES,
  isAllowedJsxProp,
  isUrlProp,
  sanitizeUrl,
} from './componentOverrideCapabilities'

type Node = any
type Scope = Record<string, unknown>

interface RenderBudget {
  count: number
}

export function createTrustedOverrideComponent(program: ComponentAstProgram): TrustedOverrideComponent {
  function TrustedAstOverride(props: Record<string, unknown>) {
    const context: RuntimeOverrideContext = {
      props,
      actions: typeof props.actions === 'object' && props.actions ? props.actions as Record<string, unknown> : {},
    }
    const scope = createInitialScope(program, props)

    for (const declaration of program.declarations) {
      scope[declaration.name] = evaluateExpression(declaration.init as Node, scope)
    }

    const tree = renderNode(program.returnNode as Node, scope, { count: 0 }, 0)
    return renderSafeNode(tree, context, 'root')
  }

  TrustedAstOverride.displayName = `TrustedAstOverride(${program.functionName})`
  return TrustedAstOverride
}

function createInitialScope(program: ComponentAstProgram, props: Record<string, unknown>): Scope {
  const safeProps = toPlainData(props)
  const scope: Scope = { clsx, undefined }
  if (program.params.kind === 'identifier') {
    scope[program.params.name] = safeProps
  } else {
    for (const binding of program.params.bindings) {
      scope[binding.local] = (safeProps as Record<string, unknown>)[binding.prop]
    }
  }
  return scope
}

function renderNode(node: Node, scope: Scope, budget: RenderBudget, depth: number): SafeRenderNode | SafeRenderNode[] | null {
  if (depth > MAX_RENDER_DEPTH) throw new Error(`Override render tree is too deep (max ${MAX_RENDER_DEPTH}).`)
  budget.count += 1
  if (budget.count > MAX_RENDER_NODES) throw new Error(`Override rendered too many nodes (max ${MAX_RENDER_NODES.toLocaleString()}).`)

  if (node.type === 'JSXFragment') {
    return { kind: 'fragment', children: renderChildren(node.children || [], scope, budget, depth + 1) }
  }

  if (node.type === 'JSXElement') {
    const tag = getJsxTagName(node.openingElement.name)
    if (!tag || !ALLOWED_JSX_TAGS.has(tag)) throw new Error(`JSX tag <${tag || 'unknown'}> is not supported.`)
    const props = renderProps(tag, node.openingElement.attributes || [], scope)
    return { kind: 'element', tag, props, children: renderChildren(node.children || [], scope, budget, depth + 1) }
  }

  if (node.type === 'LogicalExpression') {
    if (node.operator === '&&') return evaluateExpression(node.left, scope) ? renderNode(node.right, scope, budget, depth + 1) : null
    if (node.operator === '||') {
      const left = evaluateExpression(node.left, scope)
      return left ? primitiveToRenderNode(left) : renderNode(node.right, scope, budget, depth + 1)
    }
    const left = evaluateExpression(node.left, scope)
    return left != null ? primitiveToRenderNode(left) : renderNode(node.right, scope, budget, depth + 1)
  }

  if (node.type === 'ConditionalExpression') {
    return renderNode(evaluateExpression(node.test, scope) ? node.consequent : node.alternate, scope, budget, depth + 1)
  }

  if (node.type === 'CallExpression' && isMapCall(node)) {
    const items = evaluateExpression(node.callee.object, scope)
    if (!Array.isArray(items)) return null
    const callback = node.arguments[0]
    const param = callback.params[0].name
    return items.slice(0, MAX_MAP_ITEMS).flatMap((item) => {
      const childScope = { ...scope, [param]: item }
      const rendered = renderNode(callback.body, childScope, budget, depth + 1)
      return Array.isArray(rendered) ? rendered : rendered ? [rendered] : []
    })
  }

  if (node.type === 'NullLiteral') return null
  if (node.type === 'BooleanLiteral' && node.value === false) return null

  const value = evaluateExpression(node, scope)
  return primitiveToRenderNode(value)
}

function renderChildren(children: Node[], scope: Scope, budget: RenderBudget, depth: number): SafeRenderNode[] {
  const output: SafeRenderNode[] = []
  for (const child of children) {
    if (child.type === 'JSXText') {
      const text = child.value.replace(/\s+/g, ' ')
      if (text.trim()) output.push({ kind: 'text', value: text })
      continue
    }
    if (child.type === 'JSXExpressionContainer') {
      if (child.expression.type === 'JSXEmptyExpression') continue
      const rendered = renderNode(child.expression, scope, budget, depth + 1)
      if (Array.isArray(rendered)) output.push(...rendered)
      else if (rendered) output.push(rendered)
      continue
    }
    const rendered = renderNode(child, scope, budget, depth + 1)
    if (Array.isArray(rendered)) output.push(...rendered)
    else if (rendered) output.push(rendered)
  }
  return output
}

function renderProps(tag: string, attributes: Node[], scope: Scope): Record<string, SafePropValue> {
  const props: Record<string, SafePropValue> = {}
  for (const attribute of attributes) {
    const prop = getJsxAttributeName(attribute.name)
    if (!prop || !isAllowedJsxProp(tag, prop)) continue
    if (!attribute.value) {
      props[prop] = true
      continue
    }
    if (attribute.value.type === 'StringLiteral') {
      props[prop] = isUrlProp(prop) ? sanitizeUrl(attribute.value.value) : attribute.value.value
      continue
    }
    if (attribute.value.type !== 'JSXExpressionContainer' || attribute.value.expression.type === 'JSXEmptyExpression') continue
    if (ALLOWED_EVENT_PROPS.has(prop)) {
      const path = getMemberPath(attribute.value.expression)
      if (path) props[prop] = { kind: 'action', path }
      continue
    }
    const value = sanitizePropValue(prop, evaluateExpression(attribute.value.expression, scope))
    if (value !== undefined) props[prop] = value
  }
  return props
}

function evaluateExpression(node: Node, scope: Scope): unknown {
  switch (node.type) {
    case 'StringLiteral':
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return node.value
    case 'NullLiteral':
      return null
    case 'Identifier':
      return scope[node.name]
    case 'TemplateLiteral':
      return node.quasis.reduce((text: string, quasi: Node, index: number) => {
        const expression = node.expressions[index]
        return text + quasi.value.cooked + (expression ? stringifySafe(evaluateExpression(expression, scope)) : '')
      }, '')
    case 'UnaryExpression': {
      const value = evaluateExpression(node.argument, scope) as any
      if (node.operator === '!') return !value
      if (node.operator === '+') return +value
      if (node.operator === '-') return -value
      return undefined
    }
    case 'BinaryExpression':
      return evaluateBinary(node.operator, evaluateExpression(node.left, scope), evaluateExpression(node.right, scope))
    case 'LogicalExpression': {
      const left = evaluateExpression(node.left, scope)
      if (node.operator === '&&') return left && evaluateExpression(node.right, scope)
      if (node.operator === '||') return left || evaluateExpression(node.right, scope)
      return left ?? evaluateExpression(node.right, scope)
    }
    case 'ConditionalExpression':
      return evaluateExpression(evaluateExpression(node.test, scope) ? node.consequent : node.alternate, scope)
    case 'MemberExpression':
    case 'OptionalMemberExpression': {
      const object = evaluateExpression(node.object, scope) as Record<string, unknown> | null | undefined
      if (object == null) return undefined
      const value = object[node.property.name]
      return typeof value === 'function' ? undefined : value
    }
    case 'ObjectExpression': {
      const output: Record<string, unknown> = {}
      for (const property of node.properties || []) {
        const key = property.key.type === 'Identifier' ? property.key.name : property.key.value
        if (FORBIDDEN_PROPERTY_NAMES.has(key)) continue
        output[key] = evaluateExpression(property.value, scope)
      }
      return toPlainData(output)
    }
    case 'ArrayExpression':
      return (node.elements || []).map((element: Node) => evaluateExpression(element, scope))
    case 'CallExpression':
      if (node.callee.type === 'Identifier' && node.callee.name === 'clsx') {
        return clsx(...(node.arguments || []).map((arg: Node) => evaluateExpression(arg, scope)))
      }
      if (isMapCall(node)) {
        const items = evaluateExpression(node.callee.object, scope)
        if (!Array.isArray(items)) return []
        const callback = node.arguments[0]
        const param = callback.params[0].name
        return items.slice(0, MAX_MAP_ITEMS).map((item) => evaluateExpression(callback.body, { ...scope, [param]: item }))
      }
      return undefined
    default:
      return undefined
  }
}

function evaluateBinary(operator: string, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '===': return left === right
    case '!==': return left !== right
    case '>': return (left as any) > (right as any)
    case '>=': return (left as any) >= (right as any)
    case '<': return (left as any) < (right as any)
    case '<=': return (left as any) <= (right as any)
    case '+': return (left as any) + (right as any)
    case '-': return (left as any) - (right as any)
    case '*': return (left as any) * (right as any)
    case '/': return (left as any) / (right as any)
    case '%': return (left as any) % (right as any)
    default: return undefined
  }
}

function primitiveToRenderNode(value: unknown): SafeRenderNode | SafeRenderNode[] | null {
  if (Array.isArray(value)) return value.flatMap((item) => {
    const node = primitiveToRenderNode(item)
    return Array.isArray(node) ? node : node ? [node] : []
  })
  if (value == null || typeof value === 'boolean') return null
  if (typeof value === 'string' || typeof value === 'number') return { kind: 'text', value: String(value) }
  return null
}

function renderSafeNode(node: SafeRenderNode | SafeRenderNode[] | null, context: RuntimeOverrideContext, key: string): React.ReactNode {
  if (Array.isArray(node)) return node.map((child, index) => renderSafeNode(child, context, `${key}:${index}`))
  if (!node) return null
  if (node.kind === 'text') return node.value
  if (node.kind === 'fragment') return <React.Fragment key={key}>{node.children.map((child, index) => renderSafeNode(child, context, `${key}:${index}`))}</React.Fragment>

  if (!ALLOWED_JSX_TAGS.has(node.tag)) return null
  const props: Record<string, unknown> = { key }
  for (const [prop, value] of Object.entries(node.props)) {
    if (!isAllowedJsxProp(node.tag, prop)) continue
    if (isActionBinding(value)) {
      const action = resolveAction(value, context)
      if (action) props[prop] = action
      continue
    }
    props[prop] = sanitizePropValue(prop, value)
  }
  return React.createElement(node.tag, props, ...node.children.map((child, index) => renderSafeNode(child, context, `${key}:${index}`)))
}

function resolveAction(binding: SafeActionBinding, context: RuntimeOverrideContext): (() => void) | undefined {
  const parts = binding.path.split('.')
  let value: unknown = parts[0] === 'actions' ? context.actions : context.props[parts[0]]
  for (const part of parts.slice(1)) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined
  return typeof value === 'function' ? () => { void value() } : undefined
}

function sanitizePropValue(prop: string, value: unknown): SafePropValue | undefined {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return typeof value === 'string' && isUrlProp(prop) ? sanitizeUrl(value) : value as SafePropPrimitive
  }
  if (Array.isArray(value)) {
    const safe = value.filter(isSafePrimitive)
    return safe.length === value.length ? safe : undefined
  }
  if (prop === 'style' && typeof value === 'object') {
    const style: Record<string, SafePropPrimitive> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PROPERTY_NAMES.has(key)) continue
      if (isSafePrimitive(item)) style[key] = item
    }
    return style
  }
  return undefined
}

function toPlainData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined
  if (Array.isArray(value)) return value.map((item) => toPlainData(item, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) return undefined
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_PROPERTY_NAMES.has(key)) continue
      const safe = toPlainData(item, seen)
      if (safe !== undefined) output[key] = safe
    }
    return output
  }
  return undefined
}

function isSafePrimitive(value: unknown): value is SafePropPrimitive {
  return value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function isActionBinding(value: SafePropValue): value is SafeActionBinding {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as SafeActionBinding).kind === 'action'
}

function stringifySafe(value: unknown): string {
  return value == null ? '' : String(value)
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

function isMapCall(node: Node): boolean {
  return (
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'map'
  )
}
