/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { tmpdir } from "./fixture"
import { createTuiResolvedConfig } from "./tui-runtime"
import { TestTuiContexts } from "./tui-environment"

type PanelInput = {
  initialTab: "usage" | "stats"
  /** Static body, or a resolver receiving the days query value ("" = all time). */
  statsFixture: unknown | ((days: string) => unknown)
  /** Static StatsQuota body served for /stats/quota; omitted = no quota windows. */
  quotaFixture?: unknown
  width?: number
  height?: number
}

/**
 * Mounts DialogUsage with the full provider stack and a stubbed SDK fetch that
 * serves the given stats fixture for /stats/usage and the quota fixture for
 * /stats/quota. Shared by render tests and the USAGE_PREVIEW dump.
 */
export async function mountUsagePanel(input: PanelInput) {
  const root = await tmpdir()
  const state = path.join(root.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const fetchStub = buildFetchStub(input)
  const providers = await loadProviders()

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
    const off = providers.registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)
    return buildTree(providers, { fetchStub, directory: root.path, state, initialTab: input.initialTab, keymap, resolvedConfig })
  }

  const setup = await testRender(() => <Harness />, {
    width: input.width ?? 100,
    height: input.height ?? 64,
  })
  return { setup, frameWith: frameWithOf(setup), cleanup: () => setup.renderer.destroy() }
}

function buildFetchStub(input: PanelInput): typeof fetch {
  return (async (request: RequestInfo | URL) => {
    const url = request instanceof Request ? request.url : String(request)
    if (url.includes("/stats/quota")) {
      return new Response(JSON.stringify(input.quotaFixture ?? {}), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }
    if (!url.includes("/stats/usage")) {
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
    }
    const days = new URL(url).searchParams.get("days") ?? ""
    const body = typeof input.statsFixture === "function" ? (input.statsFixture as (days: string) => unknown)(days) : input.statsFixture
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  }) as typeof fetch
}

async function loadProviders() {
  const [dialog, component, kv, theme, config, toast, keymap, i18n, route, sdk] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/component/dialog-usage"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
    import("../../src/i18n"),
    import("../../src/context/route"),
    import("../../src/context/sdk"),
  ])
  return {
    DialogProvider: dialog.DialogProvider,
    DialogUsage: component.DialogUsage,
    KVProvider: kv.KVProvider,
    ThemeProvider: theme.ThemeProvider,
    TuiConfigProvider: config.TuiConfigProvider,
    ToastProvider: toast.ToastProvider,
    OpencodeKeymapProvider: keymap.OpencodeKeymapProvider,
    registerOpencodeKeymap: keymap.registerOpencodeKeymap,
    I18nProvider: i18n.I18nProvider,
    RouteProvider: route.RouteProvider,
    SDKProvider: sdk.SDKProvider,
  }
}

function buildTree(
  p: Awaited<ReturnType<typeof loadProviders>>,
  props: {
    fetchStub: typeof fetch
    directory: string
    state: string
    initialTab: "usage" | "stats"
    keymap: ReturnType<typeof createDefaultOpenTuiKeymap>
    resolvedConfig: ReturnType<typeof createTuiResolvedConfig>
  },
) {
  return (
    <TestTuiContexts directory={props.directory} paths={{ home: props.directory, state: props.state, worktree: props.directory }}>
      <p.OpencodeKeymapProvider keymap={props.keymap}>
        <p.TuiConfigProvider config={props.resolvedConfig}>
          <p.KVProvider>
            <p.ThemeProvider mode="dark">
              <p.ToastProvider>
                <p.I18nProvider>
                  <p.RouteProvider initialRoute={{ type: "home" }}>
                    <p.SDKProvider url="http://127.0.0.1:9" directory={props.directory} fetch={props.fetchStub}>
                      <p.DialogProvider>
                        <p.DialogUsage initialTab={props.initialTab} />
                      </p.DialogProvider>
                    </p.SDKProvider>
                  </p.RouteProvider>
                </p.I18nProvider>
              </p.ToastProvider>
            </p.ThemeProvider>
          </p.KVProvider>
        </p.TuiConfigProvider>
      </p.OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

function frameWithOf(setup: Awaited<ReturnType<typeof testRender>>) {
  return async (needle: string) => {
    const start = Date.now()
    for (;;) {
      await setup.renderOnce()
      const frame = setup.captureCharFrame()
      if (frame.includes(needle)) return frame
      if (Date.now() - start > 3000) return frame
      await Bun.sleep(20)
    }
  }
}
