import type { Agent } from "@/agent/agent"
import type { HomegraphInjectSource } from "@/mcp/homegraph"
import { Runtime } from "@opencode-ai/core/runtime"

import PART_CODEBASE from "./prompt-parts/codebase-understanding.txt"
import PART_CODEBASE_HOMEGRAPH from "./prompt-parts/codebase-understanding-homegraph.txt"

// Agents whose prompts were rewritten to route through `# Codebase understanding`.
// Search specialists (explore) and agents without synced prompts stay out.
export const CODEBASE_AGENTS = new Set(["build", "goal", "ask"])

/** Soften product-only claims when the user brought their own mcp.homegraph. */
const USER_INDEX_NOTE =
  "Your HomeGraph MCP may not auto-init or auto-sync — do not assume the index is fresh; follow tool replies."

export type PromptPartsOptions = {
  /** MCP homegraph connected and exposing homegraph_* tools. */
  readonly homegraphReady?: boolean
  /** product = built-in inject; user = preserved user mcp.homegraph. */
  readonly homegraphSource?: HomegraphInjectSource
}

export function agentNeedsHomegraphPrompt(agentName: string): boolean {
  return CODEBASE_AGENTS.has(agentName)
}

function homegraphPromptPart(source?: HomegraphInjectSource): string {
  if (source !== "user") return PART_CODEBASE_HOMEGRAPH
  // Line-scoped: replace only the product auto-sync sentence on its line (no cross-line regex).
  const claim =
    "The product refreshes the `.homegraph` index after edits (may lag a few minutes) — never init/sync it yourself."
  return PART_CODEBASE_HOMEGRAPH.split("\n")
    .map((line) => (line.includes(claim) ? line.replace(claim, USER_INDEX_NOTE) : line))
    .join("\n")
}

export function forAgent(agent: Pick<Agent.Info, "name">, opts: PromptPartsOptions = {}) {
  if (!CODEBASE_AGENTS.has(agent.name)) {
    return []
  }
  // Only teach homegraph_* when tools are actually usable — avoid prompting
  // for a server that failed to connect.
  const routing = opts.homegraphReady ? homegraphPromptPart(opts.homegraphSource) : PART_CODEBASE
  if (agent.name !== "build" || Runtime.current.mode !== "default") return [routing]

  const lookups = opts.homegraphReady ? "`glob`/`grep`/`read` and `homegraph_*`" : "`glob`/`grep`/`read`"
  return [
    routing,
    `Follow this section to locate edit sites and call chains before editing. When marking a step \`in_progress\`, \`todowrite\` may run in parallel with ${lookups} where the routing above permits parallel calls.`,
  ]
}

export * as AgentPromptParts from "./prompt-parts"
