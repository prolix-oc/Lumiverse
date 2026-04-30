import { transform } from 'sucrase'
import React, { useState, useCallback, useMemo, memo, Fragment } from 'react'
import clsx from 'clsx'
import { validateComponentOverrideSource } from './componentOverrideSecurity'

/**
 * Scope object injected into user TSX modules.
 * Users don't need import statements — everything is available as globals.
 *
 * SECURITY: This is a cooperative sandbox. Dangerous globals are shadowed,
 * React is wrapped in an allowlist proxy, and the JSX factory strips refs
 * and event handlers so user code can only render presentational markup.
 */

// ── Blocked globals ───────────────────────────────────────────────────────

const BLOCKED_GLOBALS = [
  // Network / data exfiltration
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator',
  'sendBeacon', 'Request', 'Response',
  // Storage / cookies
  'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  // Code generation
  'eval', 'Function',
  // Navigation / location
  'location', 'history',
  // Document-level access that could leak data
  'cookie',
  // Import
  'importScripts',
  // WASM / workers
  'WebAssembly', 'Worker', 'SharedWorker', 'ServiceWorker',
] as const

const blockedEntries: Record<string, undefined> = {}
for (const key of BLOCKED_GLOBALS) blockedEntries[key] = undefined

// ── Safe React proxy ──────────────────────────────────────────────────────

const ALLOWED_REACT_KEYS = new Set([
  'useState',
  'useCallback',
  'useMemo',
  'useReducer',
  'useContext',
  'useId',
  'useTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'createElement',
  'Fragment',
  'memo',
  'Children',
  'isValidElement',
  'version',
  'StrictMode',
  'Suspense',
  'lazy',
  'Component',
  'PureComponent',
])

const BLOCKED_REACT_KEYS = new Set([
  'useRef',
  'useEffect',
  'useLayoutEffect',
  'useInsertionEffect',
  'useImperativeHandle',
  'createRef',
  'forwardRef',
  'findDOMNode',
  'cloneElement',
  'createPortal',
])

/** JSX factory that strips refs, event handlers, dangerous tags, and malicious URLs. */
function safeCreateElement(type: any, props: any, ...children: any[]) {
  // Block dangerous HTML tags
  if (typeof type === 'string') {
    const tag = type.toLowerCase()
    if (tag === 'script' || tag === 'iframe' || tag === 'object' || tag === 'embed' || tag === 'frame' || tag === 'frameset') {
      console.warn(`[ComponentOverride] Tag '<${type}>' is not allowed in component overrides`)
      return React.createElement('div', { style: { color: 'red', padding: 8, border: '1px solid red' } }, `Blocked tag: ${type}`)
    }
  }

  if (props && typeof props === 'object') {
    const safeProps: any = {}
    for (const [key, value] of Object.entries(props)) {
      // Strip ref props (prevents DOM node access)
      if (key === 'ref') {
        console.warn(`[ComponentOverride] ref prop is not allowed in component overrides`)
        continue
      }
      // Strip event handlers (prevents arbitrary JS on interaction)
      if (key.startsWith('on') && typeof value === 'function') {
        console.warn(`[ComponentOverride] Event handler '${key}' is not allowed in component overrides`)
        continue
      }
      // Block dangerous URLs on link-like props
      if (typeof value === 'string' && (key === 'href' || key === 'src' || key === 'srcDoc' || key === 'action' || key === 'formAction')) {
        if (/^\s*(javascript:|data:text\/html|vbscript:)/i.test(value)) {
          console.warn(`[ComponentOverride] Dangerous URL in '${key}' blocked`)
          safeProps[key] = 'about:blank'
          continue
        }
      }
      safeProps[key] = value
    }
    return React.createElement(type, safeProps, ...children)
  }

  return React.createElement(type, props, ...children)
}

const SafeReact = new Proxy(React, {
  get(target, prop) {
    if (prop === 'createElement') {
      return safeCreateElement
    }
    // $$typeof is accessed as a string key by React internals
    if (prop === '$$typeof') {
      return (target as any)[prop]
    }
    if (typeof prop === 'string') {
      if (ALLOWED_REACT_KEYS.has(prop)) {
        return (target as any)[prop]
      }
      if (BLOCKED_REACT_KEYS.has(prop)) {
        return function () {
          throw new Error(`React.${prop} is not available in component overrides`)
        }
      }
      throw new Error(`React.${prop} is not available in component overrides`)
    }
    // Allow well-known symbols required by React internals
    if (
      prop === Symbol.toStringTag ||
      prop === Symbol.iterator ||
      prop === Symbol.toPrimitive
    ) {
      return (target as any)[prop]
    }
    return undefined
  },
  ownKeys(target) {
    return Array.from(ALLOWED_REACT_KEYS).filter((k) => k in target)
  },
  getOwnPropertyDescriptor(target, prop) {
    if (typeof prop === 'string' && ALLOWED_REACT_KEYS.has(prop)) {
      return Object.getOwnPropertyDescriptor(target, prop)
    }
    return undefined
  },
})

