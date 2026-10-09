/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"

const directory = "/tmp/opencode/packages/opencode"

function sessionInfo(id: string, parentID?: string) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    title: id,
    parentID,
    time: { created: 0, updated: 0 },
    version: "1.15.13",
    directory,
  }
}

function assistantMessage(sessionID: string, id: string) {
  return {
    id,
    sessionID,
    role: "assistant" as const,
    agent: "build",
    modelID: "model",
    providerID: "test",
    mode: "build",
    parentID: `msg_user_${id}`,
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, completed: 2 },
  }
}

function userMessage(sessionID: string, id: string) {
  return {
    id,
    sessionID,
    role: "user" as const,
    agent: "build",
    model: { providerID: "test", modelID: "model" },
    time: { created: 1 },
  }
}

function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

function messageUpdated(info: ReturnType<typeof assistantMessage> | ReturnType<typeof userMessage>) {
  return global({
    id: `evt_${info.id}`,
    type: "message.updated",
    properties: { sessionID: info.sessionID, info },
  })
}

function textPart(sessionID: string, messageID: string, id: string, text: string) {
  return global({
    id: `evt_${id}`,
    type: "message.part.updated",
    properties: {
      sessionID,
      time: 2,
      part: { id, sessionID, messageID, type: "text", text },
    },
  })
}

test("evictOthers drops idle sessions but keeps the kept tree and working sessions", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")

  let messageRequests = 0
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/session")
      return json([
        sessionInfo("ses_child", "ses_keep"),
        sessionInfo("ses_idle"),
        sessionInfo("ses_keep"),
        sessionInfo("ses_working"),
      ])
    if (url.pathname === "/session/ses_idle") return json(sessionInfo("ses_idle"))
    if (url.pathname === "/session/ses_idle/message") {
      messageRequests += 1
      return json([
        {
          info: assistantMessage("ses_idle", "msg_idle"),
          parts: [{ id: "prt_idle", sessionID: "ses_idle", messageID: "msg_idle", type: "text", text: "content" }],
        },
      ])
    }
    if (url.pathname === "/session/ses_idle/todo" || url.pathname === "/session/ses_idle/diff") return json([])
    return undefined
  }, tmp.path)

  try {
    await sync.session.sync("ses_idle")
    await wait(() => sync.data.message["ses_idle"]?.length === 1)
    expect(sync.data.part["msg_idle"]?.length).toBe(1)
    expect(messageRequests).toBe(1)

    emit(messageUpdated(assistantMessage("ses_child", "msg_child")))
    emit(messageUpdated(userMessage("ses_working", "msg_working")))
    await wait(() => sync.data.message["ses_child"]?.length === 1 && sync.data.message["ses_working"]?.length === 1)

    sync.session.evictOthers("ses_keep")

    // idle session payload is gone, kept tree and working session survive
    expect(sync.data.message["ses_idle"]).toBeUndefined()
    expect(sync.data.part["msg_idle"]).toBeUndefined()
    expect(sync.data.message["ses_child"]?.length).toBe(1)
    expect(sync.data.message["ses_working"]?.length).toBe(1)
    // session list info is never evicted
    expect(sync.data.session.map((session) => session.id)).toContain("ses_idle")

    // eviction clears the full-sync marker, so revisiting refetches
    await sync.session.sync("ses_idle")
    await wait(() => sync.data.message["ses_idle"]?.length === 1)
    expect(messageRequests).toBe(2)
    expect(sync.data.part["msg_idle"]?.length).toBe(1)
  } finally {
    app.renderer.destroy()
  }
})

test("message.removed clears the parts of the removed message", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount(undefined, tmp.path)

  try {
    emit(messageUpdated(assistantMessage("ses_removed", "msg_removed")))
    emit(textPart("ses_removed", "msg_removed", "prt_removed", "content"))
    await wait(() => sync.data.part["msg_removed"]?.length === 1)

    emit(
      global({
        id: "evt_msg_removed",
        type: "message.removed",
        properties: { sessionID: "ses_removed", messageID: "msg_removed" },
      }),
    )
    await wait(() => sync.data.part["msg_removed"] === undefined)
    expect(sync.data.message["ses_removed"]?.length).toBe(0)

    // a removal for a session without stored messages must not crash the subscriber
    emit(
      global({
        id: "evt_msg_removed_unknown",
        type: "message.removed",
        properties: { sessionID: "ses_unknown", messageID: "msg_unknown" },
      }),
    )
    emit(messageUpdated(assistantMessage("ses_removed", "msg_after")))
    await wait(() => sync.data.message["ses_removed"]?.length === 1)
  } finally {
    app.renderer.destroy()
  }
})

test("session.deleted evicts the session payload data", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const { app, emit, sync } = await mount((url) => {
    if (url.pathname === "/session") return json([sessionInfo("ses_deleted")])
    return undefined
  }, tmp.path)

  try {
    emit(messageUpdated(assistantMessage("ses_deleted", "msg_deleted")))
    emit(textPart("ses_deleted", "msg_deleted", "prt_deleted", "content"))
    await wait(() => sync.data.part["msg_deleted"]?.length === 1)

    emit(
      global({
        id: "evt_session_deleted",
        type: "session.deleted",
        properties: { sessionID: "ses_deleted", info: sessionInfo("ses_deleted") },
      }),
    )
    await wait(() => sync.data.message["ses_deleted"] === undefined)
    expect(sync.data.part["msg_deleted"]).toBeUndefined()
    expect(sync.data.session.map((session) => session.id)).not.toContain("ses_deleted")
  } finally {
    app.renderer.destroy()
  }
})
