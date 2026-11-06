import { describe, expect } from "bun:test"
import { DateTime, Effect } from "effect"
import { EventV2 } from "@opencode-ai/core/event"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageUpdater } from "@opencode-ai/core/session/message-updater"
import { it } from "./lib/effect"

describe("failed step projection", () => {
  for (const input of [
    { error: { type: "output_length", message: "truncated", attempts: 1 }, finish: "length" },
    { error: { type: "unknown", message: "failed" }, finish: "error" },
  ] as const) {
    it.effect(`preserves usage and projects ${input.error.type} as ${input.finish}`, () =>
      Effect.gen(function* () {
        const id = SessionMessage.ID.make("msg_failed_step")
        const tokens = { input: 20, output: 32000, reasoning: 31940, cache: { read: 0, write: 0 } }
        const state: SessionMessageUpdater.MemoryState = {
          messages: [
            new SessionMessage.Assistant({
              id,
              type: "assistant",
              agent: "build",
              model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
              content: [],
              time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(500) },
              finish: "length",
              cost: 0.1,
              tokens,
            }),
          ],
        }
        const event: SessionEvent.Step.Failed = {
          id: EventV2.ID.make("evt_failed_step"),
          type: "session.next.step.failed",
          data: {
            sessionID: SessionV2.ID.make("ses_failed_step"),
            assistantMessageID: id,
            timestamp: DateTime.makeUnsafe(1000),
            error: input.error,
          },
        }
        yield* SessionMessageUpdater.update(SessionMessageUpdater.memory(state), event)
        expect(state.messages).toHaveLength(1)
        expect(state.messages[0]).toMatchObject({
          id,
          finish: input.finish,
          error: input.error,
          cost: 0.1,
          tokens,
          time: { completed: DateTime.makeUnsafe(1000) },
        })
      }),
    )
  }
})
