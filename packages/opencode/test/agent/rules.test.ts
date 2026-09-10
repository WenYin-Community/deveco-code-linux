import { describe, expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { AgentRules } from "../../src/agent/rules"
import RULES_COMMON from "../../src/agent/rules/common.txt"
import { Permission } from "../../src/permission"

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const model = (id: string) => ({ api: { id } }) as Provider.Model

describe("agent.rules", () => {
  test("rules fall back to the common ruleset for unknown models", () => {
    const rules = AgentRules.forAgent(model("some-unreleased-model"), build)

    expect(rules).toEqual([RULES_COMMON])
    expect(rules[0]).toContain("# ArkTS / ArkUI codegen rules")
    expect(rules[0]).not.toContain("## Tools Guidelines")
  })

  test("rules are identical across model id spelling variants", () => {
    const dotted = AgentRules.forAgent(model("glm-5.1"), build)

    expect(AgentRules.forAgent(model("glm-5-1"), build)).toEqual(dotted)
    expect(AgentRules.forAgent(model("glm-5p1"), build)).toEqual(dotted)
  })

  test("rules are omitted for agents that do not write ArkTS code", () => {
    expect(AgentRules.forAgent(model("glm-5"), { ...build, name: "explore" })).toEqual([])
  })
})
