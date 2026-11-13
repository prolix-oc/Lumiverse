import { afterEach, describe, expect, test } from 'bun:test'
import {
  DEVICE_LANDING_PAGE_START_TAB_STORAGE_KEY,
  readDeviceLandingPageStartTab,
  writeDeviceLandingPageStartTab,
} from './landingPageStartTab'

const USER_A = 'landing-start-user-a'
const USER_B = 'landing-start-user-b'

afterEach(() => {
  localStorage.removeItem(`${DEVICE_LANDING_PAGE_START_TAB_STORAGE_KEY}:${USER_A}`)
  localStorage.removeItem(`${DEVICE_LANDING_PAGE_START_TAB_STORAGE_KEY}:${USER_B}`)
})

describe('device landing-page start tab', () => {
  test('keeps each user’s preferred Suite start tab in this browser only', () => {
    writeDeviceLandingPageStartTab(USER_A, 'chats')

    expect(readDeviceLandingPageStartTab(USER_A)).toBe('chats')
    expect(readDeviceLandingPageStartTab(USER_B)).toBe('characters')
  })
})
