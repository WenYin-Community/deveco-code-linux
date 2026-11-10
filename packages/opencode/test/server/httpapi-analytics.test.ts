import { afterEach, describe, expect, mock, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { HttpRouter } from "effect/unstable/http"
import { InstanceHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { AnalyticsPaths, ClientCommandPayload } from "../../src/server/routes/instance/httpapi/groups/analytics"
import { ServerAuth } from "../../src/server/auth"
import type { ClientCommandInput } from "../../src/plugin/analytics/client-command"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

// The handler calls the recorder singleton, which reads real auth and writes the encrypted queue.
// Replace it so these route tests assert what the endpoint forwards without depending on whether
// the machine running them happens to be logged in.
const reported: ClientCommandInput[] = []
void mock.module("@/plugin/analytics/client-command", () => ({
  recordClientCommand: async (input: ClientCommandInput) => {
    reported.push(input)
  },
}))

type ServerModule = typeof import("../../src/server/routes/instance/httpapi/server")
let serverModule: ServerModule | undefined

// Loaded after the mock above so the handler resolves the stubbed recorder.
async function loadServer() {
  serverModule ??= await import("../../src/server/routes/instance/httpapi/server")
  return serverModule
}

afterEach(async () => {
  reported.length = 0
  await disposeAllInstances()
  await resetDatabase()
})

// Same app harness as the other instance route tests: the real route tree behind a web handler,
// no listen socket.
async function app(input: { password?: string; username?: string } = {}) {
  const { HttpApiApp } = await loadServer()
  const handler = HttpRouter.toWebHandler(
    HttpApiApp.routes.pipe(
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            DEVECO_SERVER_PASSWORD: input.password,
            DEVECO_SERVER_USERNAME: input.username,
          }),
        ),
      ),
    ),
    { disableLogger: true },
  ).handler
  return (request: string | URL, init?: RequestInit) =>
    handler(new Request(new URL(request, "http://localhost"), init), HttpApiApp.context)
}

function basic(username: string, password: string) {
  return ServerAuth.header({ username, password }) ?? ""
}

function report(input: { name: string; headers?: Record<string, string>; body?: unknown }): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...input.headers },
    body: JSON.stringify(input.body ?? { name: input.name }),
  }
}

describe("analytics HttpApi", () => {
  test("exposes the client command report route", () => {
    const spec = OpenApi.fromApi(InstanceHttpApi)
    const operation = spec.paths?.[AnalyticsPaths.command]?.post
    if (!operation) throw new Error("analytics.command is missing from the instance API")

    expect(AnalyticsPaths.command).toBe("/analytics/command")
    expect(operation.responses?.["200"]).toBeDefined()
    expect(operation.requestBody).toBeDefined()
  })

  test("accepts a name plus optional session and directory", () => {
    // The payload schema is the single source of truth for the TUI-facing fields.
    const fields = Object.keys(ClientCommandPayload.fields)
    expect(fields.sort()).toEqual(["directory", "name", "sessionID"])
  })

  test("forwards the report to the recorder and answers success", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = await app()

    const response = await request(
      AnalyticsPaths.command,
      report({
        name: "sessions",
        headers: { "x-deveco-directory": tmp.path },
        body: { name: "sessions", sessionID: "session-1", directory: tmp.path },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toBe(true)
    expect(reported).toEqual([{ name: "sessions", sessionID: "session-1", directory: tmp.path }])
  })

  test("uses the routing query directory when the body omits one", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = await app()

    const response = await request(
      `${AnalyticsPaths.command}?directory=${encodeURIComponent(tmp.path)}`,
      report({ name: "models" }),
    )

    expect(response.status).toBe(200)
    expect(reported).toEqual([{ name: "models", sessionID: undefined, directory: tmp.path }])
  })

  test("discards a directory that is not an existing absolute path", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = await app()

    const response = await request(
      AnalyticsPaths.command,
      report({
        name: "sessions",
        headers: { "x-deveco-directory": tmp.path },
        body: { name: "sessions", directory: "relative/invented" },
      }),
    )

    // The routing header still selects the instance, but the recorder is never handed the
    // invented string, so it cannot mint a project id for it.
    expect(response.status).toBe(200)
    expect(reported).toEqual([{ name: "sessions", sessionID: undefined, directory: undefined }])
  })

  test("requires configured auth like the other instance routes", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const request = await app({ password: "secret" })
    const headers = { "x-deveco-directory": tmp.path }

    const denied = await request(AnalyticsPaths.command, report({ name: "sessions", headers }))
    await denied.body?.cancel().catch(() => {})
    expect(denied.status).toBe(401)
    expect(reported).toEqual([])

    const allowed = await request(
      AnalyticsPaths.command,
      report({
        name: "sessions",
        headers: { ...headers, authorization: basic("deveco", "secret") },
      }),
    )
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toBe(true)
    // The routing header only selects the instance; project identity comes from the body or the
    // routing query parameter, so the recorder falls back to the server cwd here.
    expect(reported).toEqual([{ name: "sessions", sessionID: undefined, directory: undefined }])
  })
})
