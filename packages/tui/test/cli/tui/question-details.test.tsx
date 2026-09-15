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

const request = {
  id: "que_test",
  sessionID: "ses_test",
  questions: [
    {
      question: "Delete expired memories?",
      header: "Expiry",
      options: [{ label: "Keep all", description: "Cancel the deletions" }],
      details:
        "**name**: stale-memory\n\n**description**: Skip tool-call narration\n\nDo not explain tool calls.\n\n**metadata**\n- `type: feedback`\n- `sessionId: ses_dream`\n- `modified: 2026-07-05 08:11`",
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

async function mountQuestion(root: string) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

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
                      <DialogProvider>
                        <QuestionPrompt request={request} directory={root} />
                      </DialogProvider>
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

  const app = await testRender(() => <Harness />, { width: 140, height: 30, kittyKeyboard: true })
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
    await until(() => frame().includes("sessionId: ses_dream"), "the rendered metadata line")
    expect(frame()).toContain("Memory details")
    expect(frame()).toContain("Skip tool-call narration")
    expect(frame()).toContain("sessionId: ses_dream")
    // markdown rendering, not the raw source: label, quote, list and code markers are consumed
    expect(frame()).toContain("name: stale-memory")
    expect(frame()).not.toContain("**name**")
    expect(frame()).not.toContain("**description**")
    expect(frame()).not.toContain("**metadata**")
    expect(frame()).not.toContain("`")

    app.mockInput.pressEscape()
    await until(() => !frame().includes("Memory details"), "the dialog to close")
    expect(frame()).toContain("ctrl+o view details")
  } finally {
    app.renderer.destroy()
  }
})
