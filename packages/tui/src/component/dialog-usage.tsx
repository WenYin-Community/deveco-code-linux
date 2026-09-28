import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { StatsQuota, StatsUsage } from "@opencode-ai/sdk/v2"
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useI18n } from "../i18n"
import { useTuiConfig } from "../config"
import { useBindings, useCommandShortcut } from "../keymap"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { longestSessionWallDuration, sessionWallDuration } from "../context/session-timer"
import { StatusBody } from "./dialog-status"

const TOP_TABS = ["status", "config", "usage", "stats"] as const
const SUB_TABS = ["overview", "models"] as const

// Selected-tab block palette: the layer holding focus renders its selected tab in
// its active color, the other layer's selected tab dims to #CCCCCC.
const TOP_TAB_BG = RGBA.fromHex("#AFD7FF")
const SUB_TAB_BG = RGBA.fromHex("#FFAF60")
const UNFOCUSED_TAB_BG = RGBA.fromHex("#CCCCCC")
const TAB_BLOCK_FG = RGBA.fromHex("#000000")
const TITLE_FG = RGBA.fromHex("#AFD7FF")
const VALUE_FG = RGBA.fromHex("#F7AA5D")

const TAB_KEYS = {
  status: "dialog.usage_tab_status",
  config: "dialog.usage_tab_config",
  usage: "dialog.usage_tab_usage",
  stats: "dialog.usage_tab_stats",
} as const

const SUB_TAB_KEYS = {
  overview: "dialog.usage_tab_overview",
  models: "dialog.usage_tab_models",
} as const

export type UsageTab = "status" | "config" | "usage" | "stats"
export type DialogUsageProps = {
  initialTab?: UsageTab
  /** Which tabs this dialog shows; defaults to the usage|stats pair. */
  tabs?: readonly UsageTab[]
}

function wrapPrev<T>(list: readonly T[], current: T) {
  const index = list.indexOf(current)
  if (index === -1) return current
  return list[(index - 1 + list.length) % list.length] ?? current
}

function wrapNext<T>(list: readonly T[], current: T) {
  const index = list.indexOf(current)
  if (index === -1) return current
  return list[(index + 1) % list.length] ?? current
}

/**
 * Tabbed usage panel (Claude Code Settings/Stats style).
 * Opened by /usage (Usage tab) and /stats (Stats tab, focus starts on the
 * sub-tab bar). The existing /status command keeps its own DialogStatus.
 */
