import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { transpileComponent } from './componentTranspiler'

test('evicting old editing revisions preserves components already in use', async () => {
  const source = 'export default function Component(props) { return <div>{props.content}</div> }'
  const first = await transpileComponent(source)
  expect(first.error).toBeNull()
  expect((await transpileComponent(source)).component).toBe(first.component)
  for (let revision = 0; revision < 40; revision++) {
    await transpileComponent(`export default function Component(props) { return <div>Revision ${revision}</div> }`)
  }
  expect((await transpileComponent(source)).component).not.toBe(first.component)
  expect(renderToStaticMarkup(createElement(first.component!, { content: 'Draft survives' }))).toBe('<div>Draft survives</div>')
})
