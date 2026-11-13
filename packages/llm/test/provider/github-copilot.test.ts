import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { LLM, ModelID } from "../../src"
import { configure, shouldUseResponsesApi } from "../../src/providers/github-copilot"
import { LLMClient } from "../../src/route"
import { it } from "../lib/effect"
import { dynamicResponse } from "../lib/http"
import { deltaChunk } from "../lib/openai-chunks"
import { sseEvents } from "../lib/sse"

const copilot = configure({ apiKey: "k", baseURL: "https://proxy.test/api" })

describe("GitHub Copilot", () => {
  for (const [id, expected] of [
    ["gpt-5", true],
    ["gpt-5-mini", false],
    ["gpt-4o", false],
    ["claude-3-5-sonnet", false],
  ] as const)
    it.effect(`maps ${id} to ${expected ? "Responses" : "Chat"}`, () =>
      Effect.gen(function* () {
        expect(shouldUseResponsesApi(id)).toBe(expected)
      }),
    )

  it.effect("accepts branded model ids", () =>
    Effect.gen(function* () {
      expect(shouldUseResponsesApi(ModelID.make("gpt-5.5"))).toBe(true)
    }),
  )

  it.effect("selects the Responses route for gpt-5 models", () =>
    Effect.gen(function* () {
      const model = copilot.model("gpt-5")
      expect(model).toMatchObject({ id: "gpt-5", provider: "github-copilot" })
      expect(model.route.id).toBe("openai-responses")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))
      expect(prepared.route).toBe("openai-responses")
      expect(prepared.body).toMatchObject({ model: "gpt-5", stream: true })
    }),
  )

  it.effect("selects the Chat route for non-gpt-5 models", () =>
    Effect.gen(function* () {
      const model = copilot.model("gpt-4o")
      expect(model.route.id).toBe("openai-chat")

      const prepared = yield* LLMClient.prepare(LLM.request({ model, prompt: "Say hello." }))
      expect(prepared.route).toBe("openai-chat")
      expect(prepared.body).toMatchObject({ model: "gpt-4o", stream: true })
    }),
  )

  it.effect("selects routes explicitly via responses and chat", () =>
    Effect.gen(function* () {
      const responses = yield* LLMClient.prepare(LLM.request({ model: copilot.responses("gpt-5"), prompt: "Hi." }))
      expect(responses.route).toBe("openai-responses")

      const chat = yield* LLMClient.prepare(LLM.request({ model: copilot.chat("gpt-4o"), prompt: "Hi." }))
      expect(chat.route).toBe("openai-chat")
    }),
  )

  it.effect("strips credentials and baseURL from route defaults", () =>
    Effect.gen(function* () {
      for (const model of [copilot.model("gpt-5"), copilot.model("gpt-4o")]) {
        expect(model.route.defaults).not.toHaveProperty("apiKey")
        expect(model.route.defaults).not.toHaveProperty("auth")
        expect(model.route.defaults).not.toHaveProperty("baseURL")
      }
    }),
  )

  it.effect("sends Chat requests to the configured baseURL with bearer auth", () =>
    Effect.gen(function* () {
      const response = yield* LLMClient.generate(
        LLM.request({ model: copilot.model("gpt-4o"), prompt: "Say hello." }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://proxy.test/api/chat/completions")
              expect(web.headers.get("authorization")).toBe("Bearer k")
              return input.respond(sseEvents(deltaChunk({ role: "assistant", content: "Hello" }), deltaChunk({}, "stop")), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )

      expect(response.text).toBe("Hello")
    }),
  )

  it.effect("sends Responses requests to the configured baseURL with bearer auth", () =>
    Effect.gen(function* () {
      yield* LLMClient.generate(
        LLM.request({ model: copilot.model("gpt-5"), prompt: "Say hello." }),
      ).pipe(
        Effect.provide(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              const web = yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie)
              expect(web.url).toBe("https://proxy.test/api/responses")
              expect(web.headers.get("authorization")).toBe("Bearer k")
              return input.respond(sseEvents({ type: "response.completed", response: {} }), {
                headers: { "content-type": "text/event-stream" },
              })
            }),
          ),
        ),
      )
    }),
  )
})