export function DialogUsage(props: DialogUsageProps) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const { t, lng } = useI18n()
  const tuiConfig = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const tabs = props.tabs ?? (["usage", "stats"] as const)
  const initial = props.initialTab ?? tabs[0]
  const [activeTab, setActiveTab] = createSignal<(typeof TOP_TABS)[number]>(initial)
  const [subTab, setSubTab] = createSignal<(typeof SUB_TABS)[number]>("overview")
  const [focus, setFocus] = createSignal<"top" | "sub">(initial === "stats" ? "sub" : "top")

  // Entering Stats always shows the sub-tab bar starting on Overview; leaving Stats
  // through direct tab selection (mouse) returns focus to the top tab bar.
  const selectTab = (tab: UsageTab) => {
    if (tab === "stats") setSubTab("overview")
    else setFocus("top")
    setActiveTab(tab)
  }

  const sdk = useSDK()
  const route = useRoute()
  const clipboard = useClipboard()
  const toast = useToast()
  const [stats, setStats] = createSignal<StatsUsage | undefined>()
  const [statsState, setStatsState] = createSignal<"loading" | "error" | "ready">("loading")
  const [range, setRange] = createSignal<"all" | "7d" | "30d">("all")
  const [quota, setQuota] = createSignal<StatsQuota | undefined>()

  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const rangeDays = () => (range() === "7d" ? 7 : range() === "30d" ? 30 : undefined)

  const fetchStats = () => {
    setStatsState("loading")
    sdk.client.stats
      .usage({ sessionID: sessionID(), days: rangeDays()?.toString() }, { throwOnError: true })
      .then((result) => {
        setStats(result.data)
        setStatsState("ready")
      })
      .catch(() => setStatsState("error"))
    sdk.client.stats
      .quota({ throwOnError: true })
      .then((result) => setQuota(result.data))
      .catch(() => setQuota(undefined))
  }

  // The dialog container starts a quarter of the way down the terminal, so the
  // panel must fit within 75% of the height minus its chrome rows.
  const contentHeight = createMemo(() => Math.max(8, Math.floor(dimensions().height * 0.75) - 9))
  const modelColor = (index: number) => theme[MODEL_COLOR_KEYS[index % MODEL_COLOR_KEYS.length]]

  useBindings(() => ({
    commands: [
      {
        name: "dialog.usage.tab.prev",
        title: t("dialog.usage_tab_prev"),
        category: t("category.dialog"),
        run: () => {
          if (focus() === "sub") {
            setSubTab((prev) => wrapPrev(SUB_TABS, prev))
            return
          }
          selectTab(wrapPrev(tabs, activeTab()))
        },
      },
      {
        name: "dialog.usage.tab.next",
        title: t("dialog.usage_tab_next"),
        category: t("category.dialog"),
        run: () => {
          if (focus() === "sub") {
            setSubTab((prev) => wrapNext(SUB_TABS, prev))
            return
          }
          selectTab(wrapNext(tabs, activeTab()))
        },
      },
      {
        name: "dialog.usage.focus.sub",
        title: t("dialog.usage_focus_sub"),
        category: t("category.dialog"),
        run: () => {
          if (activeTab() !== "stats" || focus() === "sub") return
          setFocus("sub")
        },
      },
      {
        name: "dialog.usage.focus.top",
        title: t("dialog.usage_focus_top"),
        category: t("category.dialog"),
        run: () => {
          if (focus() !== "sub") return
          setFocus("top")
        },
      },
      {
        name: "dialog.usage.dates.cycle",
        title: t("dialog.usage_dates_cycle"),
        category: t("category.dialog"),
        run: () => {
          if (activeTab() !== "stats") return
          setRange((prev) => (prev === "all" ? "7d" : prev === "7d" ? "30d" : "all"))
        },
      },
      {
        name: "dialog.usage.stats.copy",
        title: t("dialog.usage_copy"),
        category: t("category.dialog"),
        run: () => {
          if (activeTab() !== "stats") return
          const segmentsText = (segments: UsageSegment[]) => segments.map((segment) => segment.text).join("")
          const text = [
            ...overviewPairs().map(([left, right]) => padDisplay(segmentsText(left), 38) + segmentsText(right)),
            overviewTokenLine(),
          ]
            .filter(Boolean)
            .join("\n")
          const written = clipboard.write?.(text)
          if (written) void written.then(() => toast.show({ message: t("dialog.usage_copy_done"), variant: "success" }))
        },
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.usage", [
      "dialog.usage.tab.prev",
      "dialog.usage.tab.next",
      "dialog.usage.focus.sub",
      "dialog.usage.focus.top",
      "dialog.usage.dates.cycle",
      "dialog.usage.stats.copy",
    ]),
  }))

  onMount(() => {
    dialog.setSize("large")
    fetchStats()
  })
  createEffect(on(activeTab, fetchStats, { defer: true }))
  createEffect(on(range, fetchStats, { defer: true }))

  const rShortcut = useCommandShortcut("dialog.usage.dates.cycle")

  const footerHint = createMemo(() => {
    const r = rShortcut()
    if (activeTab() === "stats" && r) {
      if (focus() === "sub") return t("dialog.usage_footer_stats_sub", { r })
      return t("dialog.usage_footer_stats_top", { r })
    }
    return t("dialog.usage_esc_cancel")
  })

  const locale = () => (lng() === "zh" ? "zh-CN" : "en-US")
  const heatmap = createMemo(() => buildHeatmap(stats()?.daily ?? [], locale()))
  const meta = createMemo(() => rangeMeta(stats()?.daily ?? [], rangeDays()))

  // Stats block segments: labels and units render white, filled values in VALUE_FG.
  const overviewPairs = createMemo(() => {
    const data = stats()
    if (!data) return []
    return [
      [
        [seg(`${t("dialog.usage_favorite_model")}: `), seg(truncateDisplay(favoriteModel(data), 22), "value")],
        [seg(`${t("dialog.usage_total_tokens")}: `), seg(compactNumber(totalTokens(data.total.tokens)), "value")],
      ],
      [
        [seg(`${t("dialog.usage_sessions")}: `), seg(data.total.sessions.toLocaleString(), "value")],
        [seg(`${t("dialog.usage_longest_session")}: `), ...numberSegs(formatDuration(longestSessionWallDuration()))],
      ],
      [
        [seg(`${t("dialog.usage_active_days")}: `), seg(String(meta().activeDays), "value"), seg(`/${meta().totalDays}`, "muted")],
        [seg(`${t("dialog.usage_longest_streak")}: `), seg(String(meta().longestStreak), "value"), seg(` ${t("dialog.usage_days_word")}`)],
      ],
      [
        [seg(`${t("dialog.usage_most_active_day")}: `), seg(formatDay(meta().mostActiveDay, locale()), "value")],
        [seg(`${t("dialog.usage_current_streak")}: `), seg(String(meta().currentStreak), "value"), seg(` ${t("dialog.usage_days_word")}`)],
      ],
    ] as Array<[UsageSegment[], UsageSegment[]]>
  })

  // Claude Code chart: top-3 non-zero models; the builder sizes itself.
  const chartModels = createMemo(() =>
    (stats()?.models ?? []).filter((model) => model.daily.some((entry) => entry.tokens > 0)).slice(0, 3),
  )
  const modelChart = createMemo(() => buildTokenChart(chartModels().map((model) => model.daily), dimensions().width, 8))

  const modelCards = createMemo(() => {
    const models = stats()?.models ?? []
    const total = models.reduce((acc, model) => acc + totalTokens(model.tokens), 0) || 1
    const cards = models.map((model, index) => ({
      model,
      share: totalTokens(model.tokens) / total,
      colorIndex: index,
    }))
    const pairs: Array<[ModelCardData, ModelCardData?]> = []
    for (let i = 0; i < cards.length; i += 2) pairs.push([cards[i], cards[i + 1]])
    return pairs
  })

  const overviewTokenLine = createMemo(() => {
    const data = stats()
    if (!data) return ""
    return t("dialog.usage_stats_tokens_line", {
      input: compactNumber(data.total.tokens.input),
      output: compactNumber(data.total.tokens.output),
      cacheRead: compactNumber(data.total.tokens.cache.read),
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={TITLE_FG} attributes={TextAttributes.BOLD}>
          {t(tabs.includes("config") ? "dialog.settings_title" : "dialog.usage_title")}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          {t("dialog.esc")}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <For each={tabs}>
          {(tab) => {
            const active = () => tab === activeTab()
            return (
              <box
                backgroundColor={active() ? (focus() === "top" ? TOP_TAB_BG : UNFOCUSED_TAB_BG) : undefined}
                onMouseUp={() => selectTab(tab)}
              >
                <text fg={active() ? TAB_BLOCK_FG : theme.text} attributes={active() ? TextAttributes.BOLD : undefined}>
                  {` ${t(TAB_KEYS[tab])} `}
                </text>
              </box>
            )
          }}
        </For>
      </box>
      <scrollbox scrollbarOptions={{ visible: false }} maxHeight={contentHeight()}>
        <Switch>
          <Match when={activeTab() === "status"}>
            <StatusBody />
          </Match>
          <Match when={activeTab() === "config"}>
            <text fg={theme.textMuted}>{t("dialog.usage_placeholder_config")}</text>
          </Match>
          <Match when={activeTab() === "usage"}>
            <box gap={1}>
              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {t("dialog.usage_user")}
              </text>
              <Show when={quota()?.hourly?.enabled}>
                <QuotaRow label={t("dialog.usage_quota_hourly")} window={quota()?.hourly} />
              </Show>
              <Show when={quota()?.weekly?.enabled}>
                <QuotaRow label={t("dialog.usage_quota_weekly")} window={quota()?.weekly} />
              </Show>
              <Show when={quota()?.monthly?.enabled}>
                <QuotaRow label={t("dialog.usage_quota_monthly")} window={quota()?.monthly} />
              </Show>

              <text fg={theme.text} attributes={TextAttributes.BOLD}>
                {t("dialog.usage_session")}
              </text>
              <Switch>
                <Match when={statsState() === "error"}>
                  <text fg={theme.error}>{t("dialog.usage_load_error")}</text>
                </Match>
                <Match when={statsState() === "loading" && !stats()}>
                  <text fg={theme.textMuted}>{t("dialog.usage_loading")}</text>
                </Match>
                <Match when={stats()?.session} keyed>
                  {(session) => (
                    <box gap={1}>
                      <UsageRow
                        label={`${t("dialog.usage_duration_api")}:`}
                        value={formatDuration(session.durationApi)}
                      />
                      <UsageRow
                        label={`${t("dialog.usage_duration_wall")}:`}
                        value={formatDuration(sessionWallDuration(session.sessionID))}
                      />
                      <UsageRow
                        label={`${t("dialog.usage_usage_label")}:`}
                        value={t("dialog.usage_usage_line", {
                          input: compactNumber(session.tokens.input),
                          output: compactNumber(session.tokens.output),
                          cacheRead: compactNumber(session.tokens.cache.read),
                        })}
                      />
                    </box>
                  )}
                </Match>
                <Match when={true}>
                  <text fg={theme.textMuted}>{t("dialog.usage_no_active_session")}</text>
                </Match>
              </Switch>
            </box>
          </Match>
          <Match when={activeTab() === "stats"}>
            <box gap={1}>
              <box flexDirection="row" gap={2}>
                <For each={SUB_TABS}>
                  {(tab) => {
                    const selected = () => tab === subTab()
                    return (
                      <box
                        backgroundColor={selected() ? (focus() === "sub" ? SUB_TAB_BG : UNFOCUSED_TAB_BG) : undefined}
                        onMouseUp={() => {
                          setSubTab(tab)
                          setFocus("sub")
                        }}
                      >
                        <text fg={selected() ? TAB_BLOCK_FG : theme.text} attributes={selected() ? TextAttributes.BOLD : undefined}>
                          {` ${t(SUB_TAB_KEYS[tab])} `}
                        </text>
                      </box>
                    )
                  }}
                </For>
              </box>
              <Switch>
                <Match when={subTab() === "overview"}>
                  <Switch>
                    <Match when={statsState() === "error"}>
                      <text fg={theme.error}>{t("dialog.usage_load_error")}</text>
                    </Match>
                    <Match when={statsState() === "loading" && !stats()}>
                      <text fg={theme.textMuted}>{t("dialog.usage_loading")}</text>
                    </Match>
                    <Match when={stats()}>
                      <box gap={1}>
                          <box flexDirection="column">
                            <box flexDirection="row">
                              <box width={4} flexShrink={0} />
                              <text fg={theme.text}>{heatmap().months}</text>
                            </box>
                            <For each={heatmap().rows}>
                              {(row) => (
                                <box flexDirection="row">
                                  <box width={4} flexShrink={0}>
                                    <text fg={theme.text}>{row.label}</text>
                                  </box>
                                  <box flexDirection="row">
                                    <For each={row.runs}>
                                      {(run) => <text fg={run.active ? theme.accent : theme.textMuted}>{run.text}</text>}
                                    </For>
                                  </box>
                                </box>
                              )}
                            </For>
                          </box>
                          <text fg={theme.text}>
                            {`${t("dialog.usage_less")} `}
                            <span style={{ fg: theme.accent }}>{"░ ▒ ▓ █"}</span>
                            {` ${t("dialog.usage_more")}`}
                          </text>
                          <RangeRow active={range()} onSelect={setRange} />
                          <box gap={1}>
                            <For each={overviewPairs()}>
                              {(pair) => <StatPair left={pair[0]} right={pair[1]} />}
                            </For>
                          </box>
                          <text fg={theme.textMuted}>{overviewTokenLine()}</text>
                      </box>
                    </Match>
                  </Switch>
                </Match>
                <Match when={subTab() === "models"}>
                  <Switch>
                    <Match when={statsState() === "error"}>
                      <text fg={theme.error}>{t("dialog.usage_load_error")}</text>
                    </Match>
                    <Match when={statsState() === "loading" && !stats()}>
                      <text fg={theme.textMuted}>{t("dialog.usage_loading")}</text>
                    </Match>
                    <Match when={stats()?.models.length === 0}>
                      <text fg={theme.textMuted}>{t("dialog.usage_no_models")}</text>
                    </Match>
                    <Match when={stats()}>
                      <box gap={1}>
                        <text fg={theme.text} attributes={TextAttributes.BOLD}>
                          {t("dialog.usage_tokens_per_day")}
                        </text>
                        <Show when={modelChart()} keyed>
                          {(chart) => (
                            <box flexDirection="row">
                              <box width={8} flexShrink={0}>
                                <For each={chart.yLabels}>
                                  {(label) => <text fg={theme.textMuted}>{label.padStart(7)}</text>}
                                </For>
                              </box>
                              <box flexDirection="column">
                                <For each={chart.rows}>
                                  {(row) => (
                                    <box flexDirection="row">
                                      <For each={row}>
                                        {(run) => (
                                          <text fg={run.color >= 0 ? modelColor(run.color) : theme.textMuted}>
                                            {run.text}
                                          </text>
                                        )}
                                      </For>
                                    </box>
                                  )}
                                </For>
                                <text fg={theme.textMuted}>{chart.xLabels}</text>
                              </box>
                            </box>
                          )}
                        </Show>
                        <box flexDirection="row">
                          <For each={chartModels()}>
                            {(model, index) => (
                              <>
                                {index() > 0 && <text fg={theme.textMuted}>{" · "}</text>}
                                <text fg={modelColor(index())}>{"●"}</text>
                                <text fg={theme.text}>{` ${model.modelID}`}</text>
                              </>
                            )}
                          </For>
                        </box>
                        <RangeRow active={range()} onSelect={setRange} />
                        <For each={modelCards()}>
                          {(pair) => (
                            <box flexDirection="row">
                              <box width={40} flexShrink={0}>
                                <ModelCard card={pair[0]} />
                              </box>
                              <Show when={pair[1]}>
                                {(second) => <ModelCard card={second()} />}
                              </Show>
                            </box>
                          )}
                        </For>
                      </box>
                    </Match>
                  </Switch>
                </Match>
              </Switch>
            </box>
          </Match>
        </Switch>
      </scrollbox>
      <text fg={theme.textMuted}>{footerHint()}</text>
    </box>
  )
}

type UsageSegment = { text: string; kind: "plain" | "value" | "muted" }

const seg = (text: string, kind: "plain" | "value" | "muted" = "plain"): UsageSegment => ({ text, kind })

// Splits digits from surrounding text so numbers render in VALUE_FG and units stay plain.
const numberSegs = (text: string): UsageSegment[] =>
  text
    .split(/(\d+(?:\.\d+)?)/)
    .filter(Boolean)
    .map((part) => (/\d/.test(part) ? seg(part, "value") : seg(part)))

function RangeRow(props: { active: "all" | "7d" | "30d"; onSelect: (next: "all" | "7d" | "30d") => void }) {
  const { theme } = useTheme()
  const { t } = useI18n()
  return (
    <box flexDirection="row" gap={2}>
      <For each={["all", "7d", "30d"] as const}>
        {(item) => (
          <box onMouseUp={() => props.onSelect(item)}>
            <text
              fg={props.active === item ? VALUE_FG : theme.textMuted}
              attributes={props.active === item ? TextAttributes.BOLD : undefined}
            >
              {` ${t(`dialog.usage_range_${item}`)} `}
            </text>
          </box>
        )}
      </For>
    </box>
  )
}

// Claude Code uses theme suggestion/success/warning; deveco's closest trio.
const MODEL_COLOR_KEYS = ["accent", "success", "warning"] as const

type ModelCardData = {
  model: NonNullable<StatsUsage["models"]>[number]
  share: number
  colorIndex: number
}

function ModelCard(props: { card: ModelCardData }) {
  const { theme } = useTheme()
  const { t } = useI18n()
  const { model, share, colorIndex } = props.card
  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={theme[MODEL_COLOR_KEYS[colorIndex % MODEL_COLOR_KEYS.length]]}>{"● "}</text>
        <text fg={theme.text}>{`${model.modelID} `}</text>
        <text fg={VALUE_FG}>{`(${(share * 100).toFixed(1)}%)`}</text>
      </box>
      <text fg={theme.text}>
        {`${t("dialog.usage_in")}: `}
        <span style={{ fg: VALUE_FG }}>{compactNumber(model.tokens.input)}</span>
        {` · ${t("dialog.usage_out")}: `}
        <span style={{ fg: VALUE_FG }}>{compactNumber(model.tokens.output)}</span>
      </text>
      <text fg={theme.text}>
        {`${t("dialog.usage_cache_read")}: `}
        <span style={{ fg: VALUE_FG }}>{compactNumber(model.tokens.cache.read)}</span>
      </text>
    </box>
  )
}


function localTime(utcStr: string) {
  const d = new Date(utcStr.replace(" ", "T") + "Z")
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function QuotaRow(props: {
  label: string
  window: { periodHours?: number; total?: number; used?: number; remaining?: number; nextResetTime?: string } | undefined
}) {
  const { theme } = useTheme()
  const { t } = useI18n()
  const w = props.window
  if (!w) return <box />
  const labelRow = (
    <box flexDirection="row" gap={1}>
      <text fg={theme.textMuted}>{`${props.label}:`}</text>
      <Show when={w.nextResetTime}>
        <text fg={theme.textMuted}>{localTime(w.nextResetTime!)}</text>
      </Show>
    </box>
  )
  // A missing or zero total (the quota-reset moment) leaves the ratio undefined,
  // so the row degrades to the label instead of dividing by zero.
  const total = w.total
  if (!total) return <box gap={1}>{labelRow}</box>
  const used = w.used ?? 0
  const barWidth = 32
  // Solid cells are what is LEFT and hollow cells what was used, so the bar reads
  // "remaining first". The cloud's own `remaining` field stays ignored — the local
  // used/total pair is the only input.
  const remainingRatio = Math.min(1, Math.max(0, 1 - used / total))
  const remainingCells = Math.round(remainingRatio * barWidth)
  // used=0 is a full quota, not a 99.9% one; the 99.9 cap only keeps a nearly
  // drained quota from ever printing a misleading "100.0%".
  const remainingPercent = used === 0 ? "100.0" : Math.min(99.9, remainingRatio * 100).toFixed(1)
  const low = remainingRatio <= 0.2
  return (
    <box gap={1}>
      {labelRow}
      <box flexDirection="row" gap={1}>
        <box flexDirection="row">
          <text fg={low ? theme.warning : theme.accent}>{"█".repeat(remainingCells)}</text>
          <text fg={theme.textMuted}>{"░".repeat(barWidth - remainingCells)}</text>
        </box>
        <Show
          when={used <= total}
          fallback={
            // Overspent: no percentage makes sense, so the absolute overshoot
            // replaces it; the whole amount line renders in error red.
            <text fg={theme.error}>
              {`${t("dialog.usage_quota_exceeded")} ${compactNumber(used - total)} (${compactNumber(used)} / ${compactNumber(total)})`}
            </text>
          }
        >
          <text fg={low ? theme.warning : theme.textMuted}>
            {`${remainingPercent}% ${t("dialog.usage_quota_left")} (${compactNumber(used)} / ${compactNumber(total)})`}
          </text>
        </Show>
      </box>
    </box>
  )
}


function UsageRow(props: { label: string; value: string }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row">
      <box width={24} flexShrink={0}>
        <text fg={theme.textMuted}>{props.label}</text>
      </box>
      <text fg={theme.textMuted}>{props.value}</text>
    </box>
  )
}

function StatPair(props: { left: UsageSegment[]; right: UsageSegment[] }) {
  const { theme } = useTheme()
  const renderSegments = (segments: UsageSegment[]) => (
    <For each={segments}>
      {(segment) => (
        <text fg={segment.kind === "value" ? VALUE_FG : segment.kind === "muted" ? theme.textMuted : theme.text}>
          {segment.text}
        </text>
      )}
    </For>
  )
  return (
    <box flexDirection="row">
      <box width={40} flexShrink={0}>
        <box flexDirection="row">{renderSegments(props.left)}</box>
      </box>
      <box flexDirection="row">{renderSegments(props.right)}</box>
    </box>
  )
}

function totalTokens(tokens: StatsUsage["total"]["tokens"]) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

function favoriteModel(data: StatsUsage) {
  const first = data.models[0]
  return first ? `${first.providerID}/${first.modelID}` : "—"
}

export function compactNumber(value: number) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

export function formatDuration(ms: number) {
  if (ms <= 0) return "0s"
  const seconds = Math.floor(ms / 1000)
  const units: Array<[number, string]> = [
    [Math.floor(seconds / 86400), "d"],
    [Math.floor((seconds % 86400) / 3600), "h"],
    [Math.floor((seconds % 3600) / 60), "m"],
    [seconds % 60, "s"],
  ]
  const parts = units.filter(([count], index) => count > 0 || index === 3)
  const leading = parts.findIndex(([count]) => count > 0)
  return parts
    .slice(Math.max(0, leading === -1 ? parts.length - 1 : leading))
    .slice(0, 3)
    .map(([count, unit]) => `${count}${unit}`)
    .join(" ")
}

const wideChar = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60]/

