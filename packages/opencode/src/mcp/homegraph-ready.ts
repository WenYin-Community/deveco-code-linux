/**
 * Probe whether product HomeGraph MCP is usable for prompt routing.
 * Lives outside homegraph.ts to avoid a cycle with MCP.Service (index → homegraph).
 */
import { Effect, Option } from "effect"
import { MCP } from "@/mcp"
import {
  getHomegraphInjectSource,
  HOMEGRAPH_MCP_NAME,
  type HomegraphInjectSource,
} from "./homegraph"

export type HomegraphReadyInfo = {
  readonly ready: boolean
  readonly source?: HomegraphInjectSource
}

/** Fast-map phase exposes project first; explore may arrive after full index — that is OK. */
export const READY_TOOL = `${HOMEGRAPH_MCP_NAME}_project`

type StatusLike = { status: string; error?: string } | undefined

/**
 * Pure ready decision (unit-tested). Ready only when connected and exposing
 * homegraph_project — missing explore alone is not an error.
 */
export function evaluateHomegraphReady(
  st: StatusLike,
  toolKeys: Iterable<string>,
  source?: HomegraphInjectSource,
): HomegraphReadyInfo {
  if (!st) {
    return { ready: false, source }
  }
  if (st.status === "disabled") {
    return { ready: false, source }
  }
  if (st.status !== "connected") {
    return { ready: false, source }
  }
  const tools = toolKeys instanceof Set ? toolKeys : new Set(toolKeys)
  if (!tools.has(READY_TOOL)) {
    return { ready: false, source }
  }
  return { ready: true, source }
}

/**
 * Ready when connected and exposing homegraph_project (fast build usable).
 * Missing explore alone is not an error. Expected negatives stay quiet.
 */
export const probeHomegraphReady: Effect.Effect<HomegraphReadyInfo> = Effect.gen(function* () {
  const source = getHomegraphInjectSource()
  const mcp = yield* Effect.serviceOption(MCP.Service)
  if (Option.isNone(mcp)) {
    // No MCP layer in this Effect context — not an unexpected HomeGraph failure.
    return { ready: false, source }
  }
  const statuses = yield* mcp.value.status()
  const st = statuses[HOMEGRAPH_MCP_NAME]
  if (!st) {
    return evaluateHomegraphReady(undefined, [], source)
  }
  if (st.status === "disabled") {
    return evaluateHomegraphReady(st, [], source)
  }
  if (st.status !== "connected") {
    yield* Effect.logWarning("homegraph ready: not connected", {
      status: st.status,
      error: "error" in st ? st.error : undefined,
    })
    return evaluateHomegraphReady(st, [], source)
  }
  const tools = yield* mcp.value.tools()
  const info = evaluateHomegraphReady(st, Object.keys(tools), source)
  if (!info.ready) {
    yield* Effect.logWarning("homegraph ready: connected but no homegraph_project")
  }
  return info
}).pipe(
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("homegraph ready: probe failed", {
        error: String(cause),
      })
      return { ready: false, source: getHomegraphInjectSource() } satisfies HomegraphReadyInfo
    }),
  ),
)

/** @deprecated prefer probeHomegraphReady for source-aware routing */
export const isHomegraphReady = probeHomegraphReady.pipe(Effect.map((info) => info.ready))
