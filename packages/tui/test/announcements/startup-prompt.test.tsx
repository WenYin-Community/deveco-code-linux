import { Global } from "@opencode-ai/core/global"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, mock, test } from "bun:test"
import { Effect } from "effect"
import { createEffect, createSignal } from "solid-js"
import { announcementKey, type Announcement } from "../../src/announcements/model"
import type { AnnouncementState } from "../../src/announcements/service"
import { useAnnouncements } from "../../src/context/announcements"
import { registerDevEcoExtensions, resetDevEcoExtensions } from "../../src/deveco-extensions"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

const realService = { ...(await import("../../src/announcements/service")) }

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
let promptVersion = 0
let refreshes = 0
let crashDetected = false
let items: Announcement[] = []
let publishState: ((state: AnnouncementState) => void) | undefined

function publishPrompt() {
  publishState?.({ items, promptVersion })
}

function setPromptVersion(version: number) {
  promptVersion = version
  publishPrompt()
}

mock.module("../../src/announcements/service", () => ({
  ...realService,
  createAnnouncementService: (input: { onChange: (state: AnnouncementState) => void }) => ({
    start: async () => {
      publishState = input.onChange
      publishPrompt()
    },
    refresh: async () => {
      refreshes++
    },
    markRead: async (key: string) => {
      items = items.map((item) => (announcementKey(item) === key ? { ...item, read: true } : item))
      publishPrompt()
    },
    stop: () => {
      if (publishState === input.onChange) publishState = undefined
    },
    ackPrompt: (version: number) => {
      if (promptVersion === version) setPromptVersion(0)
    },
  }),
}))

async function startApp(options: { items?: Announcement[]; blocked?: boolean; signed?: boolean } = {}) {
  items = options.items ?? [announcement]
  refreshes = 0
  const [agreement, setAgreement] = createSignal(
    options.signed === false ? undefined : { accepted: true, upload: { state: "local" } },
  )
  const [blocking, setBlocking] = createSignal(options.blocked ?? false)
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const { CrashDialog, StartupHomeBody } = await import("./startup-dialogs")

  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let api: TuiPluginApi | undefined
  const calls = createFetch((url) => {
    if (url.pathname === "/skill")
      return json({ location: { directory, project: { id: "proj_test", directory } }, data: [] })
  })
  const events = createEventSource()

  resetDevEcoExtensions()
  registerDevEcoExtensions({
    collectDialog: CrashDialog,
    consumeCrashInfo: () => crashDetected,
    agreementGate: (props) => {
      const announcements = useAnnouncements()
      createEffect(() => announcements.setAgreement(agreement()))
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
          started()
        },
        async dispose() {},
      },
    }).pipe(Effect.provide(Global.defaultLayer)),
  )

  await ready
  await setup.flush()

  return {
    setup,
    api: () => api,
    setAgreement,
    setBlocking,
    finish: async () => {
      process.emit("SIGHUP")
      await task
    },
  }
}

test("startup crash modal defers announcement prompt until it closes", async () => {
  setPromptVersion(0)
  crashDetected = true
  const app = await startApp()
  try {
    setPromptVersion(1)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")

    await app.setup.waitForFrame((frame) => frame.includes("SYNC_DONE"))
    await app.setup.flush()
    await Bun.sleep(50)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).toContain("CRASH_DIALOG")

    app.api()?.ui.dialog.clear()
    await app.setup.waitForFrame((frame) => frame.includes("ANNOUNCEMENT_DIALOG"))
    expect(app.setup.captureCharFrame()).not.toContain("CRASH_DIALOG")
  } finally {
    await app.finish()
  }
})

test("new modal arriving during announcement import is not overwritten", async () => {
  setPromptVersion(0)
  crashDetected = false
  const app = await startApp()
  try {
    await app.setup.waitForFrame((frame) => frame.includes("SYNC_DONE"))
    setPromptVersion(1)
    app.api()?.keymap.dispatchCommand("model.list")
    await app.setup.waitForFrame((frame) => frame.includes("Select model"))
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")
    expect(items.some((item) => item.read)).toBe(false)
    app.api()?.ui.dialog.clear()
    await app.setup.waitForFrame((frame) => frame.includes("announcement body"))
  } finally {
    await app.finish()
  }
})

