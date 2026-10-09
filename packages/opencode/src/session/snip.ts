import { Effect, Layer, Context, Schema } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionID, MessageID, PartID } from "./schema"
import { Session } from "./session"
import { Token } from "@/util/token"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { turns, type Turn } from "./compaction"
import { deriveShortId } from "./snip-shared"

/**
 * History Snip Compact — a lightweight context-compression layer.
 *
 * When conversation history grows, completed turns outside the tail-protection
 * window have their Read/Grep/Glob tool *results* replaced (in the model-facing
 * projection) by a generic placeholder, preserving user queries and assistant
 * final text. Unlike summary-based Compaction, Snip is deterministic, calls no
 * LLM, and is reversible. See spec/history-snip-compact/.
 *
 * Shared constants/deriveShortId live in `snip-shared.ts` (a leaf module) so
 * that both this engine and the projection in `message-v2.ts` can use them
 * without forming a circular import (this module imports `turns` from
 * compaction, which imports message-v2).
 */

/** Only read-only retrieval tools are snippable; write/exec tools are never snipped. */
export const SNIPPABLE_TOOLS = new Set(["read", "grep", "glob"])

export const DEFAULT_TAIL_MESSAGES = 15
export const DEFAULT_THRESHOLD_TOKENS = 10_000

export const Event = {
  Snipped: EventV2.define({
    type: "session.snipped",
    schema: {
      sessionID: SessionID,
      executed: Schema.Boolean,
      snippedCount: Schema.Number,
      replacedCount: Schema.Number,
      tokensFreed: Schema.Number,
      snippedTurnIds: Schema.Array(Schema.String),
    },
  }),
}

export type SnipResult = {
  executed: boolean
  snippedCount: number
  replacedCount: number
  tokensFreed: number
  snippedTurnIds: string[]
}

export interface Interface {
  readonly shouldSnip: (input: { messages: SessionV1.WithParts[] }) => Effect.Effect<boolean>
  readonly execute: (input: { sessionID: SessionID; force?: boolean }) => Effect.Effect<SnipResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSnip") {}

export const use = serviceUse(Service)

/**
 * Walk messages backward and accumulate a token estimate since the last
 * boundary (a snip boundary user message or a compaction summary assistant).
 * Returns true when the accumulation strictly exceeds the configured threshold.
 * Pure over the messages array; reads config for the threshold and the auto flag.
 *
 * Exported for pure-function unit testing (the Service wraps this in Effect).
 */
export function shouldSnipImpl(messages: SessionV1.WithParts[], cfg: ConfigV1.Info) {
  if (cfg.compaction?.snip?.auto === false) return false
  const threshold = cfg.compaction?.snip?.threshold_tokens ?? DEFAULT_THRESHOLD_TOKENS
  let accum = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    // Reset accumulation at the most recent boundary: either a snip-boundary
    // user message or a finished compaction summary assistant message.
    if (msg.info.role === "user" && msg.parts.some((part) => part.type === "snip")) break
    if (
      msg.info.role === "assistant" &&
      msg.info.summary &&
      msg.info.finish &&
      !msg.info.error
    )
      break
    accum += Token.estimate(JSON.stringify(msg))
  }
  return accum > threshold
}

type EligiblePart = {
  part: SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted }
  turnId: string
}

/**
 * True when the tool part is a completed Read/Grep/Glob result that has not yet
 * been snipped or pruned. Error/pending states are preserved by definition
 * (only `completed` reaches here).
 */
function isSnippablePart(part: SessionV1.Part): part is SessionV1.ToolPart & { state: SessionV1.ToolStateCompleted } {
  if (part.type !== "tool") return false
  if (!SNIPPABLE_TOOLS.has(part.tool)) return false
  if (part.state.status !== "completed") return false
  // Already-processed (snip or prune) — skip.
  if (part.state.time.snipped || part.state.time.compacted) return false
  return true
}

/** Collect eligible parts from the assistant messages within a single turn. */
function eligiblePartsForTurn(
  messages: SessionV1.WithParts[],
  turn: Turn,
  turnId: string,
): EligiblePart[] {
  return messages
    .slice(turn.start, turn.end)
    .filter((msg) => msg.info.role === "assistant")
    .flatMap((msg) => msg.parts)
    .filter(isSnippablePart)
    .map((part) => ({ part, turnId }))
}

/**
 * Scan non-protected turns for completed Read/Grep/Glob tool parts whose result
 * is long enough to be worth snipping and not already snipped/pruned. Pure over
 * the messages array. Protected turns (last N user messages) are skipped.
 */
