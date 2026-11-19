/** @jsxImportSource @opentui/solid */
import { Renderable, RGBA, TextAttributes, TextRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, jest, test } from "bun:test"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { AnnouncementBrowser } from "../../src/announcements/browser"
import { announcementKey } from "../../src/announcements/model"
import { announcementCachePath, loadAnnouncementCache } from "../../src/announcements/store"
import { DialogAnnouncements } from "../../src/component/dialog-announcements"
import { TuiConfigProvider } from "../../src/config"
import { AnnouncementsProvider, useAnnouncements } from "../../src/context/announcements"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { I18nProvider } from "../../src/i18n"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../src/keymap"
import { DialogProvider, useDialog } from "../../src/ui/dialog"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const first = { title: "First title", content: "first body", publishTime: 2 }
const markdownLink = "https://example.invalid/markdown"
const second = {
  title: "Second title",
  content:
    "## Markdown heading\n\n**Formatted Markdown**\n\n" +
    `> 中文 [Markdown quote ${"details ".repeat(16)}documentation](${markdownLink})`,
  publishTime: 1,
}
const updated = { ...first, content: "updated body" }
const htmlLink = "https://example.invalid/html?channel=$preview"
const third = {
  title: "Third title",
  content: "<p><strong>Formatted announcement</strong></p>" + `<ol><li><a href="${htmlLink}">First step</a></li></ol>`,
  publishTime: 4,
}

async function mount(root: string, width: number) {
  const state = path.join(root, "state")
  await Bun.write(path.join(state, "kv.json"), JSON.stringify({ language: "en" }))
  const config = createTuiResolvedConfig()

  function OpenAnnouncements() {
    const dialog = useDialog()
    const announcements = useAnnouncements()
    onMount(() => {
      announcements.setAgreement({ accepted: true, upload: { state: "local" } })
      dialog.replace(() => <DialogAnnouncements replace={dialog.replace} />)
    })
    return null
  }

  const app = await testRender(
    () => {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      onCleanup(registerOpencodeKeymap(keymap, renderer, config))
      return (
        <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <I18nProvider>
                  <ThemeProvider mode="dark">
                    <ToastProvider>
                      <AnnouncementsProvider>
                        <DialogProvider>
                          <OpenAnnouncements />
                        </DialogProvider>
                      </AnnouncementsProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </I18nProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </TestTuiContexts>
      )
    },
    { width, height: 36, kittyKeyboard: true },
  )

  return {
    ...app,
    read: async () =>
      (await loadAnnouncementCache(announcementCachePath(state)))
        .filter((item) => item.read)
        .map(announcementKey),
    async frameWith(text: string, ready = () => true) {
      const end = Date.now() + 2000
      do {
        await app.renderOnce()
        const frame = app.captureCharFrame()
        if (frame.includes(text) && ready()) return frame
        await Bun.sleep(10)
      } while (Date.now() < end)
      throw new Error(`Expected ${text} in frame:\n${app.captureCharFrame()}`)
    },
  }
}

test.each([70, 120])(
  "opens a separate detail and marks only viewed announcements as read at %i columns",
  async (width) => {
    await using tmp = await tmpdir()
    let items = [first, second]
    let failing = false
    let requests = 0
    const request = jest.spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => {
        requests++
        if (failing) return new Response(null, { status: 500 })
        return Response.json({ code: "200", body: items })
      }, { preconnect: globalThis.fetch.preconnect }),
    )
    let poll: (() => void) | undefined
    const setTimeout = globalThis.setTimeout
    const timer = jest.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const handle = setTimeout(handler, delay, ...args)
      if (typeof delay === "number" && delay >= 30_000) {
        poll = () => {
          poll = undefined
          clearTimeout(handle)
          handler(...args)
        }
      }
      return handle
    }) as typeof setTimeout)
    const app = await mount(tmp.path, width)
    const open = jest.spyOn(AnnouncementBrowser, "open").mockResolvedValue(true)
    const textPosition = (frame: string, text: string) => {
      const lines = frame.split("\n")
      const y = lines.findIndex((line) => line.includes(text))
      return { x: Bun.stringWidth(lines[y].slice(0, lines[y].indexOf(text))), y }
    }
    const clickText = async (frame: string, text: string) => {
      const cell = textPosition(frame, text)
      await app.mockMouse.click(cell.x, cell.y)
    }
    try {
      const list = await app.frameWith("2 unread", () => poll !== undefined)
      expect(list).toContain("● First title")
      expect(list).toContain("● Second title")
      expect(list).not.toContain("first body")
      expect(list).not.toContain("Refresh")
      app.mockInput.pressArrow("down")
      await app.renderOnce()
      expect(await app.read()).toEqual([])

      await app.mockInput.pressKey("HOME")
      app.mockInput.pressEnter()
      const detail = await app.frameWith("first body")
      expect(detail).not.toContain("Second title")
      expect(detail).not.toContain("Mark as read")
      expect(detail).not.toContain("Refresh")
      app.mockInput.pressArrow("left")
      expect(await app.frameWith("1 unread")).toContain("○ First title")
      expect(await app.read()).toEqual([announcementKey(first)])

      await app.mockInput.pressKey("HOME")
      app.mockInput.pressEnter()
      await app.frameWith("first body")
      app.mockInput.pressKey("r")
      await app.renderOnce()
      expect(requests).toBe(1)

      failing = true
      poll?.()
      const cached = await app.frameWith("first body", () => poll !== undefined && requests === 2)
      expect(cached).not.toContain("failed")

      failing = false
      items = [updated, third]
      poll?.()
      expect(await app.frameWith("first body", () => poll !== undefined && requests === 3)).not.toContain("updated body")
      app.mockInput.pressArrow("left")
      const back = await app.frameWith("2 unread")
      expect(back).toContain("○ First title")
      expect(back).toContain("● Second title")
      expect(back).toContain("● Third title")
      expect(await app.read()).toEqual([announcementKey(first)])
      await app.mockInput.pressKey("HOME")
      app.mockInput.pressEnter()
      const formatted = await app.frameWith("1. First step")
      expect(formatted).toContain("Formatted announcement")
      expect(formatted).not.toContain("<strong>")
      const link = textPosition(formatted, "First step")
      const text = Renderable.renderablesByNumber.get(app.renderer.hitTest(link.x, link.y))
      const style =
        text instanceof TextRenderable
          ? text.textNode.gatherWithInheritedStyle().find((chunk) => chunk.text === "First step")
          : undefined
      expect(style?.fg?.equals(RGBA.fromHex("#60a5fa"))).toBe(true)
      expect((style?.attributes ?? 0) & TextAttributes.UNDERLINE).toBe(TextAttributes.UNDERLINE)
      await clickText(formatted, "Formatted announcement")
      expect(open).not.toHaveBeenCalled()
      await clickText(formatted, "First step")
      expect(open.mock.calls).toEqual([[htmlLink]])
      app.mockInput.pressArrow("left")
      await app.frameWith("● Second title")
      await app.mockInput.pressKey("END")
      app.mockInput.pressEnter()
      const markdown = await app.frameWith("│ 中文 Markdown quote")
      expect(markdown).toContain("Formatted Markdown")
      expect(markdown).not.toContain("## Markdown")
      expect(markdown).not.toContain("**Formatted Markdown**")
      await clickText(markdown, "Markdown quote")
      await clickText(markdown, "documentation")
      expect(open.mock.calls).toEqual([[htmlLink], [markdownLink], [markdownLink]])
    } finally {
      app.renderer.destroy()
      open.mockRestore()
      timer.mockRestore()
      request.mockRestore()
    }
  },
)
