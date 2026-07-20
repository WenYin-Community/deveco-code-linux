export const MIN_GOAL_TOKEN_BUDGET = 1_000
export const MAX_GOAL_TOKEN_BUDGET = 10_000_000

export type GoalBudgetParseResult = { valid: true; value: number | null } | { valid: false; message: string }

// Blank input means unlimited in the TUI. CLI callers must reject an explicitly
// empty flag before calling this parser.
export function parseGoalBudget(input: string): GoalBudgetParseResult {
  if (input === "") return { valid: true, value: null }
  if (/\s/.test(input)) return { valid: false, message: "Budget must not contain spaces." }

  const match = /^(\d+)(?:\.(\d+))?([kKmM])?$/.exec(input)
  if (!match || (match[2] && !match[3])) {
    return { valid: false, message: "Enter a budget such as 10000, 100k, or 1.5m." }
  }

  const scale = match[3]?.toLowerCase() === "m" ? 6 : match[3] ? 3 : 0
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  // Parse decimal suffixes exactly, without floating-point multiplication.
  const value = Number(`${match[1]}${fraction.padEnd(scale, "0")}`)
  if (fraction.length > scale || !Number.isSafeInteger(value)) {
    return { valid: false, message: "Budget must resolve to a whole number of tokens." }
  }
  if (value < MIN_GOAL_TOKEN_BUDGET || value > MAX_GOAL_TOKEN_BUDGET) {
    return { valid: false, message: "Budget must be between 1k and 10m tokens." }
  }
  return { valid: true, value }
}

export * as GoalBudget from "./goal-budget"
