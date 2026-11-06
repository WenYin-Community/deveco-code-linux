/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { eventSource } from "../../fixture/tui-sdk"
import { ClipboardProvider, type ClipboardService } from "../../../src/context/clipboard"

const request = {
  id: "que_test",
  sessionID: "ses_test",
  questions: [
    {
      question: "Delete expired memories?",
      header: "Expiry",
      options: [{ label: "Keep all", description: "Cancel the deletions" }],
      details:
        "## 1. Memory: stale-memory\n\n~~description~~  Skip tool-call narration  \n~~type~~         feedback  \n~~created~~      2026-07-01 08:00  \n~~updated~~      2026-07-05 08:11\n\nDo not explain tool calls.\n\n~~/tmp/memory/stale_memory.md~~",
    },
  ],
} as unknown as QuestionRequest

async function until(check: () => boolean, describe: string, timeout = 2000) {
  const start = Date.now()
  for (;;) {
    if (check()) return
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${describe}`)
    await Bun.sleep(10)
  }
}

async function loadQuestionProviders() {
  const [
    { DialogProvider },
    { I18nProvider },
    { KVProvider },
    { SDKProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { QuestionPrompt },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/i18n"),
    import("../../../src/context/kv"),
    import("../../../src/context/sdk"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/routes/session/question"),
    import("../../../src/keymap"),
  ])

  return { DialogProvider, I18nProvider, KVProvider, SDKProvider, ThemeProvider, TuiConfigProvider, ToastProvider, QuestionPrompt, OpencodeKeymapProvider, registerOpencodeKeymap }
}

async function mountQuestion(root: string, clipboard?: ClipboardService, details?: string, height = 30) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const { DialogProvider, I18nProvider, KVProvider, SDKProvider, ThemeProvider, TuiConfigProvider, ToastProvider, QuestionPrompt, OpencodeKeymapProvider, registerOpencodeKeymap } = await loadQuestionProviders()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider
                      url="http://test"
                      directory={root}
                      events={eventSource()}
                      fetch={(async () => new Response("{}", { headers: { "content-type": "application/json" } })) as unknown as typeof fetch}
                    >
                      <ClipboardProvider value={clipboard}>
                        <DialogProvider>
                          <QuestionPrompt request={details ? { ...request, questions: [{ ...request.questions[0]!, details }] } : request} directory={root} />
                        </DialogProvider>
                      </ClipboardProvider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </I18nProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 140, height, kittyKeyboard: true })
  return { app, frame: () => app.captureCharFrame() }
}

test("question popup opens memory details in a dialog and esc returns", async () => {
  await using tmp = await tmpdir()
  const { app, frame } = await mountQuestion(tmp.path)
  try {
    await until(() => frame().includes("ctrl+o view details"), "the ctrl+o details hint")
    expect(frame()).not.toContain("stale-memory")

    app.mockInput.pressKey("o", { ctrl: true })
    // markdown rendering is async: wait for the last block of the document
    await until(() => frame().includes("stale_memory.md"), "the rendered file path")
    expect(frame()).toContain("Memory details")
    // the /memory detail layout: heading, aligned frontmatter rows, body, file path
    expect(frame()).toContain("Memory: stale-memory")
    expect(frame()).toContain("Skip tool-call narration")
    expect(frame()).toContain("description  Skip tool-call narration")
    expect(frame()).toContain("type         feedback")
    expect(frame()).toContain("created      2026-07-01 08:00")
    // markdown rendering, not the raw source: heading, strikethrough and code markers are consumed
    expect(frame()).not.toContain("~~")

    app.mockInput.pressEscape()
    await until(() => !frame().includes("Memory details"), "the dialog to close")
    expect(frame()).toContain("ctrl+o view details")
  } finally {
    app.renderer.destroy()
  }
})

test("drag-selecting details text copies it to the clipboard on release", async () => {
  await using tmp = await tmpdir()
  const writes: string[] = []
  const clipboard: ClipboardService = {
    write: (text) => {
      writes.push(text)
      return Promise.resolve()
    },
  }
  const { app, frame } = await mountQuestion(tmp.path, clipboard)
  try {
    await until(() => frame().includes("ctrl+o view details"), "the ctrl+o details hint")
    app.mockInput.pressKey("o", { ctrl: true })
    await until(() => frame().includes("stale_memory.md"), "the rendered file path")

    // The shared Dialog panel stops mouse-up propagation to prevent click-outside-close,
    // which would otherwise swallow the provider-level copy-on-select. The detail content box
    // copies the active selection on release before that cut can happen.
    const lines = frame().split("\n")
    const y = lines.findIndex((line) => line.includes("Skip tool-call narration"))
    const x = lines[y]!.indexOf("Skip tool-call")
    await app.mockMouse.drag(x, y, x + 12, y)

    await until(() => writes.length > 0, "the clipboard write")
    expect(writes[0]).toContain("Skip tool")
  } finally {
    app.renderer.destroy()
  }
})

test("multiple expiry files show numbered headings and no thematic-break line", async () => {
  await using tmp = await tmpdir()
  const multi =
    "## 1. Memory: stale-memory\n\n~~description~~  Skip tool-call narration  \n\nDo not explain tool calls.\n\n~~/tmp/memory/stale_memory.md~~\n\n<!--memory-section-->\n\n## 2. Memory: build-slow\n\n~~description~~  Skip tool-call narration  \n\nDo not explain tool calls.\n\n~~/tmp/memory/build_slow.md~~"
  const { app, frame } = await mountQuestion(tmp.path, undefined, multi, 48)
  try {
    await until(() => frame().includes("ctrl+o view details"), "the ctrl+o details hint")
    app.mockInput.pressKey("o", { ctrl: true })
    await until(() => frame().includes("build_slow.md"), "the second file's path")
    // numbered headings mark each file boundary
    expect(frame()).toContain("1. Memory: stale-memory")
    expect(frame()).toContain("2. Memory: build-slow")
    // each file renders in its own framed block (full border), not a single rule line
    expect(frame()).toContain("┌")
    expect(frame()).toContain("└")
    // the split sentinel is consumed, never shown raw
    expect(frame()).not.toContain("memory-section")
  } finally {
    app.renderer.destroy()
  }
})
