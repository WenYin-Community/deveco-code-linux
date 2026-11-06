import { DateTime, Effect } from "effect"
import type { EventV2 } from "@opencode-ai/core/event"
import { Database } from "@opencode-ai/core/database/database"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"
import { Session } from "./session"
import type { SessionStatus } from "./status"
import type { SessionCompaction } from "./compaction"
import type { SessionProcessor } from "./processor"
import {
  classifyFinish,
  hasContent,
  hasPendingTools,
  isOrphanedInterruptedTool,
  isReasoningOnly,
  isTerminal,
  TURN_RECOVERY_LIMIT,
} from "./finish-outcome"

const rules = {
  output_length: {
    message: "Model output reached the token limit; retrying once with an action-focused prompt",
    prompt: `The previous response reached the output token limit before the task was complete.

Do not restart or expand the analysis. Reuse the preceding reasoning and completed tool results; do not redo completed work solely because of the truncation. Take the next concrete action now. If no tool action is needed, finish with a concise answer.`,
  },
  empty_unknown: {
    message: "Model response ended without usable output; retrying once with an action-focused prompt",
    prompt: `The previous response ended before producing usable output.

Do not restart or expand the analysis. Reuse any preceding reasoning and completed tool results; do not redo completed work solely because of the interruption. Take the next concrete action now. If no tool action is needed, finish with a concise answer.`,
  },
}

type Reason = keyof typeof rules
export type State = {
  attempts: number
  pending?: { reason: Reason }
  activity?: MessageID
  providerStep: number
}

type Services = {
  sessionID: SessionID
  sessions: Session.Interface
  events: EventV2.Interface
  status: SessionStatus.Interface
  compaction: SessionCompaction.Interface
  database: Database.Interface
  experimentalEventSystem: boolean
}

type Turn = {
  services: Services
  state: State
  handle: SessionProcessor.Handle
  user: SessionV1.User
  recovering: State["pending"]
  isLastStep: boolean
  maxSteps: number
  step: number
  model: Provider.Model
}

type Settlement = Turn & {
  result: SessionProcessor.Result
  structured: unknown
  structuredFormat: boolean
}

export function create(): State {
  return { attempts: 0, providerStep: 0 }
}

export function observe(state: State, user: SessionV1.User, messages: SessionV1.WithParts[]) {
  const parts = messages.find((message) => message.info.id === user.id)?.parts
  const internal = parts?.some(
    (part) =>
      part.type === "compaction" ||
      (part.type === "text" && (part.metadata?.compaction_continue || part.metadata?.compaction_replay)),
  )
  if (user.id === state.activity || internal) return
  state.activity = user.id
  state.attempts = 0
  state.pending = undefined
  state.providerStep = 0
}

export function nextStep(state: State, maxSteps: number) {
  state.providerStep++
  return state.providerStep >= maxSteps
}

export function messages(state: State) {
  return state.pending ? [{ role: "user" as const, content: rules[state.pending.reason].prompt }] : []
}

export function started(sessionID: SessionID) {
  return Effect.logInfo("session  runner", {
    "session.id": sessionID,
    runner: "legacy",
    turnRecovery: "v1",
    recoveryLimit: TURN_RECOVERY_LIMIT,
  })
}

export const shouldStop = Effect.fn("TurnRecovery.shouldStop")(function* (
  state: State,
  input: {
    sessionID: SessionID
    user: SessionV1.User
    assistant: SessionV1.Assistant | undefined
    messages: SessionV1.WithParts[]
    step: number
  },
) {
  const assistant = input.assistant
  if (!assistant || assistant.parentID !== input.user.id || state.pending) return false
  const parts =
    input.messages.findLast((message) => message.info.role === "assistant" && message.info.id === assistant.id)
      ?.parts ?? []
  const outcome = classifyFinish({ finish: assistant.finish, error: assistant.error, parts, retries: state.attempts })
  if (!isTerminal(outcome)) return false
  const orphan = parts.find(
    (part): part is SessionV1.ToolPart => part.type === "tool" && isOrphanedInterruptedTool(part),
  )
  if (orphan) {
    yield* Effect.logWarning("loop exit with orphaned interrupted tool", {
      "session.id": input.sessionID,
      messageID: assistant.id,
      tool: orphan.tool,
      callID: orphan.callID,
    })
  }
  const log = outcome === "empty-unknown-exhausted" ? Effect.logWarning : Effect.logInfo
  yield* log("exiting loop", {
    "session.id": input.sessionID,
    messageID: assistant.id,
    exitKind: outcome,
    finish: assistant.finish,
    providerFinishReason: assistant.providerFinishReason ?? null,
    empty: !hasPendingTools(parts) && !hasContent(parts),
    reasoningOnly: isReasoningOnly(parts),
    hasToolCalls: hasPendingTools(parts),
    step: input.step,
    recoveryAttempts: state.attempts,
    messageCount: input.messages.length,
    afterCompaction: input.messages
      .findLast((message) => message.info.id === input.user.id)
      ?.parts.some((part) => part.type === "text" && part.metadata?.compaction_continue === true),
  })
  return true
})

