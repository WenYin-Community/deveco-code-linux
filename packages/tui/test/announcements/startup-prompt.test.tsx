import { Global } from "@opencode-ai/core/global"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, jest, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { createEffect, createSignal } from "solid-js"
import type { Announcement } from "../../src/announcements/model"
import { announcementCachePath } from "../../src/announcements/store"
import { useAnnouncements } from "../../src/context/announcements"
import { registerDevEcoExtensions, resetDevEcoExtensions } from "../../src/deveco-extensions"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const announcement = {
  title: "ANNOUNCEMENT_DIALOG",
  content: "announcement body",
  publishTime: 1,
  read: false,
}
const nextAnnouncement = {
  ...announcement,
  title: "Next announcement",
  content: "next body",
  publishTime: 2,
}

async function startApp(
  state: string,
  options: { cached?: Announcement[]; blocked?: boolean; signed?: boolean; crash?: boolean } = {},
) {
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ language: "en" }))
  await Bun.write(announcementCachePath(state), JSON.stringify(options.cached ?? []))
  const [agreement, setAgreement] = createSignal(
    options.signed === false ? undefined : { accepted: true, upload: { state: "local" } },
  )
  const [blocking, setBlocking] = createSignal(options.blocked ?? false)
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  const { CrashDialog, StartupHomeBody } = await import("./startup-dialogs")

  const ready = Promise.withResolvers<void>()
  let api: TuiPluginApi | undefined
  let announcements: ReturnType<typeof useAnnouncements> | undefined
  let onArrival: (() => void) | undefined
  const calls = createFetch((url) => {
    if (url.pathname === "/skill")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
  })
  const events = createEventSource()
  const renderer = jest.spyOn(core, "createCliRenderer").mockResolvedValue(setup.renderer)
  const cloud = mockAnnouncementRequest()

  resetDevEcoExtensions()
  registerDevEcoExtensions({
    collectDialog: CrashDialog,
    consumeCrashInfo: () => options.crash === true,
    agreementGate: (props) => {
      const context = useAnnouncements()
      announcements = context
      createEffect(() => context.setAgreement(agreement()))
      createEffect(() => {
        if (context.items().length === 0 || !onArrival) return
        const callback = onArrival
        onArrival = undefined
        // Run after the prompt starts its lazy import and before the import resolves.
        queueMicrotask(callback)
      })
      return props.children
    },
    homeBody: (props) => StartupHomeBody({ sync: props.sync, blocking }),
  })

  const { run } = await import("../../src/app")
  const task = Effect.runPromise(
    run({
      url: "http://test",
      directory,
      config: createTuiResolvedConfig({ plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      args: {},
      pluginHost: {
        async start(next) {
          api = next.api
          ready.resolve()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(Global.layerWith({ state }))),
  )

  const finish = async () => {
    try {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task
    } finally {
      renderer.mockRestore()
      cloud.restore()
      resetDevEcoExtensions()
    }
  }
  try {
    await Promise.race([ready.promise, task.then(() => Promise.reject(new Error("TUI exited during startup")))])
    await setup.flush()
  } catch (error) {
    await finish().catch(() => undefined)
    throw error
  }

  return {
    setup,
    api: () => api,
    setAgreement,
    setBlocking,
    items: () => announcements?.items() ?? [],
    requests: cloud.requests,
    reply(items: Announcement[], onItems?: () => void) {
      onArrival = onItems
      cloud.reply(items)
    },
    waitFor: (predicate: () => boolean) => waitFor(() => (predicate() ? true : undefined), "announcement state"),
    waitForFrame: (text: string) =>
      waitFor(async () => {
        await setup.flush()
        const frame = setup.captureCharFrame()
        return frame.includes(text) ? frame : undefined
      }, text),
    finish,
  }
}

function mockAnnouncementRequest() {
  const response = Promise.withResolvers<Response>()
  let requests = 0
  const originalFetch = globalThis.fetch
  const fetch = jest.spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        if (url.pathname !== "/sse/codeGenie/announcement") return originalFetch(input, init)
        requests++
        return response.promise
      },
      { preconnect: originalFetch.preconnect },
    ),
  )
  return {
    requests: () => requests,
    reply: (items: Announcement[]) => response.resolve(json({ code: 200, body: items })),
    restore() {
      response.resolve(new Response(null, { status: 503 }))
      fetch.mockRestore()
    },
  }
}

// Disk I/O can complete after the renderer becomes idle.
async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, description: string) {
  const deadline = Date.now() + 3000
  do {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(10)
  } while (Date.now() < deadline)
  throw new Error(`Timed out waiting for ${description}`)
}

test("startup crash modal defers announcement prompt until it closes", async () => {
  await using tmp = await tmpdir()
  const app = await startApp(tmp.path, { crash: true })
  try {
    await app.waitForFrame("SYNC_DONE")
    await app.waitForFrame("CRASH_DIALOG")
    app.reply([announcement])
    await app.waitFor(() => app.items().length === 1)
    await app.setup.flush()
    const frame = app.setup.captureCharFrame()
    expect(frame).toContain("CRASH_DIALOG")
    expect(frame).not.toContain("ANNOUNCEMENT_DIALOG")

    app.api()?.ui.dialog.clear()
    await app.waitForFrame("announcement body")
    expect(app.setup.captureCharFrame()).not.toContain("CRASH_DIALOG")
  } finally {
    await app.finish()
  }
})

