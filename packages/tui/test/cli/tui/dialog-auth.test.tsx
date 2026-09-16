/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { DialogProvider, useDialog } from "../../../src/ui/dialog"
import { DialogAuth } from "../../../src/component/dialog-auth"
import { I18nProvider, changeLanguage, useI18n } from "../../../src/i18n"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncContext, useSync } from "../../../src/context/sync"

async function mount(
  auth: () => Promise<Response>,
  options?: {
    language?: string
    configured?: boolean
    save?: () => Promise<Response>
    dispose?: () => Promise<Response>
    bootstrap?: () => Promise<void>
  },
) {
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, JSON.stringify({ language: options?.language ?? "en" }))
  const providers = [
    { id: "deveco", name: "DevEco Code", models: {} },
    { id: "openai", name: "OpenAI", models: {} },
    ...(options?.configured ? [{ id: "custom", name: "Custom model provider", models: {} }] : []),
  ]
  const sync = {
    data: {
      provider: [],
      config: { provider: options?.configured ? { custom: { models: {} } } : {} },
      provider_next: { all: providers, connected: [], default: {} },
      provider_auth: {},
      console_state: { consoleManagedProviders: [], activeOrgName: "" },
    },
    bootstrap: options?.bootstrap ?? (async () => {}),
  } as unknown as ReturnType<typeof useSync>
  const fetcher = (async (input: RequestInfo | URL) => {
    const pathname = new URL(input instanceof Request ? input.url : String(input)).pathname
    if (pathname === "/instance/dispose" && options?.dispose) return options.dispose()
    if (pathname === "/auth") return auth()
    if (pathname === "/auth/openai" && options?.save) return options.save()
    return Response.json({})
  }) as typeof fetch
  function Open() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogAuth />))
    return null
  }
  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: tmp.path, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={config}>
            <KVProvider>
              <I18nProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://127.0.0.1:9" fetch={fetcher} events={{ subscribe: async () => () => {} }}>
                      <SyncContext.Provider value={sync}>
                        <DialogProvider>
                          <Open />
                          <Toast />
                        </DialogProvider>
                      </SyncContext.Provider>
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
  const setup = await testRender(() => <Harness />, { width: 100, height: 36, kittyKeyboard: true })
  return {
    setup,
    async frame(text: string, timeout = 2000) {
      for (let i = 0; i < timeout / 10; i++) {
        await Bun.sleep(10)
        await setup.renderOnce()
        const frame = setup.captureCharFrame()
        if (frame.includes(text)) return frame
      }
      throw new Error(setup.captureCharFrame())
    },
    async close() {
      setup.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("auth renders Huawei and third-party providers before credential loading finishes", async () => {
  const panel = await mount(() => new Promise(() => {}))
  try {
    const frame = await panel.frame("Checking status")
    expect(frame).toContain("HUAWEI ID")
    expect(frame).toContain("OpenAI")
    expect(frame).toContain("Provider authentication")
  } finally {
    await panel.close()
  }
})

test("auth keeps provider actions visible when the credential endpoint fails", async () => {
  const panel = await mount(async () => new Response("unavailable", { status: 404 }))
  try {
    const frame = await panel.frame("Status unavailable")
    expect(frame).toContain("HUAWEI ID")
    expect(frame).toContain("OpenAI")
    panel.setup.mockInput.pressEnter()
    expect(await panel.frame("Sign in with HUAWEI ID")).toContain("Back")
  } finally {
    await panel.close()
  }
})

test("auth shows sign-in and sign-out together for a saved Huawei account", async () => {
  const panel = await mount(async () => Response.json([{ providerID: "deveco", type: "oauth", removable: true }]))
  try {
    expect(await panel.frame("Account saved")).toContain("OpenAI")
    panel.setup.mockInput.pressEnter()
    const frame = await panel.frame("Sign out of HUAWEI ID")
    expect(frame).toContain("Sign in with HUAWEI ID")
  } finally {
    await panel.close()
  }
})

test("sign-out describes provider refresh after removing the credential", async () => {
  const panel = await mount(async () => Response.json([{ providerID: "deveco", type: "oauth", removable: true }]), {
    bootstrap: () => new Promise(() => {}),
  })
  try {
    await panel.frame("Account saved")
    panel.setup.mockInput.pressEnter()
    await panel.frame("Sign out of HUAWEI ID")
    panel.setup.mockInput.pressArrow("down")
    panel.setup.mockInput.pressEnter()
    await panel.frame("Remove DevEco Code")
    panel.setup.mockInput.pressArrow("left")
    panel.setup.mockInput.pressEnter()
    const frame = await panel.frame("Refreshing providers...")
    expect(frame).not.toContain("Loading models...")
  } finally {
    await panel.close()
  }
})

test("auth stops waiting on a stalled transport and keeps retry available", async () => {
  const panel = await mount(() => new Promise(() => {}))
  try {
    expect(await panel.frame("Status unavailable", 12_000)).toContain("OpenAI")
    expect(panel.setup.captureCharFrame()).not.toContain("Checking status")
  } finally {
    await panel.close()
  }
}, 15_000)

test("connecting an API-key provider returns to the unified auth list", async () => {
  const panel = await mount(async () => Response.json([]))
  try {
    await panel.frame("Not connected")
    panel.setup.mockInput.pressArrow("down")
    await panel.setup.renderOnce()
    panel.setup.mockInput.pressEnter()
    await panel.frame("Connect provider")
    panel.setup.mockInput.pressEnter()
    await panel.frame("API key")
    await panel.setup.mockInput.typeText("fake-test-key")
    panel.setup.mockInput.pressEnter()
    expect(await panel.frame("Provider authentication")).toContain("HUAWEI ID")
  } finally {
    await panel.close()
  }
})

test("auth actions hide search and use left to return without a Back row", async () => {
  const panel = await mount(async () => Response.json([{ providerID: "deveco", type: "oauth", removable: true }]))
  try {
    await panel.frame("Account saved")
    panel.setup.mockInput.pressEnter()
    const frame = await panel.frame("Sign out of HUAWEI ID")
    expect(frame).not.toContain("Search")
    expect(frame).not.toMatch(/^\s*Back\s*$/m)
    panel.setup.mockInput.pressArrow("right")
    expect(await panel.frame("Sign out of HUAWEI ID")).toContain("Sign in with HUAWEI ID")
    panel.setup.mockInput.pressArrow("left")
    expect(await panel.frame("Provider authentication")).toContain("OpenAI")
  } finally {
    await panel.close()
  }
})

test("explicitly configured providers precede other providers", async () => {
  const panel = await mount(async () => Response.json([]), { configured: true })
  try {
    const frame = await panel.frame("Configured providers")
    expect(frame.indexOf("HUAWEI ID")).toBeLessThan(frame.indexOf("Configured providers"))
    expect(frame.indexOf("Configured providers")).toBeLessThan(frame.indexOf("Other providers"))
    expect(frame).toContain("Custom model provider")
  } finally {
    await panel.close()
  }
})

test("API key submission shows progress and prevents duplicate writes", async () => {
  let release = () => {}
  let writes = 0
  const pending = new Promise<Response>((resolve) => {
    release = () => resolve(Response.json(true))
  })
  const panel = await mount(async () => Response.json([]), {
    save: () => {
      writes++
      return pending
    },
  })
  try {
    await panel.frame("Not connected")
    panel.setup.mockInput.pressArrow("down")
    await panel.setup.renderOnce()
    panel.setup.mockInput.pressEnter()
    await panel.frame("Connect provider")
    panel.setup.mockInput.pressEnter()
    await panel.frame("API key")
    await panel.setup.mockInput.typeText("fake-test-key")
    panel.setup.mockInput.pressEnter()
    await panel.frame("Saving API key...")
    panel.setup.mockInput.pressEnter()
    expect(writes).toBe(1)
    release()
    await panel.frame("Provider authentication")
  } finally {
    release()
    await panel.close()
  }
})

test("a refresh failure after saving a key keeps the saved-credential error distinct", async () => {
  const panel = await mount(async () => Response.json([]), {
    dispose: async () => new Response("unavailable", { status: 500 }),
  })
  try {
    await panel.frame("Not connected")
    panel.setup.mockInput.pressArrow("down")
    await panel.setup.renderOnce()
    panel.setup.mockInput.pressEnter()
    await panel.frame("Connect provider")
    panel.setup.mockInput.pressEnter()
    await panel.frame("API key")
    await panel.setup.mockInput.typeText("fake-test-key")
    panel.setup.mockInput.pressEnter()
    expect(await panel.frame("API key saved, but provider loading failed")).not.toContain("Unable to save the API key")
  } finally {
    await panel.close()
  }
})

test("auth translates account status and sign-out confirmation into Chinese", async () => {
  // bun's mock.module is process-global and never undone. If an earlier test file
  // stubbed src/i18n, this test renders English forever and surfaces as an opaque
  // frame timeout, so name the real cause before anything else runs.
  expect(useI18n.toString()).toContain("I18nContext")
  const ui = await mount(async () => Response.json([{ providerID: "deveco", type: "oauth", removable: true }]), {
    language: "zh",
  })
  try {
    const frame = await ui.frame("已保存账号")
    expect(frame).toContain("服务商账号与认证")
    expect(frame).toContain("华为账号")
    ui.setup.mockInput.pressEnter()
    await ui.frame("退出华为账号")
    ui.setup.mockInput.pressArrow("down")
    ui.setup.mockInput.pressEnter()
    const confirm = await ui.frame("退出当前服务端上的华为账号")
    expect(confirm).toContain("取消")
    expect(confirm).toContain("移除")
  } finally {
    await ui.close()
    await changeLanguage("en")
  }
})
