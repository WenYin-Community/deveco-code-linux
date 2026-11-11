import type { AgentSideConnection } from "@agentclientprotocol/sdk"
import type {
  DebugStatePart,
  Event,
  EventMessagePartDelta,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionError,
  OpencodeClient,
  Part,
  SessionMessageResponse,
  ToolPart,
} from "@opencode-ai/sdk/v2"
import { Effect, Option, Schema } from "effect"
import { ACPSession } from "./session"
import { ACPPermission } from "./permission"
import { ACPElicitation } from "./elicitation"
import { UsageService } from "./usage"
import { partsToContentChunks, type ReplayPart } from "./content"
import {
  duplicateRunningToolUpdate,
  errorToolUpdate,
  pendingToolCall,
  runningToolUpdate,
  shellOutputSnapshot,
  completedToolUpdate,
} from "./tool"

type Connection = Pick<AgentSideConnection, "sessionUpdate" | "unstable_createElicitation"> &
  Partial<Pick<AgentSideConnection, "requestPermission" | "writeTextFile">>
type GlobalEventEnvelope = {
  payload?: Event
}
type GlobalEventStream = {
  stream: AsyncIterable<GlobalEventEnvelope>
}

// Floor between two per-step usage pushes for the same session. Completed
// assistant messages are the trigger, so bursts only happen on fast error
// retries — the end-of-turn sendUpdate is the authoritative catch-up.
const USAGE_PUSH_MIN_INTERVAL_MS = 1500

type SessionErrorPayload = NonNullable<EventSessionError["properties"]["error"]>

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const GatewayErrorBody = Schema.Struct({
  error: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
})

// Reads the human-readable failure text off a serialized session error payload
// ({ name, data }). The TUI's `formatError` (session-data.ts) has an additional
// `error.message` branch for live Error instances, but ACP only handles the
// serialized `NamedError.toObject()` shape, so that branch is unreachable here.
// MessageOutputLengthError carries no message at all, so it falls through to
// the name.
function sessionErrorText(error: SessionErrorPayload): string {
  const dataMsg = (error.data as { message?: unknown }).message
  if (typeof dataMsg === "string" && dataMsg.trim()) return dataMsg
  return error.name || "unknown error"
}

