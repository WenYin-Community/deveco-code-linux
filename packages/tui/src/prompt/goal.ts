export {
  MIN_GOAL_TOKEN_BUDGET,
  MAX_GOAL_TOKEN_BUDGET,
  parseGoalBudget,
  type GoalBudgetParseResult,
} from "@opencode-ai/core/util/goal-budget"

export type GoalInfo = {
  objective: string
  status: "active" | "paused" | "complete"
  createdAt: number
  updatedAt: number
  activeSince: number | null
  elapsedMilliseconds: number
  sourceMessageID: string | null
  reason: string | null
  tokenBudget: number | null
  budgetExhaustedAt: number | null
  usedTokens: number
}

export type GoalCommand =
  | { action: "help" }
  | { action: "stop" }
  | { action: "clear" }
  | { action: "resume" }
  | { action: "open_budget" }
  | { action: "start"; objective: string }

export const GOAL_AGENT = "build"

export const GOAL_HELP = `/goal <objective>  Start or replace a goal
/goal stop         Pause the active goal
/goal clear        Delete the current goal
/goal resume       Resume the paused goal
/goal budget       Configure the Goal token budget`

export function isGoalCommandAgent(name: string | undefined) {
  return name === GOAL_AGENT
}

// /goal is executed by the prompt submit path, never by SessionPrompt.command, so the client
// reports it itself. One submit can pass several branches (agent rejection, budget, help,
// stop/clear/resume, start), so the report must fire exactly once per submit.
export function createGoalCommandReport(report: (sessionID?: string) => void): (sessionID?: string) => void {
  let reported = false
  return (sessionID) => {
    if (reported) return
    reported = true
    report(sessionID)
  }
}

export const GOAL_SUBCOMMANDS = [
  { command: "/goal stop", description: "Pause the active goal and stop execution" },
  { command: "/goal clear", description: "Delete the goal and stop execution" },
  { command: "/goal resume", description: "Resume a paused goal" },
  { command: "/goal budget", description: "Configure the Goal token budget" },
] as const

export const GOAL_COMPLETIONS = [
  { command: "/goal ", description: "Enter a goal objective" },
  ...GOAL_SUBCOMMANDS,
] as const

type GoalUsageMessage = {
  role: string
  parentID?: string
  tokens?: {
    input: number
    output: number
    reasoning: number
    cache: {
      read: number
      write: number
    }
  }
}

export function parseGoalCommand(input: string): GoalCommand | null {
  if (input !== "/goal" && !input.startsWith("/goal ") && !input.startsWith("/goal\n")) return null
  const arguments_ = input.slice("/goal".length).trim()
  if (!arguments_) return { action: "help" }
  if (arguments_ === "stop") return { action: "stop" }
  if (arguments_ === "clear") return { action: "clear" }
  if (arguments_ === "resume") return { action: "resume" }
  if (arguments_.split(/\s+/, 1)[0] === "budget") return { action: "open_budget" }
  return { action: "start", objective: arguments_ }
}

export function goalSubcommandQuery(input: string, cursorOffset = input.length) {
  const match = /^\/goal ([^\s]*)$/.exec(input.slice(0, cursorOffset))
  return match?.[1] ?? null
}

export function isGoalLifecyclePrefix(query: string) {
  return GOAL_SUBCOMMANDS.some((item) => item.command.slice("/goal ".length).startsWith(query))
}

export function matchesSelectedGoalCommand(command: string, input: string, cursorOffset = input.length) {
  const beforeCursor = input.slice(0, cursorOffset)
  if (command === "/goal ") return beforeCursor.startsWith(command)
  return !beforeCursor || beforeCursor === command
}

