import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import type { SubEntry, SubStatus, SubagentStore } from "./subagent-store"
import { createSubagentStore, isActive } from "./subagent-store"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js"
import { RGBA } from "@opentui/core"
import { useI18n, onLanguageChange } from "../../i18n"
import i18next from "i18next"
import { write as copyToClipboard } from "../../clipboard"

const id = "internal:sidebar-subagent"

type SortOrder = "desc" | "asc"

interface Settings {
  sortOrder: () => SortOrder
}

// ── visual width (CJK-aware) ──

function charColumns(c: string): number {
  const code = c.codePointAt(0) ?? 0
  if (code < 0x20) return 0
  if (code < 0x7f) return 1
  if (code < 0xa0) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
    return 2
  return 1
}

function visualWidth(s: string): number {
  let w = 0
  for (const c of s) w += charColumns(c)
  return w
}

function truncate(text: string, maxCols: number): string {
  if (visualWidth(text) <= maxCols) return text
  let cols = 0
  let i = 0
  for (const c of text) {
    const w = charColumns(c)
    if (cols + w > maxCols - 1) break
    cols += w
    i += c.length
  }
  return text.slice(0, i) + "…"
}

function fmtDuration(ms: number, running: boolean): string {
  if (running && ms < 2000) return ""
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s"
  const s = Math.round((ms % 60000) / 1000)
  const m = Math.floor(ms / 60000) + (s === 60 ? 1 : 0)
  return `${m}m${s % 60}s`
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1000000).toFixed(1)}M`
}

// ── Morandi palette: clamp theme color saturation to MAX_SAT ──

const MAX_SAT = 0.28

function saturation(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  const luma = (max + min) / 2
  return luma <= 0.5 ? delta / (max + min) : delta / (2 - max - min)
}

function desaturate(color: RGBA, maxSat = MAX_SAT): RGBA {
  const { r, g, b } = color
  if (saturation(r, g, b) <= maxSat) return color
  const luma = r * 0.299 + g * 0.587 + b * 0.114
  let lo = 0
  let hi = 1
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2
    if (saturation(r + (luma - r) * mid, g + (luma - g) * mid, b + (luma - b) * mid) > maxSat) lo = mid
    else hi = mid
  }
  return RGBA.fromValues(r + (luma - r) * hi, g + (luma - g) * hi, b + (luma - b) * hi)
}

function dimColor(color: RGBA, factor: number): RGBA {
  return RGBA.fromValues(color.r * factor, color.g * factor, color.b * factor)
}

function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  return RGBA.fromValues(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t)
}

/** Entry line left prefix: icon + space + status dot + space */
const LEFT_PAD = 4
/** Detail row indent: two spaces */
const INDENT = 2

function View(props: { api: TuiPluginApi; store: SubagentStore; settings: Settings; session_id: string }) {
  const { t } = useI18n()
  const store = props.store

  const [open, setOpen] = createSignal(store.loadOpen())
  const [expanded, setExpanded] = createSignal<string | undefined>(undefined)
  const [now, setNow] = createSignal(Date.now())
  const [hoveredOpen, setHoveredOpen] = createSignal<string | undefined>(undefined)
  const [hoveredCancel, setHoveredCancel] = createSignal<string | undefined>(undefined)
  const [panelWidth, setPanelWidth] = createSignal(38)
  let boxEl: { width?: number } | undefined

  createEffect(() => {
    const sid = props.session_id
    untrack(() => {
      store.ensureLoaded(sid)
      setExpanded(store.loadExpanded(sid) || undefined)
    })
  })

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 100)
    const poll = setInterval(() => store.pollTokens(), 500)
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(poll)
    })
  })

  const pal = createMemo(() => {
    const theme = props.api.theme.current
    return {
      primary: desaturate(theme.primary),
      text: desaturate(theme.text),
      muted: desaturate(theme.textMuted),
      success: desaturate(theme.success),
      warning: desaturate(theme.warning),
      error: desaturate(theme.error),
    }
  })

  const entries = createMemo(() => [...store.entriesFor(props.session_id).values()])
  const entryList = createMemo(() => {
    const list = entries()
    return props.settings.sortOrder() === "desc"
      ? [...list].sort((a, b) => b.startedAt - a.startedAt)
      : [...list].sort((a, b) => a.startedAt - b.startedAt)
  })

  const doneCount = createMemo(() => entryList().filter((e) => !isActive(e.status) && e.status !== "error").length)
  const runningCount = createMemo(() => entryList().filter((e) => isActive(e.status)).length)
  const errCount = createMemo(() => entryList().filter((e) => e.status === "error").length)
  const anyEntry = () => entryList().length > 0

  const totalTokens = createMemo(() => entryList().reduce((sum, e) => sum + (e.tokens ?? 0), 0))
  const totalCost = createMemo(() => entryList().reduce((sum, e) => sum + (e.cost ?? 0), 0))

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = prev === id ? undefined : id
      store.saveExpanded(props.session_id, next ?? "")
      return next
    })
  }

  const statusColor = (entry: SubEntry) => {
    if (entry.status === "cancelled") return pal().muted
    if (!isActive(entry.status)) return entry.status === "error" ? pal().error : pal().success
    const phase = (Math.sin(((now() % 2000) / 2000) * Math.PI * 2 - Math.PI / 2) + 1) / 2
    return mixColor(pal().muted, pal().warning, phase)
  }

  const statusText = (status: SubStatus) =>
    isActive(status)
      ? t("subagent.status_running")
      : status === "cancelled"
        ? t("subagent.status_cancelled")
        : status === "error"
          ? t("subagent.status_error")
          : t("subagent.status_done")

  const statusColorOf = (status: SubStatus) =>
    isActive(status)
      ? pal().warning
      : status === "cancelled"
        ? pal().muted
        : status === "error"
          ? pal().error
          : pal().success

  // ── expanded detail right-align ──
  const labelWidth = (label: string) => visualWidth(label + ": ")
  const expandedMaxLabelW = createMemo(() =>
    Math.max(
      ...[
        t("subagent.agent"),
        t("subagent.status"),
        t("subagent.time"),
        t("subagent.tokens"),
        t("subagent.error"),
        t("subagent.cost"),
        t("subagent.model"),
        t("subagent.todo"),
        t("subagent.session"),
      ].map(labelWidth),
    ),
  )
  const expandedPad = (label: string) => Math.max(0, expandedMaxLabelW() - labelWidth(label))
  const expandedValAvail = () => Math.max(6, panelWidth() - INDENT - expandedMaxLabelW())

  // ── header summary ──
  const summary = createMemo(() => {
    if (!anyEntry()) return undefined
    const dot = "●"
    const cost = totalCost()
    return {
      done: `${dot}${doneCount()}`,
      running: runningCount() > 0 ? `${dot}${runningCount()}` : undefined,
      err: errCount() > 0 ? `${dot}${errCount()}` : undefined,
      tokens: totalTokens() > 0 ? fmtTokens(totalTokens()) : "",
      cost: cost > 0 ? `$${cost.toFixed(2)}` : "",
    }
  })

  const summaryCols = createMemo(() => {
    const s = summary()
    if (!s) return 0
    let w = visualWidth(s.done)
    if (s.running) w += 1 + visualWidth(s.running)
    if (s.err) w += 1 + visualWidth(s.err)
    if (s.tokens) w += 1 + visualWidth(s.tokens)
    if (s.cost) w += 1 + visualWidth(s.cost)
    return w
  })

  const leftCols = createMemo(() => {
    const icon = open() ? "▼" : "▶"
    return visualWidth(icon) + 1 + visualWidth(t("subagent.title"))
  })

  const spacerCols = createMemo(() => Math.max(0, panelWidth() - leftCols() - summaryCols()))

  const copySessionId = async (entry: SubEntry) => {
    if (!entry.sessionId) return
    await copyToClipboard(entry.sessionId)
    props.api.ui.toast({
      variant: "success",
      title: entry.title || entry.agent,
      message: t("subagent.copied"),
      duration: 2500,
    })
  }

  const cancelEntry = async (entry: SubEntry) => {
    const ok = await store.cancel(entry, props.session_id)
    props.api.ui.toast({
      variant: ok ? "info" : "error",
      message: ok ? t("subagent.cancel_sent") : t("subagent.cancel_failed"),
    })
  }

  const sep = () => "─".repeat(Math.max(1, panelWidth()))

  return (
    <box
      flexDirection="column"
      gap={0}
      ref={(el: { width?: number }) => (boxEl = el)}
      onSizeChange={() => {
        const w = boxEl ? Math.max(20, boxEl.width ?? 0) : 38
        setPanelWidth((prev) => (prev === w ? prev : w))
      }}
    >
      <Show when={anyEntry()}>
        <text
          onMouseUp={() => {
            setOpen((o) => {
              const next = !o
              store.saveOpen(next)
              return next
            })
          }}
        >
          <span style={{ fg: pal().text }}>{open() ? "▼ " : "▶ "}</span>
          <span style={{ fg: pal().text }}>{t("subagent.title")}</span>
          <span style={{ fg: pal().muted }}>{" ".repeat(spacerCols())}</span>
          <span style={{ fg: pal().success }}>{summary()!.done}</span>
          <Show when={summary()!.running}>
            <span style={{ fg: pal().warning }}> {summary()!.running}</span>
          </Show>
          <Show when={summary()!.err}>
            <span style={{ fg: pal().error }}> {summary()!.err}</span>
          </Show>
          <Show when={summary()!.tokens}>
            <span style={{ fg: pal().muted }}> {summary()!.tokens}</span>
          </Show>
          <Show when={summary()!.cost}>
            <span style={{ fg: pal().warning }}> {summary()!.cost}</span>
          </Show>
        </text>

        <Show when={open()}>
          <text fg={pal().muted}>{sep()}</text>

          <For each={entryList()}>
              {(entry) => {
                const isExpanded = () => expanded() === entry.id
                const active = () => isActive(entry.status)
                const elapsed = () => (entry.endedAt ?? now()) - entry.startedAt

                const tokenText = () =>
                  !isExpanded() && entry.tokens !== undefined && entry.tokens > 0 ? ` ${fmtTokens(entry.tokens!)}` : ""
                const timeText = () =>
                  !isExpanded() && (elapsed() >= 2000 || entry.endedAt !== undefined)
                    ? fmtDuration(elapsed(), active())
                    : ""
                // the rendered suffix is " {time}{tokens}" — count the leading space or the row overflows by one column and wraps
                const suffixW = () => (timeText() ? 1 + visualWidth(timeText()) : 0) + visualWidth(tokenText())
                const labelAvail = () => Math.max(6, panelWidth() - LEFT_PAD - suffixW())
                const labelText = () => {
                  const avail = labelAvail()
                  const text = truncate(entry.title || entry.agent, avail)
                  return text + " ".repeat(Math.max(0, avail - visualWidth(text)))
                }

                return (
                  <>
                    <text onMouseUp={() => toggleExpand(entry.id)}>
                      <span style={{ fg: pal().muted }}>{isExpanded() ? "▼" : "▶"}</span>{" "}
                      <span style={{ fg: statusColor(entry) }}>●</span>{" "}
                      <span style={{ fg: pal().text }}>{labelText()}</span>
                      <Show when={timeText()}>
                        <span style={{ fg: active() ? pal().warning : pal().muted }}> {timeText()}</span>
                      </Show>
                      <Show when={tokenText()}>
                        <span style={{ fg: pal().muted }}>{tokenText()}</span>
                      </Show>
                    </text>

                    <Show when={isExpanded()}>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().text }}>{t("subagent.agent")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.agent")))}</span>
                        <span style={{ fg: pal().muted }}>{entry.agent}</span>
                      </text>
                      <text>
                        {"  "}
                        <span style={{ fg: pal().text }}>{t("subagent.status")}: </span>
                        <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.status")))}</span>
                        <span style={{ fg: statusColorOf(entry.status) }}>{statusText(entry.status)}</span>
                      </text>
                      <Show when={elapsed() >= 2000 || entry.endedAt !== undefined}>
                        <text>
                          {"  "}
                          <span style={{ fg: pal().text }}>{t("subagent.time")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.time")))}</span>
                          <span style={{ fg: pal().muted }}>{fmtDuration(elapsed(), active())}</span>
                        </text>
                      </Show>
                      <Show when={entry.tokens !== undefined}>
                        <text>
                          {"  "}
                          <span style={{ fg: pal().text }}>{t("subagent.tokens")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.tokens")))}</span>
                          <span style={{ fg: pal().muted }}>{fmtTokens(entry.tokens!)}</span>
                        </text>
                      </Show>
                      <Show when={entry.error}>
                        <text>
                          {"  "}
                          <span style={{ fg: pal().error }}>{t("subagent.error")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.error")))}</span>
                          <span style={{ fg: pal().error }}>{truncate(String(entry.error), expandedValAvail())}</span>
                        </text>
                      </Show>
                      <Show when={entry.cost !== undefined}>
                        <text>
                          {"  "}
                          <span style={{ fg: pal().text }}>{t("subagent.cost")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.cost")))}</span>
                          <span style={{ fg: pal().muted }}>${entry.cost!.toFixed(4)}</span>
                        </text>
                      </Show>
                      <Show when={entry.model}>
                        <text>
                          {"  "}
                          <span style={{ fg: pal().text }}>{t("subagent.model")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.model")))}</span>
                          <span style={{ fg: pal().muted }}>{truncate(entry.model!, expandedValAvail())}</span>
                        </text>
                      </Show>
                      <Show when={entry.todoTotal !== undefined}>
                        <text>
                          {"  "}
                          <span style={{ fg: pal().text }}>{t("subagent.todo")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.todo")))}</span>
                          <span style={{ fg: pal().muted }}>
                            {entry.todoDone}/{entry.todoTotal}
                          </span>
                        </text>
                      </Show>
                      <Show when={entry.sessionId}>
                        <text onMouseUp={() => copySessionId(entry)}>
                          {"  "}
                          <span style={{ fg: pal().text }}>{t("subagent.session")}: </span>
                          <span style={{ fg: pal().muted }}>{" ".repeat(expandedPad(t("subagent.session")))}</span>
                          <span style={{ fg: pal().muted }}>
                            {truncate(entry.sessionId!, expandedValAvail() - visualWidth(" ⎘"))}
                          </span>
                          <span style={{ fg: pal().warning }}> ⎘</span>
                        </text>
                      </Show>

                      <Show when={entry.sessionId}>
                        {(() => {
                          const openW = () => visualWidth("  → " + t("subagent.open_session"))
                          const cancelLabel = () => ` ${t("subagent.cancel")}`
                          const rightW = () => (active() ? visualWidth(cancelLabel()) : 0)
                          const spacerW = () => Math.max(1, panelWidth() - openW() - rightW() - 2)
                          return (
                            <box flexDirection="row">
                              <text
                                onMouseOver={() => setHoveredOpen(entry.id)}
                                onMouseOut={() => setHoveredOpen(undefined)}
                                onMouseUp={() =>
                                  entry.sessionId && props.api.route.navigate("session", { sessionID: entry.sessionId })
                                }
                              >
                                <span style={{ fg: hoveredOpen() === entry.id ? pal().warning : pal().primary }}>
                                  {"  → "}
                                  {t("subagent.open_session")}
                                </span>
                              </text>
                              <text style={{ fg: pal().muted }}>{" ".repeat(spacerW())}</text>
                              <Show when={active()}>
                                <text
                                  onMouseOver={() => setHoveredCancel(entry.id)}
                                  onMouseOut={() => setHoveredCancel(undefined)}
                                  onMouseUp={() => cancelEntry(entry)}
                                >
                                  <span style={{ fg: hoveredCancel() === entry.id ? pal().warning : pal().error }}>
                                    {cancelLabel()}
                                  </span>
                                </text>
                              </Show>
                            </box>
                          )
                        })()}
                      </Show>
                    </Show>
                  </>
                )
              }}
          </For>
        </Show>
      </Show>
    </box>
  )
}

function currentSessionId(api: TuiPluginApi): string | undefined {
  const route = api.route.current
  return "params" in route ? (route.params?.sessionID as string | undefined) : undefined
}

const tui: TuiPlugin = async (api) => {
  const store = createSubagentStore(api)
  store.init()
  api.lifecycle.onDispose(() => store.dispose())

  // Display settings are read once from KV; no command UI mutates them at runtime.
  const settings: Settings = {
    sortOrder: () => (String(api.kv.get("subagent_sidebar.order", "desc")) === "asc" ? "asc" : "desc"),
  }

  api.slots.register({
    order: 600,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} store={store} settings={settings} session_id={props.session_id} />
      },
    },
  })

  /** One-shot data action: /subagent-clear-entries. */
  const runClearEntries = () => {
    const sid = currentSessionId(api)
    if (!sid) {
      api.ui.toast({ variant: "error", message: i18next.t("subagent.clear_empty") })
      return
    }
    store.ensureLoaded(sid)
    const running = [...store.entriesFor(sid).values()].filter((e) => isActive(e.status)).length
    api.ui.dialog.replace(() => (
      <api.ui.DialogConfirm
        title={i18next.t("subagent.clear_title")}
        message={
          running > 0 ? i18next.t("subagent.clear_prompt_running", { n: running }) : i18next.t("subagent.clear_prompt")
        }
        onConfirm={() => {
          const count = store.clearEntries(sid)
          api.ui.toast({ message: i18next.t("subagent.clear_done", { n: count }) })
          api.ui.dialog.clear()
        }}
      />
    ))
  }

  /** One-shot data action: /subagent-clear-running. */
  const runClearRunning = async () => {
    const sid = currentSessionId(api)
    if (!sid) {
      api.ui.toast({ variant: "error", message: i18next.t("subagent.no_running") })
      return
    }
    store.ensureLoaded(sid)
    const count = await store.clearRunning(sid)
    api.ui.toast({
      message: count > 0 ? i18next.t("subagent.cancel_running", { n: count }) : i18next.t("subagent.no_running"),
    })
  }

  const registerKeymap = () =>
    api.keymap.registerLayer({
      commands: [
        {
          name: "subagent.clearEntries",
          title: i18next.t("subagent.command_clear_entries"),
          slashName: "subagent-clear-entries",
          category: i18next.t("category.session"),
          namespace: "palette",
          run: () => runClearEntries(),
        },
        {
          name: "subagent.clearRunning",
          title: i18next.t("subagent.command_clear_running"),
          slashName: "subagent-clear-running",
          category: i18next.t("category.session"),
          namespace: "palette",
          run: () => runClearRunning(),
        },
      ],
    })

  let unregisterLayer = registerKeymap()
  onLanguageChange(() => {
    unregisterLayer()
    unregisterLayer = registerKeymap()
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
