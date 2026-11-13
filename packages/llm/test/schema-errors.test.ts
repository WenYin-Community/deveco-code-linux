import { describe, expect, test } from "bun:test"
import {
  ContentPolicyReason,
  InvalidProviderOutputReason,
  LLMError,
  ModelID,
  NoRouteReason,
  ProviderID,
  ProviderInternalReason,
  QuotaExceededReason,
  RateLimitReason,
  TransportReason,
  UnknownProviderReason,
} from "../src/schema"

describe("LLM error reasons", () => {
  test("NoRouteReason message names provider, model, and route", () => {
    const reason = new NoRouteReason({
      route: "openai-chat",
      provider: ProviderID.make("openai"),
      model: ModelID.make("gpt-4o-mini"),
    })

    expect(reason.message).toBe("No LLM route for openai/gpt-4o-mini using openai-chat")
    expect(reason.retryable).toBe(false)
  })

  test("non-transient reasons report retryable false", () => {
    const message = "boom"

    expect(new QuotaExceededReason({ message }).retryable).toBe(false)
    expect(new ContentPolicyReason({ message }).retryable).toBe(false)
    expect(new TransportReason({ message }).retryable).toBe(false)
    expect(new InvalidProviderOutputReason({ message }).retryable).toBe(false)
    expect(new UnknownProviderReason({ message }).retryable).toBe(false)
  })

  test("transient reasons report retryable true", () => {
    expect(new RateLimitReason({ message: "slow down" }).retryable).toBe(true)
    expect(new ProviderInternalReason({ message: "upstream hiccup", status: 500 }).retryable).toBe(true)
  })

  test("LLMError message and retryable pass through the reason", () => {
    const reason = new NoRouteReason({
      route: "openai-chat",
      provider: ProviderID.make("openai"),
      model: ModelID.make("gpt-4o-mini"),
    })
    const error = new LLMError({ module: "LLM.Client", method: "stream", reason })

    expect(error.message).toBe("LLM.Client.stream: No LLM route for openai/gpt-4o-mini using openai-chat")
    expect(error.retryable).toBe(false)
    expect(error.cause).toBe(reason)
  })
})
