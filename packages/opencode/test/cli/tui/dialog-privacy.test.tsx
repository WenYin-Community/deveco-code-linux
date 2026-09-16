/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "@opencode-ai/tui/keymap"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { DialogProvider, useDialog } from "@opencode-ai/tui/ui/dialog"
import { Toast, ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DialogPrivacy } from "@/cli/deveco-ui/dialog-privacy"

test("privacy toggles stay open for Enter and Space", async () => {
  await using tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const opened: string[] = []

  function Open() {
    const dialog = useDialog()
    onMount(() =>
      dialog.replace(() => (
        <DialogPrivacy
          openUrl={async (url) => {
            opened.push(url)
          }}
        />
      )),
    )
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <Open />
                      <Toast />
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

  const setup = await testRender(() => <Harness />, { width: 100, height: 30, kittyKeyboard: true })
  const frame = async (text: string) => {
    for (let i = 0; i < 200; i++) {
      await setup.renderOnce()
      const value = setup.captureCharFrame()
      if (value.includes(text)) return value
      await Bun.sleep(10)
    }
    throw new Error(setup.captureCharFrame())
  }
  try {
    await frame("Disable Analytics")
    setup.mockInput.pressEnter()
    expect(await frame("Privacy Policy")).toContain("Privacy")
    expect(opened).toHaveLength(1)

    setup.mockInput.pressArrow("down")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    expect(await frame("Enable Analytics")).toContain("Privacy")

    setup.mockInput.typeText(" ")
    expect(await frame("Disable Analytics")).toContain("Space toggle")
  } finally {
    setup.renderer.destroy()
  }
})