test("a new announcement arriving while details are open does not reopen the dialog after close", async () => {
  setPromptVersion(0)
  crashDetected = false
  const app = await startApp()
  try {
    await app.setup.waitForFrame((frame) => frame.includes("SYNC_DONE"))
    setPromptVersion(1)
    await app.setup.waitForFrame((frame) => frame.includes("announcement body"))

    items = [nextAnnouncement, ...items]
    setPromptVersion(2)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).toContain("announcement body")
    expect(items.find((item) => item.title === nextAnnouncement.title)?.read).toBe(false)
    app.api()?.ui.dialog.clear()
    await app.setup.flush()
    await Bun.sleep(50)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).not.toContain("next body")
    expect(items.find((item) => item.title === nextAnnouncement.title)?.read).toBe(false)
  } finally {
    await app.finish()
  }
})

test("the only unread announcement is queried after signing and opens after inline startup releases", async () => {
  setPromptVersion(0)
  crashDetected = false
  const seen = { ...announcement, title: "Seen announcement", content: "seen body", read: true }
  const app = await startApp({ blocked: true, items: [seen, announcement], signed: false })
  try {
    await app.setup.waitForFrame((frame) => frame.includes("SYNC_DONE"))
    setPromptVersion(1)
    app.api()?.keymap.dispatchCommand("announcements.open")
    await app.setup.flush()
    expect(refreshes).toBe(0)
    expect(publishState).toBeUndefined()
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")

    app.setAgreement({ accepted: true, upload: { state: "review_required" } })
    await app.setup.flush()
    expect(refreshes).toBe(0)
    app.setAgreement({ accepted: true, upload: { state: "pending" } })
    await app.setup.waitFor(() => refreshes === 1)
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).not.toContain("ANNOUNCEMENT_DIALOG")
    expect(items.find((item) => item.title === announcement.title)?.read).toBe(false)

    app.setBlocking(false)
    await app.setup.waitForFrame((frame) => frame.includes("announcement body"))
    expect(items.find((item) => item.title === announcement.title)?.read).toBe(true)
    app.setup.mockInput.pressArrow("left")
    await app.setup.waitForFrame((frame) => frame.includes("Seen announcement"))
    expect(app.setup.captureCharFrame()).not.toContain("announcement body")

    app.setAgreement({ accepted: true, upload: { state: "review_required" } })
    await app.setup.waitForFrame((frame) => !frame.includes("Seen announcement"))
    expect(publishState).toBeUndefined()
    expect(refreshes).toBe(1)
  } finally {
    await app.finish()
  }
})

test("multiple unread announcements open the announcement list", async () => {
  setPromptVersion(0)
  crashDetected = false
  const another = { ...announcement, title: "Second unread" }
  const app = await startApp({ items: [announcement, another] })
  try {
    await app.setup.waitForFrame((frame) => frame.includes("SYNC_DONE"))
    setPromptVersion(1)
    await app.setup.waitForFrame((frame) => frame.includes("Second unread"))
    expect(app.setup.captureCharFrame()).not.toContain("announcement body")
    expect(items.some((item) => item.read)).toBe(false)
  } finally {
    await app.finish()
  }
})

test("announcement command opens the list and allows automatic reminders after closing", async () => {
  setPromptVersion(0)
  crashDetected = false
  const app = await startApp()
  try {
    await app.setup.waitForFrame((frame) => frame.includes("SYNC_DONE"))
    const command = app.api()?.keymap.getCommands().find((entry) => entry.name === "announcements.open")
    expect(command?.title).toBe("View DevEco Code announcements")
    app.api()?.keymap.dispatchCommand("announcements.open")
    const list = await app.setup.waitForFrame((frame) => frame.includes("ANNOUNCEMENT_DIALOG"))
    expect(list).not.toContain("announcement body")
    expect(items.some((item) => item.read)).toBe(false)

    app.setup.mockInput.pressEnter()
    await app.setup.waitForFrame((frame) => frame.includes("announcement body"))

    app.api()?.keymap.dispatchCommand("announcements.open")
    await app.setup.flush()
    expect(app.setup.captureCharFrame()).toContain("announcement body")

    app.setup.mockInput.pressArrow("left")
    await app.setup.waitForFrame((frame) => frame.includes("○ ANNOUNCEMENT_DIALOG"))
    app.api()?.ui.dialog.clear()
    items = [nextAnnouncement, ...items]
    setPromptVersion(1)
    await app.setup.waitForFrame((frame) => frame.includes("next body"))
    expect(items.find((item) => item.title === nextAnnouncement.title)?.read).toBe(true)
  } finally {
    await app.finish()
  }
})
