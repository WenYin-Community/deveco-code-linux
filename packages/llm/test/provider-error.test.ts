import { describe, expect, test } from "bun:test"
import { isContextOverflowFailure } from "../src/provider-error"
import { InvalidRequestReason, LLMError, LLMEvent } from "../src/schema"

describe("isContextOverflowFailure", () => {
  test("matches LLMError with an InvalidRequest context-overflow classification", () => {
    const failure = new LLMError({
      module: "LLM.Client",
      method: "stream",
      reason: new InvalidRequestReason({ message: "prompt is too long", classification: "context-overflow" }),
    })

    expect(isContextOverflowFailure(failure)).toBe(true)
  })

  test("rejects LLMError without the context-overflow classification", () => {
    const failure = new LLMError({
      module: "LLM.Client",
      method: "stream",
      reason: new InvalidRequestReason({ message: "prompt is too long" }),
    })

    expect(isContextOverflowFailure(failure)).toBe(false)
  })

  test("matches provider-error events classified as context-overflow", () => {
    const event = LLMEvent.providerError({ message: "prompt is too long", classification: "context-overflow" })

    expect(isContextOverflowFailure(event)).toBe(true)
  })

  test("rejects non-error values", () => {
    expect(isContextOverflowFailure(null)).toBe(false)
    expect(isContextOverflowFailure({})).toBe(false)
    expect(isContextOverflowFailure("context-overflow")).toBe(false)
  })
})
