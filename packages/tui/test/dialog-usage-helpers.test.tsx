import { describe, expect, test } from "bun:test"
import {
  buildHeatmap,
  buildTokenChart,
  compactNumber,
  formatDuration,
  padDisplay,
  rangeMeta,
  truncateDisplay,
} from "../src/component/dialog-usage"

describe("usage panel helpers", () => {
  test("compactNumber matches Claude Code style", () => {
    expect(compactNumber(0)).toBe("0")
    expect(compactNumber(999)).toBe("999")
    expect(compactNumber(289_200)).toBe("289.2k")
    expect(compactNumber(3_300)).toBe("3.3k")
    expect(compactNumber(1_234_567)).toBe("1.2m")
    expect(compactNumber(2_500_000_000)).toBe("2.5b")
  })

  test("formatDuration renders up to three significant units", () => {
    expect(formatDuration(0)).toBe("0s")
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(3_519_000)).toBe("58m 39s")
    expect(formatDuration(3_685_080_000)).toBe("42d 15h 38m")
  })

  test("padDisplay and truncateDisplay are CJK width aware", () => {
    expect(padDisplay("abc", 6)).toBe("abc   ")
    expect(padDisplay("最常用模型", 12)).toBe("最常用模型  ")
    expect(truncateDisplay("anthropic/claude-sonnet-4-5", 15)).toBe("anthropic/clau…")
    expect(truncateDisplay("短名", 10)).toBe("短名")
  })

  test("buildHeatmap aligns rows and labels weekdays", () => {
    const today = new Date()
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    const daily = Array.from({ length: 3 }, (_, offset) => ({
      date: iso(todayMs - offset * 86_400_000),
      messages: offset + 1,
      tokens: 100,
    }))
    const heatmap = buildHeatmap(daily, "en-US")
    expect(heatmap.rows).toHaveLength(7)
    const rows = heatmap.rows.map((row) => row.runs.map((run) => run.text).join(""))
    const widths = new Set(rows.map((line) => line.length))
    expect(widths.size).toBe(1)
    expect(rows[0]?.length).toBe(52)
    // Months run window-start month through the current month, evenly spaced.
    const labels = heatmap.months.trim().split(/\s+/)
    const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short" })
    const startSunday = todayMs - new Date(todayMs).getUTCDay() * 86_400_000 - 51 * 7 * 86_400_000
    const firstMonth = Date.UTC(new Date(startSunday).getUTCFullYear(), new Date(startSunday).getUTCMonth(), 1)
    expect(labels[0]).toBe(shortMonth.format(new Date(firstMonth)))
    expect(labels.at(-1)).toBe(shortMonth.format(new Date(todayMs)))
    expect(labels.length).toBeGreaterThanOrEqual(12)
    expect(heatmap.months).toBe(labels.join(" "))
    expect(heatmap.rows.some((row) => row.label === "Mon")).toBe(true)
    expect(heatmap.rows.some((row) => row.label === "Fri")).toBe(true)
  })

  test("rangeMeta computes streaks and active days", () => {
    const today = new Date()
    const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    const daily = [
      { date: iso(todayMs - 6 * 86_400_000), messages: 1, tokens: 10 },
      { date: iso(todayMs - 5 * 86_400_000), messages: 2, tokens: 10 },
      { date: iso(todayMs - 4 * 86_400_000), messages: 3, tokens: 10 },
      { date: iso(todayMs - 1 * 86_400_000), messages: 9, tokens: 10 },
      { date: iso(todayMs), messages: 4, tokens: 10 },
    ]
    const all = rangeMeta(daily, undefined)
    expect(all.activeDays).toBe(5)
    expect(all.longestStreak).toBe(3)
    expect(all.currentStreak).toBe(2)
    expect(all.mostActiveDay).toBe(iso(todayMs - 86_400_000))
    expect(all.totalDays).toBe(7)

    const week = rangeMeta(daily, 7)
    expect(week.totalDays).toBe(7)
    expect(week.activeDays).toBe(5)

    const three = rangeMeta(daily.slice(1), 3)
    expect(three.activeDays).toBe(2)
  })
})