export function displayWidth(text: string) {
  let width = 0
  for (const char of text) width += wideChar.test(char) ? 2 : 1
  return width
}

export function padDisplay(text: string, width: number) {
  return text + " ".repeat(Math.max(0, width - displayWidth(text)))
}

export function truncateDisplay(text: string, max: number) {
  if (displayWidth(text) <= max) return text
  let width = 0
  let result = ""
  for (const char of text) {
    const next = width + (wideChar.test(char) ? 2 : 1)
    if (next > max - 1) return result + "…"
    result += char
    width = next
  }
  return result
}

function formatDay(value: string | undefined, locale: string) {
  if (!value) return "—"
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00Z`))
}

export const isoOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function levelChar(messages: number | undefined) {
  if (messages === undefined || messages === 0) return "·"
  if (messages >= 20) return "█"
  if (messages >= 10) return "▓"
  if (messages >= 5) return "▒"
  return "░"
}

export function buildHeatmap(daily: StatsUsage["daily"], locale: string) {
  const byDay = new Map(daily.map((item) => [item.date, item.messages]))
  const today = new Date()
  const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  // 52 columns with the current week as the last column (Claude Code style):
  // rows at/above today's weekday show 52 marks, rows below end with one blank.
  const startSunday = end - new Date(end).getUTCDay() * 86_400_000 - 51 * 7 * 86_400_000
  const columns = 52

  const weekdayLabel = (dow: number) =>
    dow === 1 || dow === 3 || dow === 5
      ? new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(Date.UTC(2024, 0, 7 + dow)))
      : " "

  const monthLabel = new Intl.DateTimeFormat(locale, { month: "short" })
  // Months span the window start month through the current month, evenly spaced
  // with single-space gaps (Claude Code style) instead of anchoring to the week
  // containing each 1st.
  const monthNames: string[] = []
  for (
    let cursor = Date.UTC(new Date(startSunday).getUTCFullYear(), new Date(startSunday).getUTCMonth(), 1);
    cursor <= end;
    cursor = Date.UTC(new Date(cursor).getUTCFullYear(), new Date(cursor).getUTCMonth() + 1, 1)
  ) {
    monthNames.push(monthLabel.format(new Date(cursor)))
  }
  const months = monthNames.join(" ")
  const cells: string[][] = Array.from({ length: 7 }, () => [])
  for (let week = 0; week < columns; week++) {
    for (let dow = 0; dow < 7; dow++) {
      const time = startSunday + (week * 7 + dow) * 86_400_000
      // Future days stay blank: the trailing column is a partial week.
      cells[dow].push(time > end ? " " : levelChar(byDay.get(isoOf(time))))
    }
  }

  const rows = cells.map((row, dow) => ({
    label: weekdayLabel(dow),
    runs: row
      .map((char) => ({ char, active: char !== "·" && char !== " " }))
      .reduce<Array<{ text: string; active: boolean }>>((runs, cell) => {
        const last = runs.at(-1)
        if (last && last.active === cell.active) last.text += cell.char
        else runs.push({ text: cell.char, active: cell.active })
        return runs
      }, []),
  }))

  return { months, rows }
}

export function rangeMeta(daily: StatsUsage["daily"], days: number | undefined) {
  const today = new Date()
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const todayKey = isoOf(todayMs)
  const rangeStart = days ? isoOf(todayMs - (days - 1) * 86_400_000) : undefined
  const inRange = daily
    .filter((item) => (!rangeStart || item.date >= rangeStart) && item.date <= todayKey)
    .toSorted((a, b) => a.date.localeCompare(b.date))
  const activeDays = inRange.length
  // Denominator: the range size, capped by the full history span (from the
  // FIRST ever activity to today, not just days within the current filter).
  const firstEver = daily[0] ? Math.round((Date.parse(todayKey) - Date.parse(daily[0].date)) / 86_400_000) + 1 : 0
  const totalDays = days ? Math.min(days, firstEver) : firstEver
  const mostActive = inRange.reduce(
    (best, item) => (best === null || item.messages >= best.messages ? item : best),
    null as null | (typeof inRange)[number],
  )
  const active = new Set(inRange.map((item) => item.date))
  let longestStreak = 0
  let streak = 0
  let previous: string | undefined
  for (const item of inRange) {
    streak = previous && Date.parse(item.date) - Date.parse(previous) === 86_400_000 ? streak + 1 : 1
    longestStreak = Math.max(longestStreak, streak)
    previous = item.date
  }
  let currentStreak = 0
  let cursor = Date.parse(todayKey)
  if (!active.has(todayKey)) cursor -= 86_400_000
  while (active.has(isoOf(cursor))) {
    currentStreak++
    cursor -= 86_400_000
  }
  return { activeDays, totalDays, mostActiveDay: mostActive?.date, longestStreak, currentStreak }
}

export type ChartRun = { text: string; color: number }

/**
 * Claude Code's Tokens-per-Day chart: a faithful port of asciichart 1.5.25
 * (npm) driven the same way Stats.tsx drives it — derived row count from
 * scaled rounding, first point as a colored ┼ on the axis column, zero-line
 * ┼ quirk, transitions drawn at the right point's column, later series
 * overwriting earlier ones, top-3 non-zero series, stretch/slice to
 * min(52, max(20, terminalWidth - 7)), and 2-4 date labels.
 */
export function buildTokenChart(
  series: Array<Array<{ date: string; tokens: number }>>,
  terminalWidth: number,
  height: number,
): { rows: ChartRun[][]; yLabels: string[]; xLabels: string } | null {
  const active = series.filter((daily) => daily.some((entry) => entry.tokens > 0)).slice(0, 3)
  const allDates = Array.from(new Set(active.flatMap((item) => item.map((entry) => entry.date)))).sort()
  if (active.length === 0 || allDates.length < 2) return null

  const chartWidth = Math.min(52, Math.max(20, terminalWidth - 7))
  const dateIndices = stretchDates(allDates, chartWidth)
  const lines = active.map((daily) => {
    const byDate = new Map(daily.map((entry) => [entry.date, entry.tokens]))
    return dateIndices.map((index) => byDate.get(allDates[index]!) ?? 0)
  })

  const board = buildBoard(lines, height, dateIndices.length + 1)
  drawYAxis(board)
  drawSeries(board, lines)
  drawXAxis(board)
  const chartRuns = toRuns(board)

  return {
    rows: chartRuns,
    yLabels: board.yLabels,
    xLabels: buildXLabels(allDates, dateIndices, board.gridWidth),
  }
}

/** Dense data slices to the chart width; sparse data repeats and trims. */
function stretchDates(allDates: string[], chartWidth: number): number[] {
  if (allDates.length >= chartWidth) {
    return Array.from({ length: chartWidth }, (_, i) => allDates.length - chartWidth + i)
  }
  const repeat = Math.ceil(chartWidth / allDates.length)
  const indices: number[] = []
  for (let i = 0; i < allDates.length; i++) for (let r = 0; r < repeat; r++) indices.push(i)
  indices.length = chartWidth
  return indices
}

type Board = {
  grid: string[][]
  colors: number[][]
  yLabels: string[]
  rows: number
  gridWidth: number
  max: number
  range: number
  zeroRow: number
  scale: (value: number) => number
  put: (row: number, col: number, char: string, color: number) => void
}

/** Scales values by height/range and allocates the char board. */
function buildBoard(lines: number[][], height: number, gridWidth: number): Board {
  const flat = lines.flat()
  const min = 0
  const max = Math.max(...flat)
  const range = Math.abs(max - min)
  // asciichart derives the row count: values are scaled by height/range and
  // rounded first, so the board can end up with height..height+1 rows.
  const ratio = range !== 0 ? height / range : 1
  const min2 = Math.round(min * ratio)
  const max2 = Math.round(max * ratio)
  const rows = Math.abs(max2 - min2)
  const grid = Array.from({ length: rows + 1 }, () => Array.from({ length: gridWidth }, () => " "))
  const colors = Array.from({ length: rows + 1 }, () => Array.from({ length: gridWidth }, () => -1))
  const put = (row: number, col: number, char: string, color: number) => {
    if (row < 0 || row > rows || col < 0 || col >= gridWidth) return
    grid[row][col] = char
    colors[row][col] = color
  }
  const scale = (value: number) => Math.round(value * ratio) - min2
  const zeroRow = rows - (0 - min2)
  return { grid, colors, yLabels: [], rows, gridWidth, max, range, zeroRow, scale, put }
}

function labelOf(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return `${Math.round(value)}`
}

/** Y-axis markers: ┤ on each row, ┼ at the zero baseline (bottom). */
function drawYAxis(board: Board) {
  const { grid, rows, yLabels, max, range, zeroRow } = board
  for (let row = 0; row < grid.length; row++) {
    yLabels[row] = labelOf(rows > 0 ? max - row * (range / rows) : row).padStart(6)
    grid[row][0] = row === zeroRow ? "┼" : "┤"
  }
}

/** Draws each series as line segments with ╭╮╰╯ transitions. */
function drawSeries(board: Board, lines: number[][]) {
  const { rows, scale, put } = board
  lines.forEach((line, color) => {
    let y0 = scale(line[0]!)
    put(rows - y0, 0, "┼", color)
    for (let x = 0; x < line.length - 1; x++) {
      const y1 = scale(line[x + 1]!)
      drawSegment(board, x, y0, y1, color)
      y0 = y1
    }
  })
}

function drawSegment(board: Board, x: number, y0: number, y1: number, color: number) {
  const { rows, put } = board
  if (y0 === y1) {
    put(rows - y0, 1 + x, "─", color)
    return
  }
  put(rows - y1, 1 + x, y0 > y1 ? "╰" : "╭", color)
  put(rows - y0, 1 + x, y0 > y1 ? "╮" : "╯", color)
  for (let y = Math.min(y0, y1) + 1; y < Math.max(y0, y1); y++) put(rows - y, 1 + x, "│", color)
}

/** X-axis: horizontal line at the bottom row, └ corner at the origin. */
function drawXAxis(board: Board) {
  const { grid, colors, rows, gridWidth } = board
  for (let col = 1; col < gridWidth; col++) {
    if (grid[rows][col] === " ") {
      grid[rows][col] = "─"
      colors[rows][col] = -1
    }
  }
  grid[rows][0] = "└"
}

/** Groups each grid row into same-color character runs. */
function toRuns(board: Board): ChartRun[][] {
  return board.grid.map((line, rowIndex) => {
    const runs: ChartRun[] = []
    line.forEach((char, col) => {
      const run = runs.at(-1)
      if (run && run.color === board.colors[rowIndex][col]) run.text += char
      else runs.push({ text: char, color: board.colors[rowIndex][col] })
    })
    return runs
  })
}

/** X labels: centered on each date's block when few; else evenly spaced. */
function buildXLabels(allDates: string[], dateIndices: number[], gridWidth: number): string {
  const slots = Array.from({ length: gridWidth + 8 }, () => " ")
  const distinctCount = new Set(dateIndices).size
  const maxFit = Math.floor(gridWidth / 7)
  const formatDate = (dateStr: string) => {
    const [, month, day] = dateStr.split("-")
    return `${Number(month)}.${Number(day)}`
  }

  if (distinctCount <= maxFit) {
    centerLabels(allDates, dateIndices, slots, formatDate)
  } else {
    spaceLabels(allDates, dateIndices, slots, formatDate)
  }
  return slots.join("").trimEnd()
}

function centerLabels(allDates: string[], dateIndices: number[], slots: string[], formatDate: (s: string) => string) {
  const blocks = new Map<number, { start: number; end: number }>()
  for (let col = 0; col < dateIndices.length; col++) {
    const d = dateIndices[col]!
    const block = blocks.get(d)
    if (block) block.end = col
    else blocks.set(d, { start: col, end: col })
  }
  for (const [dateIdx, block] of blocks) {
    const label = formatDate(allDates[dateIdx]!)
    const center = Math.floor((block.start + block.end) / 2)
    const start = Math.max(0, center + 1 - Math.floor(label.length / 2))
    for (let i = 0; i < label.length && start + i < slots.length; i++) {
      slots[start + i] = label[i]!
    }
  }
}

function spaceLabels(allDates: string[], dateIndices: number[], slots: string[], formatDate: (s: string) => string) {
  const numLabels = Math.min(4, Math.max(2, Math.floor(dateIndices.length / 8)))
  const step = Math.floor((dateIndices.length - 6) / (numLabels - 1)) || 1
  let currentPos = 0
  let cursor = 1
  for (let i = 0; i < numLabels; i++) {
    const index = Math.min(i * step, dateIndices.length - 1)
    const label = formatDate(allDates[dateIndices[index]!]!)
    cursor += Math.max(1, index - currentPos)
    for (const char of label) {
      if (cursor < slots.length) slots[cursor] = char
      cursor++
    }
    currentPos = index + label.length
  }
}
