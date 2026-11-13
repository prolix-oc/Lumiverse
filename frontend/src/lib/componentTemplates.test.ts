/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { compileComponentAst, formatAstDiagnostic } from './componentAstCompiler'
import { createTrustedOverrideComponent } from './componentAstRuntime'
import { HOST_SLOTS_PROP } from './componentOverrideCapabilities'
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
    test(`${name} template compiles cleanly through the AST sandbox`, async () => {
      const { template } = getComponentTemplate(name)
      const result = await compileComponentAst(template)
      const diagnostic = result.error ? formatAstDiagnostic(result.error) : null
      expect(diagnostic).toBeNull()
      expect(result.program).not.toBeNull()
      expect(template).toContain('<Original />')
    })
  }

  test('unknown component falls back to a compilable generic template', async () => {
    const { template } = getComponentTemplate('SomeComponentWithoutACuratedTemplate')
    const result = await compileComponentAst(template)
    expect(result.error).toBeNull()
    expect(template).toContain('<Original />')
  })

  test('the trusted original-component slot compiles without props or children', async () => {
    const valid = await compileComponentAst(`export default function AdditiveOverride(props) {
  return <><Original /><span>Decoration</span></>
}`)
    expect(valid.error).toBeNull()

    const withProps = await compileComponentAst(`export default function InvalidOverride(props) {
  return <Original className="replacement" />
}`)
    expect(withProps.error?.message).toBe('<Original /> does not accept props.')
  })

  test('the trusted original-component slot renders the host component unchanged', async () => {
    const compiled = await compileComponentAst(`export default function AdditiveOverride(props) {
  return <><Original /><span>Decoration</span></>
}`)
    if (!compiled.program) throw new Error('Expected additive override to compile')

    const Override = createTrustedOverrideComponent(compiled.program)
    const html = renderToStaticMarkup(React.createElement(Override, {
      [HOST_SLOTS_PROP]: {
        Original: React.createElement('button', { type: 'button' }, 'Native action'),
      },
    }))

    expect(html).toBe('<button type="button">Native action</button><span>Decoration</span>')
  })

  test('large avatar tier example compiles for message overrides', async () => {
    const source = `export default function MessageWithLargeAvatar({ message }) {
  const avatarSrc = message.avatar.cropped.lg || message.avatar.cropped.sm || message.avatarUrl
  return (
    <div>
      <img src={avatarSrc || ''} alt={message.displayName} />
      <Content />
    </div>
  )
}`
    const result = await compileComponentAst(source)

    expect(result.error ? formatAstDiagnostic(result.error) : null).toBeNull()
    expect(result.program).not.toBeNull()
  })

  test('both message styles document the complete avatar tier contract', () => {
    for (const componentName of ['BubbleMessage', 'MinimalMessage']) {
      const messageProp = getComponentTemplate(componentName).props.find((prop) => prop.name === 'message')
      const avatarProp = messageProp?.children?.find((prop) => prop.name === 'avatar')

      expect(avatarProp?.children?.map((prop) => prop.name)).toEqual(['cropped', 'original'])
      expect(avatarProp?.children?.every((prop) => prop.type === '{ sm, lg, full }')).toBe(true)
    }
  })
})
