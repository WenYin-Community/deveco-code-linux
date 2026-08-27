import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Part, SubtaskPart, ToolPart, ToolState } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"

export type SubStatus = "running" | "done" | "error" | "cancel_requested" | "cancelled"

export interface SubEntry {
  id: string
  title: string
  agent: string
  prompt: string
  error?: string
  tokens?: number
  cost?: number
  status: SubStatus
  sessionId?: string
  startedAt: number
  endedAt?: number
  model?: string
  todoTotal?: number
  todoDone?: number
  cancelRequestedAt?: number
  abortAccepted?: boolean
}

interface SessionRecord {
  ts: number
  entries: SubEntry[]
  expanded: string
  clearedIds?: string[]
  children?: Record<string, SessionRecord>
}

const KV_KEY = "subagent_sidebar.session_data"

/** OpenCode built-in tool names that spawn sub-agents or delegate tasks. */
const SUBAGENT_TOOLS = new Set(["task", "delegate", "call_omo_agent"])
const TTL_MS = 30 * 24 * 60 * 60 * 1000
const EMPTY: ReadonlyMap<string, SubEntry> = new Map()

export function isActive(status: SubStatus) {
  return status === "running" || status === "cancel_requested"
}

function settledStatus(entry: SubEntry): SubStatus {
  if (entry.status === "cancel_requested" && entry.abortAccepted) return "cancelled"
  return "done"
}

function errorText(err: unknown): string {
  if (!err) return ""
  if (typeof err === "string") return err
  if (typeof err === "object") {
    // SDK errors (session.error payloads, AssistantMessage.error) are shaped { name, data: { message } }
    const o = err as { message?: unknown; error?: unknown; data?: { message?: unknown } }
    return String(o.message ?? o.error ?? o.data?.message ?? "")
  }
  return ""
}

function childSessionId(state: ToolState): string | undefined {
  if (state.status === "pending") return undefined
  const sid = state.metadata?.session_id ?? state.metadata?.sessionId
  return sid !== undefined ? String(sid) : undefined
}

function isBackground(state: ToolState) {
  if (state.status === "pending") return false
  if (state.input?.run_in_background === true || state.input?.background === true) return true
  // ctrl+B promotion (experimental session background) marks the part metadata, not the tool input
  return state.metadata?.background === true
}

/** Pending tools have not spawned yet; completed background tools keep running until the child session idles. */
function entryStatus(part: ToolPart): SubStatus | undefined {
  const state = part.state
  if (state.status === "pending") return undefined
  if (state.status === "error") return "error"
  if (state.status === "completed" && isBackground(state) && childSessionId(state)) return "running"
  return state.status === "completed" ? "done" : "running"
}

function titleFrom(prompt: string, description?: string) {
  if (description) return description
  const text = prompt.replace(/\n/g, " ").replace(/\s+/g, " ").trim()
  return text.length > 40 ? text.slice(0, 40) + "…" : text
}

