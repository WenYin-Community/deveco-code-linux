import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"

import RULES_COMMON from "./rules/common.txt"
import RULES_GLM_5_3 from "./rules/glm-5-3.txt"

// Agents that write ArkTS code. Others (explore, title, summary) would only be
// diluted by the platform ruleset.
const RULES_AGENTS = new Set(["build", "debug", "goal", "spec-implementation", "spec-verify"])

// The same model is spelled differently across providers (glm-5.1, glm-5-1,
// glm-5p1), so match on a normalized id. Only collapse `p` between digits so
// ids like claude-opus-5 survive intact.
function normalize(id: string) {
  return id
    .toLowerCase()
    .replaceAll(".", "-")
    .replace(/(\d)p(\d)/g, "$1-$2")
}

// Model-specific rulesets, checked in order; the first match fully replaces the
// common ruleset. common.txt holds the ruleset authored against glm-5.
//
// glm-5.3 diverges: measured against the 26-case sdd bootstrap suite run with no
// ruleset at all (2026-09-22, 24/26 pass, 348 compile errors), the whole V1/V2
// state-generation section and 11 other common.txt lines drew zero errors while
// the features they guard were used heavily — 82 `@Component` + 181 `@State`
// alongside 97 `@ComponentV2` + 192 `@Local`, with no file mixing the two. Those
// lines are dropped; every remaining line is verbatim from common.txt, so this
// ruleset only ever removes guidance, never invents it.
//
// Matched exactly (bare or provider-prefixed): the measurement covers glm-5.3
// only, so siblings like glm-5.3-flash keep the common ruleset until measured.
const REGISTRY: readonly (readonly [(id: string) => boolean, string])[] = [
  [(id) => id === "glm-5-3" || id.endsWith("/glm-5-3"), RULES_GLM_5_3],
]

export function forModel(model: Provider.Model) {
  const id = normalize(model.api.id)
  return REGISTRY.find(([match]) => match(id))?.[1] ?? RULES_COMMON
}

export function forAgent(model: Provider.Model, agent: Agent.Info) {
  if (!RULES_AGENTS.has(agent.name)) return []
  return [forModel(model)]
}

export * as AgentRules from "./rules"
