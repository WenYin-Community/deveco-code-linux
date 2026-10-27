/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { I18nProvider } from "../../../src/i18n"
import en from "../../../src/i18n/en.json" with { type: "json" }
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { DialogSessionDirectoryMissing } from "../../../src/component/dialog-session-directory-missing"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const MISSING_DIRECTORY = "/tmp/deleted-session-directory"
const copy = en.dialog

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

/** Frame text with the box wrapping collapsed, so assertions are not tied to the width. */
function frameText(app: { captureCharFrame: () => string }) {
  return app.captureCharFrame().replace(/\s+/g, " ")
}

type DialogAction = () => boolean | void | Promise<boolean | void>

/** Opens the dialog on mount so the provider tree below it is already in place. */
function OpenDialog(props: { onContinue: DialogAction; onClose: () => void }) {
  const dialog = useDialog()
  onMount(() => {
    dialog.replace(
      () => <DialogSessionDirectoryMissing directory={MISSING_DIRECTORY} onContinue={props.onContinue} />,
      props.onClose,
    )
  })
  return null
}

function DialogHarness(props: { root: string; state: string; onContinue: DialogAction; onClose: () => void }) {
  const renderer = useRenderer()
  const keymap = createDefaultOpenTuiKeymap(renderer)
  const resolvedConfig = createTuiResolvedConfig()
  onCleanup(registerOpencodeKeymap(keymap, renderer, resolvedConfig))

  return (
    <TestTuiContexts directory={props.root} paths={{ home: props.root, state: props.state, worktree: props.root }}>
      <OpencodeKeymapProvider keymap={keymap}>
        <TuiConfigProvider config={resolvedConfig}>
          <KVProvider>
            <I18nProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <OpenDialog onContinue={props.onContinue} onClose={props.onClose} />
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

async function mountDialog(input: { root: string; onContinue: DialogAction; onClose: () => void }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  return testRender(() => <DialogHarness state={state} {...input} />, { kittyKeyboard: true })
}

test("dialog renders the move copy and cancels", async () => {
  await using tmp = await tmpdir()
  const calls: string[] = []
  const app = await mountDialog({
    root: tmp.path,
    onContinue: () => {
      calls.push("continue")
    },
    onClose: () => {
      calls.push("close")
    },
  })
  const shows = () => frameText(app).includes(copy.title_session_directory_missing)

  try {
    await wait(shows)
    const frame = frameText(app)
    expect(frame).toContain(MISSING_DIRECTORY)
    expect(frame).toContain(copy.session_directory_missing_desc)
    expect(frame).toContain(copy.session_directory_missing_prompt)
    expect(frame).toContain(copy.session_option_cancel)
    expect(frame).toContain(copy.session_option_continue)

    app.mockInput.pressArrow("left")
    app.mockInput.pressEnter()

    // Cancelling closes the dialog, and closing is how the caller learns that the user
    // backed out: the session screen behind it cannot render a session without a directory.
    await wait(() => calls.includes("close"))
    expect(calls).toEqual(["close"])
    await wait(() => !shows())
  } finally {
    app.renderer.destroy()
  }
})

test("dialog keeps itself open and retryable while a move is pending or rejected", async () => {
  await using tmp = await tmpdir()
  const calls: string[] = []
  let reject: (() => void) | undefined
  const app = await mountDialog({
    root: tmp.path,
    onContinue: () => {
      calls.push("continue")
      return new Promise<boolean>((resolve) => {
        reject = () => resolve(false)
      })
    },
    onClose: () => {
      calls.push("close")
    },
  })
  const shows = () => frameText(app).includes(copy.title_session_directory_missing)

  try {
    await wait(shows)
    app.mockInput.pressArrow("right")
    app.mockInput.pressEnter()
    await wait(() => calls.length === 1)
    // A double Enter used to fire the move twice; while the first request is open the
    // dialog has to swallow the second one.
    app.mockInput.pressEnter()
    await Bun.sleep(50)
    expect(calls).toEqual(["continue"])

    // A failed move must stay retryable, so a false result keeps the dialog on screen.
    reject?.()
    await Bun.sleep(50)
    expect(calls).toEqual(["continue"])
    expect(shows()).toBe(true)
  } finally {
    reject?.()
    app.renderer.destroy()
  }
})
