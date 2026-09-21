/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, mock, test } from "bun:test"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createFetch, eventSource, json } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../../../tui/test/fixture/tui-runtime"
import { ThemeProvider } from "@opencode-ai/tui/context/theme"
import { TuiConfigProvider } from "@opencode-ai/tui/config"
import { DEVECO_BASE_MODE, OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "@opencode-ai/tui/keymap"
import { SDKProvider } from "@opencode-ai/tui/context/sdk"
import { SyncContext, useSync } from "@opencode-ai/tui/context/sync"
import { KVProvider } from "@opencode-ai/tui/context/kv"
import { I18nProvider } from "@opencode-ai/tui/i18n"
import { ExitProvider, useExit } from "@opencode-ai/tui/context/exit"
import { DialogProvider } from "@opencode-ai/tui/ui/dialog"
import { ToastProvider } from "@opencode-ai/tui/ui/toast"
import { DevEcoOnboarding } from "@/cli/deveco-ui/onboarding"

// The onboarding screen only needs the model selection slice of the local context.
mock.module("@opencode-ai/tui/context/local", () => ({
  useLocal: () => ({ model: { set: () => {} } }),
}))

// Mirror of the global "app_exit" binding registered by packages/tui/src/app.tsx:
// Ctrl+C quits the application whenever the home prompt is not the focused input.
function AppExitBinding() {
  const exit = useExit()
  useBindings(() => ({
    mode: DEVECO_BASE_MODE,
    bindings: [{ key: "ctrl+c", desc: "Exit the application", cmd: () => exit() }],
  }))
  return null
}

function makeHarness(
  tmpPath: string,
  fetcher: typeof fetch,
  sync: ReturnType<typeof useSync>,
  exits: string[],
  completions: string[],
) {
  return function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts cwd={tmpPath} paths={{ home: tmpPath, state: tmpPath, worktree: tmpPath }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <SDKProvider url="http://127.0.0.1:9" fetch={fetcher} events={eventSource()}>
                        <SyncContext.Provider value={sync}>
                          <ExitProvider exit={() => exits.push("exit")}>
                            <AppExitBinding />
                            <DevEcoOnboarding initialStep="key" onComplete={() => completions.push("complete")} />
                          </ExitProvider>
                        </SyncContext.Provider>
                      </SDKProvider>
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
}

async function waitForFrame(setup: Awaited<ReturnType<typeof testRender>>, text: string) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    if (frame.includes(text)) return frame
    await Bun.sleep(10)
  }
  throw new Error(setup.captureCharFrame())
}

function makePanelHelpers(
  setup: Awaited<ReturnType<typeof testRender>>,
  exits: string[],
  completions: string[],
  tmp: Awaited<ReturnType<typeof tmpdir>>,
) {
  return {
    setup,
    exits: () => exits.length,
    completions: () => completions.length,
    frame: (text: string) => waitForFrame(setup, text),
    async settle() {
      await Bun.sleep(20)
      await setup.renderOnce()
      return setup.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

async function mount() {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language: "en" }))
  const exits: string[] = []
  const completions: string[] = []
  const { fetch: fetcher } = createFetch(() => json({}))
  const sync = {
    data: {
      provider: [],
      config: {},
      provider_next: { all: [], connected: [], default: {} },
      provider_auth: {},
    },
    bootstrap: async () => {},
  } as unknown as ReturnType<typeof useSync>
  const Harness = makeHarness(tmp.path, fetcher, sync, exits, completions)
  const setup = await testRender(() => <Harness />, { width: 100, height: 36, kittyKeyboard: true })
  return makePanelHelpers(setup, exits, completions, tmp)
}

test("ctrl+c clears a pasted API key instead of quitting the application", async () => {
  await using panel = await mount()
  await panel.frame("Enter API Key")
  await panel.setup.mockInput.typeText("sk-secret")
  expect(await panel.frame("sk-secret")).toContain("sk-secret")
  panel.setup.mockInput.pressCtrlC()
  const after = await panel.settle()

  expect(panel.exits()).toBe(0)
  expect(after).not.toContain("sk-secret")
  expect(after).toContain("Enter API Key")
})

test("ctrl+c quits the application once the API key field is empty", async () => {
  await using panel = await mount()
  await panel.frame("Enter API Key")

  panel.setup.mockInput.pressCtrlC()
  await panel.settle()

  expect(panel.exits()).toBe(1)
})

test("ctrl+c clears the field first and quits on the next press", async () => {
  await using panel = await mount()
  await panel.frame("Enter API Key")
  await panel.setup.mockInput.typeText("sk-secret")
  await panel.frame("sk-secret")

  panel.setup.mockInput.pressCtrlC()
  expect(await panel.settle()).not.toContain("sk-secret")
  expect(panel.exits()).toBe(0)

  panel.setup.mockInput.pressCtrlC()
  await panel.settle()
  expect(panel.exits()).toBe(1)
})

test("the key hint only documents the keys that act on the input", async () => {
  await using panel = await mount()
  const frame = await panel.frame("Enter to submit")

  expect(frame).toContain("Ctrl+C to clear")
  expect(frame).not.toContain("Home/End")
})

test("esc leaves the key step and ctrl+c still quits from the provider list", async () => {
  await using panel = await mount()
  await panel.frame("Enter API Key")

  panel.setup.mockInput.pressEscape()
  expect(await panel.frame("Please select provider")).not.toContain("Enter API Key")

  panel.setup.mockInput.pressCtrlC()
  await panel.settle()
  expect(panel.exits()).toBe(1)
})
