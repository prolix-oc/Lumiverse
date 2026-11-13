import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const componentSource = readFileSync(new URL('./ChatPickerModal.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('./ChatPickerModal.module.css', import.meta.url), 'utf8')

describe('ChatPickerModal interaction animation', () => {
  test('uses synchronous CSS interactions for rows that immediately navigate', () => {
    expect(componentSource).not.toContain("from 'motion/react'")
    expect(componentSource).not.toContain('whileTap=')
    expect(componentSource).not.toContain('whileHover=')
    expect(stylesSource).toContain('.card:hover')
    expect(stylesSource).toContain('.card:active')
  })
})
