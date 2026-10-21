import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Agent } from "@/agent/agent"
import { ToolRegistry } from "@/tool/registry"
import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceState } from "@/effect/instance-state"
import path from "path"
import { disposeAllInstances } from "../fixture/fixture"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"

const REMOVED_DEVECO_TOOL_NAMES = ["hdc_log", "build_project", "start_app"] as const

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

        expect(ids).toContain("switch_cwd")
        for (const name of REMOVED_DEVECO_TOOL_NAMES) expect(ids).not.toContain(name)
        expect(ids).toContain("skill")
        // identify_fault_log moved into the hmos-dfx-analyzer skill scripts; it must
        // no longer be registered as a builtin tool.
        expect(ids).not.toContain("identify_fault_log")
      }),
    30_000,
  )

  it.instance(
    "does not load arkts_knowledge_search or check_ets_files",
    () =>
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const ids = yield* registry.ids()
        expect(ids).not.toContain("arkts_knowledge_search")
        expect(ids).not.toContain("check_ets_files")
      }),
    30_000,
  )
})
