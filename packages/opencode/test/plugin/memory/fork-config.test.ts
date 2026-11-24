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
import {
  getForkConfig,
  registerForkSession,
  setForkConfig,
  unregisterForkSession,
  type ForkMemoryConfig,
} from "../../../src/plugin/memory/util/forkManager"
import {
  DEFAULT_AUTO_DREAM_CONFIG,
  DEFAULT_EXTRACTION_CONFIG,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_MEMORY_EXPIRY_CONFIG,
  DEFAULT_MEMORY_RECALL_CONFIG,
  DEFAULT_SEMANTIC_SELECTION_CONFIG,
  DEFAULT_SKILL_CONFIG,
} from "../../../src/plugin/memory/memory/types"
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

function snapshot(): ForkMemoryConfig {
  return {
    memory: { ...DEFAULT_MEMORY_CONFIG },
    autoDream: { ...DEFAULT_AUTO_DREAM_CONFIG },
    extraction: { ...DEFAULT_EXTRACTION_CONFIG },
    skills: { ...DEFAULT_SKILL_CONFIG },
    recall: { ...DEFAULT_MEMORY_RECALL_CONFIG },
    semantic: { ...DEFAULT_SEMANTIC_SELECTION_CONFIG },
    expiry: { ...DEFAULT_MEMORY_EXPIRY_CONFIG },
  }
}

function outputOf(result: unknown): string {
  if (typeof result === "string") return result
  if (result && typeof result === "object" && "output" in result && typeof result.output === "string") {
    return result.output
  }
  return ""
}

function titleOf(result: unknown): string {
  if (result && typeof result === "object" && "title" in result && typeof result.title === "string") {
    return result.title
  }
  return ""
}

const context = {
  sessionID: "ses_fork_config_live",
  messageID: "message",
  agent: "build",
  directory: "",
  worktree: "",
  abort: new AbortController().signal,
  metadata() {},
  async ask() {},
} satisfies ToolContext

function findMemoryHook(hooks: Hooks[]) {
  return hooks.find((hook) => hook.tool && "memory-read" in hook.tool)
}

describe("fork memory config snapshot", () => {
  it.instance(
    "a running fork keeps its snapshot after the live config changes",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeConfig({ autoMemory: { enabled: true } }))
        yield* Plugin.Service.use((p) => p.init())
        const hook = findMemoryHook(yield* Plugin.Service.use((p) => p.list()))
        expect(hook).toBeDefined()

        const forkSid = "ses_fork_config_dream"
        registerForkSession(forkSid, "dream")
        setForkConfig(forkSid, snapshot())
        expect(getForkConfig(forkSid)).toBeDefined()

        // Hot reload turns the Auto memory switch off for live sessions; the fork must not see it.
        yield* Effect.promise(() => writeConfig({ autoMemory: { enabled: false } }))

        const forkWrite = yield* Effect.promise(() =>
          hook!.tool!["memory-write"].execute(
            { name: "Fork note", description: "written by a running fork", type: "project", content: "snapshot config" },
            { ...context, sessionID: forkSid },
          ),
        )
        expect(outputOf(forkWrite)).toContain("created")

        const liveWrite = yield* Effect.promise(() =>
          hook!.tool!["memory-write"].execute(
            { name: "Live note", description: "written by the live session", type: "project", content: "live config" },
            context,
          ),
        )
        expect(outputOf(liveWrite)).toContain("disabled")

        yield* Effect.promise(async () => {
          unregisterForkSession(forkSid)
        })
        expect(getForkConfig(forkSid)).toBeUndefined()

        const afterUnregister = yield* Effect.promise(() =>
          hook!.tool!["memory-write"].execute(
            { name: "After note", description: "written after the fork ended", type: "project", content: "live config" },
            { ...context, sessionID: forkSid },
          ),
        )
        expect(outputOf(afterUnregister)).toContain("disabled")
      }),
  )

  it.instance(
    "a fork also keeps its frozen sub-configs",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeConfig({
            autoMemory: { enabled: true },
            autoDream: { enabled: true },
            memoryRecall: { visibleRecall: true },
          }),
        )
        yield* Plugin.Service.use((p) => p.init())
        const hook = findMemoryHook(yield* Plugin.Service.use((p) => p.list()))
        expect(hook).toBeDefined()

        const forkSid = "ses_fork_config_sub"
        registerForkSession(forkSid, "dream")
        const frozen = snapshot()
        frozen.autoDream = { ...DEFAULT_AUTO_DREAM_CONFIG, enabled: false }
        frozen.recall = { ...DEFAULT_MEMORY_RECALL_CONFIG, visibleRecall: false }
        setForkConfig(forkSid, frozen)

        const forkDream = yield* Effect.promise(() =>
          hook!.tool!["dream-trigger"].execute({}, { ...context, sessionID: forkSid }),
        )
        expect(outputOf(forkDream)).toContain("Auto Dream is disabled")

        const forkSearch = yield* Effect.promise(() =>
          hook!.tool!["memory-search"].execute({ query: "cache", limit: 1 }, { ...context, sessionID: forkSid }),
        )
        expect(titleOf(forkSearch)).not.toContain("💡")

        // The live session still follows the live config, not the fork snapshot.
        const liveSearch = yield* Effect.promise(() =>
          hook!.tool!["memory-search"].execute({ query: "cache", limit: 1 }, context),
        )
        expect(titleOf(liveSearch)).toContain("💡")

        unregisterForkSession(forkSid)
      }),
  )
})
