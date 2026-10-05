import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Equal, Hash, Layer, Schema } from "effect"
import { Tool } from "@opencode-ai/core/public"
import { Catalog } from "@opencode-ai/core/catalog"
import { LocationServiceMap } from "@opencode-ai/core/location-layer"
import { Location } from "@opencode-ai/core/location"
import { PluginBoot } from "@opencode-ai/core/plugin/boot"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolDefinitions } from "./lib/tool"
import { FSUtil } from "../src/fs-util"
import { Credential } from "../src/credential"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { Global } from "../src/global"
import { ModelsDev } from "../src/models-dev"
import { Npm } from "../src/npm"
import { Project } from "../src/project"
import { Reference } from "../src/reference"
import { ToolRegistry } from "../src/tool/registry"
import { ApplicationTools } from "../src/tool/application-tools"
import { Sandbox, SandboxContextService, SandboxRuntimeService, SandboxConfigWriterService } from "../src/sandbox"

const applicationTools = ApplicationTools.layer
const sandboxMock = Layer.mergeAll(
  Layer.succeed(SandboxContextService, SandboxContextService.of({
    resolve: () => Effect.succeed({
      profile_id: "read-only", filesystem: { ":root": "read" },
      network_enabled: true, workspace_roots: [], is_implicit: true, source_layer: "global",
    }),
    buildRequest: (resolved, target) => ({
      command: target,
      file_system_context: {
        cwd: target.cwd,
        workspace_roots: resolved.workspace_roots,
      },
      permissions: {
        profile_id: resolved.profile_id,
        filesystem: Object.fromEntries(Object.entries(resolved.filesystem)),
        network_enabled: resolved.network_enabled,
        workspace_roots: resolved.workspace_roots,
      },
      io: { kind: "pipe" },
    }),
  })),
  Layer.succeed(SandboxRuntimeService, SandboxRuntimeService.of({
    new: () => Effect.void,
    probe: () => Effect.succeed({ _tag: "Supported" as const }),
    prepare: (request) => Effect.succeed({
      executable: request.command.executable, args: request.command.args,
      cwd: request.command.cwd, env: request.command.env,
    }),
  })),
  Layer.succeed(SandboxConfigWriterService, SandboxConfigWriterService.of({
    writeProfile: () => Effect.succeed("/mock/path"),
    getWriteTargetPath: () => Effect.succeed("/mock/path"),
    getRuntimeOverride: () => Effect.succeed(undefined),
    clearRuntimeOverride: () => Effect.void,
  })),
)
const it = testEffect(
  Layer.merge(
    Layer.mergeAll(applicationTools, Database.defaultLayer, EventV2.defaultLayer, sandboxMock),
    LocationServiceMap.layer.pipe(
      Layer.provide(applicationTools),
      Layer.provide(sandboxMock),
      Layer.provide(
        Layer.mergeAll(
          Project.defaultLayer,
          EventV2.defaultLayer,
          Credential.defaultLayer,
          Credential.layer.pipe(Layer.provide(Database.layerFromPath(":memory:").pipe(Layer.fresh))),
          Npm.defaultLayer,
          ModelsDev.defaultLayer,
          FSUtil.defaultLayer,
          Global.defaultLayer,
        ),
      ),
    ),
  ),
)

describe("LocationServiceMap", () => {
  it.effect("compares equivalent location refs by value", () =>
    Effect.sync(() => {
      const directory = AbsolutePath.make("/project")
      expect(Equal.equals(Location.Ref.make({ directory }), Location.Ref.make({ directory }))).toBe(true)
      expect(Hash.hash(Location.Ref.make({ directory }))).toBe(
        Hash.hash(Location.Ref.make({ directory, workspaceID: undefined })),
      )
    }),
  )

  it.live("isolates location state while sharing location policy with catalog", () =>
    Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]())).then(() => undefined)),
    ).pipe(
      Effect.flatMap(([blocked, allowed]) =>
        Effect.gen(function* () {
          yield* (yield* ApplicationTools.Service).register({
            application_context: Tool.make({
              description: "Read application context",
              input: Schema.Struct({}),
              output: Schema.Struct({ ok: Schema.Boolean }),
              execute: () => Effect.succeed({ ok: true }),
            }),
          })
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(blocked.path, "deveco.json"),
              JSON.stringify({
                experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "test" }] },
              }),
            ),
          )

          const update = (directory: string) =>
            Effect.gen(function* () {
              yield* PluginBoot.Service.use((boot) => boot.wait())
              yield* Reference.Service
              const catalog = yield* Catalog.Service
              const transform = yield* catalog.transform()
              yield* transform((editor) => editor.provider.update(ProviderV2.ID.make("test"), () => {}))
              return {
                providers: yield* catalog.provider.all(),
                tools: yield* toolDefinitions(yield* ToolRegistry.Service),
              }
            }).pipe(
              Effect.scoped,
              Effect.provide(LocationServiceMap.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
            )

          const blockedState = yield* update(blocked.path)
          expect(blockedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(false)
          expect(blockedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
          const allowedState = yield* update(allowed.path)
          expect(allowedState.providers.some((provider) => provider.id === ProviderV2.ID.make("test"))).toBe(true)
          expect(allowedState.tools.map((tool) => tool.name).sort()).toEqual([
            "application_context",
            "apply_patch",
            "bash",
            "edit",
            "glob",
            "grep",
            "question",
            "read",
            "skill",
            "todowrite",
            "webfetch",
            "websearch",
            "write",
          ])
        }),
      ),
    ),
  )
})