test("new modal arriving during announcement import is not overwritten", async () => {
  await using tmp = await tmpdir()
  const app = await startApp(tmp.path)
  try {
    await app.waitForFrame("SYNC_DONE")
    app.reply([announcement], () => app.api()?.keymap.dispatchCommand("model.list"))
    await app.waitForFrame("Select model")
    await import("../../src/component/dialog-announcements")
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")
    expect(app.items().some((item) => item.read)).toBe(false)
    app.api()?.ui.dialog.clear()
    await app.waitForFrame("announcement body")
  } finally {
    await app.finish()
  }
})

test("a new announcement arriving while details are open does not reopen the dialog after close", async () => {
  await using tmp = await tmpdir()
  const app = await startApp(tmp.path, { cached: [announcement] })
  try {
    await app.waitForFrame("announcement body")

    app.reply([nextAnnouncement])
    await app.waitFor(() => app.items().some((item) => item.title === nextAnnouncement.title))
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).toContain("announcement body")
    expect(app.items().find((item) => item.title === nextAnnouncement.title)?.read).toBe(false)
    app.api()?.ui.dialog.clear()
    await app.setup.flush()
    await Bun.sleep(50)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).not.toContain("next body")
    expect(app.items().find((item) => item.title === nextAnnouncement.title)?.read).toBe(false)
  } finally {
    await app.finish()
  }
})

test("the only unread announcement is queried after signing and opens after inline startup releases", async () => {
  await using tmp = await tmpdir()
  const seen = { ...announcement, title: "Seen announcement", content: "seen body", read: true }
  const app = await startApp(tmp.path, { blocked: true, cached: [seen], signed: false })
  try {
    await app.waitForFrame("SYNC_DONE")
    app.api()?.keymap.dispatchCommand("announcements.open")
    await app.setup.flush()
    expect(app.requests()).toBe(0)
    expect(app.items()).toEqual([])
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")

    app.setAgreement({ accepted: true, upload: { state: "review_required" } })
    await app.setup.flush()
    expect(app.requests()).toBe(0)
    app.setAgreement({ accepted: true, upload: { state: "pending" } })
    await app.waitFor(() => app.requests() === 1)
    app.reply([announcement])
    await app.waitFor(() => app.items().length === 2)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")
    expect(app.items().find((item) => item.title === announcement.title)?.read).toBe(false)

    app.setBlocking(false)
    await app.waitForFrame("announcement body")
    await app.waitFor(() => app.items().find((item) => item.title === announcement.title)?.read === true)
    app.setup.mockInput.pressArrow("left")
    await app.waitForFrame("Seen announcement")
    expect(app.setup.captureCharFrame()).not.toContain("announcement body")

    app.setAgreement({ accepted: true, upload: { state: "review_required" } })
    await app.waitForFrame("SYNC_DONE")
    expect(app.setup.captureCharFrame()).not.toContain("Seen announcement")
    expect(app.items()).toEqual([])
    expect(app.requests()).toBe(1)
  } finally {
    await app.finish()
  }
})

test("multiple unread announcements open the announcement list", async () => {
  await using tmp = await tmpdir()
  const another = { ...announcement, title: "Second unread" }
  const app = await startApp(tmp.path)
  try {
    await app.waitForFrame("SYNC_DONE")
    app.reply([announcement, another])
    await app.waitForFrame("Second unread")
    expect(app.setup.captureCharFrame()).not.toContain("announcement body")
    expect(app.items().some((item) => item.read)).toBe(false)
  } finally {
    await app.finish()
  }
})

test("announcement command opens the list and allows automatic reminders after closing", async () => {
  await using tmp = await tmpdir()
  const app = await startApp(tmp.path, { cached: [announcement], blocked: true })
  try {
    await app.waitForFrame("SYNC_DONE")
    await app.waitFor(() => app.items().length === 1)
    const command = app.api()?.keymap.getCommands().find((entry) => entry.name === "announcements.open")
    expect(command?.title).toBe("View DevEco Code announcements")
    app.api()?.keymap.dispatchCommand("announcements.open")
    const list = await app.waitForFrame("ANNOUNCEMENT_DIALOG")
    expect(list).not.toContain("announcement body")
    expect(app.items().some((item) => item.read)).toBe(false)

    app.setup.mockInput.pressEnter()
    await app.waitForFrame("announcement body")

    app.api()?.keymap.dispatchCommand("announcements.open")
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).toContain("announcement body")

    app.setup.mockInput.pressArrow("left")
    await app.waitForFrame("○ ANNOUNCEMENT_DIALOG")
    app.api()?.ui.dialog.clear()
    app.setBlocking(false)
    app.reply([nextAnnouncement])
    await app.waitForFrame("next body")
    await app.waitFor(() => app.items().find((item) => item.title === nextAnnouncement.title)?.read === true)
  } finally {
    await app.finish()
  }
})
