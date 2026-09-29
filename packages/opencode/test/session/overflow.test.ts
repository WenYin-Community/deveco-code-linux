import { describe, expect, test } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { isOverflow, usable } from "@/session/overflow"

function createModel(opts: { context: number; output: number; input?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: opts.context, input: opts.input, output: opts.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/openai-compatible" },
    options: {},
  } as Provider.Model
}

function tokens(total: number): SessionV1.Assistant["tokens"] {
  return { total, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

const cfg = {} as ConfigV1.Info

describe("Overflow.usable", () => {
  test("reserves the completion budget out of the window", () => {
    expect(usable({ cfg, model: createModel({ context: 200_000, output: 64_000 }) })).toBe(136_000)
  })

  test("reserves only the compaction buffer when the model declares an input limit", () => {
    expect(usable({ cfg, model: createModel({ context: 400_000, output: 128_000, input: 272_000 }) })).toBe(252_000)
  })

  test("honors an explicit compaction.reserved on the input-limit branch", () => {
    const reserved = { compaction: { reserved: 40_000 } } as ConfigV1.Info
    expect(
      usable({ cfg: reserved, model: createModel({ context: 400_000, output: 128_000, input: 272_000 }) }),
    ).toBe(232_000)
    // The window branch reserves the whole completion budget instead, so the knob
    // does not apply there — asserted so a future change to that is deliberate.
    expect(usable({ cfg: reserved, model: createModel({ context: 200_000, output: 64_000 }) })).toBe(136_000)
  })

  test("returns 0 when the window is unknown", () => {
    expect(usable({ cfg, model: createModel({ context: 0, output: 0 }) })).toBe(0)
  })

  test("never collapses to 0 for a model that declares output >= context", () => {
    // Regression: maxOutputTokens() stopped clamping to the built-in 32000 cap, so
    // `context - output` hit 0 for the ~1100 catalog rows that publish the window in
    // both fields. usable() === 0 made isOverflow() true at any token count and put
    // the session into a compaction loop that only ended when compaction itself failed.
    expect(usable({ cfg, model: createModel({ context: 262_144, output: 262_144 }) })).toBe(65_536)
    expect(usable({ cfg, model: createModel({ context: 4_000, output: 50_000 }) })).toBe(1_000)
    expect(usable({ cfg, model: createModel({ context: 512, output: 512 }) })).toBe(128)
    expect(usable({ cfg, model: createModel({ context: 480, output: 8_192 }) })).toBe(120)
  })

  test("keeps the prompt budget plus the completion budget inside the window", () => {
    // The floor exists to keep a degenerate row out of a compaction loop, not to
    // grant capacity the window does not have: providers reject
    // `prompt + max_tokens > context`.
    for (const limit of [
      { context: 262_144, output: 262_144 },
      { context: 4_000, output: 50_000 },
      { context: 512, output: 512 },
      { context: 480, output: 8_192 },
      { context: 200_000, output: 64_000 },
    ]) {
      const model = createModel(limit)
      expect(usable({ cfg, model })).toBeGreaterThan(0)
      expect(usable({ cfg, model }) + ProviderTransform.maxOutputTokens(model)).toBeLessThanOrEqual(limit.context)
    }
    // A window too small to hold both a prompt and a completion still gets a
    // non-zero budget: avoiding the compaction loop outranks the fit guarantee.
    expect(usable({ cfg, model: createModel({ context: 1, output: 1 }) })).toBe(1)
  })

  test("applies an explicit outputTokenMax to the reserve", () => {
    expect(usable({ cfg, model: createModel({ context: 200_000, output: 131_072 }), outputTokenMax: 4_096 })).toBe(
      195_904,
    )
  })
})

describe("Overflow.isOverflow", () => {
  test("is false on a fresh session for output >= context models", () => {
    for (const model of [
      createModel({ context: 262_144, output: 262_144 }),
      createModel({ context: 512, output: 512 }),
      createModel({ context: 480, output: 8_192 }),
      createModel({ context: 4_000, output: 50_000 }),
    ]) {
      expect(isOverflow({ cfg, tokens: tokens(0), model })).toBe(false)
      expect(isOverflow({ cfg, tokens: tokens(64), model })).toBe(false)
    }
  })

  test("is false when the window is unknown", () => {
    expect(isOverflow({ cfg, tokens: tokens(1_000_000), model: createModel({ context: 0, output: 0 }) })).toBe(false)
  })

  test("is true once the conversation passes the usable budget", () => {
    const model = createModel({ context: 200_000, output: 64_000 })
    expect(isOverflow({ cfg, tokens: tokens(135_999), model })).toBe(false)
    expect(isOverflow({ cfg, tokens: tokens(136_000), model })).toBe(true)
  })

  test("is true for a degenerate window once any real token is spent", () => {
    const model = createModel({ context: 512, output: 512 })
    expect(isOverflow({ cfg, tokens: tokens(512), model })).toBe(true)
  })

  test("is disabled by compaction.auto === false", () => {
    const off = { compaction: { auto: false } } as ConfigV1.Info
    expect(isOverflow({ cfg: off, tokens: tokens(1_000_000), model: createModel({ context: 512, output: 512 }) })).toBe(
      false,
    )
  })
})
