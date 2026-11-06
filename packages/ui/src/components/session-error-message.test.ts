import { describe, expect, test } from "bun:test"
import { dict } from "../i18n/en"
import { turnRecoveryFailure, turnRecoveryFailureMessage } from "./session-error-message"

describe("turn recovery failure message", () => {
  test.each([
    ["reasoning_limit", true, "after one automatic recovery", "split the request into smaller tasks"],
    ["output_limit", true, "after one automatic recovery", 'Send "continue"'],
    ["response_interrupted", true, "after one automatic recovery", 'Send "continue"'],
    ["reasoning_limit", false, "per-turn output limit", "split the request into smaller tasks"],
  ] as const)("formats %s failures", (cause, retried, status, action) => {
    const failure = turnRecoveryFailure({ data: { cause, attempts: retried ? 1 : 0 } })
    expect(failure).toEqual({ cause, retried })
    if (!failure) throw new Error("expected recovery failure")
    const message = turnRecoveryFailureMessage(failure, (key) => dict[key])
    expect(message).toContain(status)
    expect(message).toContain(action)
  })

  test("ignores unrelated errors", () => {
    expect(turnRecoveryFailure({ name: "APIError", data: { message: "failed" } })).toBeUndefined()
  })
})
