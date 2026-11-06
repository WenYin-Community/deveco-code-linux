export type TurnRecoveryFailure = {
  cause: "reasoning_limit" | "output_limit" | "response_interrupted"
  retried: boolean
}

export function turnRecoveryFailure(error: unknown): TurnRecoveryFailure | undefined {
  if (!error || typeof error !== "object" || !("data" in error)) return undefined
  const data = error.data
  if (!data || typeof data !== "object" || !("cause" in data)) return undefined
  if (data.cause !== "reasoning_limit" && data.cause !== "output_limit" && data.cause !== "response_interrupted")
    return undefined
  return {
    cause: data.cause,
    retried: "attempts" in data && typeof data.attempts === "number" && data.attempts > 0,
  }
}

type TurnRecoveryMessageKey =
  | "ui.sessionTurn.error.reasoning_limit"
  | "ui.sessionTurn.error.reasoning_limitAfterRecovery"
  | "ui.sessionTurn.error.output_limit"
  | "ui.sessionTurn.error.output_limitAfterRecovery"
  | "ui.sessionTurn.error.response_interrupted"
  | "ui.sessionTurn.error.response_interruptedAfterRecovery"

export function turnRecoveryFailureMessage(
  failure: TurnRecoveryFailure,
  translate: (key: TurnRecoveryMessageKey) => string,
) {
  const suffix = failure.retried ? "AfterRecovery" : ""
  return translate(`ui.sessionTurn.error.${failure.cause}${suffix}` as TurnRecoveryMessageKey)
}
