import { describe, expect, test } from "bun:test"
import { createSubagentStore, isActive } from "../../src/feature-plugins/sidebar/subagent-store"
import type { Part, Session, ToolPart } from "@opencode-ai/sdk/v2"

type KVMap = Record<string, unknown>

function fakeKV(initial: KVMap = {}) {
  const data: KVMap = { ...initial }
  return {
    get: (key: string, fallback?: unknown) => (data[key] === undefined ? fallback : data[key]),
    set: (key: string, value: unknown) => {
      data[key] = value
    },
    dump: () => data,
  }
}

function toolPart(id: string, state: ToolPart["state"], tool = "task"): ToolPart {
  return {
    id,
    sessionID: "ses_parent",
    messageID: "msg_1",
    type: "tool",
    callID: `call_${id}`,
    tool,
    state,
  } as ToolPart
}

function apiFixture(input: {
  sessions?: Record<string, Session | undefined>
  messages?: Record<string, unknown[]>
  parts?: Record<string, Part[]>
  todos?: Record<string, { content: string; status: string }[]>
  status?: Record<string, { type: "idle" | "busy" } | undefined>
  abortResult?: () => Promise<unknown>
}) {
  const kv = fakeKV()
  const listeners = new Map<string, (event: unknown) => void>()

  const api = {
    kv,
    event: {
      on(type: string, handler: (event: unknown) => void) {
        listeners.set(type, handler)
        return () => listeners.delete(type)
      },
    },
    state: {
      session: {
        get: (sid: string) => input.sessions?.[sid],
        messages: (sid: string) => (input.messages?.[sid] ?? []) as never,
        status: (sid: string) => input.status?.[sid],
        todo: (sid: string) => input.todos?.[sid] ?? [],
      },
      part: (messageID: string) => input.parts?.[messageID] ?? [],
    },
    client: {
      session: {
        abort: input.abortResult ?? (() => Promise.resolve({ data: undefined })),
      },
    },
  } as never

  return {
    api,
    kv,
    emit: (type: string, properties: Record<string, unknown>) => listeners.get(type)?.({ properties }),
    setData: (key: string, value: unknown) => {
      kv.set(key, value)
    },
  }
}

function childSession(parentID: string, overrides: Partial<Session> = {}): Session {
  return {
    id: "ses_child",
    slug: "child",
    projectID: "proj",
    directory: "/tmp",
    parentID,
    title: "child",
    version: "1",
    time: { created: 0, updated: 0 },
    ...overrides,
  } as Session
}

