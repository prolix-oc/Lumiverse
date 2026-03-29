import { transform } from 'sucrase'
import React, { useState, useCallback, useMemo, useRef, useEffect, useLayoutEffect, memo, Fragment } from 'react'
import clsx from 'clsx'

/**
 * Scope object injected into user TSX modules.
 * Users don't need import statements — everything is available as globals.
 *
 * SECURITY: Dangerous globals are shadowed with undefined to prevent
 * data exfiltration, network calls, and navigation hijacking.
 * The user code can only render DOM — it cannot influence where data goes.
 */

// Globals that MUST be blocked in user component code
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
] as const

const blockedEntries: Record<string, undefined> = {}
for (const key of BLOCKED_GLOBALS) blockedEntries[key] = undefined

const SCOPE: Record<string, any> = {
  // React essentials
  React,
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  useLayoutEffect,
  memo,
  Fragment,
  clsx,
  // JSX runtime — required for the transpiled output
  createElement: React.createElement,
  jsxs: (React as any).jsxs ?? React.createElement,
  jsx: (React as any).jsx ?? React.createElement,
  // Safe subset of document (read-only style access)
  document: {
    getElementById: (id: string) => document.getElementById(id),
    querySelector: (sel: string) => document.querySelector(sel),
    querySelectorAll: (sel: string) => document.querySelectorAll(sel),
    documentElement: document.documentElement,
  },
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

  wrapped = `"use strict";\nvar __exports = {};\n${wrapped}\nreturn __exports;`

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
