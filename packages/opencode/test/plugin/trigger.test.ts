import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import path from "path"
import { pathToFileURL } from "url"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"
import { Session } from "../../src/session/session"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { clearSessionCwd } from "../../src/tool/lib/session-cwd"
import { getSessionCwd } from "../../src/tool/lib/session-cwd"
import { resolveWorktree } from "../../src/tool/design-tools/utils"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)
const it = testEffect(
  Layer.mergeAll(
    Plugin.layer.pipe(
      Layer.provide(EventV2Bridge.defaultLayer),
      Layer.provide(configLayer),
      Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
    ),
    CrossSpawnSpawner.defaultLayer,
  ),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string, self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const file = path.join(test.directory, "plugin.ts")
    yield* Effect.all(
      [
        Effect.promise(() => Bun.write(file, source)),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "deveco.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: [pathToFileURL(file).href],
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("observes directories only after async plugin result enrichment", () =>
    withProject(
      `export default async (input) => ({
        "tool.execute.after": async (_call, output) => {
          await Promise.resolve();
          output.metadata = { ...output.metadata, sessionCwd: input.directory };
        }
      })`,
      Effect.gen(function* () {
        const instance = yield* TestInstance
        const plugin = yield* Plugin.Service
        const sessionID = "ses_enriched_create"
        yield* Effect.addFinalizer(() => Effect.sync(() => clearSessionCwd(sessionID)))
        const result = yield* plugin.trigger(
          "tool.execute.after",
          { tool: "bash", sessionID, callID: "create", source: "builtin", args: {} },
          { title: "Create", output: "", metadata: {} },
        )
        expect(getSessionCwd(sessionID)).toBe(instance.directory)
        expect(result.metadata).toHaveProperty("sessionCwd", instance.directory)
      }),
    ),
  )

  it.instance("updates native design tool directories even when default plugins are disabled", () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const plugin = yield* Plugin.Service
      const sessions = yield* Session.Service
      const target = path.join(instance.directory, "plugin project with spaces")
      const sessionID = SessionID.make("ses_plugin_cwd")
      yield* Effect.addFinalizer(() => Effect.sync(() => clearSessionCwd(sessionID)))
      yield* Effect.promise(() => Bun.write(path.join(target, "build-profile.json5"), "{}"))

      yield* plugin.trigger(
        "tool.execute.after",
        { tool: "switch_cwd", sessionID, callID: "switch", source: "custom", args: { project_path: "requested" } },
        { title: "Switch project context", output: "", metadata: { project_path: target } },
      )

      const context: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_plugin_cwd"),
        callID: "design",
        agent: "build",
        abort: new AbortController().signal,
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      expect(yield* Effect.promise(() => resolveWorktree(context, sessions))).toBe(target)
    }).pipe(
      Effect.provide(
        Layer.mock(Session.Service, {
          get: () => Effect.die("The native reader must use the switched directory before the session fallback"),
        }),
      ),
    ),
  )

  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )
})
