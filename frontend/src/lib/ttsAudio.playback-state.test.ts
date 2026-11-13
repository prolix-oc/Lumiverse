import { describe, expect, test } from 'bun:test'
import { isTTSPlaybackActive, stopAllTTSPlayback, subscribeTTSPlayback, trackTTSAudioElement } from './ttsAudio'

class FakeAudio extends EventTarget {
  paused = true
  ended = false
  play() { this.paused = false; this.dispatchEvent(new Event('play')) }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
}

describe('host TTS playback state', () => {
  test('saved message audio counts as TTS playback and stopAll pauses it', () => {
    const el = new FakeAudio()
    let notified = 0
    const unsubscribe = subscribeTTSPlayback(() => { notified++ })
    const untrack = trackTTSAudioElement(el as unknown as HTMLMediaElement)
    expect(isTTSPlaybackActive()).toBe(false)
    el.play()
    expect(isTTSPlaybackActive()).toBe(true)
    stopAllTTSPlayback()
    expect(el.paused).toBe(true)
    expect(isTTSPlaybackActive()).toBe(false)
    el.play()
    untrack()
    expect(isTTSPlaybackActive()).toBe(false)
    expect(notified).toBeGreaterThanOrEqual(4)
    unsubscribe()
  })

  test('stopAll pauses tracked audio before the browser dispatches its play event', () => {
    const el = new FakeAudio()
    const untrack = trackTTSAudioElement(el as unknown as HTMLMediaElement)
    el.paused = false
    expect(isTTSPlaybackActive()).toBe(true)
    stopAllTTSPlayback()
    expect(el.paused).toBe(true)
    expect(isTTSPlaybackActive()).toBe(false)
    untrack()
  })
})
