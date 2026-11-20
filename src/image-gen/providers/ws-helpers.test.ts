import { describe, expect, test } from "bun:test"
import { createWebSocketReceiveBackpressure } from "./ws-helpers"

function pausableSocket(initiallyPaused = false): {
  socket: WebSocket
  calls: string[]
  isPaused(): boolean
} {
  let paused = initiallyPaused
  const calls: string[] = []
  const socket = {
    pause() {
      calls.push("pause")
      if (paused) return false
      paused = true
      return true
    },
    resume() {
      calls.push("resume")
      if (!paused) return false
      paused = false
      return true
    },
  } as unknown as WebSocket
  return { socket, calls, isPaused: () => paused }
}

describe("Bun WebSocket receive backpressure", () => {
  test("pauses at the high-water mark and resumes after draining", () => {
    const fake = pausableSocket()
    const control = createWebSocketReceiveBackpressure(fake.socket, {
      highWaterMark: 3,
      lowWaterMark: 1,
    })

    control.enqueued(2)
    control.enqueued(3)
    control.enqueued(4)
    expect(fake.calls).toEqual(["pause"])
    expect(fake.isPaused()).toBe(true)

    control.dequeued(2)
    control.dequeued(1)
    expect(fake.calls).toEqual(["pause", "resume"])
    expect(fake.isPaused()).toBe(false)
  })

  test("releases a pause when the consumer exits early", () => {
    const fake = pausableSocket()
    const control = createWebSocketReceiveBackpressure(fake.socket, {
      highWaterMark: 2,
      lowWaterMark: 0,
    })

    control.enqueued(2)
    control.release()
    control.release()

    expect(fake.calls).toEqual(["pause", "resume"])
    expect(fake.isPaused()).toBe(false)
  })

  test("does not resume a socket paused by another owner", () => {
    const fake = pausableSocket(true)
    const control = createWebSocketReceiveBackpressure(fake.socket, {
      highWaterMark: 2,
      lowWaterMark: 0,
    })

    control.enqueued(2)
    control.release()

    expect(fake.calls).toEqual(["pause"])
    expect(fake.isPaused()).toBe(true)
  })
})
