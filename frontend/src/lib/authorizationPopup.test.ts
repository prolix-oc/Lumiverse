/// <reference types="bun-types" />

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  closeAuthorizationPopup,
  navigateAuthorizationPopup,
  reserveAuthorizationPopup,
} from './authorizationPopup'

const previousWindow = globalThis.window

const open = mock(() => null as Window | null)
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { open },
})

beforeEach(() => {
  open.mockClear()
})

afterAll(() => {
  if (previousWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
  else Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
})

function popupWindow() {
  return {
    closed: false,
    opener: { original: true },
    location: { href: 'about:blank' },
    focus: mock(() => undefined),
    close: mock(() => undefined),
  }
}

describe('authorization popup', () => {
  test('reserves an explicit about:blank window during user activation', () => {
    const popup = popupWindow()
    open.mockReturnValueOnce(popup as unknown as Window)

    expect(reserveAuthorizationPopup({ name: 'provider', features: 'popup=yes' })).toBe(
      popup as unknown as Window,
    )
    expect(open).toHaveBeenCalledWith('about:blank', 'provider', 'popup=yes')
  })

  test('navigates, focuses, and disconnects an external linking popup', () => {
    const popup = popupWindow()
    const result = navigateAuthorizationPopup(
      popup as unknown as Window,
      'https://identity.example/authorize',
    )

    expect(result).toEqual({ status: 'popup', url: 'https://identity.example/authorize' })
    expect(popup.location.href).toBe('https://identity.example/authorize')
    expect(popup.opener).toBeNull()
    expect(popup.focus).toHaveBeenCalledTimes(1)
  })

  test('can preserve the opener needed by SSO completion', () => {
    const popup = popupWindow()
    const opener = popup.opener

    navigateAuthorizationPopup(
      popup as unknown as Window,
      'https://identity.example/authorize',
      { preserveOpener: true },
    )

    expect(popup.opener).toBe(opener)
  })

  test('returns a safe manual fallback when popups are blocked', () => {
    expect(navigateAuthorizationPopup(null, 'https://identity.example/verify')).toEqual({
      status: 'blocked',
      url: 'https://identity.example/verify',
    })
  })

  test('rejects non-HTTPS authorization targets', () => {
    const popup = popupWindow()

    expect(navigateAuthorizationPopup(popup as unknown as Window, 'javascript:alert(1)')).toEqual({
      status: 'invalid',
    })
    expect(popup.location.href).toBe('about:blank')
  })

  test('allows explicitly configured HTTP providers without admitting other schemes', () => {
    expect(navigateAuthorizationPopup(null, 'http://localhost:8080/authorize', { allowHttp: true })).toEqual({
      status: 'blocked',
      url: 'http://localhost:8080/authorize',
    })
    expect(navigateAuthorizationPopup(null, 'data:text/html,unsafe', { allowHttp: true })).toEqual({
      status: 'invalid',
    })
  })

  test('closes a reserved popup without exposing platform close failures', () => {
    const popup = popupWindow()
    closeAuthorizationPopup(popup as unknown as Window)
    expect(popup.close).toHaveBeenCalledTimes(1)
  })
})
