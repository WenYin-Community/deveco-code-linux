import { afterAll, beforeAll, describe, expect } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Effect, Fiber, Layer } from "effect"
import { runGoal } from "../../../src/cli/cmd/run/goal"
import { SessionGoal } from "../../../src/session/goal"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { testEffectShared, awaitWithTimeout } from "../../lib/effect"
import { TestLLMServer, reply } from "../../lib/llm-server"
import { testProviderConfig } from "../../lib/test-provider"
import { Server } from "../../../src/server/server"
import { Session } from "../../../src/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffectShared(
  Layer.mergeAll(
    FSUtil.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    LayerNode.buildLayer(LayerNode.group([Session.node, SessionGoal.node, SessionProjector.node])),
  ),
)

const flagNames = ["DEVECO_DISABLE_DEFAULT_SKILLS", "DEVECO_DISABLE_EXTERNAL_SKILLS", "DEVECO_PURE"]
const originalFlags = flagNames.map((name) => [name, process.env[name]] as const)
beforeAll(() => flagNames.forEach((name) => (process.env[name] = "1")))
afterAll(() =>
  originalFlags.forEach(([name, value]) => {
    if (value === undefined) delete process.env[name]
    if (value !== undefined) process.env[name] = value
  }),
)

describe("local Goal lifecycle", () => {
  it.live(
    "guards busy and unfinished sessions and pauses on interruption at both boundaries",
    () =>
      Effect.gen(function* () {
        const llm = yield* TestLLMServer
        return yield* provideTmpdirInstance(
          (directory) =>
            Effect.gen(function* () {
              for (const boundary of ["starting", "executing"] as const) {
                yield* llm.reset
                const controller = new AbortController()
                const client = createOpencodeClient({
                  baseUrl: "http://opencode.internal",
                  directory,
                  fetch: Object.assign(
                    async (input: RequestInfo | URL, init?: RequestInit) => {
                      const request = input instanceof Request ? input : new Request(input, init)
                      const response = await Server.Default().app.fetch(request)
                      // Interrupt before the start response is decoded by the SDK.
                      if (boundary === "starting" && new URL(request.url).pathname.endsWith("/goal")) controller.abort()
                      return response
                    },
                    { preconnect: globalThis.fetch.preconnect },
                  ),
                })
                const session = yield* Effect.promise(() =>
                  client.session.create({}, { throwOnError: true, signal: AbortSignal.timeout(15_000) }),
                )
                const running = Promise.withResolvers<void>()
                yield* llm.pushMatch((hit) => {
                  const goal = JSON.stringify(hit.body).includes("DevEco goal mode is active.")
                  if (goal) running.resolve()
                  return goal
                }, reply().hang())
                const task = yield* Effect.tryPromise(() =>
                  runGoal({
                    client,
                    sessionID: session.data.id,
                    signal: controller.signal,
                    body: {
                      action: "start",
                      objective: "interruptible goal",
                      agent: "build",
                      model: { providerID: "test", modelID: "test-model" },
                    },
                    consume: async (events) => {
                      for await (const _event of events.stream) {
                      }
                      return undefined
                    },
                  }),
                ).pipe(Effect.forkChild)
                if (boundary === "executing") {
                  yield* awaitWithTimeout(
                    Effect.promise(() => running.promise),
                    "provider never started",
                    "30 seconds",
                  )
                  yield* Effect.promise(async () => {
                    await expect(
                      runGoal({
                        client,
                        sessionID: session.data.id,
                        signal: AbortSignal.timeout(15_000),
                        body: { action: "start", objective: "replacement goal", agent: "build" },
                        consume: async () => undefined,
                      }),
                    ).rejects.toThrow("busy session")
                  })
                  controller.abort()
                }
                const result = yield* awaitWithTimeout(Fiber.join(task), "interrupted Goal never settled", "30 seconds")
                expect(result.exitCode).toBe(130)
                expect(result.goal?.status).toBe("paused")
                expect(result.goal?.reason).toBe("interrupted by user")
                const persisted = yield* Effect.promise(() =>
                  client.session.get({ sessionID: session.data.id }, { throwOnError: true }),
                )
                expect(SessionGoal.fromMetadata(persisted.data.metadata)?.status).toBe("paused")
                const status = yield* Effect.promise(() => client.session.status(undefined, { throwOnError: true }))
                expect(status.data[session.data.id]?.type ?? "idle").toBe("idle")
                yield* Effect.promise(async () => {
                  await expect(
                    runGoal({
                      client,
                      sessionID: session.data.id,
                      signal: AbortSignal.timeout(15_000),
                      body: { action: "start", objective: "replacement goal", agent: "build" },
                      consume: async () => undefined,
                    }),
                  ).rejects.toThrow("already has an active or paused goal")
                })
                const unchanged = yield* Effect.promise(() =>
                  client.session.get({ sessionID: session.data.id }, { throwOnError: true }),
                )
                expect(SessionGoal.fromMetadata(unchanged.data.metadata)?.objective).toBe("interruptible goal")
              }
            }),
          { config: testProviderConfig(llm.url) },
        )
      }).pipe(Effect.provide(TestLLMServer.layer)),
    60_000,
  )
})