export function goalFromMetadata(metadata: Record<string, unknown> | undefined): GoalInfo | null {
  const goal = metadata?.deveco_goal
  if (!goal || typeof goal !== "object") return null
  if (!("objective" in goal) || typeof goal.objective !== "string") return null
  if (!("status" in goal) || !["active", "paused", "complete"].includes(String(goal.status))) return null
  if (!("createdAt" in goal) || typeof goal.createdAt !== "number") return null
  if (!("updatedAt" in goal) || typeof goal.updatedAt !== "number") return null
  if (!("elapsedMilliseconds" in goal) || typeof goal.elapsedMilliseconds !== "number") return null
  if (!("activeSince" in goal) || (goal.activeSince !== null && typeof goal.activeSince !== "number")) return null
  if (!("sourceMessageID" in goal) || (goal.sourceMessageID !== null && typeof goal.sourceMessageID !== "string"))
    return null
  if (!("reason" in goal) || (goal.reason !== null && typeof goal.reason !== "string")) return null
  if (
    "tokenBudget" in goal &&
    goal.tokenBudget !== undefined &&
    goal.tokenBudget !== null &&
    typeof goal.tokenBudget !== "number"
  )
    return null
  if (
    "budgetExhaustedAt" in goal &&
    goal.budgetExhaustedAt !== undefined &&
    goal.budgetExhaustedAt !== null &&
    typeof goal.budgetExhaustedAt !== "number"
  )
    return null
  if (
    "usedTokens" in goal &&
    goal.usedTokens !== undefined &&
    goal.usedTokens !== null &&
    typeof goal.usedTokens !== "number"
  )
    return null
  return {
    ...(goal as Omit<GoalInfo, "tokenBudget" | "budgetExhaustedAt" | "usedTokens">),
    tokenBudget: "tokenBudget" in goal && typeof goal.tokenBudget === "number" ? goal.tokenBudget : null,
    budgetExhaustedAt:
      "budgetExhaustedAt" in goal && typeof goal.budgetExhaustedAt === "number" ? goal.budgetExhaustedAt : null,
    usedTokens: "usedTokens" in goal && typeof goal.usedTokens === "number" ? goal.usedTokens : 0,
  }
}

export const GOAL_BUDGET_KV_KEY = "goal_token_budget"

export function formatGoalTokenCount(value: number) {
  const unit = value >= 1_000_000 ? 1_000_000 : value >= 1_000 ? 1_000 : 1
  const suffix = unit === 1_000_000 ? "m" : unit === 1_000 ? "k" : ""
  const scaled = value / unit
  return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1).replace(/\.0$/, "")}${suffix}`
}

export function formatGoalBudget(value: number | null) {
  return value === null ? "Unlimited" : `${formatGoalTokenCount(value)} tokens`
}

export function formatGoalHelp(input: {
  budget: number | null
  goal: GoalInfo | null
  duration: string
  usedTokens: number
}) {
  const overview = `${GOAL_HELP}\n\nCurrent budget: ${formatGoalBudget(input.budget)}`
  if (!input.goal) return `${overview}\n\nCurrent goal\nNo goal exists for this session.`
  return [
    overview,
    "",
    "Current goal",
    `Task: ${input.goal.objective}`,
    `Budget: ${formatGoalBudget(input.goal.tokenBudget)}`,
    `Used: ${formatGoalTokenCount(input.usedTokens)} tokens`,
    `Status: ${input.goal.status}`,
    `Elapsed: ${input.duration}`,
    ...(input.goal.reason ? [`Reason: ${input.goal.reason}`] : []),
  ].join("\n")
}

export function formatGoalStatus(goal: GoalInfo, duration: string) {
  const status = goal.status === "paused" && goal.budgetExhaustedAt !== null ? "budget exceeded" : goal.status
  return `Goal · ${status} · ${duration}`
}

export function goalElapsedSeconds(goal: GoalInfo, now = Date.now()) {
  const active = goal.status === "active" && goal.activeSince !== null ? Math.max(0, now - goal.activeSince) : 0
  return Math.floor((goal.elapsedMilliseconds + active) / 1000)
}

export function goalTokenUsage(goal: GoalInfo, messages: readonly GoalUsageMessage[]) {
  if (goal.status !== "active" || !goal.sourceMessageID) return goal.usedTokens
  return messages.reduce((total, message) => {
    if (message.role !== "assistant" || !message.tokens || !message.parentID) return total
    if (message.parentID < goal.sourceMessageID!) return total
    return (
      total +
      message.tokens.input +
      message.tokens.output +
      message.tokens.reasoning +
      message.tokens.cache.read +
      message.tokens.cache.write
    )
  }, goal.usedTokens)
}
