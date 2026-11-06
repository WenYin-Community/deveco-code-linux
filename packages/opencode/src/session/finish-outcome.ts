import { SessionV1 } from "@opencode-ai/core/v1/session"

export type FinishOutcome =
  | "incomplete"
  | "need-tools"
  | "content-filter"
  | "error"
  | "length"
  | "stop"
  | "unknown-with-content"
  | "empty-unknown-retry"
  | "empty-unknown-exhausted"

export const TURN_RECOVERY_LIMIT = 1

// Outcomes that end the turn. Everything else keeps the loop running.
const TERMINAL: ReadonlySet<FinishOutcome> = new Set<FinishOutcome>([
  "content-filter",
  "error",
  "length",
  "stop",
  "unknown-with-content",
  "empty-unknown-exhausted",
])

export function isTerminal(outcome: FinishOutcome) {
  return TERMINAL.has(outcome)
}

// cleanup() marks abandoned tool_use blocks this way after retries/aborts.
// They are not pending work and must not trigger an assistant-prefill request.
export function isOrphanedInterruptedTool(part: SessionV1.ToolPart) {
  return part.state.status === "error" && part.state.metadata?.interrupted === true
}

/**
 * The single source of truth for what a provider turn's `finish` means.
 *
 * Both the per-turn check inside the run loop and the loop-entry check that
 * decides whether to exit call this. Keeping one classifier is the point: the
 * bug it replaces was `unknown` meaning "not finished" in one place and
 * "finished successfully" two hundred lines away, so an empty turn slipped out
 * of the loop reporting success for a session that wrote nothing.
 */
export function classifyFinish(input: {
  finish: string | undefined
  error: SessionV1.Assistant["error"]
  parts: readonly SessionV1.Part[]
  // Recoveries already used by this user activity, regardless of trigger.
  retries: number
}): FinishOutcome {
  if (input.error) return "error"
  if (!input.finish) return "incomplete"
  if (input.finish === "tool-calls" || hasPendingTools(input.parts)) return "need-tools"
  if (input.finish === "content-filter") return "content-filter"
  if (input.finish === "error") return "error"
  if (input.finish === "length") return "length"
  if (input.finish !== "unknown") return "stop"
  // An "unknown" finish means the provider ended the stream without saying why.
  // It is only recoverable as a normal stop when the turn produced something the
  // loop can act on; an empty one burned the turn mid-thought.
  //
  // Reasoning does NOT count here. A turn holding only reasoning wrote no text,
  // called no tool, and left no file behind - the model was cut off mid-thought
  // just like the empty case, so it gets the same retry. Counting it as content
  // is how the 0904 task12 run exited reporting success after a 598s think that
  // the upstream gateway truncated at its 600s response timeout: 92k characters
  // of reasoning, zero output.
  if (hasVisibleOutput(input.parts)) return "unknown-with-content"
  return input.retries < TURN_RECOVERY_LIMIT ? "empty-unknown-retry" : "empty-unknown-exhausted"
}

// Must stay identical to the loop-entry hasToolCalls check. Provider-executed
// and orphaned interrupted calls are not pending work, so a turn holding only
// those did no work the loop can continue from.
export function hasPendingTools(parts: readonly SessionV1.Part[]) {
  return parts.some(
    (part) => part.type === "tool" && !part.metadata?.providerExecuted && !isOrphanedInterruptedTool(part),
  )
}

// Whether the turn produced anything at all, reasoning included. Used for
// diagnostics ("did the provider send us literally nothing?"), not for deciding
// whether the turn counts as work - that is hasVisibleOutput.
export function hasContent(parts: readonly SessionV1.Part[]) {
  return parts.some((part) => (part.type === "text" || part.type === "reasoning") && part.text.trim().length > 0)
}

// Output the user or the loop can actually use. Reasoning is excluded on
// purpose: it is the model talking to itself, and a turn that only did that has
// not answered, edited, or called anything.
export function hasVisibleOutput(parts: readonly SessionV1.Part[]) {
  return parts.some((part) => part.type === "text" && part.text.trim().length > 0)
}

// An unknown-finish turn that thought but never spoke or acted. Distinguishes a
// truncated long think from a provider that streamed nothing, so the error and
// the logs can say which one happened.
export function isReasoningOnly(parts: readonly SessionV1.Part[]) {
  return !hasVisibleOutput(parts) && !hasPendingTools(parts) && hasContent(parts)
}
