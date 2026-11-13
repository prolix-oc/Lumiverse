import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

mock.module('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
})
const domWindow = dom.window

Object.assign(globalThis, {
  window: domWindow,
  document: domWindow.document,
  navigator: domWindow.navigator,
  HTMLElement: domWindow.HTMLElement,
  HTMLInputElement: domWindow.HTMLInputElement,
  Event: domWindow.Event,
  MutationObserver: domWindow.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { default: DepthControls, DeferredColorInput } = await import('./DepthControls')

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('DeferredColorInput', () => {
  test('keeps drag previews local and commits only the completed native change', () => {
    const commits: string[] = []
    act(() => root.render(
      <DeferredColorInput value="#0a0812" onCommit={(value) => commits.push(value)} />,
    ))

    const input = host.querySelector<HTMLInputElement>('input[type="color"]')!
    act(() => {
      input.value = '#123456'
      input.dispatchEvent(new domWindow.Event('input', { bubbles: true }))
    })

    expect(input.value).toBe('#123456')
    expect(commits).toEqual([])

    act(() => input.dispatchEvent(new domWindow.Event('change', { bubbles: true })))
    expect(commits).toEqual(['#123456'])
  })

  test('tracks a color changed outside the native chooser', () => {
    const onCommit = () => undefined
    act(() => root.render(<DeferredColorInput value="#0a0812" onCommit={onCommit} />))
    act(() => root.render(<DeferredColorInput value="#abcdef" onCommit={onCommit} />))

    expect(host.querySelector<HTMLInputElement>('input')?.value).toBe('#abcdef')
  })
})


test('shows the native restart requirement and clears it when the requested surface matches', async () => {
  act(() => root.render(
    <DepthControls radiusScale={1} enableGlass={false} liquidGlass={false} fontScale={1} uiScale={1}
      onRadiusChange={() => {}} onGlassToggle={() => {}} onLiquidGlassToggle={() => {}} onFontScaleChange={() => {}} onUiScaleChange={() => {}}
      showDesktopBackgroundControls onDesktopBackgroundChange={() => {}} />,
  ))
  expect(host.querySelector('[role="status"]')).toBeNull()
  await act(async () => { document.documentElement.setAttribute('data-desktop-surface-restart', '') })
  expect(host.querySelector('[role="status"]')?.textContent).toBe('renderingMode.restartRequired')
  await act(async () => { document.documentElement.removeAttribute('data-desktop-surface-restart') })
  expect(host.querySelector('[role="status"]')).toBeNull()
})

test('commits the final range value after pointer release and cancels a pending commit on unmount', () => {
  const originalRequest = window.requestAnimationFrame
  const originalCancel = window.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame }
  window.cancelAnimationFrame = (id) => { frames.delete(id) }
  const commits: number[] = []
  try {
    act(() => root.render(
      <DepthControls radiusScale={1} enableGlass={false} liquidGlass={false} fontScale={1} uiScale={0.75}
        onRadiusChange={() => {}} onGlassToggle={() => {}} onLiquidGlassToggle={() => {}} onFontScaleChange={() => {}} onUiScaleChange={(value) => commits.push(value)} />,
    ))
    const slider = host.querySelectorAll<HTMLInputElement>('input[type="range"]')[2]
    act(() => {
      slider.value = '1'
      slider.dispatchEvent(new domWindow.Event('pointerup', { bubbles: true }))
      // Browsers may finish updating the range after pointerup.
      slider.value = '0.95'
    })
    expect(commits).toEqual([])
    const callback = frames.get(1)!
    frames.delete(1)
    act(() => callback(0))
    expect(commits).toEqual([0.95])

    act(() => slider.dispatchEvent(new domWindow.Event('pointerup', { bubbles: true })))
    expect(frames.size).toBe(1)
    act(() => root.render(null))
    expect(frames.size).toBe(0)
  } finally {
    window.requestAnimationFrame = originalRequest
    window.cancelAnimationFrame = originalCancel
  }
})
