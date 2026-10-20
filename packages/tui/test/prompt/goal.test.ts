import { describe, expect, test } from "bun:test"
import {
  GOAL_COMPLETIONS,
  GOAL_SUBCOMMANDS,
  goalElapsedSeconds,
  goalFromMetadata,
  goalSubcommandQuery,
  goalTokenUsage,
  isGoalLifecyclePrefix,
  matchesSelectedGoalCommand,
  parseGoalBudget,
  parseGoalCommand,
  formatGoalHelp,
  formatGoalStatus,
  formatGoalTokenCount,
  isGoalCommandAgent,
} from "../../src/prompt/goal"

describe("goal slash command", () => {
  test("shows help for bare /goal", () => {
    expect(parseGoalCommand("/goal")).toEqual({ action: "help" })
    expect(parseGoalCommand("/goal   ")).toEqual({ action: "help" })
  })

  test("is exclusive to the build agent", () => {
    expect(isGoalCommandAgent("build")).toBe(true)
    expect(isGoalCommandAgent("plan")).toBe(false)
    expect(isGoalCommandAgent("goal")).toBe(false)
    expect(isGoalCommandAgent(undefined)).toBe(false)
  })

  test("strictly matches lifecycle subcommands", () => {
    expect(parseGoalCommand("/goal stop")).toEqual({ action: "stop" })
    expect(parseGoalCommand("/goal clear")).toEqual({ action: "clear" })
    expect(parseGoalCommand("/goal resume")).toEqual({ action: "resume" })
    expect(parseGoalCommand("/goal budget")).toEqual({ action: "open_budget" })
    expect(parseGoalCommand("/goal budget 100k ignored")).toEqual({ action: "open_budget" })
    expect(parseGoalCommand("/goal stop now")).toEqual({ action: "start", objective: "stop now" })
    expect(parseGoalCommand("/goal STOP")).toEqual({ action: "start", objective: "STOP" })
    expect(parseGoalCommand("/goalkeeper stop")).toBeNull()
  })

  test("uses all remaining input as the objective", () => {
    expect(parseGoalCommand("/goal implement the feature\nand verify it")).toEqual({
      action: "start",
      objective: "implement the feature\nand verify it",
    })
  })

  test("offers lifecycle completions after /goal space", () => {
    expect(GOAL_SUBCOMMANDS.map((item) => item.command)).toEqual([
      "/goal stop",
      "/goal clear",
      "/goal resume",
      "/goal budget",
    ])
    expect(GOAL_COMPLETIONS.map((item) => item.command)).toEqual([
      "/goal ",
      "/goal stop",
      "/goal clear",
      "/goal resume",
      "/goal budget",
    ])
    expect(goalSubcommandQuery("/goal ")).toBe("")
    expect(goalSubcommandQuery("/goal re")).toBe("re")
    expect(goalSubcommandQuery("/goal resume now")).toBeNull()
    expect(isGoalLifecyclePrefix("re")).toBe(true)
    expect(isGoalLifecyclePrefix("帮我开发一个贪吃蛇")).toBe(false)
    expect(matchesSelectedGoalCommand("/goal stop", "/goal stop")).toBe(true)
    expect(matchesSelectedGoalCommand("/goal stop", "/goal sto")).toBe(false)
    expect(matchesSelectedGoalCommand("/goal ", "/goal ")).toBe(true)
    expect(matchesSelectedGoalCommand("/goal ", "/goal 帮我开发一个贪吃蛇")).toBe(true)
    expect(matchesSelectedGoalCommand("/goal ", "/goal")).toBe(false)
  })
})

describe("goal token budget", () => {
  test("parses supported formats", () => {
    expect(parseGoalBudget("")).toEqual({ valid: true, value: null })
    expect(parseGoalBudget("10000")).toEqual({ valid: true, value: 10_000 })
    expect(parseGoalBudget("100k")).toEqual({ valid: true, value: 100_000 })
    expect(parseGoalBudget("100K")).toEqual({ valid: true, value: 100_000 })
    expect(parseGoalBudget("1.5m")).toEqual({ valid: true, value: 1_500_000 })
    expect(parseGoalBudget("1.5M")).toEqual({ valid: true, value: 1_500_000 })
  })

  test("rejects invalid or out-of-range values", () => {
    for (const input of [" ", "100 k", "-1000", "0", "1.5", "1e6", "10,000", "999", "11m", "abc"]) {
      expect(parseGoalBudget(input).valid).toBe(false)
    }
  })

  test("formats compact token counts", () => {
    expect(formatGoalTokenCount(999)).toBe("999")
    expect(formatGoalTokenCount(1_000)).toBe("1k")
    expect(formatGoalTokenCount(32_400)).toBe("32.4k")
    expect(formatGoalTokenCount(1_500_000)).toBe("1.5m")
  })

  test("formats status with elapsed time and without token usage or budget", () => {
    const goal = {
      objective: "test",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
      activeSince: 1,
      elapsedMilliseconds: 0,
      sourceMessageID: "msg_test",
      reason: null,
      tokenBudget: 100_000,
      budgetExhaustedAt: null,
      usedTokens: 0,
    }
    expect(formatGoalStatus(goal, "12m")).toBe("Goal · active · 12m")
    expect(formatGoalStatus({ ...goal, tokenBudget: null }, "12m")).toBe("Goal · active · 12m")
    expect(formatGoalStatus({ ...goal, status: "paused" }, "12m")).toBe("Goal · paused · 12m")
    expect(formatGoalStatus({ ...goal, status: "complete" }, "17m 10s")).toBe("Goal · complete · 17m 10s")
    expect(formatGoalStatus({ ...goal, status: "paused", budgetExhaustedAt: 0 }, "12m")).toBe(
      "Goal · budget exceeded · 12m",
    )
    expect(formatGoalStatus({ ...goal, status: "paused", reason: "token budget exhausted" }, "12m")).toBe(
      "Goal · paused · 12m",
    )
    expect(formatGoalStatus({ ...goal, budgetExhaustedAt: 1 }, "12m")).toBe("Goal · active · 12m")
    expect(formatGoalStatus({ ...goal, status: "complete", budgetExhaustedAt: 1 }, "17m 10s")).toBe(
      "Goal · complete · 17m 10s",
    )
  })
})

