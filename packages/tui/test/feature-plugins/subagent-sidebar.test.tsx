/** @jsxImportSource @opentui/solid */
import { afterAll, expect, mock, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { JSX } from "solid-js"
import { RGBA } from "@opentui/core"
import i18next from "i18next"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import type { Part, Session, ToolPart } from "@opencode-ai/sdk/v2"
import en from "../../src/i18n/en.json" with { type: "json" }

type ConfirmProps = {
  title: string
  message: string
  onConfirm?: () => void
  onCancel?: () => void
}
type CommandLayer = {
  commands: { name: string; slashName?: string; run: () => void | Promise<void> }[]
}

// The View reads translations through the app i18n context; stub it so the
// plugin renders standalone (interpolation matches the {{n}} JSON format).
// Snapshot the exports by value before mocking. The namespace object carries live
// bindings, so once mock.module below replaces the registry entry it reports the
// stub too, and restoring from it would just re-install the stub.
const realI18n = { ...(await import("../../src/i18n")) }
mock.module("../../src/i18n", () => ({
  ...realI18n,
  useI18n: () => ({ t, lng: () => "en" }),
  onLanguageChange: () => () => {},
}))
// mock.module rewrites the process-wide module registry and bun never undoes it,
// so without this every later test file imports the stub above and silently loses
// real i18n reactivity. Hand the genuine exports back once this file is done.
afterAll(() => {
  mock.module("../../src/i18n", () => realI18n)
})

function t(key: string, params?: Record<string, string | number>): string {
  const value = key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], en)
  const text = typeof value === "string" ? value : key
  return text.replace(/\{\{(\w+)\}\}/g, (_, k: string) => String(params?.[k] ?? ""))
}

function toolPart(id: string, state: ToolPart["state"]): ToolPart {
  return {
    id,
    sessionID: "ses_parent",
    messageID: "msg_1",
    type: "tool",
    callID: `call_${id}`,
    tool: "task",
    state,
  } as ToolPart
}

function apiFixture(input: {
  sessions?: Record<string, Session | undefined>
  messages?: Record<string, unknown[]>
  status?: Record<string, { type: "idle" | "busy" } | undefined>
}) {
  const values = new Map<string, unknown>()
  const listeners = new Map<string, (event: unknown) => void>()
  const slots: TuiSlotPlugin[] = []
  const toasts: string[] = []
  const layers: CommandLayer[] = []
  const dialogRenders: (() => JSX.Element)[] = []
  let lastConfirm: ConfirmProps | undefined

  const color = (r: number, g: number, b: number) => RGBA.fromInts(r, g, b)
  const theme = {
    current: {
      primary: color(120, 140, 200),
      text: color(200, 200, 200),
      textMuted: color(130, 130, 130),
      success: color(120, 180, 120),
      warning: color(200, 180, 120),
      error: color(190, 110, 110),
    },
  }

  const api = {
    kv: {
      get: (key: string, fallback?: unknown) => (values.has(key) ? values.get(key) : fallback),
      set: (key: string, value: unknown) => {
        values.set(key, value)
      },
      ready: true,
    },
    event: {
      on(type: string, handler: (event: unknown) => void) {
        listeners.set(type, handler)
        return () => listeners.delete(type)
      },
    },
    state: {
      session: {
        get: (sid: string) => input.sessions?.[sid],
        messages: (sid: string) => (input.messages?.[sid] ?? []) as never,
        status: (sid: string) => input.status?.[sid],
        todo: () => [],
      },
      part: () => [],
    },
    client: { session: { abort: () => Promise.resolve({ data: undefined }) } },
    theme,
    route: {
      register: () => () => {},
      navigate: () => {},
      current: { name: "session", params: { sessionID: "ses_parent" } },
    },
    ui: {
      toast: (toast: { message: string }) => {
        toasts.push(toast.message)
      },
      dialog: {
        clear() {},
        replace(render: () => JSX.Element) {
          dialogRenders.push(render)
        },
        setSize() {},
        size: "medium" as const,
        depth: 0,
        open: false,
      },
      DialogConfirm: (props: ConfirmProps) => {
        lastConfirm = props
        return (
          <box flexDirection="column">
            <text>{props.title}</text>
            <text>{props.message}</text>
          </box>
        )
      },
    },
    keymap: {
      registerLayer: (layer: CommandLayer) => {
        layers.push(layer)
        return () => {}
      },
    },
    slots: {
      register: (plugin: TuiSlotPlugin) => {
        slots.push(plugin)
        return plugin.id ?? "slot"
      },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: () => () => {},
    },
  } as unknown as TuiPluginApi

  return {
    api,
    slots,
    toasts,
    layers,
    dialogRenders,
    lastConfirm: () => lastConfirm,
    emit: (type: string, properties: Record<string, unknown>) => listeners.get(type)?.({ properties }),
  }
}

