import { expect, test } from "bun:test"
import { mountUsagePanel } from "../../fixture/usage-panel"

const todayMs = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())
const dayIso = (offset: number) => new Date(todayMs - offset * 86_400_000).toISOString().slice(0, 10)

const chartDaily = (offset: number) => ({
  date: dayIso(offset),
  tokens: offset === 0 ? 92_900 : offset === 2 ? 255_934 : 15_677,
})

const tokens = { input: 192_900, output: 3_300, reasoning: 0, cache: { read: 92_900, write: 0 } }

const statsFixture = {
  directory: undefined,
  total: { sessions: 3, messages: 42, cost: 0, longestDuration: 3_685_080_000, tokens },
  models: [
    {
      providerID: "deveco",
      modelID: "GLM-5.1",
      messages: 42,
      cost: 0,
      tokens,
      daily: [chartDaily(2), chartDaily(1), chartDaily(0)],
    },
    {
      providerID: "deveco",
      modelID: "GLM-4.6",
      messages: 7,
      cost: 0,
      tokens: { input: 50_000, output: 2_100, reasoning: 0, cache: { read: 0, write: 0 } },
      daily: [chartDaily(0)],
    },
  ],
  session: {
    sessionID: "ses_render_fixture",
    title: "Render fixture session",
    model: { providerID: "deveco", modelID: "GLM-5.1" },
    messages: 42,
    cost: 0,
    durationApi: 2_726_000,
    durationWall: 2_726_000,
    additions: 12,
    deletions: 3,
    tokens,
  },
  daily: [
    { date: dayIso(0), messages: 25, tokens: 100_000 },
    { date: dayIso(1), messages: 7, tokens: 50_000 },
    { date: dayIso(3), messages: 2, tokens: 1_000 },
  ],
}

test("dialog usage renders stats overview with heatmap and stat block", async () => {
  const panel = await mountUsagePanel({ initialTab: "stats", statsFixture })
  try {
    const frame = await panel.frameWith("Favorite model")
    expect(frame).toContain("Mon")
    expect(frame).toContain("Wed")
    expect(frame).toContain("Fri")
    expect(frame).toContain("Low ░ ▒ ▓ █ High")
    expect(frame).toContain("All time")
    expect(frame).toContain("Last 7 days")
    expect(frame).toContain("Last 30 days")
    expect(frame).toContain("Favorite model: deveco/GLM-5.1")
    expect(frame).toContain("Total tokens: 289.1k")
    
    expect(frame).toContain("Input 192.9k · Output 3.3k · Cache read 92.9k")
    const dotRows = frame.split("\n").filter((line) => (line.match(/·/g) ?? []).length > 20)
    expect(dotRows.length).toBeGreaterThanOrEqual(5)

    panel.setup.mockInput.pressKey("ARROW_RIGHT")
    const modelsFrame = await panel.frameWith("Tokens per Day")
    expect(modelsFrame).toContain("Tokens per Day")
    expect(modelsFrame).toContain("GLM-5.1")
    expect(modelsFrame).toContain("GLM-4.6")
    expect(modelsFrame).toContain("(84.7%)")
    expect(modelsFrame).toContain("(15.3%)")
    expect(modelsFrame).toContain("Cache Read:")
    
  } finally {
    panel.cleanup()
  }
})

test("models tab hides models whose requests never produced tokens", async () => {
  const withFailedModel = {
    ...statsFixture,
    models: [
      ...statsFixture.models,
      {
        providerID: "deveco",
        modelID: "failed-model",
        messages: 3,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        daily: [],
      },
    ],
  }
  const panel = await mountUsagePanel({ initialTab: "stats", statsFixture: withFailedModel })
  try {
    await panel.frameWith("Favorite model")
    panel.setup.mockInput.pressKey("ARROW_RIGHT")
    const frame = await panel.frameWith("Tokens per Day")
    expect(frame).toContain("GLM-5.1")
    expect(frame).not.toContain("failed-model")
    expect(frame).not.toContain("0.0%")
  } finally {
    panel.cleanup()
  }
})

