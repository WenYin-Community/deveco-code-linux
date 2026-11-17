import { Runtime } from "@opencode-ai/core/runtime"
import type { ConfigPermissionV1 } from "@opencode-ai/core/v1/config/permission"

import DEFAULT_BUILD from "./build.txt"
import DEFAULT_COMPACTION from "./compaction.txt"
import DEFAULT_DEBUG from "./debug.txt"
import DEFAULT_EXPLORE from "./explore.txt"
import DEFAULT_GENERATE from "../generate.txt"
import DEFAULT_PLAN from "./plan.txt"
import DEFAULT_SUMMARY from "./summary.txt"
import DEFAULT_TITLE from "./title.txt"

import STUDIO_BUILD from "./deveco-studio/build.txt"
import STUDIO_COMPACTION from "./deveco-studio/compaction.txt"
import STUDIO_DEBUG from "./deveco-studio/debug.txt"
import STUDIO_EXPLORE from "./deveco-studio/explore.txt"
import STUDIO_GENERATE from "./deveco-studio/generate.txt"
import STUDIO_PLAN from "./deveco-studio/plan.txt"
import STUDIO_SUMMARY from "./deveco-studio/summary.txt"
import STUDIO_TITLE from "./deveco-studio/title.txt"

const defaultAgents = ["build", "debug", "plan", "general", "explore", "ask", "compaction", "title", "summary"] as const

const studioAgents = ["build", "debug", "plan", "general", "explore", "ask", "compaction", "title", "summary"] as const

export type WorkflowOverride = {
  readonly description?: string
  readonly mode?: "subagent" | "primary" | "all"
  readonly hidden?: boolean
  readonly color?: string
  readonly temperature?: number
  readonly topP?: number
  readonly steps?: number
  readonly permission?: ConfigPermissionV1.Info
}

export const profiles = {
  default: {
    defaultAgent: "build",
    agents: defaultAgents,
    overrides: {} as Record<string, WorkflowOverride>,
    prompts: {
      build: DEFAULT_BUILD,
      compaction: DEFAULT_COMPACTION,
      debug: DEFAULT_DEBUG,
      explore: DEFAULT_EXPLORE,
      generate: DEFAULT_GENERATE,
      plan: DEFAULT_PLAN,
      summary: DEFAULT_SUMMARY,
      title: DEFAULT_TITLE,
    },
  },
  "deveco-studio": {
    defaultAgent: "build",
    agents: studioAgents,
    overrides: {} as Record<string, WorkflowOverride>,
    prompts: {
      build: STUDIO_BUILD,
      compaction: STUDIO_COMPACTION,
      debug: STUDIO_DEBUG,
      explore: STUDIO_EXPLORE,
      generate: STUDIO_GENERATE,
      plan: STUDIO_PLAN,
      summary: STUDIO_SUMMARY,
      title: STUDIO_TITLE,
    },
  },
} as const

export function select(profile = Runtime.current.agentProfile) {
  return profiles[profile]
}

export const current = select()

export * as AgentPromptProfile from "./profile"
