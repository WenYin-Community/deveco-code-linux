import { afterEach, describe, expect, spyOn } from "bun:test"
import path from "path"
import { Server } from "../../src/server/server"
import { Effect, Fiber } from "effect"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { it } from "../lib/effect"
import { waitGlobalBusEvent } from "./global-bus"
import { clearDevecoModelCache, getDevEcoModelCatalog } from "../../src/plugin/deveco-models"

function app() {
  return Server.Default().app
}

function waitDisposed(directory: string) {
  return waitGlobalBusEvent({
    message: "timed out waiting for instance disposal",
    predicate: (event) => event.payload.type === "server.instance.disposed" && event.directory === directory,
  })
}

const tmpdirEffect = (options: Parameters<typeof tmpdir>[0]) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir(options)),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

afterEach(async () => {
  clearDevecoModelCache()
  await disposeAllInstances()
  await resetDatabase()
})

async function loadTaskDefaults(model: string) {
  clearDevecoModelCache()
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      code: 200,
      body: {
        version: 1,
        inner_models: [
          {
            protocol: "openai",
            group_name: "default",
            model_configs: [{ id: 1, model_id: model, input_modalities: ["text", "image"] }],
            task_default_model_map: { ui_verification: model },
          },
        ],
      },
    }),
  )
  try {
    if (!(await getDevEcoModelCatalog("config-test-token"))) throw new Error("Model catalog fixture did not load")
  } finally {
    fetch.mockRestore()
  }
}

describe("config HttpApi", () => {
  it.live(
    "exports current task defaults without persisting or retaining them in configuration",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: { deveco: { options: { baseURL: "https://provider.invalid/v1" } } },
        },
      })
      for (const model of ["cloud-vision", "updated-cloud-vision"]) {
        yield* Effect.promise(() => loadTaskDefaults(model))
        const response = yield* Effect.promise(() =>
          Promise.resolve(
            app().request("/config", {
              headers: { "x-deveco-directory": tmp.path },
            }),
          ),
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          provider: {
            deveco: {
              options: {
                baseURL: "https://provider.invalid/v1",
                task_default_model_map: { ui_verification: model },
              },
            },
          },
        })
      }
      const stored = yield* Effect.promise(() => Bun.file(path.join(tmp.path, "deveco.json")).json())
      expect(stored.provider.deveco.options).toEqual({ baseURL: "https://provider.invalid/v1" })
    }),
  )

  it.live(
    "preserves explicitly configured task defaults",
    Effect.gen(function* () {
      yield* Effect.promise(() => loadTaskDefaults("cloud-vision"))
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: { deveco: { options: { task_default_model_map: { ui_verification: "configured-vision" } } } },
        },
      })
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-deveco-directory": tmp.path },
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          deveco: {
            options: {
              task_default_model_map: { ui_verification: "configured-vision" },
            },
          },
        },
      })
    }),
  )

  it.live(
    "does not add a default model mapping before a catalog is loaded",
    Effect.gen(function* () {
      clearDevecoModelCache()
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: { "x-deveco-directory": tmp.path },
          }),
        ),
      )
      expect(response.status).toBe(200)
      expect((yield* Effect.promise(() => response.json())).provider?.deveco).toBeUndefined()
    }),
  )

  it.live(
    "serves config update through the default server app",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({ config: { formatter: false, lsp: false } })
      const disposed = yield* waitDisposed(tmp.path).pipe(Effect.forkScoped({ startImmediately: true }))

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            method: "PATCH",
            headers: {
              "content-type": "application/json",
              "x-deveco-directory": tmp.path,
            },
            body: JSON.stringify({ username: "patched-user", formatter: false, lsp: false }),
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
      yield* Fiber.join(disposed)
      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "config.json")).json())).toMatchObject({
        username: "patched-user",
        formatter: false,
        lsp: false,
      })
    }),
  )

  it.live(
    "serves config with active provider model status",
    Effect.gen(function* () {
      const tmp = yield* tmpdirEffect({
        config: {
          formatter: false,
          lsp: false,
          provider: {
            omniroute: {
              models: {
                "gpt-4o": {
                  status: "active",
                },
              },
            },
          },
        },
      })

      const response = yield* Effect.promise(() =>
        Promise.resolve(
          app().request("/config", {
            headers: {
              "x-deveco-directory": tmp.path,
            },
          }),
        ),
      )

      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        provider: {
          omniroute: {
            models: {
              "gpt-4o": {
                status: "active",
              },
            },
          },
        },
      })
    }),
  )
})
