import { afterEach, describe, expect, spyOn } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Npm } from "@opencode-ai/core/npm"
import { InstanceStore } from "@/project/instance-store"
import type { PluginLoadRecord } from "@/plugin/load-status"
import { snapshot } from "@/plugin/load-status"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const { Plugin } = await import("../../src/plugin/index")
const { EventV2Bridge } = await import("../../src/event-v2-bridge")
const { RuntimeFlags } = await import("../../src/effect/runtime-flags")
const { TestConfig } = await import("../fixture/config")

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer, testInstanceStoreLayer))

type Spec = string | [string, Record<string, unknown>]
type Read = () => Record<string, PluginLoadRecord>

function declarePlugins(directory: string, specs: Spec[]) {
  return Effect.promise(() => Bun.write(path.join(directory, "deveco.json"), JSON.stringify({ plugin: specs })))
}

function writePlugin(directory: string, name: string, code: string) {
  return Effect.promise(async () => {
    const file = path.join(directory, name)
    await Bun.write(file, code)
    return pathToFileURL(file).href
  })
}

// Runs the real plugin layer over the specs declared in `directory`/deveco.json and reads the
// load-status registry from inside the instance scope, so a test sees exactly what a running server
// leaves behind for the analytics plugin to join with the config.
function withRecords<A, R>(directory: string, body: (read: Read) => Effect.Effect<A, never, R>) {
  const source = path.join(directory, "deveco.json")
  return Effect.gen(function* () {
    const specs = yield* Effect.promise(
      async () => ((await Bun.file(source).json()) as { plugin?: Spec[] }).plugin ?? [],
    )
    return yield* Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      yield* plugin.list()
      return yield* body(() => snapshot(directory))
    }).pipe(
      Effect.provide(
        Plugin.layer.pipe(
          Layer.provide(EventV2Bridge.defaultLayer),
          Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
          Layer.provide(
            TestConfig.layer({
              get: () =>
                Effect.succeed({
                  plugin: specs,
                  plugin_origins: specs.map((spec) => ({ spec, source, scope: "local" as const })),
                }),
              directories: () => Effect.succeed([directory]),
            }),
          ),
        ),
      ),
      provideInstance(directory),
    )
  })
}

describe("plugin.load-status.recording", () => {
  it.live("records a plugin that loads, keyed by the config specifier", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const plain = yield* writePlugin(
        directory,
        "plain.ts",
        'export default { id: "rec-plain", server: async () => ({}) }\n',
      )
      const configured = yield* writePlugin(
        directory,
        "configured.ts",
        'export default { id: "rec-configured", server: async () => ({}) }\n',
      )
      yield* declarePlugins(directory, [plain, [configured, { profile: "test" }]])

      const records = yield* withRecords(directory, (read) => Effect.succeed(read()))
      expect(records[plain]).toEqual({ loadStatus: "loaded", failureStage: "" })
      // A [spec, options] declaration is recorded under its specifier, the key analytics looks up.
      expect(records[configured]).toEqual({ loadStatus: "loaded", failureStage: "" })
    }),
  )

  it.live("records the install stage when an npm plugin cannot be installed", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* declarePlugins(directory, ["rec-npm-plugin@1.0.0"])
      const add = spyOn(Npm, "add").mockRejectedValue(new Error("boom"))
      try {
        const records = yield* withRecords(directory, (read) => Effect.succeed(read()))
        expect(records["rec-npm-plugin@1.0.0"]).toEqual({ loadStatus: "failed", failureStage: "install" })
      } finally {
        add.mockRestore()
      }
    }),
  )

  it.live("records the load stage when importing the plugin entrypoint fails", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const broken = yield* writePlugin(directory, "broken.ts", 'throw new Error("rec-import-failure")\n')
      yield* declarePlugins(directory, [broken])

      const records = yield* withRecords(directory, (read) => Effect.succeed(read()))
      expect(records[broken]).toEqual({ loadStatus: "failed", failureStage: "load" })
    }),
  )

  it.live("records the server stage when a loaded plugin refuses to initialize", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const rejecting = yield* writePlugin(
        directory,
        "rejecting.ts",
        'export default { id: "rec-rejecting", server: async () => { throw new Error("rec-init-failure") } }\n',
      )
      yield* declarePlugins(directory, [rejecting])

      const records = yield* withRecords(directory, (read) => Effect.succeed(read()))
      expect(records[rejecting]).toEqual({ loadStatus: "failed", failureStage: "server" })
    }),
  )

  it.live("records a package without a server entrypoint as missing", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const pkg = yield* Effect.promise(async () => {
        const dir = path.join(directory, "no-server-entry")
        await Bun.write(
          path.join(dir, "package.json"),
          JSON.stringify({ name: "rec-no-server-entry", version: "1.0.0", exports: {} }),
        )
        return pathToFileURL(dir).href
      })
      yield* declarePlugins(directory, [pkg])

      const records = yield* withRecords(directory, (read) => Effect.succeed(read()))
      expect(records[pkg]).toEqual({ loadStatus: "missing", failureStage: "" })
    }),
  )

  it.live("records nothing for a deprecated plugin the loader skips", () =>
    Effect.gen(function* () {
      // loader.ts returns before any report callback for deprecated packages, so the inventory has
      // to derive "skipped"/"deprecated" itself instead of the loader inventing a record.
      const directory = yield* tmpdirScoped()
      yield* declarePlugins(directory, ["opencode-openai-codex-auth"])

      const records = yield* withRecords(directory, (read) => Effect.succeed(read()))
      expect(records["opencode-openai-codex-auth"]).toBeUndefined()
    }),
  )

  it.live("hands the resolved config with its plugin origins to a plugin config hook", () =>
    Effect.gen(function* () {
      // The plugin inventory is built from the config hook argument, so the host must deliver the
      // derived origin list there once every plugin of the instance has been applied.
      const directory = yield* tmpdirScoped()
      const received = path.join(directory, "config-hook.json")
      const probe = yield* writePlugin(
        directory,
        "probe.ts",
        [
          "export default {",
          '  id: "rec-probe",',
          "  server: async () => ({",
          "    config: async (cfg) => {",
          `      await Bun.write(${JSON.stringify(received)}, JSON.stringify(cfg?.plugin_origins ?? null))`,
          "    },",
          "  }),",
          "}",
        ].join("\n"),
      )
      yield* declarePlugins(directory, [probe])

      const origins = yield* withRecords(directory, () =>
        Effect.promise(async () => {
          const text = await Bun.file(received)
            .text()
            .catch(() => undefined)
          return text === undefined ? undefined : JSON.parse(text)
        }),
      )
      expect(origins).toEqual([{ spec: probe, source: path.join(directory, "deveco.json"), scope: "local" }])
    }),
  )

  it.live("forgets the records of a directory once the instance is disposed", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const plain = yield* writePlugin(
        directory,
        "plain.ts",
        'export default { id: "rec-plain", server: async () => ({}) }\n',
      )
      yield* declarePlugins(directory, [plain])

      yield* withRecords(directory, (read) =>
        Effect.sync(() => {
          expect(read()[plain]).toEqual({ loadStatus: "loaded", failureStage: "" })
        }),
      )
      yield* InstanceStore.Service.use((store) => store.disposeDirectory(directory))
      expect(snapshot(directory)).toEqual({})
    }),
  )
})
