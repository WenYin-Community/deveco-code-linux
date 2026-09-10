import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"

import RULES_COMMON from "./rules/common.txt"

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
// common ruleset. Empty until a model needs to diverge from common.txt, which
// currently holds the ruleset authored against glm-5.
const REGISTRY: readonly (readonly [(id: string) => boolean, string])[] = []

export function forModel(model: Provider.Model) {
  const id = normalize(model.api.id)
  return REGISTRY.find(([match]) => match(id))?.[1] ?? RULES_COMMON
}

export function forAgent(model: Provider.Model, agent: Agent.Info) {
  if (!RULES_AGENTS.has(agent.name)) return []
  return [forModel(model)]
}

export * as AgentRules from "./rules"
