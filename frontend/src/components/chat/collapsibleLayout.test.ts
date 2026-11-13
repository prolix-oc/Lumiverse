import { describe, expect, test } from 'bun:test'
import { findDetailsToggleLayoutTargetFromPath, isCollapsibleToggleElement } from './collapsibleLayout'

function tagTarget(tagName: string): EventTarget & { tagName: string } {
  return Object.assign(new EventTarget(), { tagName })
}

describe('findDetailsToggleLayoutTargetFromPath', () => {
  test('returns the details element for a summary activation path', () => {
    const details = tagTarget('DETAILS')
    const path = [
      tagTarget('SPAN'),
      tagTarget('SUMMARY'),
      details,
      tagTarget('DIV'),
    ]

    expect(findDetailsToggleLayoutTargetFromPath(path)).toBe(details)
  })

  test('ignores details elements that are not reached through a summary', () => {
    const details = tagTarget('DETAILS')
    const path = [
      tagTarget('SPAN'),
      details,
      tagTarget('DIV'),
    ]

    expect(findDetailsToggleLayoutTargetFromPath(path)).toBeNull()
  })

  test('prefers the innermost details following the activated summary', () => {
    const innerDetails = tagTarget('DETAILS')
    const outerDetails = tagTarget('DETAILS')
    const path = [
      tagTarget('SPAN'),
      tagTarget('SUMMARY'),
      innerDetails,
      outerDetails,
      tagTarget('DIV'),
    ]

    expect(findDetailsToggleLayoutTargetFromPath(path)).toBe(innerDetails)
  })
})

describe('isCollapsibleToggleElement', () => {
  test('recognizes reasoning, long-message, and native details toggles', () => {
    const attributedTarget = (attribute: string) => Object.assign(new EventTarget(), {
      tagName: 'BUTTON',
      hasAttribute: (name: string) => name === attribute,
    })

    expect(isCollapsibleToggleElement(tagTarget('SUMMARY'))).toBe(true)
    expect(isCollapsibleToggleElement(attributedTarget('data-reasoning-toggle'))).toBe(true)
    expect(isCollapsibleToggleElement(attributedTarget('data-long-message-toggle'))).toBe(true)
    expect(isCollapsibleToggleElement(tagTarget('BUTTON'))).toBe(false)
  })
})
