import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import { SessionGoal } from "@/session/goal"
import { setTimeout } from "node:timers/promises"

type Events = Awaited<ReturnType<OpencodeClient["event"]["subscribe"]>>
type Start = Extract<NonNullable<Parameters<OpencodeClient["session"]["goal"]>[0]["body"]>, { action: "start" }>

export async function runGoal(input: {
  client: OpencodeClient
  sessionID: string
  body: Start
  signal: AbortSignal
  consume: (events: Events) => Promise<string | undefined>
}) {
  if (input.signal.aborted) return { goal: null, exitCode: 130 }
  const before = await snapshot(input.client, input.sessionID)
  if (before.status !== "idle") throw new Error("Cannot start a goal in a busy session.")
  if (before.goal?.status === "active" || before.goal?.status === "paused") {
    throw new Error("This session already has an active or paused goal. Use a new session or clear the existing goal.")
  }

  const controller = new AbortController()
  const ready = Promise.withResolvers<void>()
  const interrupted = Promise.withResolvers<void>()
  const state = {
    goal: null as SessionGoal.Info | null,
    error: undefined as unknown,
    started: false,
    settled: false,
    interrupted: false,
    terminalGeneration: null as number | null,
    drainedGeneration: null as number | null,
    consumed: Promise.resolve(),
    wake: Promise.withResolvers<void>(),
  }
  const interrupt = () => {
    interrupted.resolve()
    ready.resolve()
  }
  input.signal.addEventListener("abort", interrupt, { once: true })
  if (input.signal.aborted) interrupt()

  const timeout = globalThis.setTimeout(() => {
    state.error = new Error("Timed out connecting to the local Goal event stream.")
    ready.resolve()
  }, 10_000)

  try {
    const events = await input.client.event.subscribe(undefined, {
      signal: controller.signal,
      sseMaxRetryAttempts: 1,
      onSseError(error) {
        if (controller.signal.aborted) return
        state.error = error
        ready.resolve()
        state.wake.resolve()
      },
    })
    const stream = async function* () {
      for await (const event of events.stream) {
        if (event.type === "server.connected") ready.resolve()
        yield event
        // Resuming after yield means the renderer processed this event and all
        // preceding output. A polled idle snapshot alone is not a drain fence.
        if (event.type === "session.updated" && event.properties.info.id === input.sessionID) {
          const goal = SessionGoal.fromMetadata(event.properties.info.metadata)
          state.terminalGeneration = goal && goal.status !== "active" ? goal.createdAt : null
          if (state.terminalGeneration === null) state.drainedGeneration = null
        }
        if (event.type === "session.status" && event.properties.sessionID === input.sessionID) {
          state.drainedGeneration = event.properties.status.type === "idle" ? state.terminalGeneration : null
          state.wake.resolve()
        }
      }
    }
    state.consumed = input.consume({ stream: stream() }).then(
      (error) => {
        if (error) state.error = new Error(error)
        if (!controller.signal.aborted && !state.error)
          state.error = new Error("Goal event stream closed unexpectedly.")
        ready.resolve()
        state.wake.resolve()
      },
      (error: unknown) => {
        state.error = error
        ready.resolve()
        state.wake.resolve()
      },
    )
    // SDK SSE generators connect lazily. Wait for server.connected before
    // submitting, otherwise a fast provider can finish before subscription.
    await ready.promise
    globalThis.clearTimeout(timeout)
    if (input.signal.aborted) return { goal: null, exitCode: 130 }
    if (state.error) throw state.error
    state.started = true
    const started = await input.client.session.goal(
      { sessionID: input.sessionID, body: input.body },
      { throwOnError: true, signal: AbortSignal.timeout(30_000) },
    )
    state.goal = SessionGoal.fromMetadata({ deveco_goal: started.data.goal })
    if (!state.goal) throw new Error("The server did not return the started goal.")

    // This loop only observes backend state; model execution and budgeting
    // remain owned by the existing Goal service.
    while (true) {
      state.wake = Promise.withResolvers<void>()
      if (state.error) throw state.error
      if (input.signal.aborted && !state.interrupted) {
        state.interrupted = true
        await abortOwnedGoal(input.client, input.sessionID, state.goal.createdAt)
      }
      const current = await snapshot(input.client, input.sessionID)
      if (!current.goal || current.goal.createdAt !== state.goal.createdAt) {
        throw new Error("The running goal was cleared or replaced by another client.")
      }
      if (
        current.goal.status !== "active" &&
        current.status === "idle" &&
        state.drainedGeneration === state.goal.createdAt
      ) {
        state.settled = true
        return {
          goal: current.goal,
          exitCode: state.interrupted
            ? 130
            : current.goal.status === "complete"
              ? 0
              : current.goal.budgetExhaustedAt !== null
                ? 2
                : 1,
        }
      }
      await Promise.race([
        setTimeout(1000, undefined, { signal: controller.signal }).catch(() => {}),
        state.wake.promise,
        ...(state.interrupted ? [] : [interrupted.promise]),
      ])
    }
  } finally {
    globalThis.clearTimeout(timeout)
    input.signal.removeEventListener("abort", interrupt)
    // A failed start request may already have created a goal. Do not leave it
    // running on transport failure, and never abort a replacement generation.
    if (state.started && !state.settled) {
      await snapshot(input.client, input.sessionID)
        .then((current) => {
          if (!current.goal || current.goal.status !== "active") return
          if (state.goal && current.goal.createdAt !== state.goal.createdAt) return
          if (
            !state.goal &&
            (current.goal.createdAt === before.goal?.createdAt ||
              current.goal.objective !== input.body.objective.trim())
          )
            return
          return abortOwnedGoal(input.client, input.sessionID, current.goal.createdAt)
        })
        .catch(() => {})
    }
    controller.abort()
    await state.consumed
  }
}

async function snapshot(client: OpencodeClient, sessionID: string) {
  const result = await Promise.all([
    client.session.get({ sessionID }, { throwOnError: true, signal: AbortSignal.timeout(15_000) }),
    client.session.status(undefined, { throwOnError: true, signal: AbortSignal.timeout(15_000) }),
  ])
  return {
    goal: SessionGoal.fromMetadata(result[0].data.metadata),
    status: result[1].data[sessionID]?.type ?? "idle",
  }
}

async function abortOwnedGoal(client: OpencodeClient, sessionID: string, createdAt: number) {
  const current = await client.session.get({ sessionID }, { throwOnError: true, signal: AbortSignal.timeout(15_000) })
  if (SessionGoal.fromMetadata(current.data.metadata)?.createdAt !== createdAt) return
  await client.session.abort({ sessionID }, { throwOnError: true, signal: AbortSignal.timeout(15_000) })
}

export * as RunGoal from "./goal"
