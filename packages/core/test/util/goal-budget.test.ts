import { describe, expect, test } from "bun:test"
import { parseGoalBudget } from "../../src/util/goal-budget"

describe("Goal token budget", () => {
  test("supports unlimited, integer and exact decimal suffixes", () => {
    for (const [input, value] of [
      ["", null],
      ["1000", 1000],
      ["200k", 200_000],
      ["200K", 200_000],
      ["1.5m", 1_500_000],
      ["10M", 10_000_000],
      ["1.001k", 1001],
      ["1.000001m", 1_000_001],
      ["1.0010k", 1001],
    ] as const) {
      expect(parseGoalBudget(input)).toEqual({ valid: true, value })
    }
  })

  test("rejects malformed, fractional-token and out-of-range budgets", () => {
    for (const input of [
      " ",
      " 200k",
      "200k ",
      "100 k",
      "-1000",
      "0",
      "1.5",
      "1e6",
      "10,000",
      "999",
      "11m",
      "abc",
      "1.0001k",
      "1.0000001m",
      "9007199254740992",
    ]) {
      expect(parseGoalBudget(input).valid).toBe(false)
    }
  })
})
