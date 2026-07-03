import { expect, describe, it } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { testEffect } from "../lib/effect"

// Enable default plugins so MemoryPlugin loads as a built-in
const configLayer = Config.layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
)

const pluginLayer = Plugin.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(configLayer),
  Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: false })),
)

const it_ = testEffect(Layer.mergeAll(pluginLayer))

describe("memory plugin integration", () => {
  it_.instance(
    "memory plugin loads and registers tools",
    () =>
      Effect.gen(function* () {
        yield* Plugin.Service.use((p) => p.init())
        const hooks = yield* Plugin.Service.use((p) => p.list())

        // Find the memory plugin's hooks
        const memoryHook = hooks.find((h) => h.tool && "memory-read" in h.tool)
        expect(memoryHook).toBeDefined()

        // Verify all 10 tools are registered
        const tools = memoryHook!.tool!
        const toolNames = Object.keys(tools).sort()
        expect(toolNames).toEqual([
          "dream-approve",
          "dream-reject",
          "dream-trigger",
          "memory-delete",
          "memory-read",
          "memory-search",
          "memory-write",
          "skill-list",
          "skill-manage",
          "skill-view",
        ])

        // Verify key hooks are present
        expect(memoryHook!.dispose).toBeDefined()
        expect(memoryHook!.event).toBeDefined()
        expect(memoryHook!["chat.message"]).toBeDefined()
        expect(memoryHook!["experimental.chat.system.transform"]).toBeDefined()
        expect(memoryHook!["experimental.chat.messages.transform"]).toBeDefined()
        expect(memoryHook!["experimental.session.compacting"]).toBeDefined()
        expect(memoryHook!["experimental.text.complete"]).toBeDefined()
        expect(memoryHook!["permission.ask"]).toBeDefined()
        expect(memoryHook!["tool.execute.after"]).toBeDefined()
      }),
  )
})