export function collectEligible(
  messages: SessionV1.WithParts[],
  allTurns: Turn[],
  tailMessages: number,
): EligiblePart[] {
  const userMessageIds = messages
    .filter(
      (m) =>
        m.info.role === "user" &&
        !m.parts.some((part) => part.type === "compaction" || part.type === "snip"),
    )
    .map((m) => m.info.id)
  const protectedIds = new Set(tailMessages > 0 ? userMessageIds.slice(-tailMessages) : [])

  return allTurns
    .filter((turn) => !protectedIds.has(turn.id))
    .flatMap((turn) => eligiblePartsForTurn(messages, turn, deriveShortId(turn.id)))
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const session = yield* Session.Service
    const events = yield* EventV2Bridge.Service

    const shouldSnip = Effect.fn("SessionSnip.shouldSnip")(function* (input: {
      messages: SessionV1.WithParts[]
    }) {
      const cfg = yield* config.get()
      const result = shouldSnipImpl(input.messages, cfg)
      // Diagnostic: log accum vs threshold for debugging auto-trigger
      const threshold = cfg.compaction?.snip?.threshold_tokens ?? DEFAULT_THRESHOLD_TOKENS
      let accum = 0
      let breakReason = "none"
      for (let i = input.messages.length - 1; i >= 0; i--) {
        const msg = input.messages[i]
        if (msg.info.role === "user" && msg.parts.some((part) => part.type === "snip")) {
          breakReason = "snip-boundary"
          break
        }
        if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish && !msg.info.error) {
          breakReason = "compaction-summary"
          break
        }
        accum += Token.estimate(JSON.stringify(msg))
      }
      yield* Effect.logInfo("snip shouldSnip", { result, accum, threshold, breakReason, messages: input.messages.length })
      return result
    })

    const execute = Effect.fn("SessionSnip.execute")(function* (input: {
      sessionID: SessionID
      force?: boolean
    }) {
      const cfg = yield* config.get()
      const tailMessages = cfg.compaction?.snip?.tail_messages ?? DEFAULT_TAIL_MESSAGES

      const messages = yield* session
        .messages({ sessionID: input.sessionID })
        .pipe(Effect.orDie)
      const allTurns = turns(messages)
      const eligible = collectEligible(messages, allTurns, tailMessages)

      // Diagnostic: log why eligible might be empty
      const userMsgCount = messages.filter((m) => m.info.role === "user" && !m.parts.some((p) => p.type === "compaction" || p.type === "snip")).length
      const protectedCount = Math.min(tailMessages, userMsgCount)
      const unprotectedTurns = allTurns.length - protectedCount
      let skippedSnipped = 0
      let skippedStatus = 0
      let skippedTool = 0
      for (const turn of allTurns) {
        if (protectedCount > 0 && allTurns.indexOf(turn) >= allTurns.length - protectedCount) continue
        for (let i = turn.start; i < turn.end; i++) {
          const msg = messages[i]
          if (!msg || msg.info.role !== "assistant") continue
          for (const part of msg.parts) {
            if (part.type !== "tool") continue
            const state = part.state as { status: string; output?: string; time?: { snipped?: number; compacted?: number } }
            if (state.time?.snipped || state.time?.compacted) { skippedSnipped++; continue }
            if (state.status !== "completed") { skippedStatus++; continue }
            if (!SNIPPABLE_TOOLS.has(part.tool)) { skippedTool++; continue }
          }
        }
      }
      yield* Effect.logInfo("snip execute diagnostics", {
        force: !!input.force,
        messages: messages.length,
        turns: allTurns.length,
        userMsgCount,
        protectedCount,
        unprotectedTurns,
        eligible: eligible.length,
        skippedSnipped,
        skippedStatus,
        skippedTool,
      })

      if (eligible.length === 0) {
        yield* Effect.logInfo("snip no-op", { "session.id": input.sessionID })
        return {
          executed: false,
          snippedCount: 0,
          replacedCount: 0,
          tokensFreed: 0,
          snippedTurnIds: [],
        } satisfies SnipResult
      }

      // Group eligible parts by turn to compute per-turn snip ids.
      const snippedTurnIdSet = new Set<string>()
      let replacedCount = 0
      let tokensFreed = 0
      for (const item of eligible) {
        item.part.state.time.snipped = Date.now()
        tokensFreed += Token.estimate(item.part.state.output)
        replacedCount++
        snippedTurnIdSet.add(item.turnId)
        yield* session.updatePart(item.part)
      }
      const snippedTurnIds = Array.from(snippedTurnIdSet)
      const snippedCount = snippedTurnIds.length

      // Insert the snip boundary as a standalone user message carrying a
      // SnipPart. It carries no text, so projection drops it (invisible to the
      // model) while remaining queryable for UI rendering and as the
      // accumulation-reset boundary for future auto-snips.
      const lastUser = messages.findLast(
        (m): m is SessionV1.WithParts & { info: SessionV1.User } =>
          m.info.role === "user" &&
          !m.parts.some((part) => part.type === "compaction" || part.type === "snip"),
      )
      if (!lastUser) {
        yield* Effect.logWarning("snip: no real user message to derive boundary metadata", {
          "session.id": input.sessionID,
        })
        return {
          executed: false,
          snippedCount: 0,
          replacedCount: 0,
          tokensFreed: 0,
          snippedTurnIds: [],
        } satisfies SnipResult
      }
      const boundaryMsg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: input.sessionID,
        agent: lastUser.info.agent,
        model: lastUser.info.model,
        time: { created: Date.now() },
      })
      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: boundaryMsg.id,
        sessionID: boundaryMsg.sessionID,
        type: "snip",
        snippedCount,
        replacedCount,
        tokensFreed,
        snippedTurnIds,
        auto: !input.force,
      })

      yield* Effect.logInfo("snip executed", {
        "session.id": input.sessionID,
        snippedCount,
        replacedCount,
        tokensFreed,
        force: !!input.force,
      })

      const result = {
        executed: true,
        snippedCount,
        replacedCount,
        tokensFreed,
        snippedTurnIds,
      } satisfies SnipResult

      yield* events.publish(Event.Snipped, { ...result, sessionID: input.sessionID })

      return result
    })

    return Service.of({ shouldSnip, execute })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(Session.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(EventV2Bridge.defaultLayer),
  ),
)

export const node = LayerNode.make(layer, [Session.node, Config.node, EventV2Bridge.node])

export * as SessionSnip from "./snip"
