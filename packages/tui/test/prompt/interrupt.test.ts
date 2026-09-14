import type { Part } from "@opencode-ai/sdk/v2"
import { describe, expect, test } from "bun:test"
import { shouldKeepMessagesOnInterrupt } from "../../src/component/prompt/interrupt"

describe("shouldKeepMessagesOnInterrupt", () => {
  test("protects messages when the current user message is unavailable", () => {
    expect(shouldKeepMessagesOnInterrupt([], {})).toBe(true)
  })

  test("does not protect a turn with no substantive assistant output", () => {
    expect(shouldKeepMessagesOnInterrupt([{ id: "user-1", role: "user" }], {})).toBe(false)
  })

  test("only considers assistant messages after the latest user message", () => {
    const messages = [
      { id: "user-1", role: "user" as const },
      { id: "assistant-1", role: "assistant" as const },
      { id: "user-2", role: "user" as const },
      { id: "assistant-2", role: "assistant" as const },
    ]
    const parts: Record<string, Part[]> = {
      "assistant-1": [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "text",
          text: "output from the previous turn",
        },
      ],
    }

    expect(shouldKeepMessagesOnInterrupt(messages, parts)).toBe(false)
  })

  test("protects the current turn when its assistant output is substantive", () => {
    const messages = [
      { id: "user-1", role: "user" as const },
      { id: "assistant-1", role: "assistant" as const },
    ]
    const parts: Record<string, Part[]> = {
      "assistant-1": [
        {
          id: "part-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          type: "text",
          text: "current output",
        },
      ],
    }

    expect(shouldKeepMessagesOnInterrupt(messages, parts)).toBe(true)
  })
})