const runningState = (input: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  ({ status: "running", input, metadata, time: { start: 1000 } }) as ToolPart["state"]

const completedState = (input: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) =>
  ({ status: "completed", input, metadata, output: "", title: "done", time: { start: 1000, end: 2000 } }) as ToolPart["state"]

describe("subagent store", () => {
  test("tool part starts a running entry and session.idle settles it with usage", () => {
    const fx = apiFixture({
      sessions: {
        ses_child: childSession("ses_parent", {
          id: "ses_child",
          agent: "explore",
          cost: 0.05,
        }),
      },
      messages: {
        ses_child: [
          {
            id: "m1",
            sessionID: "ses_child",
            role: "assistant",
            time: { created: 0, completed: 1 },
            parentID: "",
            modelID: "claude-4",
            providerID: "anthropic",
            mode: "primary",
            agent: "explore",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0.05,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
          },
        ],
      },
      status: { ses_child: { type: "idle" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p1", runningState({ description: "scan files", prompt: "scan", subagent_type: "explore" })),
    })
    let entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p1")
    expect(entry?.status).toBe("running")
    expect(entry?.title).toBe("scan files")
    expect(entry?.agent).toBe("explore")

    fx.emit("session.idle", { sessionID: "ses_child" })
    entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p1")
    expect(entry?.status).toBe("done")
    expect(entry?.endedAt).toBeDefined()
    expect(entry?.tokens).toBe(150)
    expect(entry?.cost).toBe(0.05)
    expect(entry?.model).toBe("claude-4")

    store.dispose()
  })

  test("completed background tool with child session stays running until idle", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "build" }) },
      status: { ses_child: { type: "busy" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p2", completedState({ background: true, prompt: "build it" }, { sessionId: "ses_child" })),
    })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("running")

    fx.emit("session.idle", { sessionID: "ses_child" })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("done")
    store.dispose()
  })

  test("poll settles a background entry whose session.idle was never seen", () => {
    // the child already idled before the completed background part arrived, so the idle
    // event is gone — the periodic poll must reconcile against the live session status
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "build" }) },
      status: { ses_child: { type: "idle" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p2", completedState({ background: true, prompt: "build it" }, { sessionId: "ses_child" })),
    })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("running")

    store.pollTokens()
    const entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")
    expect(entry?.status).toBe("done")
    expect(entry?.endedAt).toBeDefined()
    store.dispose()
  })

  test("poll leaves a busy background entry running", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "build" }) },
      status: { ses_child: { type: "busy" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p2", completedState({ background: true, prompt: "build it" }, { sessionId: "ses_child" })),
    })
    store.pollTokens()
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("running")
    store.dispose()
  })

  test("ctrl+B promoted task stays running until its child session idles", () => {
    // promotion completes the tool part with metadata.background — the tool input has no flag
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "build" }) },
      status: { ses_child: { type: "busy" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p2", runningState({ prompt: "build it" }, { sessionId: "ses_child" })),
    })
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p2", completedState({ prompt: "build it" }, { sessionId: "ses_child", background: true })),
    })
    // the part is completed but the child session is still busy — the entry must keep running
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("running")

    store.pollTokens()
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("running")

    fx.emit("session.idle", { sessionID: "ses_child" })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p2")?.status).toBe("done")
    store.dispose()
  })

  test("tool error never spawns an entry, only fails a tracked one", () => {
    const fx = apiFixture({})
    const store = createSubagentStore(fx.api)
    store.init()

    const errorState = { status: "error", input: {}, error: "boom", time: { start: 0, end: 1 } } as ToolPart["state"]
    fx.emit("message.part.updated", { sessionID: "ses_parent", part: toolPart("p3", errorState) })
    expect(store.entriesFor("ses_parent").size).toBe(0)

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p3", runningState({ prompt: "x" })),
    })
    fx.emit("message.part.updated", { sessionID: "ses_parent", part: toolPart("p3", errorState) })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p3")?.status).toBe("error")
    store.dispose()
  })

  test("session.error marks matching entry as error with message", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p4", runningState({ prompt: "x", subagent_type: "explore" })),
    })
    // real SDK payload shape: { name, data: { message } }
    fx.emit("session.error", { sessionID: "ses_child", error: { name: "UnknownError", data: { message: "provider down" } } })
    const entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p4")
    expect(entry?.status).toBe("error")
    expect(entry?.error).toBe("provider down")
    store.dispose()
  })

  test("session.error falls back to the assistant message's structured error", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      messages: {
        ses_child: [
          {
            id: "m1",
            sessionID: "ses_child",
            role: "assistant",
            time: { created: 0, completed: 1 },
            parentID: "",
            modelID: "claude-4",
            providerID: "anthropic",
            mode: "primary",
            agent: "explore",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: { name: "ProviderAuthError", data: { providerID: "anthropic", message: "missing API key" } },
          },
        ],
      },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p4b", runningState({ prompt: "x", subagent_type: "explore" })),
    })
    fx.emit("session.error", { sessionID: "ses_child" })
    const entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p4b")
    expect(entry?.status).toBe("error")
    expect(entry?.error).toBe("missing API key")
    store.dispose()
  })

  test("subtask parts are tracked and settled via agent-name fallback", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: {
        id: "sp1",
        sessionID: "ses_parent",
        messageID: "msg_1",
        type: "subtask",
        prompt: "go explore",
        description: "exploration",
        agent: "explore",
      },
    })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "sub:sp1")?.status).toBe("running")

    // no entry carries the child session id — fallback matches by agent name
    fx.emit("session.idle", { sessionID: "ses_child" })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "sub:sp1")?.status).toBe("done")
    store.dispose()
  })

  test("entries persist to KV and reload on a fresh store", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      status: { ses_child: { type: "idle" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p5", runningState({ prompt: "x" })),
    })
    fx.emit("session.idle", { sessionID: "ses_child" })
    store.dispose()

    const kvData = JSON.parse(String(fx.kv.get("subagent_sidebar.session_data")))
    expect(kvData["ses_parent"].entries).toHaveLength(1)
    expect(kvData["ses_parent"].entries[0].status).toBe("done")

    // fresh store over the same KV restores persisted entries without events
    const fx2 = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
    })
    fx2.kv.set("subagent_sidebar.session_data", fx.kv.get("subagent_sidebar.session_data"))
    const store2 = createSubagentStore(fx2.api)
    store2.init()
    store2.ensureLoaded("ses_parent")
    const entry = [...store2.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p5")
    expect(entry?.status).toBe("done")
    store2.dispose()
  })

  test("child-session view nests its record under the parent in KV", () => {
    const fx = apiFixture({
      sessions: {
        ses_parent: { id: "ses_parent", slug: "p", projectID: "proj", directory: "/tmp", title: "p", version: "1", time: { created: 0, updated: 0 } } as Session,
        ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }),
        ses_grandchild: childSession("ses_child", { id: "ses_grandchild", agent: "explore" }),
      },
      status: { ses_grandchild: { type: "idle" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    // user opens the child session; grandchild subagent lands in the child's record
    store.ensureLoaded("ses_child")
    fx.emit("message.part.updated", {
      sessionID: "ses_child",
      part: toolPart("p6", runningState({ prompt: "x" })),
    })
    fx.emit("session.idle", { sessionID: "ses_grandchild" })
    store.dispose()

    const data = JSON.parse(String(fx.kv.get("subagent_sidebar.session_data")))
    expect(data["ses_parent"].children["ses_child"].entries).toHaveLength(1)
    expect(data["ses_parent"].children["ses_child"].entries[0].status).toBe("done")
  })

  test("clearEntries wipes entries and clearedIds blocks scan rebuild", () => {
    const part = toolPart("p7", completedState({ prompt: "done task" }))
    const fx = apiFixture({
      parts: { msg_1: [part] },
      messages: { ses_parent: [{ id: "msg_1", sessionID: "ses_parent", role: "user", time: { created: 0 } }] },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    store.ensureLoaded("ses_parent")
    expect(store.entriesFor("ses_parent").size).toBe(1)
    expect(store.clearEntries("ses_parent")).toBe(1)
    expect(store.entriesFor("ses_parent").size).toBe(0)

    // a new store over the same KV must not rebuild the cleared entry from parts
    const fx2 = apiFixture({
      parts: { msg_1: [part] },
      messages: { ses_parent: [{ id: "msg_1", sessionID: "ses_parent", role: "user", time: { created: 0 } }] },
    })
    fx2.kv.set("subagent_sidebar.session_data", fx.kv.get("subagent_sidebar.session_data"))
    const store2 = createSubagentStore(fx2.api)
    store2.init()
    store2.ensureLoaded("ses_parent")
    expect(store2.entriesFor("ses_parent").size).toBe(0)
    store2.dispose()
  })

  test("clearEntries cancels a pending debounced persist so cleared entries stay cleared", async () => {
    const fx = apiFixture({})
    const store = createSubagentStore(fx.api)
    store.init()

    // running entries persist on a 200ms debounce — a timer is now pending with the pre-clear map
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p12", runningState({ prompt: "x" })),
    })
    expect(store.clearEntries("ses_parent")).toBe(1)

    // without cancelling the timer, its fire would write the cleared entries back into KV
    await new Promise((resolve) => setTimeout(resolve, 250))
    const data = JSON.parse(String(fx.kv.get("subagent_sidebar.session_data", "{}")))
    expect(data["ses_parent"]?.entries ?? []).toHaveLength(0)
    store.dispose()
  })

  test("grandchild settlement lands in the nested KV record when the child view is closed", () => {
    // ses_child is itself a subagent of ses_parent and was never opened in this process;
    // its own subagent ses_grandchild idling must settle ses_child's nested KV record
    const fx = apiFixture({
      sessions: {
        ses_parent: { id: "ses_parent", slug: "p", projectID: "proj", directory: "/tmp", title: "p", version: "1", time: { created: 0, updated: 0 } } as Session,
        ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }),
        ses_grandchild: childSession("ses_child", { id: "ses_grandchild", agent: "build" }),
      },
    })
    fx.kv.set(
      "subagent_sidebar.session_data",
      JSON.stringify({
        ses_parent: {
          ts: Date.now(),
          scroll: 0,
          expanded: "",
          children: {
            ses_child: {
              ts: Date.now(),
              scroll: 0,
              expanded: "",
              entries: [{ id: "tool:p13", title: "nested", agent: "build", prompt: "x", status: "running", sessionId: "ses_grandchild", startedAt: 1000 }],
            },
          },
        },
      }),
    )
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("session.idle", { sessionID: "ses_grandchild" })

    const data = JSON.parse(String(fx.kv.get("subagent_sidebar.session_data")))
    const entry = data["ses_parent"].children["ses_child"].entries[0]
    expect(entry.status).toBe("done")
    expect(entry.endedAt).toBeDefined()
    store.dispose()
  })

  test("cancel never overwrites an entry that settled during the abort round trip", async () => {
    let releaseAbort: (() => void) | undefined
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      status: { ses_child: { type: "busy" } },
      abortResult: () => new Promise((resolve) => (releaseAbort = () => resolve({ data: undefined }))),
    })
    const store = createSubagentStore(fx.api)
    store.init()
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p14", runningState({ prompt: "x" })),
    })
    const entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p14")!

    const pending = store.cancel({ ...entry, sessionId: "ses_child" }, "ses_parent")
    // the child completes while the abort call is still in flight
    fx.emit("session.idle", { sessionID: "ses_child" })
    releaseAbort!()
    expect(await pending).toBe(true)

    const settled = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p14")
    expect(settled?.status).toBe("done")
    store.dispose()
  })

  test("scan rebuilds entries from message parts and settles stale runners via status", () => {
    const part = toolPart("p8", runningState({ prompt: "never finished", subagent_type: "explore" }, { sessionId: "ses_child" }))
    const fx = apiFixture({
      parts: { msg_1: [part] },
      messages: { ses_parent: [{ id: "msg_1", sessionID: "ses_parent", role: "user", time: { created: 0 } }] },
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      status: { ses_child: { type: "idle" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()
    store.ensureLoaded("ses_parent")
    // part state says running, but the child session is idle — reconcile settles it
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p8")?.status).toBe("done")
    store.dispose()
  })

  test("clearRunning aborts busy entries and counts them", async () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      status: { ses_child: { type: "busy" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p9", runningState({ prompt: "x" }, { sessionId: "ses_child" })),
    })
    expect(await store.clearRunning("ses_parent")).toBe(1)
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p9")?.status).toBe("cancel_requested")

    fx.emit("session.idle", { sessionID: "ses_child" })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p9")?.status).toBe("cancelled")
    expect(await store.clearRunning("ses_parent")).toBe(0)
    store.dispose()
  })

  test("clearRunning settles entries without an abortable session locally", async () => {
    const fx = apiFixture({})
    const store = createSubagentStore(fx.api)
    store.init()
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p9b", runningState({ prompt: "x" })),
    })
    expect(await store.clearRunning("ses_parent")).toBe(1)
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p9b")?.status).toBe("done")
    store.dispose()
  })

  test("cancel requests abort and records the cancelled status after idle", async () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      status: { ses_child: { type: "busy" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p10", runningState({ prompt: "x" }), "task"),
    })
    const entry = [...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p10")!

    const ok = await store.cancel({ ...entry, sessionId: "ses_child" }, "ses_parent")
    expect(ok).toBe(true)
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p10")?.status).toBe("cancel_requested")

    fx.emit("session.idle", { sessionID: "ses_child" })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p10")?.status).toBe("cancelled")
    store.dispose()
  })

  test("re-emitted part events never resurrect a settled entry", () => {
    const fx = apiFixture({
      sessions: { ses_child: childSession("ses_parent", { id: "ses_child", agent: "explore" }) },
      status: { ses_child: { type: "idle" } },
    })
    const store = createSubagentStore(fx.api)
    store.init()

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p11", runningState({ prompt: "x", subagent_type: "explore" })),
    })
    fx.emit("session.idle", { sessionID: "ses_child" })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p11")?.status).toBe("done")

    // stale/re-emitted running-state part after settlement must not flip it back
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p11", runningState({ prompt: "x", subagent_type: "explore" })),
    })
    expect([...store.entriesFor("ses_parent").values()].find((e) => e.id === "tool:p11")?.status).toBe("done")
    store.dispose()
  })

  test("isActive distinguishes active from settled statuses", () => {
    expect(isActive("running")).toBe(true)
    expect(isActive("cancel_requested")).toBe(true)
    expect(isActive("done")).toBe(false)
    expect(isActive("error")).toBe(false)
    expect(isActive("cancelled")).toBe(false)
  })
})
