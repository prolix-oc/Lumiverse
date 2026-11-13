import { describe, expect, test } from 'bun:test'
import {
  FULLSCREEN_FLOAT_WIDGET_STYLE,
  resolveFloatWidgetSize,
  resolveFloatWidgetStyle,
} from './spindle-float-widget-layout'

describe('Spindle float widget layout', () => {
  test('uses scale-compensated viewport dimensions in fullscreen mode', () => {
    expect(resolveFloatWidgetStyle(true, { x: 24, y: 96 }, { width: 40, height: 40 })).toEqual({
      left: 0,
      top: 0,
      width: 'var(--app-scaled-viewport-width, calc(100vw / var(--lumiverse-ui-scale, 1)))',
      height: 'var(--app-scaled-viewport-height, calc(100vh / var(--lumiverse-ui-scale, 1)))',
    })
    expect(FULLSCREEN_FLOAT_WIDGET_STYLE.width).not.toContain('window.innerWidth')
    expect(FULLSCREEN_FLOAT_WIDGET_STYLE.height).not.toContain('window.innerHeight')
  })

  test('positions regular widgets in layout pixels using a compositor transform', () => {
    expect(resolveFloatWidgetStyle(false, { x: 24, y: 96 }, { width: 320, height: 148 })).toEqual({
      left: 0,
      top: 0,
      transform: 'translate3d(24px, 96px, 0)',
      width: 320,
      height: 148,
    })
  })

  test('preserves a mobile widget requested size when it fits the viewport', () => {
    expect(resolveFloatWidgetSize(true, { width: 320, height: 500 }, { width: 390, height: 844 })).toEqual({
      width: 320,
      height: 500,
    })
  })

  test('clamps oversized mobile widgets to the padded viewport', () => {
    expect(resolveFloatWidgetSize(true, { width: 900, height: 1000 }, { width: 390, height: 844 })).toEqual({
      width: 366,
      height: 820,
    })
  })

  test('does not clamp desktop widget sizes', () => {
    expect(resolveFloatWidgetSize(false, { width: 900, height: 1000 }, { width: 390, height: 844 })).toEqual({
      width: 900,
      height: 1000,
    })
  })
})