test("cycling the date range refreshes overview values", async () => {
  const tokensAll = { input: 900_000, output: 40_000, reasoning: 0, cache: { read: 500_000, write: 0 } }
  const tokensWeek = { input: 5_000, output: 500, reasoning: 0, cache: { read: 1_000, write: 0 } }
  const byRange = (days: string) =>
    days === "7"
      ? {
          total: { sessions: 2, messages: 6, cost: 0, longestDuration: 3_600_000, tokens: tokensWeek },
          models: [
            { providerID: "deveco", modelID: "GLM-4.6", messages: 6, cost: 0, tokens: tokensWeek, daily: [{ date: dayIso(1), tokens: 5_500 }] },
          ],
          daily: [{ date: dayIso(30), messages: 60, tokens: 1_440_000 }, { date: dayIso(1), messages: 6, tokens: 5_500 }],
        }
      : {
          total: { sessions: 9, messages: 80, cost: 0, longestDuration: 86_400_000, tokens: tokensAll },
          models: [
            { providerID: "deveco", modelID: "GLM-5.1", messages: 80, cost: 0, tokens: tokensAll, daily: [{ date: dayIso(30), tokens: 1_440_000 }] },
          ],
          daily: [{ date: dayIso(30), messages: 60, tokens: 1_440_000 }],
        }
  const panel = await mountUsagePanel({ initialTab: "stats", statsFixture: byRange })
  try {
    const before = await panel.frameWith("Total tokens: 1.4m")
    expect(before).toContain("Sessions: 9")
    expect(before).toContain("Active days: 1/31")
    panel.setup.mockInput.pressKey("r")
    const after = await panel.frameWith("Total tokens: 6.5k")
    expect(after).toContain("Sessions: 2")
    expect(after).toContain("Active days: 1/7")
    
  } finally {
    panel.cleanup()
  }
})

test("dialog usage renders session block on usage tab", async () => {
  const panel = await mountUsagePanel({ initialTab: "usage", statsFixture })
  try {
    const frame = await panel.frameWith("Current Session")
    expect(frame).toContain("Current Session")
    expect(frame).toContain("Total duration (API)")
    
    
    expect(frame).toContain("45m 26s")
    
    expect(frame).toContain("cache read")
  } finally {
    panel.cleanup()
  }
})

// /stats/quota fixture: one window per state — healthy, warning, overspent.
const quotaFixture = {
  weekly: { enabled: true, total: 50_000_000, used: 31_250_000 },
  hourly: { enabled: true, total: 50_000_000, used: 41_500_000 },
  monthly: { enabled: true, total: 50_000_000, used: 84_300_000 },
}

test("usage tab asks the user to log in when quota is unavailable", async () => {
  const panel = await mountUsagePanel({ initialTab: "usage", statsFixture })
  try {
    const frame = await panel.frameWith("Current User")
    expect(frame).toContain("Log in to view your quota.")
  } finally {
    panel.cleanup()
  }
})

test("usage tab hides the login prompt when quota windows are present", async () => {
  const panel = await mountUsagePanel({ initialTab: "usage", statsFixture, quotaFixture })
  try {
    const frame = await panel.frameWith("Weekly Quota:")
    expect(frame).not.toContain("Log in to view your quota.")
  } finally {
    panel.cleanup()
  }
})

