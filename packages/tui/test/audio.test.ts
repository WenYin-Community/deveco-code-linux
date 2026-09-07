import { mock, describe, expect, test, beforeEach } from "bun:test"

// --- Fake Audio engine ---
// Module-level mutable state read by the fake Audio instance.
// Each test configures these values, then dispose() resets the singleton so
// getAudio() re-creates the fake on the next call.
let calls: string[]
let playResults: (number | null)[]
let startResults: boolean[]
let playIndex: number
let startIndex: number
let started: boolean

const fakeAudio = {
  on() {},
  isStarted: () => started,
  start: () => {
    calls.push("start")
    const result = startResults[startIndex++] ?? true
    started = result
    return result
  },
  stop: () => {
    calls.push("stop")
    started = false
    return true
  },
  play: () => {
    calls.push("play")
    return playResults[playIndex++] ?? null
  },
  loadSound: () => 1,
  dispose() {},
}

const core = await import("@opentui/core")
mock.module("@opentui/core", () => ({
  ...core,
  Audio: {
    create: () => fakeAudio,
  },
}))

const { play, dispose } = await import("../src/audio")

describe("audio play device-change recovery", () => {
  beforeEach(() => {
    calls = []
    playResults = []
    startResults = []
    playIndex = 0
    startIndex = 0
    started = false
    dispose()
  })

  test("plays sound on first try when engine is healthy", () => {
    playResults = [1]
    const voice = play(1, { volume: 0.5 })
    expect(voice).toBe(1)
    expect(calls).toEqual(["start", "play"])
  })

  test("recovers from play failure by restarting engine and retrying", () => {
    // Simulate device change: first play fails, retry after stop+start succeeds
    playResults = [null, 1]
    const voice = play(1, { volume: 0.5 })
    expect(voice).toBe(1)
    expect(calls).toEqual(["start", "play", "stop", "start", "play"])
  })

  test("returns null when recovery start fails", () => {
    // First start succeeds (enables initial play), recovery start fails
    startResults = [true, false]
    playResults = [null]
    const voice = play(1, { volume: 0.5 })
    expect(voice).toBeNull()
    expect(calls).toEqual(["start", "play", "stop", "start"])
  })

  test("returns null when retry also fails", () => {
    playResults = [null, null]
    const voice = play(1, { volume: 0.5 })
    expect(voice).toBeNull()
    expect(calls).toEqual(["start", "play", "stop", "start", "play"])
  })
})
