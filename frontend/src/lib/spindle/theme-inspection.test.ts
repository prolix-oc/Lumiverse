import { JSDOM } from 'jsdom'
import { expect, test } from 'bun:test'
import { inspectThemeElements } from './theme-inspection'

test('inspection returns bounded geometry and styles without text or DOM handles', () => {
  const dom = new JSDOM('<!doctype html><body></body>')
  const previousDocument = globalThis.document, previousComputed = globalThis.getComputedStyle
  globalThis.document = dom.window.document
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
  const root = document.createElement('section')
  root.innerHTML = Array.from({ length: 40 }, () => '<div data-component="InspectionFixture" class="inspection-fixture" style="color:red">private text</div>').join('')
  document.body.append(root)
  try {
    const result = inspectThemeElements({ selector: '[data-component="InspectionFixture"]', properties: ['color'], limit: 2 })
    expect(result.count).toBe(40)
    expect(result.matches).toHaveLength(2)
    expect(result.matches[0].styles.color).toBe('rgb(255, 0, 0)')
    expect(JSON.stringify(result)).not.toContain('private text')
    expect(result.matches[0]).not.toHaveProperty('node')
  } finally { root.remove(); globalThis.document = previousDocument; globalThis.getComputedStyle = previousComputed; dom.window.close() }
})

test('inspection rejects arbitrary attribute probes and content-bearing properties', () => {
  for (const selector of ['input[value^="secret"]', '[data-component^="secret"]', ':has([title="secret"])', '[data-component="x"]\\[value="secret"]']) {
    expect(() => inspectThemeElements({ selector })).toThrow('INVALID_THEME_SELECTOR')
  }
  for (const property of ['content', 'background-image', '--private', 'invalid']) expect(() => inspectThemeElements({ selector: 'body', properties: [property] })).toThrow('INVALID_THEME_STYLE_PROPERTY')
  expect(() => inspectThemeElements({ selector: 'body', limit: 100 })).toThrow('INVALID_THEME_INSPECTION_LIMIT')
})