// The model service tags a failure with a machine-readable type (ScasReject,
// QuotaExhausted, WaitingInLine, ...) inside `responseBody.error.type`, and
// APIError carries the HTTP status. Neither is rendered anywhere today — the
// TUI only ever shows `error.data.message` — so the classification travels next
// to the text and lets the client pick a terminal error card over a retry notice.
//
// All errors reaching this path are terminal (retries exhausted or non-retryable),
// so there is no `retryable` field — `APIError.isRetryable` reflects the error
// type's retry support, not whether this specific failure will be retried.
function sessionErrorMeta(error: SessionErrorPayload) {
  const data = typeof error.data === "object" && error.data !== null ? error.data : undefined
  const type = data ? gatewayErrorType(data) : undefined
  const statusCode =
    data && "statusCode" in data && typeof data.statusCode === "number" ? data.statusCode : undefined
  return {
    name: error.name,
    ...(type ? { type } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  }
}

// Extracts the gateway error type from `responseBody`. FreeUsageLimitError and
// GoUsageLimitError are embedded as substrings rather than structured
// `error.type` fields — keep in sync with `SessionRetry.getRetryCategory`
// (retry.ts) which classifies the same patterns for retry budgeting.
function gatewayErrorType(data: Record<string, unknown>) {
  if (typeof data.responseBody !== "string") return undefined
  if (data.responseBody.includes("FreeUsageLimitError")) return "FreeUsageLimitError"
  if (data.responseBody.includes("GoUsageLimitError")) return "GoUsageLimitError"
  const parsed = Option.getOrUndefined(decodeJson(data.responseBody))
  return Option.getOrUndefined(Schema.decodeUnknownOption(GatewayErrorBody)(parsed))?.error?.type
}

// The wire shape for a mirrored turn failure. Shared by the live session.error
// path and message replay so both emit identical chunks.
function sessionErrorChunk(messageId: string, error: SessionErrorPayload) {
  return {
    sessionUpdate: "agent_message_chunk" as const,
    messageId,
    content: { type: "text" as const, text: sessionErrorText(error) },
    _meta: { error: sessionErrorMeta(error) },
  }
}

// Sticky-debug transcript markers (`debug-state` parts) are the only durable
// record of a /debug turn: the typed text is either absent (status/clear echo
// a marker-only user message) or synthetic (enter hides the expanded command
// template), so without this mirror a reloaded session shows nothing for the
// turn. ACP has no dedicated update for them, so they travel as agent chunks
// tagged `_meta.debugState` — same pattern as sessionErrorChunk. It must NOT
// be a user_message_chunk: clients key per-user-message state (replay indices,
// original-text decorations) off user chunks, and marker-only turns consume no
// index on the saving side. The text is a plain-language fallback for clients
// that don't know the meta; the TUI wording lives in its debug_state i18n.
function debugStateText(part: DebugStatePart): string {
  const condition = part.condition.trim()
  switch (part.state) {
    case "set":
    case "status":
      return condition ? `Debug mode active: ${condition}` : "Debug mode active"
    case "cleared":
      return condition ? `Debug mode cleared: ${condition}` : "Debug mode cleared"
    case "none":
    default:
      return "Debug mode is not active"
  }
}

function debugStateChunk(part: DebugStatePart) {
  return {
    sessionUpdate: "agent_message_chunk" as const,
    // Part-scoped id keeps each marker its own message and makes the live and
    // replay emissions of the same part indistinguishable to the client.
    messageId: `debug-state-${part.id}`,
    content: { type: "text" as const, text: debugStateText(part) },
    _meta: {
      debugState: {
        state: part.state,
        condition: part.condition,
        ...(part.command ? { command: part.command } : {}),
      },
    },
  }
}

// Section 22: task subagents are not ACP-registered sessions, so their events
// never reach the wire on their own. The link (built from the parent task
// tool part's state.metadata.sessionId) routes their tool events to the
// parent session, and the parent's reverse requests (permission/question)
// back to a session the client can actually route.
type SubagentLink = { parentSessionId: string; toolCallId: string }

const SUBAGENT_LOG_LINES = 12

function truncateProgress(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "…"
}

function subagentToolTarget(part: ToolPart): string {
  const input = "input" in part.state ? (part.state.input as Record<string, unknown>) : undefined
  const command = input?.command
  if (typeof command === "string" && command.trim()) {
    return truncateProgress(command.replace(/\s+/g, " ").trim(), 60)
  }
  const raw = input?.filePath ?? input?.file_path ?? input?.path ?? input?.pathInProject ?? input?.pattern ?? input?.query
  if (typeof raw !== "string" || !raw.trim()) return ""
  const normalized = raw.replace(/\\/g, "/")
  return truncateProgress(normalized.split("/").pop() ?? normalized, 60)
}

function subagentProgressLine(part: ToolPart): string {
  const mark = part.state.status === "completed" ? "✓" : part.state.status === "error" ? "✗" : "…"
  const time = new Date().toTimeString().slice(0, 5)
  const target = subagentToolTarget(part)
  return `${time} ${mark} ${part.tool}${target ? " " + target : ""}`
}

export function start(input: {
  sdk: OpencodeClient
  connection: Connection
  session: ACPSession.Interface
  usage: UsageService.Interface
}) {
  const subscription = new Subscription(input)
  subscription.start()
  return subscription
}

export class Subscription {
  private readonly abort = new AbortController()
  private readonly shellSnapshots = new Map<string, string>()
  private readonly toolStarts = new Set<string>()
  private readonly usagePushes = new Map<string, { messageId: string; used: number; at: number }>()
  private readonly subagentLinks = new Map<string, SubagentLink>()
  private readonly subagentLogs = new Map<string, string[]>()
  private readonly permission: ACPPermission.Handler
  private readonly elicitation: ACPElicitation.Handler
  private started = false

  constructor(
    private readonly input: {
      sdk: OpencodeClient
      connection: Connection
      session: ACPSession.Interface
      usage: UsageService.Interface
    },
  ) {
    const resolveSubagentParent = (sessionId: string): string | undefined =>
      this.subagentLinks.get(sessionId)?.parentSessionId
    this.permission = new ACPPermission.Handler({ ...input, resolveSubagentParent })
    this.elicitation = new ACPElicitation.Handler({ ...input, resolveSubagentParent })
  }

  start() {
    if (this.started) return
    this.started = true
    this.run().catch(() => {
      if (this.abort.signal.aborted) return
    })
  }

  stop() {
    this.abort.abort()
  }

  async handle(event: Event) {
    switch (event.type) {
      case "permission.asked":
        this.permission.handle(event)
        return
      case "question.asked":
        this.elicitation.handle(event)
        return
      case "session.error":
        return this.handleSessionError(event)
      case "message.part.updated":
        return this.handlePartUpdated(event)
      case "message.part.delta":
        return this.handlePartDelta(event)
      case "message.updated":
        return this.handleMessageUpdated(event)
    }
  }

  // A failed turn lives on the assistant message (`message.error`) and is
  // broadcast as `session.error`; ACP has no error session-update variant, so
  // the failure is mirrored into the conversation as an agent chunk. This is
  // the same thing the TUI does by rendering `message.error.data.message`
  // inline at the tail of the turn, and it keeps a failed turn from reaching
  // the client as an empty reply.
  private async handleSessionError(event: EventSessionError) {
    const sessionId = event.properties.sessionID
    const error = event.properties.error
    // Aborted turns are user-initiated, not failures — the TUI skips them too.
    // ContextOverflowError is transient when auto-compaction handles it — the
    // processor sets needsCompaction and continues without writing
    // message.error. Terminal ContextOverflowError (auto-compaction off) is
    // durable on message.info.error and replayed separately.
    if (!sessionId || !error || error.name === "MessageAbortedError" || error.name === "ContextOverflowError") return

    const session = await Effect.runPromise(this.input.session.tryGet(sessionId))
    // Unregistered session: a task subagent. Its failures stay inside the
    // parent's task card rather than surfacing as a top-level turn error.
    if (!session) return

    await this.input.connection.sessionUpdate({
      sessionId: session.id,
      update: sessionErrorChunk(`error-${event.id}`, error),
    })
  }

  // Live context-ring refresh: every completed assistant message (one per
  // provider step) carries its final token counts, so the client's ring can
  // follow a long turn step by step instead of jumping once at turn end.
  // Deduplicated by (message, used) and rate-limited; unregistered sessions
  // are task subagents, whose tokens never feed the parent's ring.
  private async handleMessageUpdated(event: EventMessageUpdated) {
    const info = event.properties.info
    if (info.role !== "assistant") return
    if (!info.time.completed) return
    const session = await Effect.runPromise(this.input.session.tryGet(event.properties.sessionID))
    if (!session) return
    const used = info.tokens.input + info.tokens.cache.read
    if (used <= 0) return
    const prev = this.usagePushes.get(session.id)
    const now = Date.now()
    if (prev && prev.messageId === info.id && prev.used === used) return
    if (prev && now - prev.at < USAGE_PUSH_MIN_INTERVAL_MS) return
    this.usagePushes.set(session.id, { messageId: info.id, used, at: now })
    await Effect.runPromise(
      this.input.usage.sendFromAssistantMessage({
        connection: this.input.connection,
        sessionID: session.id,
        directory: session.cwd,
        message: info,
      }),
    )
  }

  async replayMessage(message: SessionMessageResponse) {
    if (message.info.role !== "assistant" && message.info.role !== "user") return

    const cwd = message.info.role === "assistant" ? message.info.path?.cwd : undefined
    for (const part of message.parts) {
      await this.recordFetchedPart(message.info.sessionID, message, part)
      if (part.type === "tool") {
        await this.handleToolPart(message.info.sessionID, part, cwd ?? process.cwd())
        continue
      }
      if (part.type === "debug-state") {
        await this.input.connection.sessionUpdate({
          sessionId: message.info.sessionID,
          update: debugStateChunk(part),
        })
        continue
      }
      await this.replayContentPart(message, part)
    }

    // A failed turn is durable on the assistant message (`message.error`), but
    // the live session.error mirror is wire-only. Re-emit the same chunk during
    // replay so a reconnected client still sees the failure text instead of an
    // empty turn. Using the assistant message's own id as messageId keeps each
    // failed turn in its own message bubble — ACP clients aggregate chunks by
    // messageId, so a session-scoped id would merge unrelated failures.
    if (
      message.info.role === "assistant" &&
      message.info.error &&
      message.info.error.name !== "MessageAbortedError"
    ) {
      await this.input.connection.sessionUpdate({
        sessionId: message.info.sessionID,
        update: sessionErrorChunk(message.info.id, message.info.error),
      })
    }
  }

  private async replayContentPart(message: SessionMessageResponse, part: Part) {
    if (part.type !== "text" && part.type !== "file" && part.type !== "reasoning") return

    const sessionUpdate =
      part.type === "reasoning"
        ? "agent_thought_chunk"
        : message.info.role === "user"
          ? "user_message_chunk"
          : "agent_message_chunk"

    for (const chunk of partsToContentChunks([part as ReplayPart])) {
      await this.input.connection.sessionUpdate({
        sessionId: message.info.sessionID,
        update: {
          sessionUpdate,
          messageId: message.info.id,
          ...chunk,
        },
      })
    }
  }

  private async run() {
    while (!this.abort.signal.aborted) {
      const events = (await this.input.sdk.global.event({
        signal: this.abort.signal,
      })) as GlobalEventStream

      for await (const event of events.stream) {
        if (this.abort.signal.aborted) return
        if (!event.payload) continue
        await this.handle(event.payload).catch(() => {})
      }
      if (!this.abort.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }

  private async handlePartUpdated(event: EventMessagePartUpdated) {
    const part = event.properties.part
    const sessionId = part.sessionID || event.properties.sessionID
    const session = await Effect.runPromise(this.input.session.tryGet(sessionId))
    if (!session) {
      // Unregistered session: a task subagent. Compress its tool events into
      // rolling progress lines on the parent's task card — silently dropped
      // events are what made Phase 4 a black box.
      await this.forwardSubagentPart(sessionId, part)
      return
    }
    if (part.type === "tool") this.recordSubagentLink(session.id, part)

    await Effect.runPromise(
      this.input.session.recordPartMetadata({
        sessionId: session.id,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
        role: part.type === "reasoning" ? "assistant" : undefined,
        ignored: part.type === "text" ? part.ignored : undefined,
        toolCallId: part.type === "tool" ? part.callID : undefined,
        metadata: "metadata" in part ? part.metadata : undefined,
      }),
    )
    if (part.type === "debug-state") {
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: debugStateChunk(part),
      })
      return
    }
    if (part.type === "tool") {
      await this.handleToolPart(session.id, part, session.cwd)
    }
  }

  // Task tool parts carry the child session id in state.metadata (task.ts
  // stores it in ctx.metadata). Only the parent's events pass through here,
  // so this is the single race-free place to learn the link.
  private recordSubagentLink(parentSessionId: string, part: ToolPart) {
    const metadata = "metadata" in part.state ? (part.state.metadata as { sessionId?: string }) : undefined
    const childSessionId = metadata?.sessionId
    if (!childSessionId || childSessionId === parentSessionId) return
    this.subagentLinks.set(childSessionId, { parentSessionId, toolCallId: part.callID })
  }

  private clearSubagentLink(toolCallId: string) {
    for (const [child, link] of this.subagentLinks) {
      if (link.toolCallId !== toolCallId) continue
      this.subagentLinks.delete(child)
      this.subagentLogs.delete(link.toolCallId)
    }
  }

  private async forwardSubagentPart(sessionId: string, part: Part) {
    if (part.type !== "tool") return
    const link = this.subagentLinks.get(sessionId)
    if (!link) return
    const line = subagentProgressLine(part)
    const lines = this.subagentLogs.get(link.toolCallId) ?? []
    if (lines[lines.length - 1] !== line) lines.push(line)
    while (lines.length > SUBAGENT_LOG_LINES) lines.shift()
    this.subagentLogs.set(link.toolCallId, lines)
    await this.input.connection.sessionUpdate({
      sessionId: link.parentSessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: link.toolCallId,
        status: "in_progress",
        content: [{ type: "content", content: { type: "text", text: lines.join("\n") } }],
      },
    })
  }

  private async handlePartDelta(event: EventMessagePartDelta) {
    const props = event.properties
    const session = await Effect.runPromise(this.input.session.tryGet(props.sessionID))
    if (!session) return

    const known = await Effect.runPromise(
      this.input.session.tryGetPartMetadata({
        sessionId: session.id,
        messageId: props.messageID,
        partId: props.partID,
      }),
    )
    const metadata =
      known?.role && known.partType
        ? known
        : await this.fetchPartMetadata(session.id, session.cwd, props.messageID, props.partID)
    if (metadata?.role !== "assistant") return
    if (metadata.partType === "text" && props.field === "text" && metadata.ignored !== true) {
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: props.messageID,
          content: {
            type: "text",
            text: props.delta,
          },
        },
      })
      return
    }

    if (metadata.partType === "reasoning" && props.field === "text") {
      await this.input.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: props.messageID,
          content: {
            type: "text",
            text: props.delta,
          },
        },
      })
    }
  }

  private async fetchPartMetadata(sessionId: string, cwd: string, messageId: string, partId: string) {
    const message = await this.input.sdk.session
      .message(
        {
          sessionID: sessionId,
          messageID: messageId,
          directory: cwd,
        },
        { throwOnError: true },
      )
      .then((response) => response.data)
      .catch(() => undefined)
    if (!message) return

    const part = message.parts.find((item) => item.id === partId)
    if (!part) return
    return await this.recordFetchedPart(sessionId, message, part)
  }

  private async recordFetchedPart(sessionId: string, message: SessionMessageResponse, part: Part) {
    return await Effect.runPromise(
      this.input.session.recordPartMetadata({
        sessionId,
        messageId: part.messageID,
        partId: part.id,
        partType: part.type,
        role: message.info.role,
        ignored: part.type === "text" ? part.ignored : undefined,
        toolCallId: part.type === "tool" ? part.callID : undefined,
        metadata: "metadata" in part ? part.metadata : undefined,
      }),
    )
  }

  private async handleToolPart(sessionId: string, part: ToolPart, cwd: string) {
    await this.toolStart(sessionId, part, cwd)

    switch (part.state.status) {
      case "pending":
        this.shellSnapshots.delete(part.callID)
        return

      case "running":
        await this.runningTool(sessionId, part, cwd)
        return

      case "completed":
        this.clearTool(part.callID)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...completedToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
              cwd,
            }),
          },
        })
        return

      case "error":
        this.clearTool(part.callID)
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...errorToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
              cwd,
            }),
          },
        })
        return
    }
  }

  private async runningTool(sessionId: string, part: ToolPart, cwd: string) {
    if (part.state.status !== "running") return

    const output = part.tool === "bash" ? shellOutputSnapshot(part.state) : undefined
    if (output !== undefined) {
      if (this.shellSnapshots.get(part.callID) === output) {
        await this.input.connection.sessionUpdate({
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            ...duplicateRunningToolUpdate({
              toolCallId: part.callID,
              toolName: part.tool,
              state: part.state,
              cwd,
            }),
          },
        })
        return
      }
      this.shellSnapshots.set(part.callID, output)
    }

    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        ...runningToolUpdate({
          toolCallId: part.callID,
          toolName: part.tool,
          state: part.state,
          output,
          cwd,
        }),
      },
    })
  }

  private async toolStart(sessionId: string, part: ToolPart, cwd: string) {
    if (this.toolStarts.has(part.callID)) return
    this.toolStarts.add(part.callID)
    await this.input.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        ...pendingToolCall({
          toolCallId: part.callID,
          toolName: part.tool,
          state: part.state,
          cwd,
        }),
      },
    })
  }

  private clearTool(toolCallId: string) {
    this.toolStarts.delete(toolCallId)
    this.shellSnapshots.delete(toolCallId)
    this.clearSubagentLink(toolCallId)
  }
}

export * as ACPEvent from "./event"
