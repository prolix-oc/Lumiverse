/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { compileComponentAst, formatAstDiagnostic } from './componentAstCompiler'
import { getComponentTemplate } from './componentTemplates'

// Every component exposed in the override editor whose "Reset Template" button
// inserts a starter template. The template is the default shape the user falls
// back to, so it MUST pass the AST sandbox — otherwise resetting yields an
// immediately-broken override (regression: BubbleMessage's avatar fallback
// used `displayName?.[0]?.toUpperCase()`, a forbidden function call).
const COMPONENT_NAMES = [
  'BubbleMessage',
  'MinimalMessage',
  'InputArea',
  'MessageContent',
  'SwipeControls',
  'StreamingIndicator',
  'PortraitPanel',
  'ChatView',
]

describe('component starter templates', () => {
  for (const name of COMPONENT_NAMES) {
    test(`${name} template compiles cleanly through the AST sandbox`, () => {
      const { template } = getComponentTemplate(name)
      const result = compileComponentAst(template)
      const diagnostic = result.error ? formatAstDiagnostic(result.error) : null
      expect(diagnostic).toBeNull()
      expect(result.program).not.toBeNull()
    })
  }

  test('unknown component falls back to a compilable generic template', () => {
    const { template } = getComponentTemplate('SomeComponentWithoutACuratedTemplate')
    const result = compileComponentAst(template)
    expect(result.error).toBeNull()
  })
})
