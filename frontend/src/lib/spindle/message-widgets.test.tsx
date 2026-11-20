import { afterEach, describe, expect, test } from 'bun:test'
import {
  getMessageWidgetVersion,
  removeMessageWidgetsByExtension,
  subscribeMessageWidgets,
  upsertMessageWidget,
} from './message-widgets'

const extensionId = 'message-widgets-ownership-test'
const messageId = 'message-1'
const widgetId = 'widget-1'

const widget = (html: string) => ({
  messageId,
  widgetId,
  html,
})

afterEach(() => {
  removeMessageWidgetsByExtension(extensionId)
})

describe('message widget disposer ownership', () => {
  test('disposes only the exact record that created it after replacement', () => {
    let notifications = 0
    const unsubscribe = subscribeMessageWidgets(() => {
      notifications += 1
    })

    try {
      const initialVersion = getMessageWidgetVersion()
      const initialNotifications = notifications
      const disposeFirst = upsertMessageWidget(extensionId, widget('<p>first</p>'))

      expect(getMessageWidgetVersion()).toBe(initialVersion + 1)
      expect(notifications).toBe(initialNotifications + 1)

      const disposeSecond = upsertMessageWidget(extensionId, widget('<p>second</p>'))
      const replacedVersion = getMessageWidgetVersion()
      const replacedNotifications = notifications

      expect(replacedVersion).toBe(initialVersion + 2)
      expect(replacedNotifications).toBe(initialNotifications + 2)

      disposeFirst()
      disposeFirst()
      expect(getMessageWidgetVersion()).toBe(replacedVersion)
      expect(notifications).toBe(replacedNotifications)

      disposeSecond()
      expect(getMessageWidgetVersion()).toBe(replacedVersion + 1)
      expect(notifications).toBe(replacedNotifications + 1)

      disposeSecond()
      expect(getMessageWidgetVersion()).toBe(replacedVersion + 1)
      expect(notifications).toBe(replacedNotifications + 1)
      removeMessageWidgetsByExtension(extensionId)
      expect(getMessageWidgetVersion()).toBe(replacedVersion + 1)
      expect(notifications).toBe(replacedNotifications + 1)
    } finally {
      unsubscribe()
    }
  })
})