test("sidebar panel renders entries and settles them", async () => {
  const fx = apiFixture({
    sessions: {
      ses_child: {
        id: "ses_child",
        slug: "child",
        projectID: "proj",
        directory: "/tmp",
        parentID: "ses_parent",
        title: "child",
        version: "1",
        time: { created: 0, updated: 0 },
        agent: "explore",
        cost: 0.25,
      } as Session,
    },
    messages: {
      ses_child: [
        {
          id: "m1",
          sessionID: "ses_child",
          role: "assistant",
          time: { created: 0, completed: 1 },
          parentID: "",
          modelID: "test-model",
          providerID: "test",
          mode: "primary",
          agent: "explore",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0.25,
          tokens: { input: 700, output: 300, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      ],
    },
    status: { ses_child: { type: "idle" } },
  })

  const { default: plugin } = await import("../../src/feature-plugins/sidebar/subagent")
  await (plugin.tui as (api: TuiPluginApi) => Promise<void>)(fx.api)
  expect(fx.slots).toHaveLength(1)
  const render = fx.slots[0]!.slots!.sidebar_content as unknown as (
    ctx: unknown,
    props: { session_id: string },
  ) => ReturnType<typeof testRender>

  const app = await testRender(() => (
    <box width={37} flexDirection="column">
      {render({ theme: (fx.api as unknown as { theme: unknown }).theme }, { session_id: "ses_parent" })}
    </box>
  ))
  try {
    await app.renderOnce()
    // no entries yet — the whole panel stays hidden
    expect(app.captureCharFrame()).not.toContain("SubAgents")

    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart("p1", {
        status: "running",
        input: { description: "scan the codebase", prompt: "scan", subagent_type: "explore" },
        time: { start: Date.now() - 3000 },
      } as ToolPart["state"]),
    })
    await app.renderOnce()
    const frame = app.captureCharFrame()
    expect(frame).toContain("SubAgents")
    expect(frame).toContain("scan the codebase")
    // the running duration must stay on the entry's own line at sidebar width
    expect(lineWith(frame, "scan the codebase").trimEnd()).toMatch(/\d+\.\ds$/)

    fx.emit("session.idle", { sessionID: "ses_child" })
    await app.renderOnce()
    const settled = app.captureCharFrame()
    // settled: header counts 1 done entry with its tokens and cost
    expect(settled).toContain("●1")
    expect(settled).toContain("1.0k")
    expect(settled).toContain("$0.25")
    // duration and tokens share the entry line — nothing wraps below it
    expect(lineWith(settled, "scan the codebase").trimEnd()).toMatch(/\d+\.\ds 1\.0k$/)
    expect(settled.split("\n").every((line) => !/^\s*\d+(\.\d+)?[sm]/.test(line))).toBe(true)
  } finally {
    app.renderer.destroy()
  }
})

function lineWith(frame: string, needle: string): string {
  return frame.split("\n").find((line) => line.includes(needle)) ?? ""
}

test("one-shot clear slash commands", async () => {
  // the plugin reads translations through the shared i18next singleton;
  // other suite tests may have left it on zh — pin it to match en.json
  await i18next.changeLanguage("en")

  const fx = apiFixture({
    sessions: {
      ses_child: {
        id: "ses_child",
        slug: "child",
        projectID: "proj",
        directory: "/tmp",
        parentID: "ses_parent",
        title: "child",
        version: "1",
        time: { created: 0, updated: 0 },
      } as Session,
    },
    status: { ses_child: { type: "busy" } },
  })
  const { default: plugin } = await import("../../src/feature-plugins/sidebar/subagent")
  await (plugin.tui as (api: TuiPluginApi) => Promise<void>)(fx.api)

  // only the two one-shot actions are registered as slash commands
  const commands = fx.layers[0]!.commands
  expect(commands).toHaveLength(2)
  expect(commands[0]!.name).toBe("subagent.clearEntries")
  expect(commands[0]!.slashName).toBe("subagent-clear-entries")
  expect(commands[1]!.name).toBe("subagent.clearRunning")
  expect(commands[1]!.slashName).toBe("subagent-clear-running")

  // /subagent-clear-entries opens the confirmation dialog for both running entries
  for (const [pid, desc] of [["p1", "stuck task"], ["p2", "another task"]] as const) {
    fx.emit("message.part.updated", {
      sessionID: "ses_parent",
      part: toolPart(pid, {
        status: "running",
        input: { description: desc, prompt: "x", subagent_type: "explore" },
        time: { start: Date.now() },
      } as ToolPart["state"]),
    })
  }
  commands[0]!.run()
  expect(fx.dialogRenders).toHaveLength(1)
  // render the dialog so the DialogConfirm component records its props
  const clearApp = await testRender(() => fx.dialogRenders[0]!())
  try {
    await clearApp.renderOnce()
    const confirm = fx.lastConfirm()!
    expect(confirm.title).toBe("Confirm")
    expect(confirm.message).toContain("still running")
    confirm.onConfirm!()
    expect(fx.toasts.some((m) => m.includes("Cleared 2 sub-agent"))).toBe(true)
  } finally {
    clearApp.renderer.destroy()
  }

  // /subagent-clear-running aborts a newly running entry through the cancel path
  fx.emit("message.part.updated", {
    sessionID: "ses_parent",
    part: toolPart("p1", {
      status: "running",
      input: { description: "restarted task", prompt: "x", subagent_type: "explore" },
      metadata: { sessionId: "ses_child" },
      time: { start: Date.now() },
    } as ToolPart["state"]),
  })
  await commands[1]!.run()
  expect(fx.toasts.some((m) => m.includes("Cancelled 1 running"))).toBe(true)
})
