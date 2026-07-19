import { beforeAll, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import type { PromptVariableDef } from '@/lib/loom/types'

let reorderPromptVariables: (
  variables: PromptVariableDef[],
  activeId: string,
  overId: string | null,
) => PromptVariableDef[]

beforeAll(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  })
  const domWindow = dom.window as unknown as Window & typeof globalThis

  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    HTMLElement: domWindow.HTMLElement,
    HTMLButtonElement: domWindow.HTMLButtonElement,
    Element: domWindow.Element,
    Node: domWindow.Node,
    Event: domWindow.Event,
    getComputedStyle: domWindow.getComputedStyle.bind(domWindow),
  })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: domWindow.navigator })

  ;({ reorderPromptVariables } = await import('./PromptVariablesEditor'))
})

function variable(id: string): PromptVariableDef {
  return { id, name: id, label: id, type: 'text', defaultValue: '' }
}

describe('reorderPromptVariables', () => {
  test('moves a variable to the drop target while preserving the remaining order', () => {
    const variables = [variable('tone'), variable('style'), variable('length')]

    const result = reorderPromptVariables(variables, 'length', 'tone')

    expect(result.map((item) => item.id)).toEqual(['length', 'tone', 'style'])
  })

  test('leaves the existing array intact for cancelled, unchanged, or unknown drops', () => {
    const variables = [variable('tone'), variable('style')]

    expect(reorderPromptVariables(variables, 'tone', null)).toBe(variables)
    expect(reorderPromptVariables(variables, 'tone', 'tone')).toBe(variables)
    expect(reorderPromptVariables(variables, 'tone', 'missing')).toBe(variables)
  })
})