export function resume(turn: Turn) {
  if (!turn.recovering) return Effect.void
  return Effect.logInfo("turn_recovery", {
    ...logContext(turn),
    phase: "resume",
    reason: turn.recovering.reason,
    provider: turn.model.providerID,
    model: turn.model.id,
  })
}

export const settle = Effect.fn("TurnRecovery.settle")(function* (turn: Settlement) {
  // An input-overflow rebuild must retain the pending recovery until its replacement provider turn.
  turn.state.pending = turn.recovering && turn.result === "compact" ? turn.recovering : undefined
  if (typeof turn.result === "object") return yield* outputLength(turn, turn.result.compaction)
  if (turn.structured !== undefined) {
    yield* recovered(turn, "recovered")
    turn.handle.message.structured = turn.structured
    turn.handle.message.finish ??= "stop"
    yield* turn.services.sessions.updateMessage(turn.handle.message)
    return "break" as const
  }
  const parts = yield* MessageV2.parts(turn.handle.message.id).pipe(
    Effect.provideService(Database.Service, turn.services.database),
  )
  const outcome = classifyFinish({
    finish: turn.handle.message.finish,
    error: turn.handle.message.error,
    parts,
    retries: turn.state.attempts,
  })
  if (outcome === "empty-unknown-retry" || outcome === "empty-unknown-exhausted") {
    return yield* emptyUnknown(turn, parts, outcome === "empty-unknown-retry")
  }
  yield* recovered(turn, settlementPhase(turn.result))
  if (isTerminal(outcome) && !turn.handle.message.error && (yield* terminalError(turn, outcome)))
    return "break" as const
  if (turn.result === "stop") return "break" as const
  if (turn.result === "compact") yield* compact(turn, !turn.handle.message.finish)
  return "continue" as const
})

function logContext(turn: Turn) {
  return {
    runner: "legacy",
    "session.id": turn.services.sessionID,
    messageID: turn.handle.message.id,
    activityID: turn.state.activity,
    attempt: turn.state.attempts,
    step: turn.step,
  }
}

function recovered(turn: Turn, phase: string) {
  if (!turn.recovering) return Effect.void
  return Effect.logInfo("turn_recovery", {
    ...logContext(turn),
    phase,
    reason: turn.recovering.reason,
    finish: turn.handle.message.finish,
  })
}

function settlementPhase(result: SessionProcessor.Result) {
  if (result === "stop") return "stopped"
  return result === "compact" ? "compact" : "recovered"
}

const request = Effect.fn("TurnRecovery.request")(function* (turn: Turn, reason: Reason) {
  if (turn.isLastStep || turn.state.attempts >= TURN_RECOVERY_LIMIT) return false
  turn.state.attempts++
  turn.state.pending = { reason }
  if (turn.services.experimentalEventSystem) {
    yield* turn.services.events.publish(SessionEvent.Retried, {
      sessionID: turn.services.sessionID,
      attempt: turn.state.attempts,
      timestamp: DateTime.makeUnsafe(Date.now()),
      error: {
        message: rules[reason].message,
        isRetryable: true,
        metadata: { reason, runner: "legacy", messageID: turn.handle.message.id },
      },
    })
  }
  yield* turn.services.status.set(turn.services.sessionID, {
    type: "retry",
    attempt: turn.state.attempts,
    message: rules[reason].message,
    next: Date.now(),
  })
  return true
})

