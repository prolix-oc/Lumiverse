/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'InputArea.tsx'), 'utf8').replace(/\r\n/g, '\n')
const modalSource = readFileSync(join(import.meta.dir, 'InputAreaCustomizeModal.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('prompt variables input action contract', () => {
  test('renders only when prompt variables are available in composer actions', () => {
    expect(source).toMatch(/promptVariables:\s*promptVariablesAvailable\s*\?/)
  })

  test('places prompt variables immediately before tools in default composer action order', () => {
    const quickRepliesIndex = modalSource.indexOf("'quickReplies'")
    const promptVariablesIndex = modalSource.indexOf("'promptVariables'")
    const toolsIndex = modalSource.indexOf("'tools'")

    expect(quickRepliesIndex).toBeGreaterThan(-1)
    expect(promptVariablesIndex).toBeGreaterThan(quickRepliesIndex)
    expect(toolsIndex).toBeGreaterThan(promptVariablesIndex)
  })

  test('keeps a single prompt variables entry point', () => {
    expect(source.match(/onClick=\{\(\) => void openPromptVariablesModal\(\)\}/g)).toHaveLength(1)
  })
})
