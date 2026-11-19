import { describe, expect } from "bun:test"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import type { Hooks, ToolContext } from "@opencode-ai/plugin"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import path from "node:path"
import fs from "node:fs/promises"
import { EventV2Bridge } from "../../../src/event-v2-bridge"
import { Config } from "../../../src/config/config"
import { Env } from "../../../src/env"
import { RuntimeFlags } from "../../../src/effect/runtime-flags"
import { Plugin } from "../../../src/plugin"
import { SLASH_COMMANDS_GUIDANCE } from "../../../src/plugin/memory/skills/prompts"
import { AccountTest } from "../../fake/account"
import { AuthTest } from "../../fake/auth"
import { NpmTest } from "../../fake/npm"
import { testEffect } from "../../lib/effect"

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

const it = testEffect(Layer.mergeAll(pluginLayer))

const CONFIG = path.join(Global.Path.config, "memory-config.json")
let stamp = Date.now()

// The plugin reloads when the config file's mtime changes. Bump the mtime explicitly so fast
// consecutive writes cannot land on the same timestamp and leave the switch stale.
async function writeConfig(config: Record<string, unknown>) {
  await Bun.write(CONFIG, JSON.stringify(config))
  stamp += 1000
  const t = new Date(stamp)
  await fs.utimes(CONFIG, t, t)
}

async function setAutoMemory(enabled: boolean) {
  await writeConfig({ autoMemory: { enabled } })
}

const context = {
  sessionID: "ses_auto_memory_switch",
  messageID: "message",
  agent: "build",
  directory: "",
  worktree: "",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
} satisfies ToolContext

const transformInput = { sessionID: "ses_auto_memory_switch", model: {} as never }

function findMemoryHook(hooks: Hooks[]) {
  return hooks.find((hook) => hook.tool && "memory-read" in hook.tool)
}

describe("memory global switch", () => {
  it.instance(
    "stops system injection and memory tools without a restart",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => setAutoMemory(true))
        yield* Plugin.Service.use((p) => p.init())
        const hook = findMemoryHook(yield* Plugin.Service.use((p) => p.list()))
        expect(hook).toBeDefined()

        const on = { system: [] as string[] }
        yield* Effect.promise(() =>
          hook!["experimental.chat.system.transform"]!(transformInput, on),
        )
        expect(on.system).toContain(SLASH_COMMANDS_GUIDANCE)

        yield* Effect.promise(() => setAutoMemory(false))
        const off = { system: [] as string[] }
        yield* Effect.promise(() =>
          hook!["experimental.chat.system.transform"]!(transformInput, off),
        )
        expect(off.system).toEqual([])

        const refused = yield* Effect.promise(() =>
          hook!.tool!["memory-write"]!.execute(
            { name: "global-off", description: "must not be written", type: "project", content: "x" },
            context,
          ),
        )
        expect(typeof refused === "string" ? refused : refused.output).toContain("disabled")

        yield* Effect.promise(() => setAutoMemory(true))
        const again = { system: [] as string[] }
        yield* Effect.promise(() =>
          hook!["experimental.chat.system.transform"]!(transformInput, again),
        )
        expect(again.system).toContain(SLASH_COMMANDS_GUIDANCE)
      }),
  )

  it.instance(
    "stops recall injection without a restart",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => setAutoMemory(true))
        yield* Plugin.Service.use((p) => p.init())
        const hook = findMemoryHook(yield* Plugin.Service.use((p) => p.list()))
        expect(hook).toBeDefined()

        const written = yield* Effect.promise(() =>
          hook!.tool!["memory-write"]!.execute(
            {
              name: "Cache dir",
              description: "Use one shared cache dir",
              type: "project",
              content: "Store caches under .cache/deveco.",
            },
            context,
          ),
        )
        expect(typeof written === "string" ? written : written.output).toContain("created")

        const recalled = [
          { info: { sessionID: "ses_auto_memory_switch", role: "user", id: "msg-1" }, parts: [{ type: "text", text: "cache directory" }] },
        ]
        yield* Effect.promise(() =>
          hook!["experimental.chat.messages.transform"]!({}, { messages: recalled as never }),
        )
        expect(recalled[0]!.parts.some((part) => part.type === "text" && (part as { synthetic?: boolean }).synthetic)).toBe(true)

        yield* Effect.promise(() => setAutoMemory(false))
        const after = [
          { info: { sessionID: "ses_auto_memory_switch", role: "user", id: "msg-2" }, parts: [{ type: "text", text: "cache directory" }] },
        ]
        yield* Effect.promise(() =>
          hook!["experimental.chat.messages.transform"]!({}, { messages: after as never }),
        )
        expect(after[0]!.parts).toHaveLength(1)
      }),
  )

  it.instance(
    "visibility switches reload without a restart",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeConfig({ autoMemory: { enabled: true }, memoryRecall: { visibleWrite: true, visibleRecall: true } }),
        )
        yield* Plugin.Service.use((p) => p.init())
        const hook = findMemoryHook(yield* Plugin.Service.use((p) => p.list()))
        expect(hook).toBeDefined()

        const first = yield* Effect.promise(() =>
          hook!.tool!["memory-write"]!.execute(
            { name: "Cache dir", description: "Use one shared cache dir", type: "project", content: "v1" },
            context,
          ),
        )
        expect((first as { title?: string }).title).toContain("📝")

        yield* Effect.promise(() =>
          writeConfig({ autoMemory: { enabled: true }, memoryRecall: { visibleWrite: false, visibleRecall: false } }),
        )
        const second = yield* Effect.promise(() =>
          hook!.tool!["memory-write"]!.execute(
            { name: "Cache dir", description: "Use one shared cache dir", type: "project", content: "v2" },
            context,
          ),
        )
        expect((second as { title?: string }).title).not.toContain("📝")

        const out = { text: "answer" }
        yield* Effect.promise(() =>
          hook!["experimental.text.complete"]!(
            { sessionID: context.sessionID, messageID: "message", partID: "part" },
            out,
          ),
        )
        expect(out.text).toBe("answer")
      }),
  )
})