describe("buildTokenChart (asciichart port)", () => {
  const dayIso = (offset: number) =>
    new Date(Date.UTC(2026, 7, 24) - offset * 86_400_000).toISOString().slice(0, 10)
  const flatOf = (chart: NonNullable<ReturnType<typeof buildTokenChart>>) =>
    chart.rows.map((row) => row.map((run) => run.text).join("")).join("\n")

  test("sparse data fills the full chart width with flat runs", () => {
    const chart = buildTokenChart(
      [[
        { date: dayIso(13), tokens: 150_000 },
        { date: dayIso(8), tokens: 152_000 },
        { date: dayIso(5), tokens: 154_000 },
        { date: dayIso(3), tokens: 156_000 },
        { date: dayIso(1), tokens: 158_000 },
        { date: dayIso(0), tokens: 163_000 },
      ]],
      100,
      8,
    )!
    // chartWidth = 52, repeat = ceil(52/6) = 9, trimmed to exactly 52 columns
    const widths = new Set(chart.rows.map((row) => row.reduce((acc, run) => acc + run.text.length, 0)))
    expect(widths.size).toBe(1)
    expect([...widths][0]).toBe(53)
    expect(flatOf(chart)).toContain("──────")
    expect(chart.rows.length).toBe(chart.yLabels.length)
  })

  test("derives the row count from scaled rounding like asciichart", () => {
    const chart = buildTokenChart(
      [[{ date: dayIso(1), tokens: 8_000 }, { date: dayIso(0), tokens: 0 }]],
      40,
      8,
    )!
    // ratio = 8/8000 -> min2=0, max2=8, rows=8 -> 9 lines
    expect(chart.rows).toHaveLength(9)
    expect(chart.yLabels).toHaveLength(9)
    expect(chart.yLabels[0]).toBe("    8k")
    expect(chart.yLabels[8]).toBe("     0")
  })

  test("marks the first point as a colored ┼ on the axis column", () => {
    const chart = buildTokenChart(
      [[{ date: dayIso(1), tokens: 5_000 }, { date: dayIso(0), tokens: 2_000 }]],
      40,
      8,
    )!
    const coloredAxis = chart.rows
      .flat()
      .some((run) => run.color >= 0 && run.text.includes("┼"))
    expect(coloredAxis).toBe(true)
  })

  test("dense data keeps one column per date (CC renders zigzag)", () => {
    const daily = Array.from({ length: 30 }, (_, index) => ({
      date: dayIso(29 - index),
      tokens: 1_000 + ((index * 7919) % 40_000),
    }))
    const chart = buildTokenChart([daily], 40, 8)!
    // 30 dates < chartWidth 33 -> repeat ceil = 2, trimmed to 33 columns
    const widths = new Set(chart.rows.map((row) => row.reduce((acc, run) => acc + run.text.length, 0)))
    expect(widths.size).toBe(1)
    expect([...widths][0]).toBe(34)
    const dataRows = chart.rows.slice(0, -1).map((row) => row.map((run) => run.text).join("")).join("\n")
    expect(dataRows).not.toContain("─────")
    expect(flatOf(chart)).toMatch(/[╭╮╰╯]/)

    const long = Array.from({ length: 60 }, (_, index) => ({
      date: dayIso(59 - index),
      tokens: 1_000 + index * 100,
    }))
    const sliced = buildTokenChart([long], 30, 8)!
    // 60 dates >= chartWidth 23 -> sliced to the most recent 23
    const slicedWidths = new Set(sliced.rows.map((row) => row.reduce((acc, run) => acc + run.text.length, 0)))
    expect([...slicedWidths][0]).toBe(24)
    expect(sliced.xLabels).not.toContain("Jun")
  })

  test("keeps only top-3 non-zero series", () => {
    const real = [{ date: dayIso(1), tokens: 5_000 }, { date: dayIso(0), tokens: 1_000 }]
    const zero = [{ date: dayIso(1), tokens: 0 }, { date: dayIso(0), tokens: 0 }]
    const five = [
      real,
      real.map((e) => ({ ...e, tokens: e.tokens + 500 })),
      real.map((e) => ({ ...e, tokens: e.tokens + 900 })),
      zero,
      real.map((e) => ({ ...e, tokens: e.tokens + 100 })),
    ]
    const chart = buildTokenChart(five, 40, 8)!
    const colors = new Set(chart.rows.flat().filter((run) => run.color >= 0).map((run) => run.color))
    expect(colors.size).toBe(3)
  })

  test("returns null without enough data", () => {
    expect(buildTokenChart([[{ date: dayIso(0), tokens: 1 }]], 40, 8)).toBeNull()
    expect(buildTokenChart([], 40, 8)).toBeNull()
    expect(buildTokenChart([[{ date: dayIso(1), tokens: 0 }, { date: dayIso(0), tokens: 0 }]], 40, 8)).toBeNull()
  })

  test("formats millions with one decimal", () => {
    const chart = buildTokenChart(
      [[{ date: dayIso(1), tokens: 2_500_000 }, { date: dayIso(0), tokens: 1_000_000 }]],
      40,
      8,
    )!
    expect(chart.yLabels[0]).toBe("  2.5M")
  })
})
