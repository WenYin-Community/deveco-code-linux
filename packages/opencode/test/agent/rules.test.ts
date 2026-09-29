import { describe, expect, test } from "bun:test"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "../../src/provider/provider"
import { AgentRules } from "../../src/agent/rules"
import RULES_COMMON from "../../src/agent/rules/common.txt"
import RULES_GLM_5_3 from "../../src/agent/rules/glm-5-3.txt"
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

  test("glm-5.3 resolves to its own ruleset, not the common one", () => {
    const rules = AgentRules.forAgent(model("glm-5.3"), build)

    expect(rules).toEqual([RULES_GLM_5_3])
    expect(rules[0]).not.toEqual(RULES_COMMON)
    expect(rules[0]).toContain("# ArkTS / ArkUI codegen rules")
  })

  test("glm-5.3 ruleset is reached through every model id spelling", () => {
    const dotted = AgentRules.forAgent(model("glm-5.3"), build)

    expect(AgentRules.forAgent(model("glm-5-3"), build)).toEqual(dotted)
    expect(AgentRules.forAgent(model("glm-5p3"), build)).toEqual(dotted)
    expect(AgentRules.forAgent(model("GLM-5.3"), build)).toEqual(dotted)
    expect(AgentRules.forAgent(model("火山AI网关/glm-5.3"), build)).toEqual(dotted)
  })

  test("sibling glm versions keep the common ruleset", () => {
    expect(AgentRules.forAgent(model("glm-5.1"), build)).toEqual([RULES_COMMON])
    expect(AgentRules.forAgent(model("glm-5"), build)).toEqual([RULES_COMMON])
  })

  test("unmeasured glm-5.3 variants keep the common ruleset", () => {
    expect(AgentRules.forAgent(model("glm-5.3-flash"), build)).toEqual([RULES_COMMON])
    expect(AgentRules.forAgent(model("火山AI网关/glm-5.3-flash"), build)).toEqual([RULES_COMMON])
  })

  test("glm-5.3 ruleset drops the V1/V2 section but keeps the measured error classes", () => {
    expect(RULES_GLM_5_3).not.toContain("largest single error class")
    expect(RULES_GLM_5_3).toContain("arkts-no-untyped-obj-literals")
    expect(RULES_GLM_5_3).toContain("arkts-no-standalone-this")
    expect(RULES_GLM_5_3.length).toBeLessThan(RULES_COMMON.length)
  })

  test("rules are omitted for agents that do not write ArkTS code", () => {
    expect(AgentRules.forAgent(model("glm-5"), { ...build, name: "explore" })).toEqual([])
  })
})
