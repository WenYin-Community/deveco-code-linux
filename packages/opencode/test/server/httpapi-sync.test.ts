import { afterEach, describe, expect, mock } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Flag } from "@opencode-ai/core/flag/flag"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { SyncTicket } from "../../src/control-plane/sync-ticket"
import { SyncPaths } from "../../src/server/routes/instance/httpapi/groups/sync"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { Session } from "@/session/session"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory, requestWithQueryInDirectory } from "./httpapi-layer"

const originalWorkspaces = Flag.DEVECO_EXPERIMENTAL_WORKSPACES
const originalWorkspaceID = Flag.DEVECO_WORKSPACE_ID
const TEST_WORKSPACE_ID = WorkspaceV2.ID.make("wrk_test_sync")
const context = Context.empty() as Context.Context<unknown>
const it = testEffect(Layer.mergeAll(Session.defaultLayer, httpApiLayer))

afterEach(async () => {
  mock.restore()
  Flag.DEVECO_EXPERIMENTAL_WORKSPACES = originalWorkspaces
  Flag.DEVECO_WORKSPACE_ID = originalWorkspaceID
  await disposeAllInstances()
  await resetDatabase()
})

describe("sync HttpApi", () => {
  it.instance(
    "serves sync routes",
    () =>
      Effect.gen(function* () {
        Flag.DEVECO_EXPERIMENTAL_WORKSPACES = true
        Flag.DEVECO_WORKSPACE_ID = TEST_WORKSPACE_ID
        const tmp = yield* TestInstance
        const headers = { "x-deveco-directory": tmp.directory, "content-type": "application/json" }
        const session = yield* Session.use.create({ title: "sync" })
        const ticket = SyncTicket.mint(TEST_WORKSPACE_ID)

        const started = yield* requestInDirectory(SyncPaths.start, tmp.directory, { method: "POST", headers })
        expect(started.status).toBe(200)
        expect(yield* started.json).toBe(true)

        const history = yield* requestInDirectory(SyncPaths.history, tmp.directory, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
        })
        expect(history.status).toBe(200)
        const rows = (yield* history.json) as Array<{
          id: string
          aggregate_id: string
          seq: number
          type: string
          data: Record<string, unknown>
        }>
        expect(rows.map((row) => row.aggregate_id)).toContain(session.id)

        const replayed = yield* requestWithQueryInDirectory(
          `${SyncPaths.replay}?ticket=${encodeURIComponent(ticket)}`,
          tmp.directory,
          {
          method: "POST",
          headers,
          body: JSON.stringify({
            directory: tmp.directory,
            events: rows
              .filter((row) => row.aggregate_id === session.id)
              .map((row) => ({
                id: row.id,
                aggregateID: row.aggregate_id,
                seq: row.seq,
                type: row.type,
                data: row.data,
              })),
          }),
        })
        expect(replayed.status).toBe(200)
        expect(yield* replayed.json).toEqual({ sessionID: session.id })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance(
    "validates seq values",
    () =>
      Effect.gen(function* () {
        Flag.DEVECO_WORKSPACE_ID = TEST_WORKSPACE_ID
        const tmp = yield* TestInstance
        const headers = { "x-deveco-directory": tmp.directory, "content-type": "application/json" }
        const ticket = SyncTicket.mint(TEST_WORKSPACE_ID)
        const replayPath = `${SyncPaths.replay}?ticket=${encodeURIComponent(ticket)}`
        const cases = [
          {
            path: SyncPaths.history,
            body: { aggregate: -1 },
          },
          {
            path: SyncPaths.history,
            body: { aggregate: 1.5 },
          },
          {
            path: replayPath,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: -1, type: "session.created", data: {} }],
            },
          },
          {
            path: replayPath,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 1.5, type: "session.created", data: {} }],
            },
          },
          {
            path: replayPath,
            body: {
              directory: tmp.directory,
              events: [{ id: "event", aggregateID: "session", seq: 0, type: "session.created", data: {} }],
            },
          },
        ]

        for (const item of cases) {
          const response = yield* (item.path.includes("?")
            ? requestWithQueryInDirectory(item.path, tmp.directory, {
                method: "POST",
                headers,
                body: JSON.stringify(item.body),
              })
            : requestInDirectory(item.path, tmp.directory, {
                method: "POST",
                headers,
                body: JSON.stringify(item.body),
              }))
          expect(response.status).toBe(400)
        }
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  it.instance.skip(
    "returns structured validation errors",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const response = yield* Effect.promise(() =>
          HttpApiApp.webHandler().handler(
            new Request(`http://localhost${SyncPaths.history}`, {
              method: "POST",
              headers: { "x-deveco-directory": tmp.directory, "content-type": "application/json" },
              body: JSON.stringify({ aggregate: -1 }),
            }),
            context,
          ),
        )

        expect(response.status).toBe(400)
        expect(response.headers.get("content-type") ?? "").toContain("application/json")
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>
        expect(body.success).toBe(false)
        expect(Array.isArray(body.error) || Array.isArray(body.errors)).toBe(true)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
