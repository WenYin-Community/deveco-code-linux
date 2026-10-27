import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { Permission, AskTimedOutError } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"

const events = EventV2Bridge.defaultLayer
const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = Layer.mergeAll(
  Permission.layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(events)),
  events,
  CrossSpawnSpawner.defaultLayer,
  InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
)
const it = testEffect(env)

const askInput = (): PermissionV1.AskInput => ({
  sessionID: SessionID.make("ses_permission_timeout"),
  permission: "hdc",
  patterns: ["hdc install"],
  always: ["hdc install"],
  metadata: { command: "hdc install app.hap" },
  ruleset: [],
})

const ask = (options: Permission.AskOptions) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(askInput(), options)
  })

const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      const list = yield* permission.list()
      if (list.length === count) return list
      yield* Effect.sleep("10 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(new Error(`timed out waiting for ${count} pending permission request(s)`)),
    }),
  )

// Squash a failed exit into its error; a nested Exit (from
// Fiber.await) must already be flattened by the caller.
function squashFailure<A, E>(exit: Exit.Exit<A, E>) {
  if (Exit.isFailure(exit)) return Cause.squash(exit.cause)
  throw new Error("expected permission effect to fail")
}

const fail = <A, E, R>(self: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return squashFailure<A, E>(yield* Effect.exit(self))
  })

describe("permission ask timeout (hdc guard)", () => {
  // `permission.ask` keeps its pending/approved state in an
  // InstanceState, so every test runs inside a temp instance
  // (it.instance) rather than a bare live runtime.
  it.instance("auto-rejects after timeoutMs and clears the pending request", () =>
    Effect.gen(function* () {
      const error = yield* fail(ask({ timeoutMs: 100 }))
      expect(error).toBeInstanceOf(AskTimedOutError)
      expect(error).toBeInstanceOf(PermissionV1.RejectedError)

      const pending = yield* Effect.gen(function* () {
        const permission = yield* Permission.Service
        return yield* permission.list()
      })
      expect(pending).toHaveLength(0)
    }),
  )

  it.instance("resolves normally when replied before the timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* ask({ timeoutMs: 30_000 }).pipe(Effect.forkScoped)

      const [pending] = yield* waitForPending(1)
      const permission = yield* Permission.Service
      yield* permission.reply({ requestID: pending.id, reply: "once" })

      yield* Fiber.await(fiber)
    }),
  )

  it.instance("a timed-out ask is not remembered as an approval", () =>
    Effect.gen(function* () {
      yield* fail(ask({ timeoutMs: 50 }))

      // The second ask with the same pattern must ask again: the
      // timeout's reject publication must not act as an approval.
      const fiber = yield* ask({ timeoutMs: 100 }).pipe(Effect.forkScoped)
      yield* waitForPending(1)

      // Fiber.await resolves with the fiber's Exit as its success
      // value, so the failure lives one level down.
      const error = squashFailure(yield* Fiber.await(fiber))
      expect(error).toBeInstanceOf(PermissionV1.RejectedError)
    }),
  )
})