const outputLength = Effect.fn("TurnRecovery.outputLength")(function* (turn: Turn, needsCompaction: boolean) {
  const retry = yield* request(turn, "output_length")
  const persisted = yield* MessageV2.get({
    sessionID: turn.services.sessionID,
    messageID: turn.handle.message.id,
  }).pipe(Effect.provideService(Database.Service, turn.services.database), Effect.orDie)
  yield* logOutputLength(turn, persisted.parts, retry, needsCompaction)
  if (!retry) {
    const cause = isReasoningOnly(persisted.parts) ? "reasoning_limit" : "output_limit"
    yield* turn.handle.failOutputLength(turn.state.attempts, outputLengthMessage(cause, turn.isLastStep), cause)
    return "break" as const
  }
  if (needsCompaction) yield* compact(turn)
  return "continue" as const
})

function failureContext(turn: Turn, reason: Reason, retry: boolean) {
  return {
    ...logContext(turn),
    phase: retry ? "retry" : "failed",
    reason,
    previousReason: turn.recovering?.reason ?? null,
    cause: turn.isLastStep ? "step_limit" : retry ? "recoverable" : "recovery_exhausted",
  }
}

function logOutputLength(turn: Turn, parts: SessionV1.Part[], retry: boolean, compaction: boolean) {
  return Effect.logWarning("turn_recovery", {
    ...failureContext(turn, "output_length", retry),
    providerStep: turn.state.providerStep,
    maxSteps: Number.isFinite(turn.maxSteps) ? turn.maxSteps : undefined,
    provider: turn.model.providerID,
    model: turn.model.id,
    finish: turn.handle.message.finish,
    tokens: turn.handle.message.tokens,
    compaction,
    hasText: parts.some((part) => part.type === "text" && part.text.length > 0),
    hasToolCall: parts.some((part) => part.type === "tool"),
  })
}

function outputLengthMessage(cause: "reasoning_limit" | "output_limit", isLastStep: boolean) {
  const limit = isLastStep ? "and the agent step budget is exhausted" : "after one automatic recovery"
  if (cause === "reasoning_limit") {
    return `Model reasoning reached the per-turn output limit ${limit}. Increase the output token limit or split the request into smaller tasks.`
  }
  return `Model output reached the token limit ${limit}. Send "continue" to resume from the current progress.`
}

const emptyUnknown = Effect.fn("TurnRecovery.emptyUnknown")(function* (
  turn: Turn,
  parts: SessionV1.Part[],
  eligible: boolean,
) {
  const retry = eligible ? yield* request(turn, "empty_unknown") : false
  yield* Effect.logWarning("turn_recovery", {
    ...failureContext(turn, "empty_unknown", retry),
    providerFinishReason: turn.handle.message.providerFinishReason ?? null,
    reasoningOnly: isReasoningOnly(parts),
  })
  if (retry) return "continue" as const
  turn.handle.message.error = new SessionV1.EmptyCompletionError({
    message:
      turn.state.attempts > 0
        ? 'The model response ended unexpectedly after one automatic recovery. Send "continue" to retry from the current progress.'
        : 'The model response ended unexpectedly. Send "continue" to retry from the current progress.',
    type: "empty_unknown",
    attempts: turn.state.attempts,
    cause: "response_interrupted",
    providerFinishReason: turn.handle.message.providerFinishReason,
  }).toObject()
  yield* fail(turn)
  return "break" as const
})

const terminalError = Effect.fn("TurnRecovery.terminalError")(function* (
  turn: Settlement,
  outcome: ReturnType<typeof classifyFinish>,
) {
  if (outcome === "content-filter") {
    turn.handle.message.error = new SessionV1.ContentFilterError({
      message: "The response was blocked by the provider's content filter",
    }).toObject()
    yield* fail(turn)
    return true
  }
  if (!turn.structuredFormat || outcome === "unknown-with-content") return false
  turn.handle.message.error = new SessionV1.StructuredOutputError({
    message: "Model did not produce structured output",
    retries: 0,
  }).toObject()
  yield* turn.services.sessions.updateMessage(turn.handle.message)
  return true
})

function fail(turn: Turn) {
  return turn.services.sessions.updateMessage(turn.handle.message).pipe(
    Effect.andThen(
      turn.services.events.publish(Session.Event.Error, {
        sessionID: turn.services.sessionID,
        error: turn.handle.message.error,
      }),
    ),
  )
}

function compact(turn: Turn, overflow?: boolean) {
  return turn.services.compaction.create({
    sessionID: turn.services.sessionID,
    agent: turn.user.agent,
    model: turn.user.model,
    auto: true,
    ...(overflow === undefined ? {} : { overflow }),
  })
}

export * as TurnRecovery from "./turn-recovery"
