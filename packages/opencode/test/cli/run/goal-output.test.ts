import { describe, expect } from "bun:test"
import { createOpencodeClient, type SessionGoal } from "@opencode-ai/sdk/v2"
import { Effect, Fiber } from "effect"
import { runGoal } from "../../../src/cli/cmd/run/goal"
import { it, awaitWithTimeout } from "../../lib/effect"

describe("Goal output draining", () => {
  it.live(
    "waits for slow consumers after completion and budget exhaustion",
    () =>
      Effect.gen(function* () {
        for (const result of [
          { status: "complete", exitCode: 0 },
          { status: "paused", exitCode: 2 },
        ] as const) {
          const sessionID = "ses_output_review"
          const goal = {
            objective: "drain all output",
            status: result.status,
            createdAt: 1,
            updatedAt: 2,
            activeSince: null,
            elapsedMilliseconds: 1,
            sourceMessageID: null,
            reason: result.status === "paused" ? "token budget exhausted" : null,
            tokenBudget: result.status === "paused" ? 1000 : null,
            budgetExhaustedAt: result.status === "paused" ? 2 : null,
            usedTokens: 1200,
          } satisfies SessionGoal
          const session = {
            id: sessionID,
            projectID: "project",
            directory: "/project",
            title: "output",
            version: "1",
            time: { created: 1, updated: 2 },
          }
          const controller = new AbortController()
          const paused = Promise.withResolvers<void>()
          const release = Promise.withResolvers<void>()
          const cancelled = Promise.withResolvers<"cancelled">()
          const waiting = Promise.withResolvers<"waiting">()
          const transport = {
            started: false,
            polls: 0,
            writer: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
          }
          const observed: string[] = []
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              release.resolve()
              controller.abort()
            }),
          )
          // Control only the HTTP/SSE boundary: use the real SDK and runGoal.
          // Gates simulate a slow renderer without timing-based readiness waits.
          const client = createOpencodeClient({
            baseUrl: "http://goal-output.test",
            fetch: Object.assign(
              async (input: RequestInfo | URL, init?: RequestInit) => {
                const request = input instanceof Request ? input : new Request(input, init)
                const url = new URL(request.url)
                if (url.pathname === "/event") {
                  request.signal.addEventListener("abort", () => cancelled.resolve("cancelled"), { once: true })
                  return new Response(
                    new ReadableStream<Uint8Array>({
                      start(writer) {
                        transport.writer = writer
                        writer.enqueue(
                          new TextEncoder().encode(
                            `data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`,
                          ),
                        )
                      },
                    }),
                    { headers: { "content-type": "text/event-stream" } },
                  )
                }
                if (url.pathname.endsWith("/goal")) {
                  transport.started = true
                  const text = (value: string) => ({
                    type: "message.part.updated",
                    properties: { part: { sessionID, type: "text", text: value } },
                  })
                  for (const event of [
                    { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
                    // An earlier idle event must not count as the terminal fence.
                    { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
                    text("first"),
                    { type: "session.updated", properties: { info: { ...session, metadata: { deveco_goal: goal } } } },
                    text("last"),
                    { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
                  ])
                    transport.writer!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`))
                  return Response.json({ goal, replaced: false })
                }
                if (url.pathname === "/session/status") {
                  if (transport.started && ++transport.polls === 2) waiting.resolve("waiting")
                  return Response.json({})
                }
                if (url.pathname === `/session/${sessionID}/abort`) return Response.json(true)
                if (url.pathname === `/session/${sessionID}`)
                  return Response.json({ ...session, metadata: transport.started ? { deveco_goal: goal } : {} })
                throw new Error(`Unexpected request: ${url.pathname}`)
              },
              { preconnect: globalThis.fetch.preconnect },
            ),
          })
          const task = yield* Effect.tryPromise(() =>
            runGoal({
              client,
              sessionID,
              body: { action: "start", objective: goal.objective, tokenBudget: goal.tokenBudget },
              signal: controller.signal,
              consume: async (events) => {
                for await (const event of events.stream) {
                  if (event.type !== "message.part.updated" || event.properties.part.type !== "text") continue
                  if (event.properties.part.text === "first") {
                    paused.resolve()
                    await release.promise
                  }
                  observed.push(event.properties.part.text)
                }
                return undefined
              },
            }),
          ).pipe(Effect.forkChild)
          yield* awaitWithTimeout(
            Effect.promise(() => paused.promise),
            "renderer never paused",
            "5 seconds",
          )
          const outcome = yield* awaitWithTimeout(
            Effect.promise(() => Promise.race([cancelled.promise, waiting.promise])),
            "Goal monitor neither waited nor cancelled",
            "5 seconds",
          )
          expect(outcome).toBe("waiting")
          release.resolve()
          const completed = yield* awaitWithTimeout(Fiber.join(task), "Goal output never drained", "5 seconds")
          expect(completed.exitCode).toBe(result.exitCode)
          expect(observed).toEqual(["first", "last"])
        }
      }),
    20_000,
  )
})
