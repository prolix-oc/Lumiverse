/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = readFileSync(join(import.meta.dir, 'InputArea.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('prompt variables input action contract', () => {
  const actionBarStart = source.indexOf('<div className={styles.actionBar}>')
  const actionBarEnd = source.indexOf('\n        </div>\n      </div>', actionBarStart)
  const actionBar = source.slice(actionBarStart, actionBarEnd)

  test('renders only when prompt variables are available', () => {
    expect(actionBarStart).toBeGreaterThan(-1)
    expect(actionBarEnd).toBeGreaterThan(actionBarStart)
    expect(actionBar).toMatch(/\{promptVariablesAvailable && \(\s*<button/)
  })

  test('places prompt variables immediately before tools', () => {
    const quickRepliesButton = actionBar.indexOf('<MessageSquareQuote size={14} />')
    const promptVariablesButton = actionBar.indexOf('{promptVariablesAvailable && (')
    const promptVariablesButtonEnd = actionBar.indexOf('\n          )}', promptVariablesButton) + '\n          )}'.length
    const toolsMarker = actionBar.indexOf("openPopover === 'tools'")
    const toolsButton = actionBar.lastIndexOf('<button', toolsMarker)

    expect(promptVariablesButton).toBeGreaterThan(quickRepliesButton)
    expect(promptVariablesButtonEnd).toBeGreaterThan(promptVariablesButton)
    expect(toolsButton).toBeGreaterThan(promptVariablesButton)
    expect(actionBar.slice(promptVariablesButton, promptVariablesButtonEnd)).toContain('<Sliders size={14} />')
    expect(actionBar.slice(promptVariablesButtonEnd, toolsButton).trim()).toBe('')
  })

  test('keeps a single prompt variables entry point', () => {
    expect(source.match(/onClick=\{\(\) => void openPromptVariablesModal\(\)\}/g)).toHaveLength(1)
  })
})
