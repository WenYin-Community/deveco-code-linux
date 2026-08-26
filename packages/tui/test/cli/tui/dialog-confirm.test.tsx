/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function mountButtons(input: { root: string; onConfirm: () => void; onCancel: () => void }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider, useDialog },
    { DialogConfirmButtons },
    { I18nProvider },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/ui/dialog-confirm"),
    import("../../../src/i18n"),
    import("../../../src/context/kv"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/keymap"),
  ])

  function OpenButtons() {
    const dialog = useDialog()
    onMount(() => {
      dialog.replace(() => (
        <DialogConfirmButtons
          cancelLabel="Skip"
          confirmLabel="Upload"
          closeOnSelect={false}
          onCancel={input.onCancel}
          onConfirm={input.onConfirm}
        />
      ))
    })
    return null
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={input.root}
        paths={{
          home: input.root,
          state,
          worktree: input.root,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <OpenButtons />
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

  return testRender(() => <Harness />, { kittyKeyboard: true })
}

test("dialog confirm buttons select cancel and confirm with arrow keys", async () => {
  await using tmp = await tmpdir()
  const selected: string[] = []
  const app = await mountButtons({
    root: tmp.path,
    onCancel: () => selected.push("cancel"),
    onConfirm: () => selected.push("confirm"),
  })

  try {
    await wait(() => app.captureCharFrame().includes("Skip"))
    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()

    expect(selected).toEqual(["cancel", "confirm"])
  } finally {
    app.renderer.destroy()
  }
})
