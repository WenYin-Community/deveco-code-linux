import { createTestKeymap } from "@opentui/keymap/testing"
import { expect, test } from "bun:test"
import {
  dispatchExternalCommand,
  LOCAL_COMMAND_SESSION_ID_DATA_KEY,
  registerLocalCommandReporting,
} from "../src/keymap"

// The command transformer wraps `run` at layer-registration time, so the test harness registers
// the reporter before any command layer, exactly like the app does.
function createHarness() {
  const harness = createTestKeymap({ defaultKeys: true })
  const reported: { name: string; sessionID?: string }[] = []
  registerLocalCommandReporting(harness.keymap, (name, sessionID) => reported.push({ name, sessionID }))
  return {
    keymap: harness.keymap,
    host: harness.host,
    cleanup: () => harness.cleanup(),
    reported,
  }
}

function registerPaletteCommands(keymap: ReturnType<typeof createTestKeymap>["keymap"], ran: string[]) {
  return keymap.registerLayer({
    commands: [
      {
        name: "session.list",
        slashName: "sessions",
        run: () => void ran.push("session.list"),
      },
      {
        name: "model.list",
        slashName: "models",
        run: () => void ran.push("model.list"),
      },
      {
        name: "prompt.goal",
        slashName: "goal",
        run: () => void ran.push("prompt.goal"),
      },
      {
        name: "app.exit",
        slashName: "exit",
        run: () => void ran.push("app.exit"),
      },
      {
        name: "prompt.submit",
        run: () => void ran.push("prompt.submit"),
      },
    ],
    bindings: [
      { key: "x", cmd: "session.list" },
      { key: "y", cmd: "prompt.submit" },
    ],
  })
}

test("a locally dispatched slash command is reported once", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)
  harness.keymap.setData(LOCAL_COMMAND_SESSION_ID_DATA_KEY, "session-1")

  harness.keymap.dispatchCommand("session.list")

  expect(ran).toEqual(["session.list"])
  expect(harness.reported).toEqual([{ name: "sessions", sessionID: "session-1" }])
  off()
  harness.cleanup()
})

test("a keybinding that executes a slash command is reported once", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)

  harness.host.press("x")

  expect(ran).toEqual(["session.list"])
  expect(harness.reported).toEqual([{ name: "sessions", sessionID: undefined }])
  off()
  harness.cleanup()
})

test("commands without a slash name are never reported", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)

  harness.keymap.dispatchCommand("prompt.submit")
  harness.host.press("y")

  expect(ran).toEqual(["prompt.submit", "prompt.submit"])
  expect(harness.reported).toEqual([])
  off()
  harness.cleanup()
})

test("IDE-initiated UI actions are not counted as user slash commands", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)

  // tui.command.execute actions arrive from the IDE/control plane. Their server routes only
  // publish the TUI event (they never run SessionPrompt.command), and the product rule counts
  // user-typed slash commands only, so nothing reports them by design: the UI action still runs,
  // the client counter stays silent.
  dispatchExternalCommand(harness.keymap, "session.list")

  expect(ran).toEqual(["session.list"])
  expect(harness.reported).toEqual([])
  off()
  harness.cleanup()
})

test("the /goal palette command is reported by the prompt interception instead", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)

  harness.keymap.dispatchCommand("prompt.goal")

  // The command only prefills the prompt with "/goal "; the submit path performs and reports it.
  expect(ran).toEqual(["prompt.goal"])
  expect(harness.reported).toEqual([])
  off()
  harness.cleanup()
})

test("the /exit command still runs but is never reported", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)

  // /exit tears the renderer down and ends the process before the fire-and-forget flush finishes,
  // so a report would only reach the server on the next launch; exit has no workflow value.
  harness.keymap.dispatchCommand("app.exit")

  expect(ran).toEqual(["app.exit"])
  expect(harness.reported).toEqual([])
  off()
  harness.cleanup()
})

test("every local execution is reported, not only the first", () => {
  const harness = createHarness()
  const ran: string[] = []
  const off = registerPaletteCommands(harness.keymap, ran)

  harness.keymap.dispatchCommand("session.list")
  harness.keymap.dispatchCommand("model.list")

  expect(harness.reported).toEqual([
    { name: "sessions", sessionID: undefined },
    { name: "models", sessionID: undefined },
  ])
  off()
  harness.cleanup()
})
