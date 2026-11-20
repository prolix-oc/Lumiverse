import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearCssComponentsForExtension,
  getCssComponentRegistrations,
  MAX_CSS_COMPONENTS_PER_EXTENSION,
  registerCssComponent,
  resetCssComponentRegistryForTests,
} from './css-component-registry'

afterEach(() => resetCssComponentRegistryForTests())

describe('PR1 CSS component registration', () => {
  test('stores a canonical selector with generation ownership and supports idempotent disposal', () => {
    const dispose = registerCssComponent('extension-a', 3, {
      name: 'ImagePreview',
      selector: ' [data-component = \'ImagePreview\'] ',
      category: 'message',
    })

    expect(getCssComponentRegistrations()).toEqual([{
      id: 'extension-a:3:1',
      extensionId: 'extension-a',
      generation: 3,
      name: 'ImagePreview',
      selector: '[data-component="ImagePreview"]',
      category: 'message',
    }])
    dispose()
    dispose()
    expect(getCssComponentRegistrations()).toHaveLength(0)
  })

  test('rejects unknown fields and selectors that could escape the data-component scope', () => {
    expect(() => registerCssComponent('extension-a', 1, {
      name: 'ImagePreview',
      selector: '[data-component="ImagePreview"] .danger',
      category: 'message',
    })).toThrow('CSS_COMPONENT_SELECTOR_INVALID')
    expect(() => registerCssComponent('extension-a', 1, {
      name: 'ImagePreview',
      selector: '[data-component="ImagePreview"]',
      category: 'message',
      cssText: 'body { color: red }',
    })).toThrow('CSS_COMPONENT_INVALID_OPTIONS')
  })

  test('caps each extension and clears only the requested generation', () => {
    for (let index = 0; index < MAX_CSS_COMPONENTS_PER_EXTENSION; index += 1) {
      registerCssComponent('extension-a', 1, {
        name: `Component${index}`,
        selector: `[data-component="Component${index}"]`,
        category: 'message',
      })
    }
    expect(() => registerCssComponent('extension-a', 1, {
      name: 'Overflow',
      selector: '[data-component="Overflow"]',
      category: 'message',
    })).toThrow('CSS_COMPONENT_LIMIT_REACHED')
    registerCssComponent('extension-a', 2, {
      name: 'NextGeneration',
      selector: '[data-component="NextGeneration"]',
      category: 'message',
    })
    clearCssComponentsForExtension('extension-a', 1)
    expect(getCssComponentRegistrations().map((entry) => entry.generation)).toEqual([2])
  })
})
