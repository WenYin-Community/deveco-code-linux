import { expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import { adaptHarnessHooks } from "../../src/plugin/harness-compat"

test("retains the current verification policy after an older Harness config hook", async () => {
  const config: Parameters<NonNullable<Hooks["config"]>>[0] = {}
  const hooks = adaptHarnessHooks({
    config: async (config) => {
      config.command = { "spec-verify": { template: "maximum of 3 total verification attempts" } }
      config.agent = { goal: { prompt: "Goal" }, "spec-verify": { prompt: "Verify" } }
    },
  })
  await hooks.config!(config)
  expect(config.command?.["spec-verify"].template).toContain("at most 2 verification attempts")
  expect(config.agent?.goal?.prompt).toContain("Do not run a separate final pass")
  expect(config.agent?.["spec-verify"]?.prompt).toContain("model's image-input capability")
})

test("preserves replacement workflows and updated Harness policy", async () => {
  const config: Parameters<NonNullable<Hooks["config"]>>[0] = {
    command: { "spec-verify": { template: "Use the current verification workflow" } },
    agent: { goal: { prompt: "User goal" } },
  }
  await adaptHarnessHooks({}).config!(config)
  expect(config.agent?.goal?.prompt).toBe("User goal")
  expect(config.command?.["spec-verify"].template).toBe("Use the current verification workflow")
})

test("corrects route-table guidance after Harness transforms the system prompt", async () => {
  const output = { system: ["Host prompt"] }
  await adaptHarnessHooks({
    "experimental.chat.system.transform": async (_, output) => {
      output.system.push("routerMap: `name` + `buildFunction` + `pageSourceFile`")
    },
  })["experimental.chat.system.transform"]!({ sessionID: "session", model: {} as never }, output)
  expect(output.system).toEqual(["Host prompt", "routerMap: `name` + `buildMethod` + `pageSourceFile`"])
})