describe("goal help", () => {
  const goal = {
    objective: "finish goal mode",
    status: "active" as const,
    createdAt: 1_000,
    updatedAt: 1_000,
    activeSince: 2_000,
    elapsedMilliseconds: 3_000,
    sourceMessageID: "msg_test",
    reason: null,
    tokenBudget: 20_000,
    budgetExhaustedAt: null,
    usedTokens: 0,
  }

  test.each(["active", "paused", "complete"] as const)(
    "shows Unlimited after clearing the default budget with an existing %s goal",
    (status) => {
      const message = formatGoalHelp({
        budget: null,
        goal: { ...goal, status },
        duration: "12m",
        usedTokens: 3_000,
      })
      expect(message).toContain("Current budget: Unlimited")
      expect(message).toContain("Current goal\nTask: finish goal mode\nBudget: 20k tokens\nUsed: 3k tokens")
      expect(message).toContain(`Status: ${status}\nElapsed: 12m`)
    },
  )

  test("shows the updated numeric default separately from the goal budget", () => {
    const message = formatGoalHelp({ budget: 100_000, goal, duration: "12m", usedTokens: 3_000 })
    expect(message).toContain("Current budget: 100k tokens")
    expect(message).toContain("Current goal\nTask: finish goal mode\nBudget: 20k tokens\nUsed: 3k tokens")
  })

  test("keeps an existing unlimited goal distinct from a new numeric default", () => {
    const message = formatGoalHelp({
      budget: 20_000,
      goal: { ...goal, tokenBudget: null },
      duration: "12m",
      usedTokens: 3_000,
    })
    expect(message).toContain("Current budget: 20k tokens")
    expect(message).toContain("Current goal\nTask: finish goal mode\nBudget: Unlimited\nUsed: 3k tokens")
  })

  test("shows the configured budget without usage when no goal exists", () => {
    for (const budget of [null, 20_000]) {
      const message = formatGoalHelp({ budget, goal: null, duration: "0s", usedTokens: 0 })
      expect(message).toContain(`Current budget: ${budget === null ? "Unlimited" : "20k tokens"}`)
      expect(message).toContain("No goal exists for this session.")
      expect(message).not.toContain("Used:")
    }
  })
})

describe("goal sidebar state", () => {
  const goal = {
    objective: "finish goal mode",
    status: "active" as const,
    createdAt: 1_000,
    updatedAt: 1_000,
    activeSince: 2_000,
    elapsedMilliseconds: 3_000,
    sourceMessageID: "msg_test",
    reason: null,
    tokenBudget: 100_000,
    budgetExhaustedAt: null,
    usedTokens: 0,
  }

  test("reads goal state from session metadata", () => {
    expect(goalFromMetadata({ deveco_goal: goal })).toEqual(goal)
    expect(goalFromMetadata({ deveco_goal: { status: "active" } })).toBeNull()
    expect(
      goalFromMetadata({
        deveco_goal: {
          ...goal,
          tokenBudget: undefined,
          budgetExhaustedAt: undefined,
        },
      }),
    ).toMatchObject({ tokenBudget: null, budgetExhaustedAt: null, usedTokens: 0 })
  })

  test("advances elapsed time only while active", () => {
    expect(goalElapsedSeconds(goal, 7_000)).toBe(8)
    expect(goalElapsedSeconds({ ...goal, status: "paused" }, 7_000)).toBe(3)
  })

  test("counts assistant token usage only from the current goal", () => {
    const tokens = (input: number) => ({
      input,
      output: 2,
      reasoning: 3,
      cache: { read: 4, write: 1 },
    })
    const current = { ...goal, sourceMessageID: "msg_002" }
    expect(
      goalTokenUsage(current, [
        { role: "assistant", parentID: "msg_001", tokens: tokens(100) },
        { role: "assistant", parentID: "msg_002", tokens: tokens(10) },
        { role: "user", parentID: "msg_003" },
        { role: "assistant", parentID: "msg_003", tokens: tokens(20) },
      ]),
    ).toBe(50)
    expect(
      goalTokenUsage({ ...current, status: "paused", usedTokens: 50, sourceMessageID: null }, [
        { role: "assistant", parentID: "msg_004", tokens: tokens(200) },
      ]),
    ).toBe(50)
  })
})
