/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { tmpdir } from "../../fixture/fixture"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { eventSource } from "../../fixture/tui-sdk"
import { Locale } from "../../../src/util/locale"
import * as Memory from "../../../src/util/memory"

async function until(check: () => boolean | Promise<boolean>, describe: string, timeout = 4000) {
  const start = Date.now()
  for (;;) {
    if (await check()) return
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${describe}`)
    await Bun.sleep(10)
  }
}

function escColumn(frame: string) {
  return frame.split("\n")[0].lastIndexOf("esc")
}

function row(frame: string, title: string) {
  return frame.split("\n").find((line) => line.includes(title)) ?? ""
}

async function readConfig(file: string) {
  return (await Bun.file(file)
    .json()
    .catch(() => ({}))) as Record<string, { enabled?: boolean }>
}

async function mountMemory(root: string, height = 40, width = 120) {
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const dir = Memory.memoryDir({}, { home: root, directory: root })
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, "cache.md"),
    memory("Cache dir", "Use one shared cache dir", CACHE_STAMP, "Store caches under `.cache/deveco`.\n"),
  )
  await writeFile(
    path.join(dir, "build.md"),
    memory(
      "Slow builds",
      "Use the incremental build",
      BUILD_STAMP,
      "Run `bun build --incremental`.\n\nFull builds take minutes.\n",
    ),
  )
  await writeFile(
    path.join(dir, "MEMORY.md"),
    [
      "# Project Memory Index",
      "",
      "## Memories",
      "",
      "- [Cache dir](cache.md) Use one shared cache dir",
      "- [Slow builds](build.md) Use the incremental build",
      "- [Gone](gone.md) already deleted",
      "",
    ].join("\n"),
  )

  const [
    { DialogProvider, useDialog },
    { I18nProvider },
    { KVProvider },
    { SDKProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider },
    { ProjectProvider },
    { DialogMemory },
    { OpencodeKeymapProvider, registerOpencodeKeymap },
  ] = await Promise.all([
    import("../../../src/ui/dialog"),
    import("../../../src/i18n"),
    import("../../../src/context/kv"),
    import("../../../src/context/sdk"),
    import("../../../src/context/theme"),
    import("../../../src/config"),
    import("../../../src/ui/toast"),
    import("../../../src/context/project"),
    import("../../../src/component/dialog-memory"),
    import("../../../src/keymap"),
  ])

  // Same as app.tsx: the command puts the dialog on the dialog stack, which is
  // what activates the modal keymap mode the dialog actions are bound in.
  function Launcher() {
    const dialog = useDialog()
    onMount(() => dialog.replace(() => <DialogMemory />))
    return null
  }

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
                      fetch={
                        (async () =>
                          new Response("{}", {
                            headers: { "content-type": "application/json" },
                          })) as unknown as typeof fetch
                      }
                    >
                      <ProjectProvider>
                        <DialogProvider>
                          <Launcher />
                        </DialogProvider>
                      </ProjectProvider>
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

  const app = await testRender(() => <Harness />, { width, height, kittyKeyboard: true })
  return {
    app,
    frame: () => app.captureCharFrame(),
    config: path.join(root, ".deveco", "memory-config.json"),
    dir,
  }
}

// Fixed stamps so the list and the metadata rows can be asserted without depending on the clock.
// The newest memory sorts first, so cache.md stays on the last row for END to reach.
const CACHE_STAMP = Date.UTC(2026, 0, 2, 3, 4)
const BUILD_STAMP = Date.UTC(2026, 0, 3, 3, 4)

function memory(name: string, description: string, updated: number, body: string) {
  return [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    "type: project",
    `created: ${updated - 86400000}`,
    `updated: ${updated}`,
    "---",
    "",
    body,
  ].join("\n")
}

async function files(dir: string) {
  const names = await readdir(dir)
  return names.filter((name) => name.endsWith(".md") && name !== "MEMORY.md").sort()
}
async function index(dir: string) {
  return Bun.file(path.join(dir, "MEMORY.md")).text()
}

test("memory detail survives a file deleted from under it", async () => {
  await using tmp = await tmpdir()
  const { app, frame, dir } = await mountMemory(tmp.path)
  try {
    await until(() => frame().includes("Auto memory"), "the memory settings")
    await app.mockInput.pressKey("END")
    await until(() => frame().includes("View details space"), "the memory row to be selected")
    const list = frame()

    // The list snapshot is stale by design, so this row still opens: the detail view has to show
    // the file is gone instead of rendering an empty panel or taking the renderer down.
    await rm(path.join(dir, "cache.md"), { force: true })
    await app.mockInput.pressKey(" ")
    await until(() => frame().includes("Memory file no longer exists"), "the missing state")
    expect(frame()).not.toContain("Store caches under")
    expect(frame()).toContain("Memory: cache")
    // No delete affordances on a memory that is already gone, and the panel keeps the list width.
    expect(frame()).not.toContain("delete ctrl+d")
    expect(frame()).not.toContain("Delete all ctrl+shift+d")
    expect(escColumn(frame())).toBe(escColumn(list))

    // The bound delete keys route to the same guard: refresh instead of confirming a no-op.
    await app.mockInput.pressKey("d", { ctrl: true })
    await until(() => frame().includes("Memory settings"), "the refreshed list")
    expect(frame()).not.toContain("Delete this memory file?")
    expect(frame()).not.toContain("Cache dir")
    expect(await files(dir)).toEqual(["build.md"])

    await app.mockInput.pressEscape()
    await until(() => !frame().includes("Memory settings"), "the dialog to close")
  } finally {
    app.renderer.destroy()
  }
})

test("memory dialog toggles settings and shows memory content", async () => {
  await using tmp = await tmpdir()
  const { app, frame, config, dir } = await mountMemory(tmp.path)
  try {
    await until(() => frame().includes("Auto memory"), "the memory settings")
    expect(frame()).toContain("Memory settings")
    expect(row(frame(), "Auto memory")).toContain("✓ Enabled")
    expect(row(frame(), "Skill extraction")).toContain("○ Disabled")
    // The footer only offers what the selected row can do, and the labels come from the
    // resolved keybindings rather than hardcoded strings.
    expect(frame()).toContain("toggle space")
    expect(frame()).toContain("Read at plugin init, restart to apply")
    expect(frame()).not.toContain("View details")

    // Settings rows come first, so space toggles the row the cursor starts on and writes the
    // user config file the plugin reads; Enter does the same thing.
    await app.mockInput.pressKey(" ")
    await until(async () => (await readConfig(config)).autoMemory?.enabled === false, "the toggle to be written")
    await until(() => row(frame(), "Auto memory").includes("○ Disabled"), "the enabled state to flip")
    await app.mockInput.pressEnter()
    await until(async () => (await readConfig(config)).autoMemory?.enabled === true, "the second toggle")
    await until(() => row(frame(), "Auto memory").includes("✓ Enabled"), "the enabled state to flip back")

    // The last row is a memory, so its footer swaps the toggle hint for the memory actions, and
    // the row shows when the memory was updated instead of its description.
    await app.mockInput.pressKey("END")
    await until(() => frame().includes("delete ctrl+d"), "the memory row to be selected")
    expect(row(frame(), "Cache dir")).toContain(Locale.datetime(CACHE_STAMP))
    expect(row(frame(), "Cache dir")).not.toContain("Use one shared cache dir")
    expect(frame()).toContain("View details space")
    expect(frame()).not.toContain("toggle space")
    const list = frame()

    // space opens the memory from here; either way it must not reach the filter, where a lone
    // space would leave the list showing "No results found".
    await app.mockInput.pressKey(" ")
    await until(() => frame().includes("Store caches under"), "the memory body opened by space")
    expect(frame()).not.toContain("No results found")
    expect(frame()).toContain("Memory: Cache dir")
    expect(frame()).not.toContain("autoMemory.enabled")
    // The content view carries the metadata: both stamps, the type and the description.
    expect(row(frame(), "updated")).toContain(Locale.datetime(CACHE_STAMP))
    expect(row(frame(), "created")).toContain(Locale.datetime(CACHE_STAMP - 86400000))
    // The fallback row is only for files the plugin never stamped.
    expect(frame()).not.toMatch(/^\s*time\s/m)
    expect(/type\s+project/.test(frame())).toBe(true)
    expect(/description\s+Use one shared cache dir/.test(frame())).toBe(true)
    expect(frame()).not.toContain("description:")
    expect(frame()).not.toContain("updated:")
    // The content view replaces the dialog, which resets its geometry: it has to stay as
    // wide as the list, otherwise the panel shrinks and jumps while the file loads.
    expect(escColumn(frame())).toBe(escColumn(list))
    expect(frame()).toContain("delete ctrl+d")
    expect(frame()).toContain("Delete all ctrl+shift+d")

    // Coming back from the content view the cursor stays on the memory it opened from: its hints
    // are showing and space re-opens the same file instead of the first row.
    await app.mockInput.pressEscape()
    await until(() => frame().includes("View details space"), "the memory list on the opened row")
    expect(escColumn(frame())).toBe(escColumn(list))
    expect(frame()).not.toContain("toggle space")
    await app.mockInput.pressKey(" ")
    await until(() => frame().includes("Store caches under"), "the same memory body")
    await app.mockInput.pressEscape()
    await until(() => frame().includes("View details space"), "the memory list on the opened row")

    // A cancelled deletion keeps the cursor there too.
    await app.mockInput.pressKey("d", { ctrl: true })
    await until(() => frame().includes("Delete this memory file?"), "the delete confirmation")
    await app.mockInput.pressEscape()
    await until(() => frame().includes("View details space"), "the list after cancelling")
    expect(await files(dir)).toEqual(["build.md", "cache.md"])

    await app.mockInput.pressKey("d", { ctrl: true })
    await until(() => frame().includes("Delete this memory file?"), "the delete confirmation")
    await app.mockInput.pressEnter()
    await until(async () => (await files(dir)).join() === "build.md", "the memory file to be deleted")
    await until(async () => !(await index(dir)).includes("Cache dir"), "the index entry to be dropped")
    await until(() => frame().includes("Auto memory"), "the memory list")
    expect(frame()).not.toContain("Cache dir")
    expect(await index(dir)).not.toContain("Gone") // entries whose file is missing are dropped too

    // The deleted row is gone, so the list starts over on the first setting: nothing to delete.
    expect(frame()).not.toContain("Delete all ctrl+shift+d")
    expect(frame()).not.toContain("delete ctrl+d")
    await app.mockInput.pressKey("END")
    await until(() => frame().includes("Delete all ctrl+shift+d"), "the delete all hint")
    await app.mockInput.pressKey("D", { ctrl: true, shift: true })
    await until(() => frame().includes("Delete every memory file"), "the delete all confirmation")
    await app.mockInput.pressEnter()
    await until(async () => (await files(dir)).length === 0, "every memory file to be deleted")
    expect(await index(dir)).not.toContain("Slow builds")
    await until(() => frame().includes("No memories yet"), "the empty memories placeholder")

    await app.mockInput.pressEscape()
    await until(() => !frame().includes("Memory settings"), "the dialog to close")
  } finally {
    app.renderer.destroy()
  }
})

async function many(dir: string, count: number) {
  await mkdir(dir, { recursive: true })
  for (let i = 0; i < count; i++) await writeFile(path.join(dir, `m${i}.md`), memory(`Mem ${i}`, "d", 1000 + i, "body"))
}

test("hovering the memory list does not slide it around", async () => {
  await using tmp = await tmpdir()
  await many(Memory.memoryDir({}, { home: tmp.path, directory: tmp.path }), 8)
  const { app, frame } = await mountMemory(tmp.path, 40, 120)
  const header = () =>
    frame()
      .split("\n")
      .findIndex((line) => line.includes("Memories"))
  try {
    await until(() => frame().includes("Auto memory"), "the memory settings")
    const at = header()
    expect(at).toBeGreaterThan(0)

    // Slow sweep across the settings/memory boundary, each hover allowed to finish first. Hovering a
    // row that is already on screen must not move the list: a re-centered list slides other rows under
    // the pointer, which the renderer reports back as a new hover, and the selection starts marching
    // with nobody touching the mouse.
    for (let y = 16; y <= at + 3; y++) {
      await app.mockMouse.moveTo(60, y)
      await app.waitForVisualIdle({ quietFrames: 3, maxFrames: 40 })
      expect(header()).toBe(at)
    }
  } finally {
    app.renderer.destroy()
  }
}, 30000)
