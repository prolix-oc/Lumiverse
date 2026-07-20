import { describe, expect, test } from 'bun:test'
import { healFormattingArtifacts } from './formatHealing'

describe('healFormattingArtifacts', () => {
  test('closes unclosed font tags around dialogue and actions', () => {
    expect(healFormattingArtifacts('<font color="aaabbb>"Hey there." They said.'))
      .toBe('<font color="aaabbb">"Hey there."</font> They said.')
    expect(healFormattingArtifacts('<font color=xxxxxx>"Hey hey!" <font color=baabaa>*They look great today.*'))
      .toBe('<font color=xxxxxx>"Hey hey!"</font> <font color=baabaa>*They look great today.*</font>')
  })

  test('does not change balanced font tags', () => {
    const input = '<font color=#abc>"Hello."</font> <font color=#def>*She smiled.*</font>'
    expect(healFormattingArtifacts(input)).toBe(input)
  })
})
