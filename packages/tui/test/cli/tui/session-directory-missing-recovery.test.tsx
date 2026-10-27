/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { ArgsProvider } from "../../../src/context/args"
import { EditorContextProvider } from "../../../src/context/editor"
import { ExitProvider } from "../../../src/context/exit"
import { KVProvider } from "../../../src/context/kv"
import { LocalProvider } from "../../../src/context/local"
import { PermissionProvider } from "../../../src/context/permission"
import { ProjectProvider } from "../../../src/context/project"
import { RouteProvider, useRoute } from "../../../src/context/route"
import { SDKProvider, type EventSource } from "../../../src/context/sdk"
import { SyncProvider, useSync } from "../../../src/context/sync"
import { ThemeProvider } from "../../../src/context/theme"
import { I18nProvider } from "../../../src/i18n"
import en from "../../../src/i18n/en.json" with { type: "json" }
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { TuiConfigProvider } from "../../../src/config"
import { DialogProvider } from "../../../src/ui/dialog"
import { Toast, ToastProvider } from "../../../src/ui/toast"
import { useSessionDirectoryMissingRecovery } from "../../../src/component/session-directory-missing-recovery"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { createEventSource, createFetch, directory as sdkDirectory, json } from "../../fixture/tui-sdk"

const MISSING_DIRECTORY = "/tmp/deleted-session-directory"
const SESSION_ID = "ses_directory_missing"
const copy = en.dialog

/** The 409 for a deleted session directory, wrapped the way the SDK throws it. */
function directoryMissingError() {
  const body = {
    _tag: "DirectoryMissingError",
    directory: MISSING_DIRECTORY,
    message: `Directory does not exist: ${MISSING_DIRECTORY}`,
  }
  return new Error(body.message, { cause: { body, status: 409 } })
}

/** Session payload the fake server returns once the session lives in the current directory. */
function movedSession() {
  const now = Date.now()
  return {
    id: SESSION_ID,
    projectID: "proj_test",
    directory: sdkDirectory,
    title: "Session with a deleted directory",
    version: "1.0.0",
    time: { created: now, updated: now },
  }
}

async function wait(fn: () => boolean, timeout = 4000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

type Scenario = {
  /** Response for POST /experimental/control-plane/move-session. */
  move: () => Response
  /** Session id passed to recover(); undefined exercises the "unknown session" path. */
  sessionID?: string
}

/**
 * Fake server for the recovery flow. The shared fixture only sees the URL, so this
 * wrapper also records request bodies (the move payload) and session creations.
 */
function scenarioFetch(input: { scenario: Scenario; moves: unknown[]; creates: URL[] }) {
  const base = createFetch()
  return (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(request instanceof Request ? request.url : String(request))
    const method = request instanceof Request ? request.method : (init?.method ?? "GET")
    if (method === "POST" && url.pathname === "/session") input.creates.push(url)
    if (url.pathname === "/experimental/control-plane/move-session") {
      const body = request instanceof Request ? await request.clone().text() : init?.body
      input.moves.push(typeof body === "string" ? JSON.parse(body) : undefined)
      return input.scenario.move()
    }
    // After a successful move the flow reloads the same session with its new directory.
    if (url.pathname === `/session/${SESSION_ID}` && method === "GET") return json(movedSession())
    if (url.pathname.startsWith(`/session/${SESSION_ID}/`)) {
      return url.pathname.endsWith("/debug-state") ? json({ active: false }) : json([])
    }
    if (url.pathname === "/session" && method === "GET") return json([movedSession()])
    return base.fetch(request, init)
    // Same mock-fetch assertion the shared fixture uses: the stub has no preconnect.
  }) as typeof globalThis.fetch
}

/** Runs the recovery hook once on mount and hands the captured contexts back. */
function RecoveryProbe(props: {
  sessionID?: string
  onProbe: (result: { sync: ReturnType<typeof useSync>; route: ReturnType<typeof useRoute> }) => void
}) {
  const recovery = useSessionDirectoryMissingRecovery()
  const sync = useSync()
  const route = useRoute()
  onMount(() => {
    // Start on the session page: cancelling has to move the user away from it.
    route.navigate({ type: "session", sessionID: SESSION_ID })
    // The 409 body carries the directory only, hence the explicit session id — the same
    // call shape the prompt and the session route use.
    recovery.recover(directoryMissingError(), props.sessionID)
    props.onProbe({ sync, route })
  })
  return null
}

