/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import path from "node:path"
import { createSignal, onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { formatGoalHelp } from "../../../src/prompt/goal"

async function wait(fn: () => boolean) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > 2000) throw new Error("timed out waiting for alert content")
    await Bun.sleep(10)
  }
}

async function mountAlert(root: string, message: string | (() => string)) {
  await Bun.write(path.join(root, "state", "kv.json"), "{}")
  const [
    { DialogProvider, useDialog },
    { DialogAlert },
    { I18nProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-alert"),
    import("../../../src/i18n"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function OpenAlert() {
    const dialog = useDialog()
    onMount(() => void DialogAlert.show(dialog, "Goal mode", message))
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={root} paths={{ home: root, state: path.join(root, "state"), worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <OpenAlert />
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </I18nProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  return testRender(() => <Harness />, { width: 100, height: 50, kittyKeyboard: true })
}

test("goal help refreshes used tokens while the alert stays open", async () => {
  await using tmp = await tmpdir()
  const [usedTokens, setUsedTokens] = createSignal(0)
  const app = await mountAlert(tmp.path, () =>
    formatGoalHelp({
      budget: null,
      goal: {
        objective: "verify live usage",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
        activeSince: 1,
        elapsedMilliseconds: 0,
        sourceMessageID: "msg_test",
        reason: null,
        tokenBudget: null,
        budgetExhaustedAt: null,
        usedTokens: 0,
      },
      duration: "0s",
      usedTokens: usedTokens(),
    }),
  )
  try {
    await wait(() => app.captureCharFrame().includes("Used: 0 tokens"))
    setUsedTokens(1500)
    await wait(() => app.captureCharFrame().includes("Used: 1.5k tokens"))
    expect(app.captureCharFrame()).not.toContain("Used: 0 tokens")
  } finally {
    app.renderer.destroy()
  }
})

test("alert still accepts a static message", async () => {
  await using tmp = await tmpdir()
  const app = await mountAlert(tmp.path, "Static alert message")
  try {
    await wait(() => app.captureCharFrame().includes("Static alert message"))
    expect(app.captureCharFrame()).toContain("Goal mode")
  } finally {
    app.renderer.destroy()
  }
})
