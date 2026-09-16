import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/fixture"
import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.layer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("upgrades to latest when the request body is omitted", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.post(GlobalPaths.upgrade)

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects malformed upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text("{", "application/json")),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({ success: false, error: "Invalid request body" })
    }),
  )
})

const productPath = "/global/product-agreement"
describe("product agreement HttpApi", () => {
  it.live("exposes review links and accepts the displayed version without HUAWEI auth", () =>
    Effect.gen(function* () {
      const response = yield* HttpClient.get(productPath)
      expect(response.status).toBe(200)
      const agreement = (yield* response.json) as { version: string; termsUrl: string; privacyUrl: string }
      expect(agreement.termsUrl).toStartWith("https://")
      expect(agreement.privacyUrl).toStartWith("https://")
      const accepted = yield* HttpClientRequest.post(productPath).pipe(
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify({ version: agreement.version, accepted: true }), "application/json")),
        HttpClient.execute,
      )
      expect(accepted.status).toBe(200)
      expect(yield* accepted.json).toMatchObject({ accepted: true, version: agreement.version })
    }),
  )
  it.live("reports storage failures as server errors without exposing filesystem paths", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const original = Global.Path.state
      yield* Effect.addFinalizer(() => Effect.sync(() => { Global.Path.state = original }))
      yield* Effect.promise(() => Bun.write(`${tmp.path}/not-a-directory`, "file"))
      Global.Path.state = `${tmp.path}/not-a-directory`
      const response = yield* HttpClientRequest.post(productPath).pipe(
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify({ version: "1", accepted: true }), "application/json")),
        HttpClient.execute,
      )
      expect(response.status).toBe(500)
      expect(yield* response.json).toEqual({
        _tag: "UnknownError", message: "Unable to save product agreement acceptance.",
      })
    }),
  )
  it.live("rejects missing consent and outdated versions", () =>
    Effect.gen(function* () {
      for (const payload of [{ version: "old", accepted: true }, { version: "1", accepted: false }]) {
        const response = yield* HttpClientRequest.post(productPath).pipe(
          HttpClientRequest.setBody(HttpBody.text(JSON.stringify(payload), "application/json")),
          HttpClient.execute,
        )
        expect(response.status).toBe(400)
      }
    }),
  )
})

describe("agreement upload HttpApi", () => {
  it.live("retry cannot create consent and stale service revisions are rejected", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const original = Global.Path.state
      yield* Effect.addFinalizer(() => Effect.sync(() => { Global.Path.state = original }))
      Global.Path.state = tmp.path
      const retry = yield* HttpClientRequest.post(`${productPath}/retry`).pipe(
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify({ force: true }), "application/json")),
        HttpClient.execute,
      )
      expect(retry.status).toBe(200)
      expect(yield* retry.json).toMatchObject({ accepted: false, upload: { state: "not_signed" } })
      const stale = yield* HttpClientRequest.post(productPath).pipe(
        HttpClientRequest.setBody(HttpBody.text(JSON.stringify({ version: "1", accepted: true, serviceRevision: "stale" }), "application/json")),
        HttpClient.execute,
      )
      expect(stale.status).toBe(400)
      const current = yield* HttpClient.get(productPath)
      expect(yield* current.json).toMatchObject({ accepted: false })
    }),
  )
})