test("quota rows show remaining percentage, warning threshold and overspend text", async () => {
  const panel = await mountUsagePanel({ initialTab: "usage", statsFixture, quotaFixture })
  try {
    const frame = await panel.frameWith("37.5% left")
    expect(frame).toContain("Weekly Quota:")
    expect(frame).toContain("37.5% left (31.3m / 50.0m)")
    // 37.5% of 32 cells left = 12 solid, 20 hollow.
    expect(frame).toContain(`${"█".repeat(12)}${"░".repeat(20)}`)
    expect(frame).toContain("17.0% left (41.5m / 50.0m)")
    // 17% of 32 cells = 5 solid.
    expect(frame).toContain(`${"█".repeat(5)}${"░".repeat(27)}`)
    // Overspent window drops the percentage for the absolute overshoot.
    expect(frame).toContain("Exceeded 34.3m (84.3m / 50.0m)")
    expect(frame).not.toContain("% left (84.3m")
    // 0 remaining = a fully hollow bar.
    expect(frame).toContain("░".repeat(32))
    // Tier coloring is invisible to char frames, so assert the real span
    // foregrounds (dark-theme RGB: warning/accent/error/muted).
    const spans = panel.setup.captureSpans().lines.flatMap((line) => line.spans)
    const fgOf = (predicate: (span: { text: string }) => boolean) => spans.find(predicate)?.fg.toInts().slice(0, 3)
    expect(fgOf((span) => span.text.includes("17.0% left"))).toEqual([245, 167, 66])
    expect(fgOf((span) => span.text.includes("37.5% left"))).toEqual([128, 128, 128])
    expect(fgOf((span) => span.text.includes("Exceeded 34.3m"))).toEqual([224, 108, 117])
    expect(fgOf((span) => span.text === "█".repeat(5))).toEqual([245, 167, 66])
    expect(fgOf((span) => span.text === "█".repeat(12))).toEqual([157, 124, 216])
  } finally {
    panel.cleanup()
  }
})

test("quota row without a total degrades to the label only", async () => {
  const panel = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 0, used: 123 } },
  })
  try {
    const frame = await panel.frameWith("Weekly Quota:")
    expect(frame).toContain("Weekly Quota:")
    expect(frame).not.toContain("% left")
    expect(frame).not.toContain("Quota Reset Time:")
  } finally {
    panel.cleanup()
  }
})

test("quota row reports 0.0% left when exhausted and 100.0% left when untouched", async () => {
  const exhausted = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 50_000_000, used: 50_000_000 } },
  })
  try {
    const frame = await exhausted.frameWith("0.0% left")
    expect(frame).toContain("0.0% left (50.0m / 50.0m)")
    expect(frame).not.toContain("█")
  } finally {
    exhausted.cleanup()
  }

  const untouched = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 50_000_000, used: 0 } },
  })
  try {
    const frame = await untouched.frameWith("100.0% left")
    expect(frame).toContain("100.0% left (0 / 50.0m)")
    expect(frame).toContain("█".repeat(32))
  } finally {
    untouched.cleanup()
  }
})

test("quota row boundaries: 20% tier flip, 99.9 cap, half-cell rounding", async () => {
  // Exactly 20% remaining enters the warning tier; one token fewer stays in
  // accent — both render "20.0% left (40.0m / 50.0m)", only the color differs.
  const atThreshold = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 50_000_000, used: 40_000_000 } },
  })
  try {
    const frame = await atThreshold.frameWith("20.0% left")
    expect(frame).toContain("20.0% left (40.0m / 50.0m)")
    const spans = atThreshold.setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("20.0% left"))?.fg.toInts().slice(0, 3)).toEqual([245, 167, 66])
  } finally {
    atThreshold.cleanup()
  }

  const belowThreshold = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 50_000_000, used: 39_999_999 } },
  })
  try {
    const frame = await belowThreshold.frameWith("20.0% left")
    expect(frame).toContain("20.0% left (40.0m / 50.0m)")
    const spans = belowThreshold.setup.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("20.0% left"))?.fg.toInts().slice(0, 3)).toEqual([128, 128, 128])
  } finally {
    belowThreshold.cleanup()
  }

  // used=1 renders the 99.9 cap instead of a misleading 100.0%.
  const capped = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 50_000_000, used: 1 } },
  })
  try {
    const frame = await capped.frameWith("99.9% left")
    expect(frame).toContain("99.9% left (1 / 50.0m)")
  } finally {
    capped.cleanup()
  }

  // remainingRatio×32 = 0.5 rounds up to exactly one solid cell.
  const halfCell = await mountUsagePanel({
    initialTab: "usage",
    statsFixture,
    quotaFixture: { weekly: { enabled: true, total: 50_000_000, used: 49_218_750 } },
  })
  try {
    const frame = await halfCell.frameWith("1.6% left")
    expect(frame).toContain(`█${"░".repeat(31)}`)
  } finally {
    halfCell.cleanup()
  }
})
