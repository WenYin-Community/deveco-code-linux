import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionGoal } from "@/session/goal"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import { testEffect } from "../lib/effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const it = testEffect(LayerNode.buildLayer(LayerNode.group([SessionGoal.node, Session.node, SessionProjector.node])))

describe("session goal", () => {
  it.instance("persists lifecycle state in session metadata", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({ metadata: { retained: true } })

      const started = yield* goals.start(session.id, "  finish the feature  ")
      expect(started.replaced).toBe(false)
      expect(started.goal.objective).toBe("finish the feature")
      expect(started.goal.status).toBe("active")
      expect(started.goal.tokenBudget).toBeNull()
      expect(started.goal.budgetExhaustedAt).toBeNull()
      expect((yield* sessions.get(session.id)).metadata?.retained).toBe(true)

      const messageID = MessageID.ascending()
      const bound = yield* goals.bindPrompt({ sessionID: session.id, createdAt: started.goal.createdAt, messageID })
      expect(bound?.sourceMessageID).toBe(messageID)

      const paused = yield* goals.pause(session.id, "model failure")
      expect(paused?.status).toBe("paused")
      expect(paused?.activeSince).toBeNull()
      expect(paused?.reason).toBe("model failure")
      expect(paused?.sourceMessageID).toBeNull()
      expect(paused?.usedTokens).toBe(0)

      const resumed = yield* goals.resume(session.id)
      expect(resumed?.status).toBe("active")
      expect(resumed?.activeSince).not.toBeNull()

      const completed = yield* goals.complete(session.id, "tests passed")
      expect(completed?.status).toBe("complete")
      expect(completed?.reason).toBe("tests passed")
      expect(SessionGoal.fromMetadata((yield* sessions.get(session.id)).metadata)?.status).toBe("complete")

      expect(yield* goals.clear(session.id)).toBe(true)
      expect(yield* goals.get(session.id)).toBeNull()
      expect((yield* sessions.get(session.id)).metadata?.retained).toBe(true)
    }),
  )

  it.instance("reports replacement only for unfinished goals", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({})

      const first = yield* goals.start(session.id, "goal A")
      const replacement = yield* goals.start(session.id, "goal B")
      expect(replacement.replaced).toBe(true)
      expect(replacement.goal.createdAt).toBeGreaterThan(first.goal.createdAt)
      yield* goals.complete(session.id)
      expect((yield* goals.start(session.id, "goal C")).replaced).toBe(false)
    }),
  )

  it.instance("pauses an active goal when its token budget is exhausted", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({})
      const started = yield* goals.start(session.id, "bounded goal", 1_000)
      const sourceMessageID = MessageID.ascending()
      yield* goals.bindPrompt({
        sessionID: session.id,
        createdAt: started.goal.createdAt,
        messageID: sourceMessageID,
      })

      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        parentID: sourceMessageID,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: {
          input: 700,
          output: 200,
          reasoning: 50,
          cache: { read: 50, write: 0 },
        },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now(), completed: Date.now() },
      } satisfies SessionV1.Assistant)

      const result = yield* goals.checkBudget(session.id)
      expect(result.usedTokens).toBe(1_000)
      expect(result.exhausted).toBe(true)
      expect(result.goal?.status).toBe("paused")
      expect(result.goal?.budgetExhaustedAt).not.toBeNull()
      expect(result.goal?.reason).toBe("token budget exhausted")

      const resumed = yield* goals.resume(session.id)
      expect(resumed?.status).toBe("paused")
      expect(resumed?.budgetExhaustedAt).not.toBeNull()

      const stillExhausted = yield* goals.resume(session.id, 1_000)
      expect(stillExhausted?.status).toBe("paused")

      const resumedWithMoreBudget = yield* goals.resume(session.id, 2_000)
      expect(resumedWithMoreBudget?.status).toBe("active")
      expect(resumedWithMoreBudget?.tokenBudget).toBe(2_000)
      expect(resumedWithMoreBudget?.budgetExhaustedAt).toBeNull()
    }),
  )

  it.instance("anchors a resumed goal to the latest user message", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({})
      const started = yield* goals.start(session.id, "resumed goal")
      const userID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: userID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "build",
        model: {
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("test-model"),
        },
      } satisfies SessionV1.User)
      yield* goals.bindPrompt({ sessionID: session.id, createdAt: started.goal.createdAt, messageID: userID })

      yield* sessions.updateMessage({
        id: MessageID.ascending(),
        sessionID: session.id,
        parentID: userID,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: {
          input: 100,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now(), completed: Date.now() },
      } satisfies SessionV1.Assistant)

      yield* goals.pause(session.id, "token budget exhausted")
      const resumed = yield* goals.resume(session.id)
      expect(resumed?.sourceMessageID).toBe(userID)

      const resumedAssistantID = MessageID.ascending()
      yield* sessions.updateMessage({
        id: resumedAssistantID,
        sessionID: session.id,
        parentID: userID,
        role: "assistant",
        mode: "build",
        agent: "build",
        path: { cwd: ".", root: "." },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        modelID: ModelV2.ID.make("test-model"),
        providerID: ProviderV2.ID.make("test"),
        time: { created: Date.now(), completed: Date.now() },
      } satisfies SessionV1.Assistant)
      expect(yield* goals.canUpdateFrom(session.id, resumedAssistantID)).toBe(true)
    }),
  )

  it.instance("treats legacy goal metadata as unlimited", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        metadata: {
          deveco_goal: {
            objective: "legacy",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
            activeSince: 1,
            elapsedMilliseconds: 0,
            sourceMessageID: null,
            reason: null,
          },
        },
      })
      const goal = SessionGoal.fromMetadata((yield* sessions.get(session.id)).metadata)
      expect(goal?.tokenBudget).toBeNull()
      expect(goal?.budgetExhaustedAt).toBeNull()
      expect(goal?.usedTokens).toBe(0)
    }),
  )

  it.instance("settles late provider usage once for stopped goals and excludes later work", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      for (const status of ["complete", "paused"] as const) {
        const session = yield* sessions.create({})
        const started = yield* goals.start(session.id, "late provider usage")
        const sourceMessageID = MessageID.ascending()
        const bound = yield* goals.bindPrompt({
          sessionID: session.id,
          createdAt: started.goal.createdAt,
          messageID: sourceMessageID,
        })
        const message = {
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID: sourceMessageID,
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: Date.now() },
        } satisfies SessionV1.Assistant
        yield* sessions.updateMessage(message)
        if (status === "complete") yield* goals.complete(session.id)
        if (status === "paused") yield* goals.pause(session.id)
        expect((yield* goals.get(session.id))?.usedTokens).toBe(0)

        yield* sessions.updateMessage({
          ...message,
          tokens: { input: 700, output: 100, reasoning: 10, cache: { read: 80, write: 10 } },
        })
        yield* sessions.updateMessage({
          ...message,
          id: MessageID.ascending(),
          tokens: { ...message.tokens, input: 500 },
        })
        yield* goals.settleUsage({ sessionID: session.id, goal: bound, messageID: message.id })
        expect(yield* goals.get(session.id)).toMatchObject({ status, usedTokens: 900 })
        yield* goals.settleUsage({ sessionID: session.id, goal: bound, messageID: message.id })
        expect(yield* goals.tokenUsage(session.id)).toBe(900)

        yield* goals.start(session.id, "replacement goal")
        yield* goals.complete(session.id)
        yield* goals.settleUsage({ sessionID: session.id, goal: bound, messageID: message.id })
        expect((yield* goals.get(session.id))?.usedTokens).toBe(0)
      }
    }),
  )

  it.instance("does not count tokens from a paused session", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const goals = yield* SessionGoal.Service
      const session = yield* sessions.create({})
      const started = yield* goals.start(session.id, "paused usage")
      const sourceMessageID = MessageID.ascending()
      yield* goals.bindPrompt({
        sessionID: session.id,
        createdAt: started.goal.createdAt,
        messageID: sourceMessageID,
      })

      const assistant = (parentID: MessageID, input: number) =>
        sessions.updateMessage({
          id: MessageID.ascending(),
          sessionID: session.id,
          parentID,
          role: "assistant",
          mode: "build",
          agent: "build",
          path: { cwd: ".", root: "." },
          cost: 0,
          tokens: {
            input,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: ModelV2.ID.make("test-model"),
          providerID: ProviderV2.ID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
        } satisfies SessionV1.Assistant)

      yield* assistant(sourceMessageID, 100)
      const paused = yield* goals.pause(session.id, "stopped by user")
      expect(paused?.usedTokens).toBe(100)
      expect(yield* goals.tokenUsage(session.id)).toBe(100)

      const pausedParent = MessageID.ascending()
      yield* assistant(pausedParent, 500)
      expect(yield* goals.tokenUsage(session.id)).toBe(100)

      const resumed = yield* goals.resume(session.id)
      expect(resumed?.status).toBe("active")
      expect(resumed?.usedTokens).toBe(100)
      expect(yield* goals.tokenUsage(session.id)).toBe(100)

      const resumeParent = MessageID.ascending()
      yield* assistant(resumeParent, 40)
      expect(yield* goals.tokenUsage(session.id)).toBe(140)
    }),
  )
})