function Harness(props: {
  root: string
  state: string
  fetch: typeof globalThis.fetch
  events: EventSource
  sessionID?: string
  onProbe: Parameters<typeof RecoveryProbe>[0]["onProbe"]
}) {
  // The keymap needs the renderer, so it has to be created inside the render tree.
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
                  <ExitProvider exit={() => undefined}>
                    <ArgsProvider>
                      <SDKProvider url="http://test" directory={sdkDirectory} fetch={props.fetch} events={props.events}>
                        <PermissionProvider>
                          <ProjectProvider>
                            <SyncProvider>
                              <RouteProvider>
                                <EditorContextProvider integration={{ connection: () => undefined }}>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <RecoveryProbe sessionID={props.sessionID} onProbe={props.onProbe} />
                                      <Toast />
                                    </DialogProvider>
                                  </LocalProvider>
                                </EditorContextProvider>
                              </RouteProvider>
                            </SyncProvider>
                          </ProjectProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </ArgsProvider>
                  </ExitProvider>
                </ToastProvider>
              </ThemeProvider>
            </I18nProvider>
          </KVProvider>
        </TuiConfigProvider>
      </OpencodeKeymapProvider>
    </TestTuiContexts>
  )
}

async function mountScenario(input: { root: string; scenario: Scenario }) {
  const state = path.join(input.root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const moves: unknown[] = []
  const creates: URL[] = []
  const events = createEventSource()
  let sync: ReturnType<typeof useSync> | undefined
  let route: ReturnType<typeof useRoute> | undefined
  const onProbe: Parameters<typeof RecoveryProbe>[0]["onProbe"] = (result) => {
    sync = result.sync
    route = result.route
  }

  const app = await testRender(
    () => (
      <Harness
        root={input.root}
        state={state}
        fetch={scenarioFetch({ scenario: input.scenario, moves, creates })}
        events={events.source}
        sessionID={input.scenario.sessionID}
        onProbe={onProbe}
      />
    ),
    { kittyKeyboard: true },
  )
  return {
    app,
    moves,
    creates,
    session: () => sync!.session.get(SESSION_ID),
    routeType: () => route!.data.type,
    showsDialog: () => app.captureCharFrame().includes(copy.title_session_directory_missing),
  }
}
type Mounted = Awaited<ReturnType<typeof mountScenario>>

/** Mounts the fake server for one scenario and always tears the renderer down. */
async function withScenario(scenario: Scenario, body: (mounted: Mounted) => Promise<void>) {
  await using tmp = await tmpdir()
  const mounted = await mountScenario({ root: tmp.path, scenario })
  try {
    await body(mounted)
  } finally {
    mounted.app.renderer.destroy()
  }
}

test("recovery migrates the session into the current directory", async () => {
  await withScenario({ sessionID: SESSION_ID, move: () => new Response(null, { status: 204 }) }, async (scenario) => {
    await wait(() => scenario.showsDialog())
    scenario.app.mockInput.pressArrow("right")
    scenario.app.mockInput.pressEnter()

    await wait(() => scenario.moves.length === 1)
    // The same session id: the history is preserved and nothing new is created.
    expect(scenario.moves[0]).toEqual({
      sessionID: SESSION_ID,
      destination: { directory: sdkDirectory },
      moveChanges: false,
    })
    expect(scenario.creates).toEqual([])
    // A move keeps the id, so the recovery flow reloads the session itself and the cached
    // entry must already point at the current directory.
    await wait(() => scenario.session()?.directory === sdkDirectory)
    await wait(() => !scenario.showsDialog())
    // Closing the dialog after a successful move is not a cancellation.
    expect(scenario.routeType()).toBe("session")
    expect(scenario.app.captureCharFrame()).not.toContain(copy.session_directory_missing_cancelled)
  })
})

test("recovery keeps the dialog and reports the failure when the move fails", async () => {
  const failed = () => json({ message: "Destination directory belongs to another project" }, { status: 400 })
  await withScenario({ sessionID: SESSION_ID, move: failed }, async (scenario) => {
    await wait(() => scenario.showsDialog())
    scenario.app.mockInput.pressArrow("right")
    scenario.app.mockInput.pressEnter()

    await wait(() => scenario.app.captureCharFrame().includes(copy.session_directory_missing_move_failed))
    // A silent failure would strand the user on a dead session page: the dialog stays
    // open for a retry and no replacement session is created.
    expect(scenario.showsDialog()).toBe(true)
    expect(scenario.creates).toEqual([])
  })
})

test("recovery leaves the session untouched when the dialog is dismissed", async () => {
  await withScenario({ sessionID: SESSION_ID, move: () => new Response(null, { status: 204 }) }, async (scenario) => {
    await wait(() => scenario.showsDialog())
    expect(scenario.routeType()).toBe("session")

    // Escape only reaches the dialog's close callback, which is how a dismissal is
    // reported; without the recovery flow listening to it the user would be left on a
    // session page whose requests all fail.
    scenario.app.mockInput.pressEscape()

    await wait(() => !scenario.showsDialog())
    expect(scenario.moves).toEqual([])
    expect(scenario.creates).toEqual([])
    await wait(() => scenario.routeType() === "home")
    await wait(() => scenario.app.captureCharFrame().includes(copy.session_directory_missing_cancelled))
  })
})