export function createSubagentStore(api: TuiPluginApi) {
  const kv = api.kv
  const [maps, setMaps] = createSignal<ReadonlyMap<string, ReadonlyMap<string, SubEntry>>>(new Map(), {
    equals: false,
  })
  const hydrated = new Set<string>()
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false

  const sessionOf = (sid: string) => api.state.session.get(sid)

  const readSessionTokens = (sid: string): number | undefined => {
    if (!sid) return undefined
    const messages = api.state.session.messages(sid) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role !== "assistant" || !(m.tokens.output > 0)) continue
      const total = m.tokens.input + m.tokens.output + m.tokens.reasoning + m.tokens.cache.read + m.tokens.cache.write
      if (total > 0) return total
    }
    return undefined
  }

  const readSessionCost = (sid: string): number | undefined => {
    if (!sid) return undefined
    const cost = sessionOf(sid)?.cost
    if (cost != null && cost > 0) return cost
    let total = 0
    for (const m of api.state.session.messages(sid) ?? []) {
      if (m.role === "assistant") total += m.cost
    }
    return total > 0 ? total : undefined
  }

  const readSessionModel = (sid: string): string | undefined => {
    if (!sid) return undefined
    const messages = api.state.session.messages(sid) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant") return m.modelID
    }
    return undefined
  }

  const readSessionTodo = (sid: string): { total: number; done: number } | undefined => {
    if (!sid) return undefined
    const todos = api.state.session.todo(sid)
    if (!todos.length) return undefined
    return { total: todos.length, done: todos.filter((t) => t.status === "completed" || t.status === "cancelled").length }
  }

  const loadData = (): Record<string, SessionRecord> => {
    try {
      return JSON.parse(String(kv.get(KV_KEY, "{}")))
    } catch {
      return {}
    }
  }

  const resolveParent = (sid: string): { parentSid: string; isChild: boolean } => {
    const parentID = sessionOf(sid)?.parentID
    return parentID ? { parentSid: parentID, isChild: true } : { parentSid: sid, isChild: false }
  }

  /** Single read-modify-write entry point for the KV session record; nests children under their parent. */
  const withRecord = (sid: string, patch: (rec: SessionRecord) => Partial<SessionRecord>) => {
    try {
      const data = loadData()
      const { parentSid, isChild } = resolveParent(sid)
      const now = Date.now()
      if (isChild) {
        const parent = data[parentSid] ?? { ts: now, entries: [], expanded: "", children: {} }
        const children = parent.children ?? {}
        const child = children[sid] ?? { ts: now, entries: [], expanded: "" }
        children[sid] = { ...child, ts: now, ...patch(child) }
        data[parentSid] = { ...parent, ts: now, children }
      } else {
        const rec = data[sid] ?? { ts: now, entries: [], expanded: "", children: {} }
        data[sid] = { ...rec, ts: now, ...patch(rec) }
      }
      kv.set(KV_KEY, JSON.stringify(data))
    } catch {}
  }

  /** Reads a session's KV record, resolving nested child records the same way withRecord writes them. */
  const recordFor = (sid: string): SessionRecord | undefined => {
    const { parentSid, isChild } = resolveParent(sid)
    const rec = loadData()[parentSid]
    return isChild ? rec?.children?.[sid] : rec
  }

  const persistEntries = (sid: string, entries: ReadonlyMap<string, SubEntry>, immediate: boolean) => {
    const write = () => withRecord(sid, () => ({ entries: [...entries.values()] }))
    // per-session debounce so rapid updates to different sessions cannot drop each other
    const timer = persistTimers.get(sid)
    if (timer) clearTimeout(timer)
    if (immediate) {
      persistTimers.delete(sid)
      // settled statuses flush immediately so cross-view/cross-restart state stays consistent
      write()
      return
    }
    persistTimers.set(
      sid,
      setTimeout(() => {
        persistTimers.delete(sid)
        write()
      }, 200),
    )
  }

  const mutateEntries = (sid: string, mutate: (entries: Map<string, SubEntry>) => void, persist = true) => {
    if (disposed) return
    const before = maps().get(sid)
    const next = new Map(before ?? EMPTY)
    mutate(next)
    if (before && next.size === before.size && [...next].every(([id, entry]) => before.get(id) === entry)) return
    if (!before && next.size === 0) return
    const settledNow = [...next.values()].some((entry) => {
      const prev = before?.get(entry.id)
      return prev !== undefined && isActive(prev.status) && !isActive(entry.status)
    })
    if (persist) persistEntries(sid, next, settledNow)
    setMaps((prev) => {
      const mapsNext = new Map(prev)
      if (next.size) mapsNext.set(sid, next)
      else mapsNext.delete(sid)
      return mapsNext
    })
  }

  const upsert = (sid: string, partial: Omit<SubEntry, "startedAt" | "endedAt"> & { startedAt?: number }) => {
    mutateEntries(sid, (entries) => {
      const existing = entries.get(partial.id)
      const ended = partial.status === "done" || partial.status === "error" || partial.status === "cancelled"
      entries.set(partial.id, {
        ...(existing ?? { startedAt: Date.now() }),
        ...partial,
        startedAt: existing?.startedAt ?? partial.startedAt ?? Date.now(),
        endedAt: ended ? (existing?.endedAt ?? Date.now()) : undefined,
      })
    })
  }

  /** Re-emitted part events must not resurrect entries that already settled. */
  const isSettled = (sid: string, id: string) => {
    const entry = maps().get(sid)?.get(id)
    return entry !== undefined && !isActive(entry.status)
  }

  const toolEntry = (part: ToolPart, status: SubStatus, existing?: SubEntry): SubEntry => {
    const state = part.state
    const input = state.status === "pending" ? {} : state.input
    return {
      ...(existing ?? { startedAt: Date.now() }),
      id: `tool:${part.id}`,
      title: titleFrom(String(input.prompt ?? ""), input.description !== undefined ? String(input.description) : undefined),
      agent: String(input.subagent_type ?? part.tool),
      prompt: String(input.prompt ?? ""),
      sessionId: existing?.sessionId ?? childSessionId(state),
      status,
      startedAt: existing?.startedAt ?? (state.status === "pending" ? Date.now() : state.time.start),
      endedAt: status === "done" ? (existing?.endedAt ?? Date.now()) : undefined,
    }
  }

  const handlePartUpdated = (sessionID: string, part: Part) => {
    if (part.type === "subtask") {
      const id = `sub:${part.id}`
      // re-emitted part events must not resurrect a settled entry
      if (isSettled(sessionID, id)) return
      upsert(sessionID, {
        id,
        title: titleFrom(part.prompt, part.description),
        agent: part.agent,
        prompt: part.prompt,
        status: "running",
        model: part.model?.modelID,
      })
      return
    }
    if (part.type !== "tool" || !SUBAGENT_TOOLS.has(part.tool)) return

    const id = `tool:${part.id}`
    const state = part.state
    if (state.status === "error") {
      // the tool call itself failed — only fail an already-tracked entry, never spawn one
      mutateEntries(sessionID, (entries) => {
        const existing = entries.get(id)
        if (existing && isActive(existing.status)) {
          entries.set(id, { ...existing, status: "error", endedAt: Date.now(), error: state.error })
        }
      })
      return
    }
    const status = entryStatus(part)
    if (!status) return
    mutateEntries(sessionID, (entries) => {
      if (isSettled(sessionID, id)) return
      entries.set(id, toolEntry(part, status, entries.get(id)))
    })
  }

  const applySettlement = (
    entries: Map<string, SubEntry>,
    match: (entry: SubEntry) => boolean,
    sid: string,
    status: "done" | "error",
    info: SettlementInfo,
  ): boolean => {
    for (const [id, entry] of entries) {
      if (!isActive(entry.status) || !match(entry)) continue
      entries.set(id, {
        ...entry,
        status: status === "error" ? "error" : settledStatus(entry),
        endedAt: Date.now(),
        tokens: entry.tokens ?? info.tokens,
        cost: entry.cost ?? info.cost,
        model: entry.model ?? info.model,
        todoTotal: entry.todoTotal ?? info.todo?.total,
        todoDone: entry.todoDone ?? info.todo?.done,
        sessionId: entry.sessionId ?? sid,
        error: info.error || entry.error,
      })
      return true
    }
    return false
  }

  interface SettlementInfo {
    tokens?: number
    cost?: number
    model?: string
    todo?: { total: number; done: number }
    error?: string
  }

  const normalizeAgent = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "")

  /** Fallback when no entry carries the child session ID: agent-name overlap, then oldest unlinked runner. */
  const applySettlementFallback = (
    entries: Map<string, SubEntry>,
    sid: string,
    status: "done" | "error",
    agent: string | undefined,
    info: SettlementInfo,
  ): boolean => {
    if (agent) {
      const target = normalizeAgent(agent)
      let best: SubEntry | undefined
      for (const entry of entries.values()) {
        if (!isActive(entry.status)) continue
        const name = normalizeAgent(entry.agent)
        if (!name || !target || (!name.includes(target) && !target.includes(name))) continue
        if (!best || entry.startedAt < best.startedAt) best = entry
      }
      if (best && applySettlement(entries, (entry) => entry.id === best!.id, sid, status, info)) return true
    }
    let unlinked: SubEntry | undefined
    for (const entry of entries.values()) {
      if (!isActive(entry.status) || entry.sessionId) continue
      if (!unlinked || entry.startedAt < unlinked.startedAt) unlinked = entry
    }
    return unlinked ? applySettlement(entries, (entry) => entry.id === unlinked!.id, sid, status, info) : false
  }

  const lastAssistantError = (sid: string): string | undefined => {
    const messages = api.state.session.messages(sid) ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === "assistant" && m.error) return errorText(m.error)
    }
    return undefined
  }

  const handleSessionEnd = (sid: string, status: "done" | "error", eventError?: unknown) => {
    if (!sid) return
    const session = sessionOf(sid)
    const parentSid = session?.parentID
    if (!parentSid) return

    const info: SettlementInfo = {
      tokens: readSessionTokens(sid),
      cost: readSessionCost(sid),
      model: readSessionModel(sid),
      todo: readSessionTodo(sid),
      error: status === "error" ? errorText(eventError) || lastAssistantError(sid) : undefined,
    }
    const agent = session?.agent

    const settle = (entries: Map<string, SubEntry>) =>
      applySettlement(entries, (entry) => entry.sessionId === sid, sid, status, info) ||
      applySettlementFallback(entries, sid, status, agent, info)

    if (maps().has(parentSid)) {
      mutateEntries(parentSid, settle)
      return
    }
    // parent session not opened yet in this process — settle straight into the KV record
    try {
      const rec = recordFor(parentSid)
      if (!rec?.entries.length) return
      const entries = new Map(rec.entries.map((e) => [e.id, e]))
      if (!settle(entries)) return
      withRecord(parentSid, () => ({ entries: [...entries.values()] }))
    } catch {}
  }

  /** Rebuild entries from the session's message parts (covers events missed before the session was opened). */
  const scanSession = (sid: string, entries: Map<string, SubEntry>, clearedIds: Set<string>) => {
    for (const msg of api.state.session.messages(sid) ?? []) {
      for (const partRaw of api.state.part(msg.id) ?? []) {
        const part = partRaw as Part
        if (part.type !== "tool" || !SUBAGENT_TOOLS.has(part.tool)) continue
        if (!part.id || clearedIds.has(`tool:${part.id}`)) continue

        const id = `tool:${part.id}`
        const existing = entries.get(id)
        if (existing && !isActive(existing.status)) continue

        const status = entryStatus(part)
        if (!status) {
          // pending part with no status signal yet — settle via message tokens or age heuristics
          if (!existing) continue
          const hasTokens = msg.role === "assistant" && (msg.tokens.input > 0 || msg.tokens.output > 0)
          if (hasTokens || Date.now() - existing.startedAt > 30 * 60 * 1000) {
            entries.set(id, { ...existing, status: "done", endedAt: Date.now() })
          }
          continue
        }
        if (part.state.status === "error") {
          if (existing && isActive(existing.status)) {
            entries.set(id, { ...existing, status: "error", endedAt: Date.now(), error: part.state.error })
          }
          continue
        }
        entries.set(id, toolEntry(part, status, existing))
      }
    }
  }

  const isDescendant = (childId: string, rootId: string): boolean => {
    const visited = new Set<string>()
    let current = sessionOf(childId)
    while (current?.parentID) {
      if (visited.has(current.id)) return false
      visited.add(current.id)
      if (current.parentID === rootId) return true
      current = sessionOf(current.parentID)
    }
    return false
  }

  /** Settle active entries whose child session is idle (covers missed session.idle events). */
  const reconcileRunning = (sid: string) => {
    mutateEntries(sid, (entries) => {
      for (const [id, entry] of entries) {
        if (!isActive(entry.status) || !entry.sessionId) continue
        if (!isDescendant(entry.sessionId, sid)) continue
        if (api.state.session.status(entry.sessionId)?.type === "busy") continue
        entries.set(id, {
          ...entry,
          status: entry.status === "cancel_requested" && entry.abortAccepted ? "cancelled" : "done",
          endedAt: Date.now(),
          tokens: readSessionTokens(entry.sessionId) ?? entry.tokens,
          cost: readSessionCost(entry.sessionId) ?? entry.cost,
        })
      }
    })
  }

  const ensureLoaded = (sid: string) => {
    if (hydrated.has(sid)) return
    hydrated.add(sid)
    const { parentSid, isChild } = resolveParent(sid)
    const rec = loadData()[parentSid]
    const own = isChild ? rec?.children?.[sid] : rec
    const entries = new Map((own?.entries ?? []).map((e) => [e.id, e]))
    try {
      scanSession(sid, entries, new Set(own?.clearedIds ?? []))
    } catch {}
    if (entries.size) {
      setMaps((prev) => new Map(prev).set(sid, entries))
      persistEntries(sid, entries, false)
    }
    reconcileRunning(sid)
  }

  /** Periodic refresh: reconcile stale runners, live tokens for active entries, backfill for settled ones. */
  const pollTokens = () => {
    if (disposed) return
    // background entries survive a missed session.idle (e.g. the child idled before its
    // completed part event arrived) — settle them against the live session status here
    for (const sid of [...maps().keys()]) reconcileRunning(sid)
    for (const [sid, entries] of maps()) {
      let changed = false
      const next = new Map(entries)
      for (const [id, entry] of next) {
        if (!entry.sessionId || !isDescendant(entry.sessionId, sid)) continue
        // settled entries only need a backfill while token data is still missing (sync lag)
        if (!isActive(entry.status) && entry.tokens !== undefined) continue
        const patch: Partial<SubEntry> = {}
        const tokens = readSessionTokens(entry.sessionId)
        if (tokens !== undefined && tokens !== entry.tokens) patch.tokens = tokens
        const todo = readSessionTodo(entry.sessionId)
        if (todo && (todo.total !== entry.todoTotal || todo.done !== entry.todoDone)) {
          patch.todoTotal = todo.total
          patch.todoDone = todo.done
        }
        const model = readSessionModel(entry.sessionId)
        if (model && !entry.model) patch.model = model
        const cost = readSessionCost(entry.sessionId)
        if (cost !== undefined && cost !== entry.cost) patch.cost = cost
        if (Object.keys(patch).length) {
          next.set(id, { ...entry, ...patch })
          changed = true
        }
      }
      if (changed) {
        setMaps((prev) => new Map(prev).set(sid, next))
        persistEntries(sid, next, false)
      }
    }
  }

  const cancel = async (entry: SubEntry, currentSid: string) => {
    if (!entry.sessionId) return false
    const child = sessionOf(entry.sessionId)
    if (!child?.parentID || !isDescendant(entry.sessionId, currentSid)) return false
    if (api.state.session.status(entry.sessionId)?.type !== "busy") {
      mutateEntries(currentSid, (entries) => {
        const fresh = entries.get(entry.id)
        if (fresh && isActive(fresh.status)) entries.set(entry.id, { ...fresh, status: "done", endedAt: Date.now() })
      })
      return true
    }
    upsert(currentSid, { ...entry, status: "cancel_requested", cancelRequestedAt: Date.now(), abortAccepted: false })
    const result = await api.client.session.abort({ sessionID: entry.sessionId }).catch((err: unknown) => err)
    const failed = result instanceof Error || (typeof result === "object" && result !== null && "error" in result && result.error)
    // the child may have settled (e.g. session.idle) while the abort round trip was in flight — never overwrite that
    const fresh = maps().get(currentSid)?.get(entry.id)
    if (!fresh || !isActive(fresh.status)) return !failed
    if (failed) {
      upsert(currentSid, { ...fresh, status: "error", error: errorText(result) })
      return false
    }
    upsert(currentSid, { ...fresh, status: "cancel_requested", abortAccepted: true })
    return true
  }

  const clearRunning = async (sid: string): Promise<number> => {
    const active = [...(maps().get(sid) ?? EMPTY).values()].filter((entry) => isActive(entry.status))
    await Promise.all(
      active.map(async (entry) => {
        if (await cancel(entry, sid)) return
        // no abortable child session (missing sessionId or not a descendant) — leave the running list locally
        mutateEntries(sid, (entries) => {
          const fresh = entries.get(entry.id)
          if (fresh && isActive(fresh.status)) entries.set(entry.id, { ...fresh, status: "done", endedAt: Date.now() })
        })
      }),
    )
    return active.length
  }

  const clearEntries = (sid: string): number => {
    const ids = [...(maps().get(sid) ?? EMPTY).keys()]
    hydrated.add(sid)
    // a pending debounced persist would write the pre-clear entries back to KV
    const timer = persistTimers.get(sid)
    if (timer) {
      clearTimeout(timer)
      persistTimers.delete(sid)
    }
    setMaps((prev) => {
      const next = new Map(prev)
      next.delete(sid)
      return next
    })
    withRecord(sid, (rec) => ({
      entries: [],
      expanded: "",
      clearedIds: [...new Set([...(rec.clearedIds ?? []), ...ids])],
    }))
    return ids.length
  }

  const cleanupExpired = () => {
    try {
      const data = loadData()
      const cutoff = Date.now() - TTL_MS
      const kept = Object.fromEntries(Object.entries(data).filter(([, rec]) => rec.ts >= cutoff))
      if (Object.keys(kept).length !== Object.keys(data).length) kv.set(KV_KEY, JSON.stringify(kept))
    } catch {}
  }

  const unsubscribers: (() => void)[] = []
  const init = () => {
    cleanupExpired()
    unsubscribers.push(
      api.event.on("message.part.updated", (e) => {
        handlePartUpdated(e.properties.sessionID, e.properties.part)
      }),
    )
    unsubscribers.push(
      api.event.on("session.idle", (e) => {
        handleSessionEnd(e.properties.sessionID, "done")
      }),
    )
    unsubscribers.push(
      api.event.on("session.error", (e) => {
        handleSessionEnd(e.properties.sessionID ?? "", "error", e.properties.error)
      }),
    )
  }

  const dispose = () => {
    disposed = true
    for (const timer of persistTimers.values()) clearTimeout(timer)
    persistTimers.clear()
    for (const off of unsubscribers) off()
  }

  return {
    entriesFor: (sid: string): ReadonlyMap<string, SubEntry> => maps().get(sid) ?? EMPTY,
    ensureLoaded,
    pollTokens,
    cancel,
    clearRunning,
    clearEntries,
    saveExpanded: (sid: string, expanded: string) => withRecord(sid, () => ({ expanded })),
    saveOpen: (open: boolean) => kv.set("subagent_sidebar.open", open),
    loadExpanded: (sid: string) => recordFor(sid)?.expanded ?? "",
    loadOpen: () => Boolean(kv.get("subagent_sidebar.open", true)),
    init,
    dispose,
  }
}

export type SubagentStore = ReturnType<typeof createSubagentStore>