// ── Scope ─────────────────────────────────────────────────────────────────

const SCOPE: Record<string, any> = {
  // React (proxied)
  React: SafeReact,
  useState,
  useCallback,
  useMemo,
  // Provide throwing shims for common blocked hooks so bare identifiers fail cleanly
  useRef: function () {
    throw new Error('useRef is not available in component overrides')
  },
  useEffect: function () {
    throw new Error('useEffect is not available in component overrides')
  },
  useLayoutEffect: function () {
    throw new Error('useLayoutEffect is not available in component overrides')
  },
  memo,
  Fragment,
  clsx,
  // JSX runtime — hijacked by safeCreateElement
  createElement: safeCreateElement,
  jsxs: safeCreateElement,
  jsx: safeCreateElement,
  // No document access — user components are purely presentational
  // Safe console for debugging
  console: { log: console.log, warn: console.warn, error: console.error, info: console.info },
  // Shadow dangerous globals with undefined
  ...blockedEntries,
  // Block window access (which would bypass all shadows)
  window: undefined,
  globalThis: undefined,
  self: undefined,
}

const SCOPE_KEYS = Object.keys(SCOPE)
const SCOPE_VALUES = Object.values(SCOPE)

export interface TranspileResult {
  component: React.ComponentType<any> | null
  error: string | null
}

/**
 * Transpile user TSX source into a React component.
 *
 * The user writes a module with `export default function MyComp(props) { ... }`.
 * We transpile TSX→JS via Sucrase, then evaluate it in a sandboxed scope that
 * provides React, hooks, and utility functions — no import statements needed.
 */
export function transpileComponent(source: string): TranspileResult {
  if (!source.trim()) return { component: null, error: null }

  const safety = validateComponentOverrideSource(source)
  if (!safety.valid) {
    return { component: null, error: safety.error || 'Unsafe component override source' }
  }

  // ── Step 1: Transpile TSX → JS ──
  let code: string
  try {
    const result = transform(source, {
      transforms: ['typescript', 'jsx'],
      jsxRuntime: 'classic',
      production: true,
    })
    code = result.code
  } catch (e) {
    return { component: null, error: `Syntax error: ${(e as Error).message}` }
  }

  // ── Step 2: Wrap in module pattern ──
  // Sucrase outputs `export default ...` which isn't valid in Function body.
  // Replace export patterns with assignments to a local `__exports` object.
  let wrapped = code
    .replace(/export\s+default\s+function\s+(\w+)/g, 'function $1')
    .replace(/export\s+default\s+/g, '__exports.default = ')

  // If there was a named function after stripping `export default`, assign it
  // Find the last top-level function declaration name and assign it as default
  const funcMatch = wrapped.match(/^function\s+(\w+)/m)
  if (funcMatch && !wrapped.includes('__exports.default')) {
    wrapped += `\n__exports.default = ${funcMatch[1]};`
  }

  // NOTE: "use strict" is inside an IIFE, not at the top level, because
  // SCOPE_KEYS includes "eval" (shadowed to undefined for security).
  // Strict mode forbids "eval" as a parameter name, but the outer sloppy-mode
  // function can accept it — the inner IIFE still inherits the shadow.
  wrapped = `var __exports = {};\n;(function(){"use strict";\n${wrapped}\n})();\nreturn __exports;`

  // ── Step 3: Evaluate in sandboxed scope ──
  try {
    // eslint-disable-next-line no-new-func
    const factory = new Function(...SCOPE_KEYS, wrapped)
    const exports = factory(...SCOPE_VALUES)

    if (typeof exports.default !== 'function') {
      return { component: null, error: 'Module must export a default function component' }
    }

    return { component: exports.default, error: null }
  } catch (e) {
    return { component: null, error: `Runtime error: ${(e as Error).message}` }
  }
}

/**
 * Validate user TSX without fully evaluating it.
 * Useful for editor-time feedback.
 */
export function validateTSX(source: string): { valid: boolean; error?: string } {
  if (!source.trim()) return { valid: true }

  const safety = validateComponentOverrideSource(source)
  if (!safety.valid) return safety

  try {
    transform(source, {
      transforms: ['typescript', 'jsx'],
      jsxRuntime: 'classic',
      production: true,
    })
    return { valid: true }
  } catch (e) {
    return { valid: false, error: (e as Error).message }
  }
}
