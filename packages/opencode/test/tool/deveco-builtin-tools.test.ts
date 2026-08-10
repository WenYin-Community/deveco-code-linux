import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { ToolRegistry } from "@/tool/registry"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import emulatorTools from "../../src/tool/lib/emulator_tools.json"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const HARMONY_NAPI_TOOL_NAMES = emulatorTools.map((tool) => tool.name)
const DEVECO_REGISTRY_TOOL_NAMES = ["hdc_log", "switch_cwd", "build_project", "start_app"] as const

const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [path.join(dir, ".deveco")])),
})

const root = LayerNode.group([ToolRegistry.node, Agent.node])
const replacements = [
  LayerNode.replace(Config.node, configLayer),
  LayerNode.replace(RuntimeFlags.node, RuntimeFlags.layer()),
]

const it = testEffect(LayerNode.buildLayer(root, { replacements }))

afterEach(async () => {
  await disposeAllInstances()
})

describe("deveco builtin tools", () => {
  it.instance(
    "loads DevEco HarmonyOS registry built-ins on startup",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()

        for (const name of DEVECO_REGISTRY_TOOL_NAMES) {
          expect(ids).toContain(name)
        }
        expect(ids).toContain("skill")
      }),
    30_000,
  )

  it.instance(
    "loads Harmony NAPI dynamic tools from the internal plugin",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()

        for (const name of HARMONY_NAPI_TOOL_NAMES) {
          expect(ids).toContain(name)
        }
        expect(ids.filter((id) => HARMONY_NAPI_TOOL_NAMES.includes(id)).length).toBe(HARMONY_NAPI_TOOL_NAMES.length)
      }),
    30_000,
  )

  it.instance(
    "does not load arkts_knowledge_search",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("arkts_knowledge_search")
      }),
    30_000,
  )
})
